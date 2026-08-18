# TransBook

通过 DeepSeek API 翻译整本书的 Web 应用：上传 epub/txt → 自动生成人名/地名/术语表（可查看编辑）→ 按章并发翻译（标题与正文分离、大章自动分段）→ 导出 epub/txt。翻译任务在本地后端执行，全部数据落盘持久化，不用数据库。

## 功能特性

- 支持 **epub / txt** 上传，txt 自动识别编码（utf-8 → gb18030 → utf-16 → latin-1）并按常见章节模式分章
- **术语表**：全书扫描自动生成人名/地名/术语对照表，翻译前可查看和编辑
- **并发翻译**：章节之间、章节内分段均可并发，支持随时停止、断点续翻、单章重译
- **epub 结构保留**：只替换叶子块级元素的文本，HTML 结构不变
- **追加章节**：已上传的书可以继续追加章节（支持混合 txt/epub 格式）
- **导出**：翻译完成后可导出 epub 或 txt

## 技术栈

- 前端：Bun + SolidJS + Vite（`frontend/`）
- 后端：FastAPI + uv 管理（`backend/app/`）
- LLM：DeepSeek OpenAI 兼容接口（httpx 异步调用）

## 快速开始

前置依赖：[uv](https://docs.astral.sh/uv/)、[Bun](https://bun.sh/)

```bash
uv sync          # 安装 Python 依赖（根目录执行）
bun install      # 安装 JS 依赖（根目录执行）
./start.sh       # 一键启动：构建前端后由后端托管，仅 8300 一个端口，Ctrl+C 停止
```

打开 http://localhost:8300 ，在「设置」页填入 DeepSeek API Key 即可开始使用。

端口被占用时可以换端口启动：

```bash
BACKEND_PORT=8301 ./start.sh
```

## Docker 部署

前置依赖：[Docker](https://docs.docker.com/get-docker/)（含 Compose 插件）。无需安装 uv / Bun，前端构建在镜像内完成。

```bash
docker compose up -d --build   # 构建镜像并后台启动
```

打开 http://localhost:8300 ，在「设置」页填入 DeepSeek API Key 即可开始使用。

- **数据持久化**：全部运行数据（书籍、译文、配置、翻译队列、TTS 缓存）通过绑定挂载落在宿主机 `./backend/data/`，删容器/重建镜像数据不丢，已有数据直接可用。
- **局域网访问**：容器监听 `0.0.0.0`，局域网设备直接访问 `http://<宿主机IP>:8300`；WebDAV 书库在「设置」页开启后位于 `http://<宿主机IP>:8300/webdav/`（无认证，勿暴露公网）。
- **换端口**：编辑 `docker-compose.yml` 的 `ports`，如 `"8301:8300"`。

常用命令：

```bash
docker compose up -d --build   # 代码更新后重新构建并启动
docker compose logs -f         # 查看日志
docker compose down            # 停止并删除容器（数据保留在 ./backend/data）
```

## 单独启动

```bash
# 后端（在 backend/ 下）
cd backend && uv run uvicorn app.main:app --port 8300

# 前端开发（在 frontend/ 下，vite 代理 /api → 8300）
cd frontend && bun run dev

# 前端构建（构建后后端会自动挂载 frontend/dist 为静态站）
cd frontend && bun run build
```

## 仓库布局

```
backend/
  app/
    main.py        # FastAPI 路由（配置/书籍/章节追加/术语表/翻译控制/导出）
    store.py       # 持久化：data/config.json 与 data/books/<id>/book.json
    parsing.py     # txt 正则分章、epub 解析/生成、HTML 翻译单元抽取
    deepseek.py    # DeepSeek API 客户端
    translator.py  # 术语表生成 + 按章并发翻译流水线（asyncio）
  data/            # 运行时数据（书籍、译文、配置），已 gitignore
frontend/
  src/App.jsx  BookList.jsx  BookDetail.jsx  Settings.jsx  api.js
```

## 数据持久化

不用数据库，每本书一个目录 `backend/data/books/<id>/`：

- `book.json` — 书籍清单、翻译进度、术语表
- `source.*` — 原始上传文件
- `chapters/<cid>.src|.dst` — 各章原文与译文
- 导出文件

写 JSON 采用临时文件 + 原子替换，崩溃不会写坏数据。

## API 一览

- `GET/PUT /api/config` — 设置（api_key、base_url、model、target_lang、concurrency、max_segment_chars）
- `POST /api/books` — 上传 epub/txt（multipart）
- `GET /api/books` / `GET /api/books/{id}` / `DELETE /api/books/{id}`
- `POST /api/books/{id}/chapters` — 追加章节（file 或 text，自动分章）
- `POST /api/books/{id}/glossary/generate` / `PUT /api/books/{id}/glossary` — 生成 / 保存术语表
- `POST /api/books/{id}/translate`（body: `{chapter_ids?, overwrite?}`）/ `POST .../stop`
- `POST /api/books/{id}/chapters/{cid}/retranslate` — 单章重译
- `GET /api/books/{id}/export?fmt=txt|epub` — 导出
