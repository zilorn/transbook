"""kakuyomu.jp（カクヨム）爬虫：搜索、目录/正文抓取、增量更新。

风控约定：所有请求经 _get/_gql 单一出口，模块级锁保证串行，相邻请求间隔
>=1s 并加随机抖动；403/429/5xx 按 5s/15s/30s 退避重试，最多 3 次。
抓取任务逐章落盘，中断后已抓部分保留。

搜索与目录走官方前端同用的 GraphQL 接口（/graphql）；章节正文从 HTML 页解析。
"""
from __future__ import annotations

import asyncio
import random
import re
import time

import httpx
from bs4 import BeautifulSoup

from . import store

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
BACKOFFS = [5, 15, 30]
MIN_INTERVAL = 1.0
JITTER = 0.5
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


_client: httpx.AsyncClient | None = None
_rate_lock = asyncio.Lock()
_last_req = 0.0


async def _throttle() -> None:
    """串行 + 限速：同一时刻只有一个请求，相邻请求间隔 >=1s 加抖动。"""
    global _last_req
    async with _rate_lock:
        wait = MIN_INTERVAL + random.uniform(0, JITTER) - (time.monotonic() - _last_req)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_req = time.monotonic()


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    return _client


async def _request(method: str, url: str, **kwargs) -> httpx.Response:
    for attempt in range(len(BACKOFFS) + 1):
        await _throttle()
        try:
            resp = await _get_client().request(method, url, **kwargs)
        except httpx.HTTPError as e:
            if attempt < len(BACKOFFS):
                await asyncio.sleep(BACKOFFS[attempt])
                continue
            raise KakuyomuError(f"请求失败: {e}")
        if resp.status_code == 200:
            return resp
        if resp.status_code in (403, 429) or resp.status_code >= 500:
            if attempt < len(BACKOFFS):
                await asyncio.sleep(BACKOFFS[attempt])
                continue
            raise KakuyomuError(f"站点返回 {resp.status_code}，可能触发风控，请稍后再试")
        raise KakuyomuError(f"站点返回 {resp.status_code}")
    raise KakuyomuError("请求失败")


async def _get(url: str) -> str:
    return (await _request("GET", url)).text


async def _gql(query: str, variables: dict) -> dict:
    resp = await _request("POST", GQL_URL, json={
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
    html = await _get(f"https://kakuyomu.jp/works/{work_id}/episodes/{ep}")
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

_tasks: dict[str, asyncio.Task] = {}
_progress: dict[str, dict] = {}
_stops: dict[str, asyncio.Event] = {}


def is_crawling(book_id: str) -> bool:
    t = _tasks.get(book_id)
    return bool(t and not t.done())


def progress(book_id: str) -> dict:
    p = _progress.get(book_id)
    if p:
        return p
    return {"running": False, "total": 0, "done": 0, "added": 0,
            "current": "", "error": None}


def stop_crawl(book_id: str) -> None:
    ev = _stops.get(book_id)
    if ev:
        ev.set()


def _new_progress() -> dict:
    return {"running": True, "total": 0, "done": 0, "added": 0,
            "current": "", "error": None}


def start_crawl(book_id: str) -> bool:
    """整书抓取（须在 async 上下文中调用）。已在跑返回 False。"""
    if is_crawling(book_id):
        return False
    stop = asyncio.Event()
    _stops[book_id] = stop
    _progress[book_id] = _new_progress()
    _tasks[book_id] = asyncio.create_task(_crawl(book_id, stop))
    return True


def start_update(book_id: str) -> bool:
    """增量更新：只抓本地缺失的话数。已在跑返回 False。"""
    if is_crawling(book_id):
        return False
    stop = asyncio.Event()
    _stops[book_id] = stop
    _progress[book_id] = _new_progress()
    _tasks[book_id] = asyncio.create_task(_update(book_id, stop))
    return True


def _next_cid(chapters: list[dict]) -> int:
    nums = [int(c["id"][2:]) for c in chapters
            if re.fullmatch(r"ch\d+", c.get("id", ""))]
    return (max(nums) if nums else 0) + 1


async def _fetch_episodes(book_id: str, work_id: str, episodes: list[dict],
                          stop: asyncio.Event, prog: dict) -> int:
    """抓取 episodes 并逐章落盘，返回新增章节数。"""
    added = 0
    for e in episodes:
        if stop.is_set():
            break
        book = store.load_book(book_id)
        if not book:  # 书已被删除
            return added
        prog["current"] = e["title"]
        title, body = await fetch_chapter(work_id, e["ep"])
        n = _next_cid(book["chapters"])
        cid = f"ch{n:04d}"
        store.chapter_src_path(book_id, cid).write_text(body, encoding="utf-8")
        book["chapters"].append({
            "id": cid, "title": title or e["title"], "title_translated": None,
            "status": "pending", "error": None, "format": "txt",
            "src_ep": e["ep"],
        })
        store.save_book(book)
        prog["done"] += 1
        added += 1
    return added


async def _crawl(book_id: str, stop: asyncio.Event) -> None:
    prog = _progress[book_id]
    try:
        book = store.load_book(book_id)
        if not book:
            return
        work_id = book["source"]["work_id"]
        info = await fetch_info(work_id)
        book = store.load_book(book_id)
        if not book:
            return
        book["title"] = info["title"]
        book["author"] = info["author"]
        store.save_book(book)
        prog["total"] = len(info["episodes"])
        added = await _fetch_episodes(book_id, work_id, info["episodes"],
                                      stop, prog)
        prog["added"] = added
    except Exception as e:
        prog["error"] = str(e)
    finally:
        prog["running"] = False
        prog["current"] = ""


async def _update(book_id: str, stop: asyncio.Event) -> None:
    prog = _progress[book_id]
    try:
        book = store.load_book(book_id)
        if not book:
            return
        work_id = book["source"]["work_id"]
        info = await fetch_info(work_id)
        book = store.load_book(book_id)
        if not book:
            return
        # 书名/作者可能变动，顺手刷新
        book["title"] = info["title"]
        book["author"] = info["author"]
        store.save_book(book)
        existing = {c.get("src_ep") for c in book["chapters"]}
        missing = [e for e in info["episodes"] if e["ep"] not in existing]
        prog["total"] = len(missing)
        prog["added"] = await _fetch_episodes(book_id, work_id, missing,
                                              stop, prog)
    except Exception as e:
        prog["error"] = str(e)
    finally:
        prog["running"] = False
        prog["current"] = ""
