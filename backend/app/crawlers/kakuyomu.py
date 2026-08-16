"""kakuyomu.jp（カクヨム）爬虫：搜索、目录/正文抓取、增量更新。

站点专属逻辑：搜索与目录走官方前端同用的 GraphQL 接口（/graphql），章节正文
从 HTML 页解析（<p> 一段一行，去 ruby 注音）。限速请求走 http.HttpGate，
抓取任务生命周期（进度/停止/逐章落盘）走 tasks.CrawlRunner。
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from .http import HttpGate
from .tasks import CrawlRunner

GQL_URL = "https://kakuyomu.jp/graphql"

# 可选搜索ジャンル（与 kakuyomu 搜索页一致，可多选）
GENRES = {
    "FANTASY": "異世界ファンタジー",
    "ACTION": "現代ファンタジー",
    "SF": "SF",
    "LOVE_STORY": "恋愛",
    "ROMANCE": "ラブコメ",
    "DRAMA": "現代ドラマ",
    "HORROR": "ホラー",
    "MYSTERY": "ミステリー",
    "NONFICTION": "エッセイ・ノンフィクション",
    "HISTORY": "歴史・時代・伝奇",
    "CRITICISM": "創作論・評論",
    "OTHERS": "詩・童話・その他",
    "MAHO": "魔法のiらんど",
    "FAN_FICTION": "二次創作",
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
            "status": {"COMPLETED": "完結", "RUNNING": "連載中"}.get(
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
