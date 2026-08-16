"""翻译流水线：术语表生成、按章并发翻译、章节内分段。"""
from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager

import httpx

from . import parsing, store
from .deepseek import DeepSeekError, chat

# book_id -> asyncio.Task
_tasks: dict[str, asyncio.Task] = {}
_stop_flags: dict[str, asyncio.Event] = {}

MARK_RE = re.compile(r"【\s*(\d+)\s*】")


# ---------------- 多 API Key 并发池 ----------------

def effective_keys(cfg: dict) -> list[dict]:
    """解析出实际生效的 key 列表：model/concurrency 为空时跟随统一配置；
    没有 api_keys 时回落到旧的单 api_key 配置。"""
    keys = []
    for k in cfg.get("api_keys") or []:
        if k.get("key"):
            keys.append({
                "key": k["key"],
                "model": k.get("model") or cfg.get("model") or "deepseek-chat",
                "concurrency": max(1, int(k.get("concurrency") or cfg.get("concurrency") or 5)),
            })
    if not keys and cfg.get("api_key"):
        keys.append({"key": cfg["api_key"],
                     "model": cfg.get("model") or "deepseek-chat",
                     "concurrency": max(1, int(cfg.get("concurrency") or 5))})
    return keys


class KeyPool:
    """多 API Key 并发池：每个 key 按自身并发数放入对应数量的槽位，
    取用即占用、归还即释放，天然按 key 分摊请求。"""

    def __init__(self, cfg: dict):
        self._q: asyncio.Queue = asyncio.Queue()
        for e in effective_keys(cfg):
            for _ in range(e["concurrency"]):
                self._q.put_nowait(e)
        if self._q.empty():
            raise DeepSeekError("未配置 API Key，请先在设置中添加")

    @asynccontextmanager
    async def slot(self):
        entry = await self._q.get()
        try:
            yield entry
        finally:
            self._q.put_nowait(entry)


# ---------------- 提示词 ----------------

def _glossary_messages(sample: str, target_lang: str,
                       existing: list[dict] | None = None) -> list[dict]:
    existing_note = ""
    existing_lines = ""
    if existing:
        lines = [f"{g['src']} = {g['dst']}" for g in existing if g.get("src") and g.get("dst")]
        if lines:
            existing_note = ("以下术语已经存在于术语表中，不要重复抽取它们（包括同一实体的不同写法）：\n")
            existing_lines = "\n".join(lines[:400]) + "\n\n"
    return [
        {"role": "system", "content":
         "你是文学翻译助手。从给定的小说原文中抽取需要统一译法的专有名词：人名、地名、组织名、术语/专有词汇。"
         "只抽取确实需要统一翻译的实体，不要普通词汇。" + existing_note +
         "严格输出 JSON：{\"terms\": [{\"src\": 原文, \"dst\": 译名, \"type\": \"人名|地名|组织|术语\"}]}。"
         "不要输出任何其他内容。"},
        {"role": "user", "content": f"目标语言：{target_lang}\n\n{existing_lines}原文样本：\n{sample}"},
    ]


def _merge_glossary(existing: list[dict], new_terms: list[dict]) -> list[dict]:
    """合并新生成的术语：按规范化 src 去重，已有术语（可能经用户编辑）优先保留。"""
    def norm(s: str) -> str:
        return re.sub(r"\s+", "", s).lower()

    merged = [t for t in existing if isinstance(t, dict) and t.get("src")]
    seen = {norm(t["src"]) for t in merged}
    for t in new_terms:
        key = norm(str(t.get("src", "")).strip())
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(t)
    return merged


def _translate_messages(text: str, glossary: list[dict], target_lang: str,
                        kind: str = "正文") -> list[dict]:
    gloss = ""
    if glossary:
        lines = [f"{g['src']} = {g['dst']}" for g in glossary if g.get("src") and g.get("dst")]
        if lines:
            gloss = "术语表（必须严格遵守）：\n" + "\n".join(lines[:400]) + "\n\n"
    return [
        {"role": "system", "content":
         f"你是专业的文学翻译家，请将以下内容翻译为{target_lang}。"
         "要求：忠实原文、语言流畅自然、保留原文的段落编号标记【N】且数量与位置一一对应、"
         "不要增删内容、不要输出解释或评论。只输出带编号标记的译文。"},
        {"role": "user", "content": f"{gloss}请翻译以下{kind}：\n\n{text}"},
    ]


def _title_messages(titles: list[str], glossary: list[dict], target_lang: str) -> list[dict]:
    joined = "\n".join(f"【{i + 1}】{t}" for i, t in enumerate(titles))
    msgs = _translate_messages(joined, glossary, target_lang, kind="标题")
    msgs[0]["content"] += " 标题应简洁，不要翻译编号标记本身。但格式要一一对应。"
    return msgs


# ---------------- 编号分段 ----------------

def _group_segments(units: list[str], max_chars: int) -> list[list[int]]:
    """把单元索引按字符数分组，返回 [[idx...], ...]"""
    segments: list[list[int]] = []
    cur: list[int] = []
    cur_len = 0
    for i, u in enumerate(units):
        if cur and cur_len + len(u) > max_chars:
            segments.append(cur)
            cur, cur_len = [], 0
        cur.append(i)
        cur_len += len(u) + 8  # 加上编号标记开销
    if cur:
        segments.append(cur)
    return segments


def _format_segment(idxs: list[int], units: list[str]) -> str:
    return "\n".join(f"【{n + 1}】{units[i]}" for n, i in enumerate(idxs))


def _parse_segment(text: str, count: int) -> list[str | None]:
    """解析带【N】标记的译文，返回长度 count 的列表，缺失为 None。"""
    matches = list(MARK_RE.finditer(text))
    out: list[str | None] = [None] * count
    for n, m in enumerate(matches):
        num = int(m.group(1))
        if not (1 <= num <= count):
            continue
        end = matches[n + 1].start() if n + 1 < len(matches) else len(text)
        out[num - 1] = text[m.end():end].strip()
    return out


# ---------------- 术语表 ----------------

def _sample_text(book: dict, book_id: str, limit: int = 12000) -> str:
    """每章抽取开头一段作为术语表样本：预算（limit 字符）均分到各章，
    单章 500~3000 字符；章节太多、预算不够分时按均匀间隔选章。"""
    chapters = [ch for ch in book.get("chapters", [])
                if store.chapter_src_path(book_id, ch["id"]).exists()]
    if not chapters:
        return ""
    per = limit // len(chapters)
    if per < 500:
        count = max(1, limit // 500)
        step = len(chapters) / count
        chapters = [chapters[int(i * step)] for i in range(count)]
        per = limit // len(chapters)
    per = min(per, 3000)
    parts: list[str] = []
    for ch in chapters:
        p = store.chapter_src_path(book_id, ch["id"])
        raw = p.read_text(encoding="utf-8", errors="replace")
        if (ch.get("format") or book.get("format")) == "epub":
            _, units, _ = parsing.extract_units(raw)
            raw = "\n".join(t for _, t in units)
        if raw.strip():
            parts.append(raw[:per])
    return "\n\n".join(parts)[:limit]


async def generate_glossary(book_id: str) -> dict:
    book = store.load_book(book_id)
    if not book:
        raise DeepSeekError("书籍不存在")
    cfg = store.load_config()
    sample = _sample_text(book, book_id)
    if not sample.strip():
        raise DeepSeekError("没有可用于抽取术语的文本")
    if len(sample.strip()) < 500:
        raise DeepSeekError(
            f"全书正文合计仅 {len(sample.strip())} 字符，无法抽取术语；"
            "请确认源文件正文完整（章节内容是否为占位文本）")

    book["status"] = "glossary"
    store.save_book(book)
    try:
        existing = book.get("glossary") or []
        pool = KeyPool(cfg)
        async with httpx.AsyncClient(timeout=180) as client:
            async with pool.slot() as k:
                raw = await chat(client, cfg,
                                 _glossary_messages(sample, cfg["target_lang"], existing),
                                 json_mode=True, key=k)
        data = json.loads(raw)
        terms = data.get("terms") or data.get("glossary") or []
        if isinstance(terms, dict):
            terms = [{"src": k, "dst": v, "type": "术语"} for k, v in terms.items()]
        terms = [t for t in terms if isinstance(t, dict) and t.get("src")]
        book["glossary"] = _merge_glossary(existing, terms)
        book["status"] = "ready"
        book["error"] = None
    except Exception as e:
        book["status"] = "error"
        book["error"] = f"生成术语表失败: {e}"
    store.save_book(book)
    return book


# ---------------- 翻译 ----------------

def is_running(book_id: str) -> bool:
    t = _tasks.get(book_id)
    return bool(t and not t.done())


def stop_translation(book_id: str) -> None:
    flag = _stop_flags.get(book_id)
    if flag:
        flag.set()


async def _translate_units(client, cfg, pool: KeyPool, stop, units: list[str],
                           glossary: list[dict], on_progress=None) -> list[str]:
    """把一组文本单元分段并发翻译，返回与 units 等长的译文列表。
    on_progress(done, total)：每完成一个分段回调一次（用于进度可视化）。"""
    result: list[str | None] = [None] * len(units)
    segments = _group_segments(units, cfg["max_segment_chars"])
    done_segs = 0
    if on_progress:
        on_progress(0, len(segments))

    async def do_segment(idxs: list[int]) -> None:
        nonlocal done_segs
        try:
            if stop.is_set():
                return
            prompt = _format_segment(idxs, units)
            async with pool.slot() as k:
                for attempt in range(2):
                    if stop.is_set():
                        return
                    raw = await chat(client, cfg,
                                     _translate_messages(prompt, glossary, cfg["target_lang"]),
                                     retries=1, key=k)
                    parsed = _parse_segment(raw, len(idxs))
                    missing = [n for n, v in enumerate(parsed) if v is None]
                    if not missing:
                        for n, v in enumerate(parsed):
                            result[idxs[n]] = v
                        return
                    # 有部分缺失：保留已解析的，重试缺失部分
                    for n, v in enumerate(parsed):
                        if v is not None:
                            result[idxs[n]] = v
                    if attempt == 0:
                        idxs = [idxs[n] for n in missing]
                        prompt = _format_segment(idxs, units)
                # 重试仍失败：保留原文
                for n, v in enumerate(parsed):
                    if v is None and result[idxs[n]] is None:
                        result[idxs[n]] = units[idxs[n]]
        finally:
            done_segs += 1
            if on_progress:
                on_progress(done_segs, len(segments))

    await asyncio.gather(*(do_segment(s) for s in segments))
    return [r if r is not None else u for r, u in zip(result, units)]


async def _translate_chapter(client, cfg, pool: KeyPool, stop, book: dict, ch: dict) -> None:
    book_id = book["id"]
    src = store.chapter_src_path(book_id, ch["id"]).read_text(encoding="utf-8", errors="replace")
    glossary = book.get("glossary") or []
    target_lang = cfg["target_lang"]

    # 先抽取正文单元，分段总数（正文段 + 1 个标题段）用于进度展示
    is_epub = (ch.get("format") or book["format"]) == "epub"
    soup = heading_el = None
    if is_epub:
        soup, units, heading_el = parsing.extract_units(src)
        texts = [t for _, t in units]
    else:
        units = None
        texts = [p.strip() for p in re.split(r"\n+", src) if p.strip()]
    body_segs = len(_group_segments(texts, cfg["max_segment_chars"])) if texts else 0
    ch["seg_total"] = body_segs + 1
    ch["seg_done"] = 0
    store.save_book(book)

    def on_seg_done(d: int, _t: int) -> None:
        ch["seg_done"] = d + 1  # +1 为标题段
        store.save_book(book)

    # 章节标题单独翻译
    if stop.is_set():
        return
    async with pool.slot() as k:
        raw_title = await chat(client, cfg, _title_messages([ch["title"]], glossary, target_lang), key=k)
    parsed = _parse_segment(raw_title, 1)
    ch["title_translated"] = (parsed[0] or raw_title).strip().strip("【1】").strip() or ch["title"]
    ch["seg_done"] = 1
    store.save_book(book)

    if is_epub:
        if texts and not stop.is_set():
            translated = await _translate_units(client, cfg, pool, stop, texts, glossary,
                                                on_progress=on_seg_done)
            for (el, _), t in zip(units, translated):
                parsing.set_el_text(el, t)
        if heading_el is not None:
            parsing.set_el_text(heading_el, ch["title_translated"])
        store.chapter_dst_path(book_id, ch["id"]).write_text(str(soup), encoding="utf-8")
    else:
        if texts and not stop.is_set():
            translated = await _translate_units(client, cfg, pool, stop, texts, glossary,
                                                on_progress=on_seg_done)
            body = "\n".join(translated)
        else:
            body = src
        store.chapter_dst_path(book_id, ch["id"]).write_text(body, encoding="utf-8")


async def translate_book(book_id: str, chapter_ids: list[str] | None = None,
                         overwrite: bool = False) -> None:
    book = store.load_book(book_id)
    if not book:
        return
    # 首次翻译（尚无译文且术语表为空）时，先生成术语表再翻译
    if not book.get("glossary") and not any(c.get("status") == "done"
                                            for c in book["chapters"]):
        try:
            await generate_glossary(book_id)
            book = store.load_book(book_id) or book
        except Exception:
            # 术语表生成失败不阻塞翻译，恢复状态后继续（无术语表）
            book["status"] = "ready"
            book["error"] = None
            store.save_book(book)
    cfg = store.load_config()
    stop = asyncio.Event()
    _stop_flags[book_id] = stop
    book["status"] = "translating"
    book["error"] = None
    store.save_book(book)

    targets = [c for c in book["chapters"]
               if (chapter_ids is None or c["id"] in chapter_ids)
               and (overwrite or c.get("status") != "done")]

    try:
        pool = KeyPool(cfg)
        async with httpx.AsyncClient(timeout=180) as client:
            # 书名翻译
            if book.get("title") and (overwrite or not book.get("title_translated")):
                try:
                    async with pool.slot() as k:
                        raw = await chat(client, cfg, _title_messages(
                            [book["title"]], book.get("glossary") or [], cfg["target_lang"]), key=k)
                    parsed = _parse_segment(raw, 1)
                    book["title_translated"] = (parsed[0] or raw).strip().strip("【1】").strip()
                    store.save_book(book)
                except Exception:
                    pass

            async def worker(ch: dict) -> None:
                if stop.is_set():
                    return
                ch["status"] = "translating"
                ch["error"] = None
                ch["seg_done"] = 0
                store.save_book(book)
                try:
                    await _translate_chapter(client, cfg, pool, stop, book, ch)
                    if stop.is_set():
                        ch["status"] = "pending"
                    else:
                        ch["status"] = "done"
                except Exception as e:
                    ch["status"] = "error"
                    ch["error"] = str(e)[:300]
                store.save_book(book)

            await asyncio.gather(*(worker(c) for c in targets))

        if stop.is_set():
            book["status"] = "paused"
        elif any(c.get("status") == "error" for c in book["chapters"]):
            book["status"] = "error"
        else:
            book["status"] = "done"
    except Exception as e:
        book["status"] = "error"
        book["error"] = str(e)[:500]
    finally:
        store.save_book(book)
        _tasks.pop(book_id, None)
        _stop_flags.pop(book_id, None)


def start_translation(book_id: str, chapter_ids: list[str] | None = None,
                      overwrite: bool = False) -> bool:
    if is_running(book_id):
        return False
    task = asyncio.create_task(translate_book(book_id, chapter_ids, overwrite))
    _tasks[book_id] = task
    return True


def start_glossary(book_id: str) -> bool:
    if is_running(book_id):
        return False
    _tasks[book_id] = asyncio.create_task(generate_glossary(book_id))
    return True


# ---------------- 重翻书名 / 目录 ----------------

async def _retranslate_book_title(book_id: str) -> None:
    """只重翻书名，不动章节。"""
    try:
        book = store.load_book(book_id)
        if not book or not book.get("title"):
            return
        cfg = store.load_config()
        pool = KeyPool(cfg)
        async with httpx.AsyncClient(timeout=180) as client:
            async with pool.slot() as k:
                raw = await chat(client, cfg, _title_messages(
                    [book["title"]], book.get("glossary") or [], cfg["target_lang"]), key=k)
        parsed = _parse_segment(raw, 1)
        book = store.load_book(book_id) or book
        book["title_translated"] = (parsed[0] or raw).strip() or book["title"]
        store.save_book(book)
    finally:
        _tasks.pop(book_id, None)


async def _retranslate_toc(book_id: str) -> None:
    """只重翻全部章节标题（目录）；epub 已有译文的章节同步更新译文里的标题元素。"""
    try:
        book = store.load_book(book_id)
        if not book or not book["chapters"]:
            return
        cfg = store.load_config()
        glossary = book.get("glossary") or []
        chapters = book["chapters"]
        titles = [c["title"] for c in chapters]
        pool = KeyPool(cfg)

        async with httpx.AsyncClient(timeout=180) as client:
            async def do_segment(idxs: list[int]) -> None:
                try:
                    async with pool.slot() as k:
                        raw = await chat(client, cfg, _title_messages(
                            [titles[i] for i in idxs], glossary, cfg["target_lang"]), key=k)
                    parsed = _parse_segment(raw, len(idxs))
                    for n, v in enumerate(parsed):
                        if v:
                            chapters[idxs[n]]["title_translated"] = v.strip() or titles[idxs[n]]
                except Exception:
                    pass  # 该分段失败保留原标题/旧译名

            await asyncio.gather(*(do_segment(s) for s in
                                   _group_segments(titles, cfg["max_segment_chars"])))

        # epub 章节：把新标题写回已译 HTML 的标题元素
        for ch in chapters:
            if not ch.get("title_translated"):
                continue
            if (ch.get("format") or book["format"]) != "epub":
                continue
            dst = store.chapter_dst_path(book_id, ch["id"])
            if not dst.exists():
                continue
            try:
                soup, _, heading_el = parsing.extract_units(
                    dst.read_text(encoding="utf-8", errors="replace"))
                if heading_el is not None:
                    parsing.set_el_text(heading_el, ch["title_translated"])
                    dst.write_text(str(soup), encoding="utf-8")
            except Exception:
                pass
        store.save_book(book)
    finally:
        _tasks.pop(book_id, None)


def start_title_retranslate(book_id: str, scope: str) -> bool:
    """scope: "book" 重翻书名；"toc" 重翻目录（全部章节标题）。"""
    if is_running(book_id):
        return False
    coro = _retranslate_book_title(book_id) if scope == "book" else _retranslate_toc(book_id)
    _tasks[book_id] = asyncio.create_task(coro)
    return True


# ---------------- 翻译队列 ----------------

_queue_task: asyncio.Task | None = None
_queue_stop: asyncio.Event | None = None
_queue_current: str | None = None


def queue_running() -> bool:
    return bool(_queue_task and not _queue_task.done())


def queue_current() -> str | None:
    return _queue_current


def start_queue() -> bool:
    """启动队列执行器：按顺序逐本翻译队列中的书。"""
    global _queue_task, _queue_stop
    if queue_running() or not store.load_queue():
        return False
    _queue_stop = asyncio.Event()
    _queue_task = asyncio.create_task(_run_queue(_queue_stop))
    return True


def stop_queue() -> None:
    """停止队列：中断当前书的翻译，未开始的书保留在队列中。"""
    if _queue_stop:
        _queue_stop.set()
    if _queue_current:
        stop_translation(_queue_current)


async def _run_queue(stop: asyncio.Event) -> None:
    global _queue_task, _queue_stop, _queue_current
    try:
        while not stop.is_set():
            entries = store.load_queue()
            if not entries:
                break
            entry = entries[0]
            book_id = entry["book_id"]
            if not store.load_book(book_id):
                store.dequeue_book(book_id)
                continue
            if is_running(book_id):
                # 该书已有任务在跑（如手动单章重译），等它结束再接管
                await asyncio.sleep(2)
                continue
            _queue_current = book_id
            _tasks[book_id] = asyncio.current_task()
            try:
                await translate_book(book_id, entry.get("chapter_ids"),
                                     bool(entry.get("overwrite")))
            finally:
                _queue_current = None
            if stop.is_set():
                break  # 被停止：当前书保留在队列，下次可继续
            store.dequeue_book(book_id)
    finally:
        _queue_task = None
        _queue_stop = None
