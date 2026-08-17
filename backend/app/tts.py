"""听书（edge-tts）：章节文本抽取、逐句语音合成与 mp3 落盘缓存。

按句合成（一句一个 mp3），前端逐句连播并据此高亮当前朗读句——整章一条 mp3 无法对齐朗读位置。
缓存位置：books/<id>/tts/<cid>.<src|dst>.<voice>.<idx>.mp3，章节文件更新后缓存自动失效。
"""
from __future__ import annotations

import re
from pathlib import Path

import edge_tts
from bs4 import BeautifulSoup

from . import store

# 常用音色（id → 中文显示名），/api/tts/voices 原样返回，前端不做映射
VOICES = {
    "zh-CN-XiaoxiaoNeural": "晓晓（女声）",
    "zh-CN-XiaoyiNeural": "晓伊（女声）",
    "zh-CN-YunjianNeural": "云健（男声）",
    "zh-CN-YunxiNeural": "云希（男声）",
    "zh-CN-YunxiaNeural": "云夏（童声）",
    "zh-TW-HsiaoChenNeural": "晓臻（台湾女声）",
    "zh-HK-HiuMaanNeural": "晓曼（香港女声）",
    "ja-JP-NanamiNeural": "Nanami（日语女声）",
    "ja-JP-KeitaNeural": "Keita（日语男声）",
    "en-US-AriaNeural": "Aria（英语女声）",
    "en-US-GuyNeural": "Guy（英语男声）",
}
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


def _text_path(book_id: str, chapter_id: str, translated: bool) -> Path:
    return store.chapter_dst_path(book_id, chapter_id) if translated \
        else store.chapter_src_path(book_id, chapter_id)


def chapter_text(book_id: str, chapter: dict, translated: bool) -> str:
    """抽取章节朗读文本：txt 原样；epub 提取纯文本（按行折叠空行，图片无文本自然跳过）。

    epub 的提取口径与阅读器渲染严格一致（去首个 h1-h3、跳过 style/script/title），
    保证分句序号能与前端按文本节点拆出的句级 span 一一对应（逐句高亮依赖此对齐）。
    """
    p = _text_path(book_id, chapter["id"], translated)
    if not p.exists():
        return ""
    raw = p.read_text(encoding="utf-8", errors="replace")
    if chapter.get("format") != "epub":
        return raw.strip()
    soup = BeautifulSoup(raw, "html.parser")
    root = soup.body or soup
    for tag in root.find_all(["style", "script", "title"]):
        tag.decompose()
    first_h = root.find(re.compile(r"^h[1-3]$"))
    if first_h:
        first_h.decompose()  # 阅读器渲染时也去掉了它（与标题栏重复）
    lines = [ln.strip() for ln in root.get_text("\n").splitlines()]
    return "\n".join(ln for ln in lines if ln)


# 分句规则：正文按句读标点/换行切分，与前端 ReaderPage 的 SEG_RE 保持一致（两边规则必须同步）。
# 每个匹配要么是一句（含结尾标点），要么是连续换行（仅排版，不朗读）。
SEG_RE = re.compile(r"[^。！？!?…\n]+[。！？!?…]*|\n+")


def split_sentences(text: str) -> list[str]:
    """把朗读文本切成句子（保留结尾标点），跳过纯空白/换行段。"""
    return [m for m in SEG_RE.findall(text.strip()) if m.strip()]


def _cache_path(book_id: str, chapter_id: str, translated: bool, voice: str, idx: int) -> Path:
    d = store.BOOKS_DIR / book_id / "tts"
    d.mkdir(parents=True, exist_ok=True)
    which = "dst" if translated else "src"
    return d / f"{chapter_id}.{which}.{voice}.{idx}.mp3"


async def synthesize_sentence(book_id: str, chapter: dict, translated: bool,
                              voice: str, idx: int) -> Path:
    """合成第 idx 句并落盘缓存；命中有效缓存（不比章节文件旧）直接返回路径。"""
    sentences = split_sentences(chapter_text(book_id, chapter, translated))
    if not sentences:
        raise ValueError("章节没有可朗读的文本")
    if not 0 <= idx < len(sentences):
        raise ValueError("句序号越界")
    src = _text_path(book_id, chapter["id"], translated)
    cache = _cache_path(book_id, chapter["id"], translated, voice, idx)
    if cache.exists() and src.exists() and cache.stat().st_mtime >= src.stat().st_mtime:
        return cache
    tmp = cache.with_suffix(".tmp")
    try:
        with tmp.open("wb") as f:
            async for chunk in edge_tts.Communicate(sentences[idx], voice).stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
        tmp.replace(cache)
    finally:
        tmp.unlink(missing_ok=True)
    return cache
