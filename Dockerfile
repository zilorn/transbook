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
# 自动更新需要在容器内重新构建前端
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# 记录构建时的 commit/仓库，供自动更新与远端对比（容器内无 .git）；
# 未传参时留空，自动更新会以"未知版本"收敛到远端最新
ARG GIT_COMMIT=""
ARG GIT_REPO=""
RUN printf '{"commit": "%s", "repo": "%s"}\n' "$GIT_COMMIT" "$GIT_REPO" > /app/build-info.json

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
