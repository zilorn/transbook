# ---------- 前端构建 ----------
FROM oven/bun:1 AS frontend
WORKDIR /build
COPY package.json bun.lock ./
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile
COPY frontend/ frontend/
WORKDIR /build/frontend
RUN bun run build

# ---------- 构建信息（commit/仓库，供自动更新对比，独立于运行镜像） ----------
FROM python:3.12-slim AS gitmeta
WORKDIR /tmp/m
# .git* 同时匹配 .gitignore，保证无 .git 的构建上下文（如 tarball）也能构建；
# 注意 COPY 目录只复制其内容，.git 的内容会直接落在 WORKDIR（HEAD/config/refs/...）
COPY .git* ./
RUN out='{"commit": "", "repo": ""}'; \
    if [ -f HEAD ]; then \
      head=$(cat HEAD); \
      case "$head" in \
        ref:*) ref=${head#ref: }; \
               sha=$(cat "$ref" 2>/dev/null \
                     || grep " $ref\$" packed-refs 2>/dev/null | cut -d' ' -f1) ;; \
        *) sha=$head ;; \
      esac; \
      repo=$(sed -n '/\[remote "origin"\]/,/^\[/ s/^[[:space:]]*url = //p' config | head -1); \
      out=$(printf '{"commit": "%s", "repo": "%s"}' "${sha:-}" "$repo"); \
    fi; \
    echo "$out" > /tmp/build-info.json

# ---------- 后端运行 ----------
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv
# 自动更新需要在容器内重新构建前端
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# 构建时从 .git 提取的 commit/仓库（容器内无 git）
COPY --from=gitmeta /tmp/build-info.json /app/build-info.json

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
