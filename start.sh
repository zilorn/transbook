#!/usr/bin/env bash
# 一键启动：构建前端，再由后端 (FastAPI, 8300) 托管 frontend/dist
# Ctrl+C 停止服务
set -u
cd "$(dirname "$0")"

BACKEND_PORT=${BACKEND_PORT:-8300}
SKIP_BUILD=${SKIP_BUILD:-0}

cleanup() {
  echo ""
  echo "正在停止服务..."
  [ -n "${BACKEND_PID:-}" ] && kill -TERM -"$BACKEND_PID" 2>/dev/null
  sleep 1
  exit 0
}
trap cleanup INT TERM

# 构建前端（可用 SKIP_BUILD=1 跳过，直接使用已有 dist）
if [ "$SKIP_BUILD" != "1" ]; then
  echo "正在构建前端..."
  (cd frontend && bun run build) || { echo "错误：前端构建失败"; exit 1; }
elif [ ! -d frontend/dist ]; then
  echo "错误：frontend/dist 不存在且 SKIP_BUILD=1，请先构建"
  exit 1
fi

# 清理本项目的残留进程（上次异常退出等情况）
pkill -f "uvicorn app.main:app.*--port $BACKEND_PORT" 2>/dev/null
sleep 1

port_in_use() { fuser "$1/tcp" >/dev/null 2>&1; }

if port_in_use "$BACKEND_PORT"; then
  echo "错误：端口 $BACKEND_PORT 被其他程序占用，可执行 BACKEND_PORT=8301 ./start.sh 换端口"
  exit 1
fi

setsid bash -c "cd backend && exec uv run uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT" &
BACKEND_PID=$!

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')
fi

echo "==================================="
echo "  访问地址:  http://localhost:$BACKEND_PORT"
[ -n "$LAN_IP" ] && echo "  局域网访问: http://$LAN_IP:$BACKEND_PORT（WebDAV 书库: http://$LAN_IP:$BACKEND_PORT/webdav/）"
echo "  按 Ctrl+C 停止服务"
echo "==================================="

wait
