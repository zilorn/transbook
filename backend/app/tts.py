"""听书（edge-tts）：任意文本的语音合成与 mp3 落盘缓存。

前端自行分句并把每句文本直接发过来合成（前端渲染的句与合成的句天然一致，
逐句高亮不需要后端参与对齐）。缓存与书籍无关、跨书复用：
data/tts_cache/<sha1(voice+rate+text)>.mp3，命中即直接返回。
倍速在生成时通过 edge-tts 的 rate 参数实现（保调变速；前端 Web Audio 的
playbackRate 是重采样会变调，不用）。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import uuid
from pathlib import Path

import edge_tts

from . import store

log = logging.getLogger(__name__)

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


async def synthesize_text(text: str, voice: str, rate: float = 1.0) -> Path:
    """合成一段文本并落盘缓存；命中缓存直接返回路径。rate 为倍速（1.0=原速）。"""
    text = text.strip()
    if not text:
        raise ValueError("没有可朗读的文本")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"文本过长（>{MAX_TEXT_CHARS} 字）")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = _cache_key(text, voice, rate)
    cache = CACHE_DIR / f"{key}.mp3"
    if cache.exists():
        log.info("TTS 缓存命中（%s x%s）: %s", voice, rate, text[:20])
        return cache
    log.info("TTS 冷合成（%s x%s）: %s", voice, rate, text[:20])
    tmp = cache.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with tmp.open("wb") as f:
            async for chunk in edge_tts.Communicate(text, voice, rate=_edge_rate(rate)).stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
        tmp.replace(cache)
    finally:
        tmp.unlink(missing_ok=True)
    return cache


def _edge_rate(rate: float) -> str:
    """倍速转 edge-tts 的 rate 参数：1.25 → '+25%'，0.8 → '-20%'。"""
    return f"{round((rate - 1.0) * 100):+d}%"


def _cache_key(text: str, voice: str, rate: float) -> str:
    return hashlib.sha1(f"{voice}\n{rate:.2f}\n{text}".encode("utf-8")).hexdigest()


async def warm_cache(texts: list[str], voice: str, rate: float = 1.0, concurrency: int = 12) -> tuple[int, int]:
    """批量合成落盘缓存（听书预取）：返回 (成功数, 失败数)，已在缓存的跳过不计。

    逐句冷合成约 1.5s（edge-tts 建连开销），前端逐句预取受浏览器同源连接数限制
    跑不过播放；批量接口由后端高并发合成，前端播放时逐句请求全部毫秒级命中。
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # 去重 + 跳过已缓存
    todo: list[str] = []
    seen: set[str] = set()
    for t in texts:
        t = t.strip()
        if not t or len(t) > MAX_TEXT_CHARS:
            continue
        key = _cache_key(t, voice, rate)
        if key in seen or (CACHE_DIR / f"{key}.mp3").exists():
            continue
        seen.add(key)
        todo.append(t)
    sem = asyncio.Semaphore(concurrency)
    done = failed = 0
    skipped = len(texts) - len(todo)  # 已缓存/重复/空的句数

    async def one(text: str) -> None:
        nonlocal done, failed
        async with sem:
            try:
                await synthesize_text(text, voice, rate)
                done += 1
            except Exception:
                failed += 1  # 失败句不阻塞整批，播到时前端会逐句重试

    await asyncio.gather(*(one(t) for t in todo))
    log.info("TTS 批量预热（%s x%s）: 新合成 %d，缓存命中跳过 %d，失败 %d",
             voice, rate, done, skipped, failed)
    return done, failed
