"""爬虫共享的限速 HTTP 出口。

风控约定：同一站点内所有请求经 HttpGate 单一出口，实例级锁保证串行，
相邻请求间隔 >=1s 并加随机抖动；403/429/5xx 按 5s/15s/30s 退避重试，最多 3 次。
每个站点模块各持有一个实例，站点之间互不影响。
"""
from __future__ import annotations

import asyncio
import random
import time

import httpx

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
BACKOFFS = [5, 15, 30]
MIN_INTERVAL = 1.0
JITTER = 0.5


class HttpGate:
    """单站点的限速请求出口。error 为该站点的异常类型，请求失败时抛出。"""

    def __init__(self, error: type[Exception]):
        self._error = error
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()
        self._last_req = 0.0

    async def _throttle(self) -> None:
        """串行 + 限速：同一时刻只有一个请求，相邻请求间隔 >=1s 加抖动。"""
        async with self._lock:
            wait = MIN_INTERVAL + random.uniform(0, JITTER) \
                - (time.monotonic() - self._last_req)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_req = time.monotonic()

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
        return self._client

    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(len(BACKOFFS) + 1):
            await self._throttle()
            try:
                resp = await self._get_client().request(method, url, **kwargs)
            except httpx.HTTPError as e:
                if attempt < len(BACKOFFS):
                    await asyncio.sleep(BACKOFFS[attempt])
                    continue
                raise self._error(f"请求失败: {e}")
            if resp.status_code == 200:
                return resp
            if resp.status_code in (403, 429) or resp.status_code >= 500:
                if attempt < len(BACKOFFS):
                    await asyncio.sleep(BACKOFFS[attempt])
                    continue
                raise self._error(
                    f"站点返回 {resp.status_code}，可能触发风控，请稍后再试")
            raise self._error(f"站点返回 {resp.status_code}")
        raise self._error("请求失败")

    async def get(self, url: str) -> str:
        return (await self.request("GET", url)).text
