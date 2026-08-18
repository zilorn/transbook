# ---------- 前端构建 ----------
FROM oven/bun:1 AS frontend
WORKDIR /build
COPY package.json bun.lock ./
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile
COPY frontend/ frontend/
WORKDIR /build/frontend
RUN bun run build

# ---------- 后端运行 ----------
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv
WORKDIR /app

# Python 依赖（锁文件安装，进 /app/.venv）
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# 后端代码 + 前端产物（main.py 以 BASE_DIR.parent/frontend/dist 定位静态文件）
COPY backend/app backend/app
COPY --from=frontend /build/frontend/dist frontend/dist

# 运行数据统一落盘在 backend/data/，由 compose 挂载持久化
WORKDIR /app/backend
EXPOSE 8300
CMD ["/app/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8300"]
