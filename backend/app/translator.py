"""翻译流水线：术语表生成、按章并发翻译、章节内分段。"""
from __future__ import annotations

import asyncio
import json
import re

import httpx

from . import parsing, store
from .deepseek import DeepSeekError, chat

# book_id -> asyncio.Task
_tasks: dict[str, asyncio.Task] = {}
_stop_flags: dict[str, asyncio.Event] = {}

MARK_RE = re.compile(r"【\s*(\d+)\s*】")


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
    msgs[0]["content"] += " 标题应简洁，不要翻译编号标记本身。"
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
    """从全书中均匀抽取样本用于生成术语表。"""
    chapters = book.get("chapters", [])
    if not chapters:
        return ""
    step = max(1, len(chapters) // 6)
    parts: list[str] = []
    total = 0
    for ch in chapters[::step]:
        p = store.chapter_src_path(book_id, ch["id"])
        if not p.exists():
            continue
        raw = p.read_text(encoding="utf-8", errors="replace")
        if book.get("format") == "epub":
            _, units, _ = parsing.extract_units(raw)
            raw = "\n".join(t for _, t in units)
        chunk = raw[:3000]
        parts.append(chunk)
        total += len(chunk)
        if total >= limit:
            break
    return "\n\n".join(parts)[:limit]


async def generate_glossary(book_id: str) -> dict:
    book = store.load_book(book_id)
    if not book:
        raise DeepSeekError("书籍不存在")
    cfg = store.load_config()
    sample = _sample_text(book, book_id)
    if not sample.strip():
        raise DeepSeekError("没有可用于抽取术语的文本")

    book["status"] = "glossary"
    store.save_book(book)
    try:
        existing = book.get("glossary") or []
        async with httpx.AsyncClient(timeout=180) as client:
            raw = await chat(client, cfg,
                             _glossary_messages(sample, cfg["target_lang"], existing),
                             json_mode=True)
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


async def _translate_units(client, cfg, semaphore, stop, units: list[str],
                           glossary: list[dict]) -> list[str]:
    """把一组文本单元分段并发翻译，返回与 units 等长的译文列表。"""
    result: list[str | None] = [None] * len(units)
    segments = _group_segments(units, cfg["max_segment_chars"])

    async def do_segment(idxs: list[int]) -> None:
        if stop.is_set():
            return
        prompt = _format_segment(idxs, units)
        async with semaphore:
            for attempt in range(2):
                if stop.is_set():
                    return
                raw = await chat(client, cfg,
                                 _translate_messages(prompt, glossary, cfg["target_lang"]),
                                 retries=1)
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

    await asyncio.gather(*(do_segment(s) for s in segments))
    return [r if r is not None else u for r, u in zip(result, units)]


async def _translate_chapter(client, cfg, semaphore, stop, book: dict, ch: dict) -> None:
    book_id = book["id"]
    src = store.chapter_src_path(book_id, ch["id"]).read_text(encoding="utf-8", errors="replace")
    glossary = book.get("glossary") or []
    target_lang = cfg["target_lang"]

    # 章节标题单独翻译
    if stop.is_set():
        return
    async with semaphore:
        raw_title = await chat(client, cfg, _title_messages([ch["title"]], glossary, target_lang))
    parsed = _parse_segment(raw_title, 1)
    ch["title_translated"] = (parsed[0] or raw_title).strip().strip("【1】").strip() or ch["title"]

    if (ch.get("format") or book["format"]) == "epub":
        soup, units, heading_el = parsing.extract_units(src)
        texts = [t for _, t in units]
        if texts and not stop.is_set():
            translated = await _translate_units(client, cfg, semaphore, stop, texts, glossary)
            for (el, _), t in zip(units, translated):
                parsing.set_el_text(el, t)
        if heading_el is not None:
            parsing.set_el_text(heading_el, ch["title_translated"])
        store.chapter_dst_path(book_id, ch["id"]).write_text(str(soup), encoding="utf-8")
    else:
        units = [p.strip() for p in re.split(r"\n+", src) if p.strip()]
        if units and not stop.is_set():
            translated = await _translate_units(client, cfg, semaphore, stop, units, glossary)
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
    semaphore = asyncio.Semaphore(cfg["concurrency"])
    book["status"] = "translating"
    book["error"] = None
    store.save_book(book)

    targets = [c for c in book["chapters"]
               if (chapter_ids is None or c["id"] in chapter_ids)
               and (overwrite or c.get("status") != "done")]

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            # 书名翻译
            if book.get("title") and (overwrite or not book.get("title_translated")):
                try:
                    async with semaphore:
                        raw = await chat(client, cfg, _title_messages(
                            [book["title"]], book.get("glossary") or [], cfg["target_lang"]))
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
                store.save_book(book)
                try:
                    await _translate_chapter(client, cfg, semaphore, stop, book, ch)
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
