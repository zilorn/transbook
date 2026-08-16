"""kakuyomu.jp（カクヨム）爬虫：搜索、目录/正文抓取、增量更新。

站点专属逻辑：搜索与目录走官方前端同用的 GraphQL 接口（/graphql），排行榜解析
HTML 页内嵌的 __NEXT_DATA__（__APOLLO_STATE__ 里的 rankedWorks），章节正文
从 HTML 页解析（<p> 一段一行，去 ruby 注音）。限速请求走 http.HttpGate，
抓取任务生命周期（进度/停止/逐章落盘）走 tasks.CrawlRunner。
"""
from __future__ import annotations

import json
import re

from bs4 import BeautifulSoup

from .http import HttpGate
from .tasks import CrawlRunner

GQL_URL = "https://kakuyomu.jp/graphql"

# 可选搜索类型（与 kakuyomu 搜索页一致，可多选；值为中文显示名）
GENRES = {
    "FANTASY": "异世界奇幻",
    "ACTION": "现代奇幻",
    "SF": "科幻",
    "LOVE_STORY": "恋爱",
    "ROMANCE": "爱情喜剧",
    "DRAMA": "现代剧情",
    "HORROR": "恐怖",
    "MYSTERY": "推理悬疑",
    "NONFICTION": "随笔·纪实",
    "HISTORY": "历史·时代·传奇",
    "CRITICISM": "创作论·评论",
    "OTHERS": "诗歌·童话·其他",
    "MAHO": "魔法のiらんど",
    "FAN_FICTION": "二次创作",
}

_SEARCH_QUERY = """query Search($query: String!, $genres: [Work_Genre!]) {
  searchWorks(query: $query, genres: $genres, first: 20, order: WEEKLY_RANKING) {
    nodes {
      id title introduction genre serialStatus publicEpisodeCount
      author { name activityName }
    }
  }
}"""

_WORK_QUERY = """query Work($workId: ID!) {
  work(id: $workId) {
    id title introduction
    author { name activityName }
    tableOfContents {
      ... on TableOfContentsChapter {
        episodeUnions {
          __typename
          ... on Episode { id title }
        }
      }
    }
  }
}"""


class KakuyomuError(Exception):
    pass


_gate = HttpGate(KakuyomuError)


async def _gql(query: str, variables: dict) -> dict:
    resp = await _gate.request("POST", GQL_URL, json={
        "operationName": None,
        "query": query,
        "variables": variables,
    })
    data = resp.json()
    if data.get("errors"):
        raise KakuyomuError(f"接口错误: {data['errors'][0].get('message')}")
    return data["data"]


# ---------------- 解析 ----------------

_WORK_ID_RE = re.compile(r"(?:kakuyomu\.jp/works/)?(\d{10,})")


def parse_work_id(s: str) -> str | None:
    """从作品/章节页 URL 或纯作品 ID 中提取作品 ID。"""
    m = _WORK_ID_RE.search(s.strip())
    return m.group(1) if m else None


async def search(query: str, genres: list[str] | None = None) -> list[dict]:
    """关键词搜索（可按ジャンル多选过滤），返回
    [{work_id, url, title, author, synopsis, status, episodes, genre}]。"""
    genres = [g for g in (genres or []) if g in GENRES]
    data = await _gql(_SEARCH_QUERY, {
        "query": query, "genres": genres or None})
    out = []
    for n in data["searchWorks"]["nodes"]:
        author = n.get("author") or {}
        out.append({
            "work_id": n["id"],
            "url": f"https://kakuyomu.jp/works/{n['id']}",
            "title": n.get("title") or "",
            "author": author.get("activityName") or author.get("name") or "",
            "synopsis": (n.get("introduction") or "").strip(),
            "status": {"COMPLETED": "已完结", "RUNNING": "连载中"}.get(
                n.get("serialStatus") or "", ""),
            "episodes": n.get("publicEpisodeCount") or 0,
            "genre": GENRES.get(n.get("genre") or "", ""),
        })
    return out


async def fetch_info(work_id: str) -> dict:
    """作品信息 + 完整目录（GraphQL 一次返回全部话数，含分章作品）。"""
    data = await _gql(_WORK_QUERY, {"workId": work_id})
    work = data.get("work")
    if not work:
        raise KakuyomuError("作品不存在或已被删除")
    author = work.get("author") or {}
    episodes = []
    seen = set()
    for chap in work.get("tableOfContents") or []:
        for e in chap.get("episodeUnions") or []:
            if e.get("__typename") != "Episode" or e["id"] in seen:
                continue
            seen.add(e["id"])
            episodes.append({"ep": e["id"], "title": e.get("title") or ""})
    if not episodes:
        raise KakuyomuError("未找到任何章节")
    return {
        "title": work.get("title") or work_id,
        "author": author.get("activityName") or author.get("name") or "",
        "synopsis": (work.get("introduction") or "").strip(),
        "episodes": episodes,
    }


def _parse_body(body_el) -> str:
    """.widget-episodeBody → 纯文本：<p> 一段一行，空 <p class="blank"><br/></p> 为空行；
    去掉注音 ruby。"""
    for tag in body_el.find_all(["rt", "rp"]):
        tag.decompose()
    paras = [p.get_text(strip=True) for p in body_el.find_all("p")]
    return "\n".join(paras).strip()


async def fetch_chapter(work_id: str, ep: str) -> tuple[str, str]:
    """抓取单话，返回 (标题, 正文纯文本)。"""
    html = await _gate.get(f"https://kakuyomu.jp/works/{work_id}/episodes/{ep}")
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one("p.widget-episodeTitle")
    title = el.get_text(strip=True) if el else ""
    body_el = soup.select_one(".widget-episodeBody")
    if body_el is None:
        raise KakuyomuError("章节正文解析失败（作品可能已删除或转为非公开）")
    body = _parse_body(body_el)
    if not body:
        raise KakuyomuError("章节正文为空")
    return title, body


# ---------------- 排行榜（发现页） ----------------

# 排行周期（URL 第三段）
RANK_PERIODS = {
    "daily": "日排行",
    "weekly": "周排行",
    "monthly": "月排行",
    "yearly": "年排行",
    "entire": "总排行",
}

# 篇幅筛选（work_variation 查询参数）
RANK_VARIATIONS = {
    "all": "全部",
    "long": "长篇",
    "short": "短篇",
}

# 类型筛选（URL 第二段，snake_case；显示名复用 GENRES 中文名）
RANK_GENRES = {"all": "全部"}
RANK_GENRES.update({k.lower(): v for k, v in GENRES.items()})

_STATUS_ZH = {"COMPLETED": "已完结", "RUNNING": "连载中"}


async def rankings(genre: str = "all", period: str = "weekly",
                   variation: str = "all") -> list[dict]:
    """抓取排行榜，返回
    [{rank, work_id, url, title, author, synopsis, status, episodes, genre, points, chars}]。

    页面是 Next.js 渲染，数据内嵌在 __NEXT_DATA__ 的 __APOLLO_STATE__ 里：
    ROOT_QUERY 的 rankedWorks(...) 键给出有序的 Work 引用，实体按 id 归一化存储。
    """
    if genre not in RANK_GENRES or period not in RANK_PERIODS \
            or variation not in RANK_VARIATIONS:
        raise KakuyomuError("无效的排行榜筛选参数")
    html = await _gate.get(
        f"https://kakuyomu.jp/rankings/{genre}/{period}?work_variation={variation}")
    soup = BeautifulSoup(html, "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        raise KakuyomuError("排行榜页面解析失败（未找到内嵌数据）")
    try:
        state = json.loads(script.string)["props"]["pageProps"]["__APOLLO_STATE__"]
        root = state["ROOT_QUERY"]
        key = next(k for k in root if k.startswith("rankedWorks("))
        nodes = root[key]["nodes"]
    except Exception:
        raise KakuyomuError("排行榜页面解析失败（数据结构变化）")
    out = []
    for node in nodes:
        work = state.get(node.get("__ref", ""))
        if not work or work.get("__typename") != "Work":
            continue
        author = state.get((work.get("author") or {}).get("__ref", "")) or {}
        out.append({
            "rank": len(out) + 1,
            "work_id": work["id"],
            "url": f"https://kakuyomu.jp/works/{work['id']}",
            "title": work.get("title") or "",
            "author": author.get("activityName") or author.get("name") or "",
            "synopsis": (work.get("introduction") or "").strip(),
            "status": _STATUS_ZH.get(work.get("serialStatus") or "", ""),
            "episodes": work.get("publicEpisodeCount") or 0,
            "genre": GENRES.get(work.get("genre") or "", ""),
            "points": work.get("totalReviewPoint") or 0,
            "chars": work.get("totalCharacterCount") or 0,
        })
    return out


# ---------------- 抓取任务 ----------------

_runner = CrawlRunner(
    source_key="work_id",
    fetch_info=fetch_info,
    fetch_chapter=lambda work_id, ep, _info: fetch_chapter(work_id, ep),
)

is_crawling = _runner.is_crawling
progress = _runner.progress
stop_crawl = _runner.stop_crawl
start_crawl = _runner.start_crawl
start_update = _runner.start_update
