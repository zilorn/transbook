"""DeepSeek API 客户端（OpenAI 兼容接口）。"""
from __future__ import annotations

import asyncio
import json

import httpx


class DeepSeekError(Exception):
    pass


async def chat(client: httpx.AsyncClient, cfg: dict, messages: list[dict],
               json_mode: bool = False, retries: int = 2) -> str:
    if not cfg.get("api_key"):
        raise DeepSeekError("未配置 DeepSeek API Key，请先在设置中填写")
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": cfg.get("model") or "deepseek-v4-flash",
        "messages": messages,
        "temperature": 0.3,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {cfg['api_key']}"}

    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                raise DeepSeekError(f"DeepSeek API 返回 {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        except (httpx.HTTPError, DeepSeekError, KeyError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                await asyncio.sleep(2 * (attempt + 1))
    raise DeepSeekError(str(last_err))
