"""DeepSeek API 客户端（OpenAI 兼容接口）。"""
from __future__ import annotations

import asyncio
import json

import httpx


class DeepSeekError(Exception):
    pass


async def chat(client: httpx.AsyncClient, cfg: dict, messages: list[dict],
               json_mode: bool = False, retries: int = 2,
               key: dict | None = None) -> str:
    """key: 可选的 KeyPool 条目 {key, model, concurrency}；缺省回落到全局单 key 配置。"""
    entry = key or {}
    api_key = entry.get("key") or cfg.get("api_key")
    if not api_key:
        raise DeepSeekError("未配置 API Key，请先在设置中添加")
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": entry.get("model") or cfg.get("model") or "deepseek-chat",
        "messages": messages,
        "temperature": 0.3,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {api_key}"}

    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                raise DeepSeekError(f"API 返回 {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        except (httpx.HTTPError, DeepSeekError, KeyError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                await asyncio.sleep(2 * (attempt + 1))
    raise DeepSeekError(str(last_err))
