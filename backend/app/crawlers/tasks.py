"""爬虫共享的抓取任务管理。

CrawlRunner 负责一本书的抓取任务生命周期：整书抓取 / 增量更新 / 进度 /
协作式停止；抓取逐章落盘，中断不丢已抓部分；增量更新按 src_ep diff
只抓缺失话数。站点差异通过构造时注入的回调消化：

- source_key：book["source"] 中存放站点作品 ID 的键（ncode / work_id）
- fetch_info(source_id) -> {title, author, episodes: [{ep, title}], ...}
- fetch_chapter(source_id, ep, info) -> (标题, 正文)
"""
from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any

from .. import store


def next_cid(chapters: list[dict]) -> int:
    nums = [int(c["id"][2:]) for c in chapters
            if re.fullmatch(r"ch\d+", c.get("id", ""))]
    return (max(nums) if nums else 0) + 1


def _new_progress() -> dict:
    return {"running": True, "total": 0, "done": 0, "added": 0,
            "current": "", "error": None}


class CrawlRunner:
    def __init__(self, *, source_key: str,
                 fetch_info: Callable[[str], Awaitable[dict]],
                 fetch_chapter: Callable[[str, Any, dict], Awaitable[tuple[str, str]]]):
        self._source_key = source_key
        self._fetch_info = fetch_info
        self._fetch_chapter = fetch_chapter
        self._tasks: dict[str, asyncio.Task] = {}
        self._progress: dict[str, dict] = {}
        self._stops: dict[str, asyncio.Event] = {}

    def is_crawling(self, book_id: str) -> bool:
        t = self._tasks.get(book_id)
        return bool(t and not t.done())

    def progress(self, book_id: str) -> dict:
        p = self._progress.get(book_id)
        if p:
            return p
        return {"running": False, "total": 0, "done": 0, "added": 0,
                "current": "", "error": None}

    def stop_crawl(self, book_id: str) -> None:
        ev = self._stops.get(book_id)
        if ev:
            ev.set()

    def start_crawl(self, book_id: str) -> bool:
        """整书抓取（须在 async 上下文中调用）。已在跑返回 False。"""
        return self._start(book_id, self._crawl)

    def start_update(self, book_id: str) -> bool:
        """增量更新：只抓本地缺失的话数。已在跑返回 False。"""
        return self._start(book_id, self._update)

    def _start(self, book_id: str, target) -> bool:
        if self.is_crawling(book_id):
            return False
        stop = asyncio.Event()
        self._stops[book_id] = stop
        self._progress[book_id] = _new_progress()
        self._tasks[book_id] = asyncio.create_task(target(book_id, stop))
        return True

    async def _fetch_episodes(self, book_id: str, source_id: str,
                              episodes: list[dict], info: dict,
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
            title, body = await self._fetch_chapter(source_id, e["ep"], info)
            n = next_cid(book["chapters"])
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

    async def _crawl(self, book_id: str, stop: asyncio.Event) -> None:
        prog = self._progress[book_id]
        try:
            book = store.load_book(book_id)
            if not book:
                return
            source_id = book["source"][self._source_key]
            info = await self._fetch_info(source_id)
            book = store.load_book(book_id)
            if not book:
                return
            book["title"] = info["title"]
            book["author"] = info["author"]
            store.save_book(book)
            prog["total"] = len(info["episodes"])
            added = await self._fetch_episodes(
                book_id, source_id, info["episodes"], info, stop, prog)
            prog["added"] = added
        except Exception as e:
            prog["error"] = str(e)
        finally:
            prog["running"] = False
            prog["current"] = ""

    async def _update(self, book_id: str, stop: asyncio.Event) -> None:
        prog = self._progress[book_id]
        try:
            book = store.load_book(book_id)
            if not book:
                return
            source_id = book["source"][self._source_key]
            info = await self._fetch_info(source_id)
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
            prog["added"] = await self._fetch_episodes(
                book_id, source_id, missing, info, stop, prog)
        except Exception as e:
            prog["error"] = str(e)
        finally:
            prog["running"] = False
            prog["current"] = ""
