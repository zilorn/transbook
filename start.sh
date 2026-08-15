#!/usr/bin/env bash
# 一键启动：后端 (FastAPI, 8300) + 前端 (Vite dev, 5173)
# Ctrl+C 同时关闭所有服务
set -u
cd "$(dirname "$0")"

BACKEND_PORT=${BACKEND_PORT:-8300}
FRONTEND_PORT=${FRONTEND_PORT:-5173}

cleanup() {
  echo ""
  echo "正在停止所有服务..."
  [ -n "${BACKEND_PID:-}" ] && kill -TERM -"$BACKEND_PID" 2>/dev/null
  [ -n "${FRONTEND_PID:-}" ] && kill -TERM -"$FRONTEND_PID" 2>/dev/null
  sleep 1
  exit 0
}
trap cleanup INT TERM

# 清理本项目的残留进程（上次异常退出等情况）
PROJECT_DIR="$(pwd)"
pkill -f "uvicorn app.main:app.*--port $BACKEND_PORT" 2>/dev/null
pkill -f "$PROJECT_DIR/frontend/node_modules/.bin/vite" 2>/dev/null
sleep 1

port_in_use() { fuser "$1/tcp" >/dev/null 2>&1; }

if port_in_use "$BACKEND_PORT"; then
  echo "错误：端口 $BACKEND_PORT 被其他程序占用，可执行 BACKEND_PORT=8301 ./start.sh 换端口"
  exit 1
fi
if port_in_use "$FRONTEND_PORT"; then
  echo "错误：端口 $FRONTEND_PORT 被其他程序占用，可执行 FRONTEND_PORT=5174 ./start.sh 换端口"
  exit 1
fi

setsid bash -c "cd backend && exec uv run uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT" &
BACKEND_PID=$!

setsid bash -c "cd frontend && exec bun run dev -- --port $FRONTEND_PORT" &
FRONTEND_PID=$!

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')
fi

echo "==================================="
echo "  后端 API:  http://localhost:$BACKEND_PORT"
echo "  前端页面:  http://localhost:$FRONTEND_PORT"
[ -n "$LAN_IP" ] && echo "  局域网访问: http://$LAN_IP:$BACKEND_PORT（WebDAV 书库: http://$LAN_IP:$BACKEND_PORT/webdav/）"
echo "  按 Ctrl+C 一键停止所有服务"
echo "==================================="

wait
