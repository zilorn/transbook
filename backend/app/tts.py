"""听书（edge-tts）：任意文本的语音合成与 mp3 落盘缓存。

前端自行分句并把每句文本直接发过来合成（前端渲染的句与合成的句天然一致，
逐句高亮不需要后端参与对齐）。缓存与书籍无关、跨书复用：
data/tts_cache/<sha1(voice+text)>.mp3，命中即直接返回。
"""
from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

import edge_tts

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

# 单次合成的文本上限（前端按句发送，一句不会很长；限制防滥用）
MAX_TEXT_CHARS = 1000

CACHE_DIR = store.BOOKS_DIR.parent / "tts_cache"


async def synthesize_text(text: str, voice: str) -> Path:
    """合成一段文本并落盘缓存；命中缓存直接返回路径。"""
    text = text.strip()
    if not text:
        raise ValueError("没有可朗读的文本")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"文本过长（>{MAX_TEXT_CHARS} 字）")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{voice}\n{text}".encode("utf-8")).hexdigest()
    cache = CACHE_DIR / f"{key}.mp3"
    if cache.exists():
        return cache
    tmp = cache.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with tmp.open("wb") as f:
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
        tmp.replace(cache)
    finally:
        tmp.unlink(missing_ok=True)
    return cache
