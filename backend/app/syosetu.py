"""syosetu.com（成为小说家吧）爬虫：搜索、目录/正文抓取、增量更新。

风控约定：所有请求经 _get 单一出口，模块级锁保证串行，相邻请求间隔
>=1s 并加随机抖动；403/429/5xx 按 5s/15s/30s 退避重试，最多 3 次。
抓取任务逐章落盘，中断后已抓部分保留。
"""
from __future__ import annotations

import asyncio
import random
import re
import time
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from . import store

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
BACKOFFS = [5, 15, 30]
MIN_INTERVAL = 1.0
JITTER = 0.5


class SyosetuError(Exception):
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


async def _get(url: str) -> str:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    for attempt in range(len(BACKOFFS) + 1):
        await _throttle()
        try:
            resp = await _client.get(url)
        except httpx.HTTPError as e:
            if attempt < len(BACKOFFS):
                await asyncio.sleep(BACKOFFS[attempt])
                continue
            raise SyosetuError(f"请求失败: {e}")
        if resp.status_code == 200:
            return resp.text
        if resp.status_code in (403, 429) or resp.status_code >= 500:
            if attempt < len(BACKOFFS):
                await asyncio.sleep(BACKOFFS[attempt])
                continue
            raise SyosetuError(f"站点返回 {resp.status_code}，可能触发风控，请稍后再试")
        raise SyosetuError(f"站点返回 {resp.status_code}")
    raise SyosetuError("请求失败")


# ---------------- 解析 ----------------

_NCODE_RE = re.compile(r"(?:ncode\.syosetu\.com/)?(n\d{4}[a-z]{2})", re.I)


def parse_ncode(s: str) -> str | None:
    """从详情页/章节页 URL 或纯 N コード（如 n0305hn）中提取小写 ncode。"""
    m = _NCODE_RE.search(s.strip())
    return m.group(1).lower() if m else None


async def search(query: str) -> list[dict]:
    """关键词搜索，返回 [{ncode, url, title, author, synopsis, status, episodes}]。"""
    html = await _get("https://yomou.syosetu.com/search.php?word=" + quote(query))
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for box in soup.select(".searchkekka_box"):
        a = box.select_one(".novel_h a.tl")
        if not a:
            continue
        ncode = parse_ncode(a.get("href", ""))
        if not ncode:
            continue
        author_a = box.find("a", href=re.compile(r"mypage\.syosetu\.com"))
        ex = box.select_one(".ex")
        left = box.select_one("td.left")
        left_text = left.get_text(" ", strip=True) if left else ""
        m = re.search(r"全(\d+)エピソード", left_text)
        out.append({
            "ncode": ncode,
            "url": f"https://ncode.syosetu.com/{ncode}/",
            "title": a.get_text(strip=True),
            "author": author_a.get_text(strip=True) if author_a else "",
            "synopsis": ex.get_text(" ", strip=True) if ex else "",
            "status": "完結" if "完結" in left_text else ("連載中" if "連載" in left_text else ""),
            "episodes": int(m.group(1)) if m else 0,
        })
    return out


def _parse_episodes(soup: BeautifulSoup, ncode: str) -> list[dict]:
    eps = []
    for a in soup.select("a.p-eplist__subtitle"):
        m = re.search(rf"/{re.escape(ncode)}/(\d+)/", a.get("href", ""))
        if m:
            eps.append({"ep": int(m.group(1)), "title": a.get_text(strip=True)})
    return eps


def _parse_body(body_el) -> str:
    """.p-novel__body → 纯文本：<p> 一段一行，空 <p><br/></p> 为空行；去掉注音 ruby。"""
    for tag in body_el.find_all(["rt", "rp"]):
        tag.decompose()
    paras = [p.get_text(strip=True) for p in body_el.find_all("p")]
    return "\n".join(paras).strip()


async def fetch_info(ncode: str) -> dict:
    """作品信息 + 完整目录（自动翻页）。短篇无目录，正文在详情页，short=True。"""
    base = f"https://ncode.syosetu.com/{ncode}/"
    html = await _get(base)
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one(".p-novel__title")
    title = el.get_text(strip=True) if el else ncode
    el = soup.select_one(".p-novel__author")
    author = el.get_text(strip=True).replace("作者：", "").strip() if el else ""
    el = soup.select_one("#novel_ex")
    synopsis = el.get_text("\n", strip=True) if el else ""

    episodes = _parse_episodes(soup, ncode)
    if not episodes:
        return {"title": title, "author": author, "synopsis": synopsis,
                "short": True, "episodes": [{"ep": 1, "title": title}]}

    seen = {e["ep"] for e in episodes}
    # 分页器只露出「次へ/最後」等少数页码，需以最大页码为界逐页抓全
    pages = [int(m.group(1)) for m in re.finditer(r"\?p=(\d+)", html)]
    for p in range(2, max(pages, default=1) + 1):
        sub = BeautifulSoup(await _get(f"{base}?p={p}"), "html.parser")
        for e in _parse_episodes(sub, ncode):
            if e["ep"] not in seen:
                seen.add(e["ep"])
                episodes.append(e)
    episodes.sort(key=lambda e: e["ep"])
    return {"title": title, "author": author, "synopsis": synopsis,
            "short": False, "episodes": episodes}


async def fetch_chapter(ncode: str, ep: int, short: bool = False) -> tuple[str, str]:
    """抓取单话，返回 (标题, 正文纯文本)。"""
    base = f"https://ncode.syosetu.com/{ncode}/"
    html = await _get(base if short else f"{base}{ep}/")
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.select_one("h1.p-novel__title")
    title = h1.get_text(strip=True) if h1 else f"第 {ep} 话"
    body_el = soup.select_one(".p-novel__body")
    if body_el is None:
        raise SyosetuError(f"第 {ep} 话正文解析失败")
    body = _parse_body(body_el)
    if not body:
        raise SyosetuError(f"第 {ep} 话正文为空")
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


async def _fetch_episodes(book_id: str, ncode: str, episodes: list[dict],
                          short: bool, stop: asyncio.Event, prog: dict) -> int:
    """抓取 episodes 并逐章落盘，返回新增章节数。"""
    added = 0
    for e in episodes:
        if stop.is_set():
            break
        book = store.load_book(book_id)
        if not book:  # 书已被删除
            return added
        prog["current"] = e["title"]
        title, body = await fetch_chapter(ncode, e["ep"], short=short)
        n = _next_cid(book["chapters"])
        cid = f"ch{n:04d}"
        store.chapter_src_path(book_id, cid).write_text(body, encoding="utf-8")
        book["chapters"].append({
            "id": cid, "title": title, "title_translated": None,
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
        ncode = book["source"]["ncode"]
        info = await fetch_info(ncode)
        book = store.load_book(book_id)
        if not book:
            return
        book["title"] = info["title"]
        book["author"] = info["author"]
        store.save_book(book)
        prog["total"] = len(info["episodes"])
        added = await _fetch_episodes(book_id, ncode, info["episodes"],
                                      info["short"], stop, prog)
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
        ncode = book["source"]["ncode"]
        info = await fetch_info(ncode)
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
        prog["added"] = await _fetch_episodes(book_id, ncode, missing,
                                              info["short"], stop, prog)
    except Exception as e:
        prog["error"] = str(e)
    finally:
        prog["running"] = False
        prog["current"] = ""
