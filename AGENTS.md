# TranLatexBook — 书本翻译 Web 应用

通过 DeepSeek API 翻译整本书：上传 epub/txt → 自动生成人名/地名/术语表（可查看编辑）→
按章并发翻译（标题与正文分离、大章自动分段）→ 导出 epub/txt。翻译任务在本地后端执行，全部数据落盘持久化。

## 技术栈

- 前端：Bun + SolidJS + TypeScript + TailwindCSS + Vite（`frontend/`）
- 后端：FastAPI + uv 管理（`backend/app/`）
- LLM：DeepSeek OpenAI 兼容接口（httpx 异步调用）

## 仓库布局

```
pyproject.toml / uv.lock     # Python 依赖，uv 管理，锁定在项目根目录
package.json / bun.lock      # JS 依赖（workspaces: frontend），锁定在项目根目录
start.sh                     # 一键启动前后端，Ctrl+C 全部停止
backend/
  app/
    main.py        # FastAPI 路由（配置/书籍/章节追加/术语表/翻译控制/导出）
    store.py       # 持久化：data/config.json 与 data/books/<id>/book.json
    parsing.py     # txt 正则分章、epub 解析/生成、HTML 翻译单元抽取
    deepseek.py    # DeepSeek API 客户端
    translator.py  # 术语表生成 + 按章并发翻译流水线（asyncio）
    webdav.py      # 只读 WebDAV（/webdav/）：有译文的书打包 EPUB 暴露给阅读软件
  data/            # 运行时数据（书籍、译文、配置），已 gitignore
frontend/
  src/index.tsx  App.tsx  BookList.tsx  BookDetail.tsx  Settings.tsx  api.ts  types.ts
```

## 常用命令

```bash
./start.sh                          # 一键启动（后端 8300，前端 5173），Ctrl+C 停止
uv sync                             # 安装/同步 Python 依赖（根目录执行）
bun install                         # 安装 JS 依赖（根目录执行）
cd frontend && bun run build        # 构建前端到 frontend/dist（后端会自动挂载为静态站）
cd frontend && bun run typecheck    # TypeScript 类型检查（tsc --noEmit）
uv run uvicorn app.main:app --port 8300   # 在 backend/ 下单独起后端
```

注意：本机 8000 端口被其他服务占用，后端固定用 **8300**，前端 vite 代理 `/api` → 8300。
后端监听 `0.0.0.0`，WebDAV 书库（及 API）可从局域网访问；WebDAV 无认证，勿暴露到公网。

## 关键约定

- **持久化**：不用数据库。每本书一个目录 `backend/data/books/<id>/`：
  `book.json`（清单+进度+术语表）、`source.*`、`chapters/<cid>.src|.dst`、导出文件。
  写 JSON 用临时文件 + replace 原子替换（`store._write_json`）。
- **章节格式**：每章带 `format`（`txt`/`epub`），允许混合（追加章节时可能不同）。
  epub 章节的正文保存完整 HTML，翻译时只替换叶子块级元素的文本，结构保持不变。
- **翻译协议**：正文按段落切成翻译单元，再按 `max_segment_chars` 分组，发给模型时带
  `【N】` 编号标记，响应按编号解析回原文位置；缺失编号重试一次，仍缺失则保留原文。
  章节标题和书名用单独的提示词翻译，不走正文分段。
- **术语表去重**：重复生成术语时，提示词会附上已有术语让模型避开；生成结果再经
  `translator._merge_glossary` 按规范化 src（去空白、小写）去重合并，已有条目优先保留。
- **并发**：`translator.py` 中 `asyncio.Semaphore(配置并发数)` 控制全局 LLM 并发；
  章节之间并发、章节内分段并发，按索引重组，不会错乱。停止通过 `asyncio.Event` 协作式中断。
- **txt 分章**：`parsing.CHAPTER_PATTERNS` 按优先级匹配（第X章/卷/回、Chapter N、序/尾声、
  纯数字编号等），数值型要求至少出现 2 次才采用；识别不到则整本作为一章。
  txt 解码依次尝试 utf-8 → gb18030 → utf-16 → latin-1。
- **epub 解析**：按 spine 顺序取 ITEM_DOCUMENT，跳过 EpubNav/EpubNcx；导出 epub 时
  用 BeautifulSoup 抽取 body 内容重建干净文档（带 xml 声明的完整文档会让 ebooklib 崩溃）。
- **FastAPI 路由**：调用 `asyncio.create_task` 的接口必须是 `async def`
  （同步 def 会跑在线程池，没有 running event loop）。
- **WebDAV**：`webdav.py` 在 `/webdav/` 实现只读 WebDAV（OPTIONS/PROPFIND/GET/HEAD，
  写操作 405），与 API 同端口 8300，`config.webdav_enabled` 开关（默认关），未开启时 404。
  只列出有译文的书籍（`list_books` 中 done>0），文件名为 `<译名或原名>.epub`（重名加 `_<id>`），
  EPUB 按需生成并缓存为 `books/<id>/webdav.epub`，源文件（book.json/章节）更新后自动重建。
  无认证，仅供局域网使用。

## API 一览

- `GET/PUT /api/config` — 设置（api_key、base_url、model、target_lang、concurrency、max_segment_chars）
- `POST /api/books` — 上传 epub/txt（multipart）
- `GET /api/books` / `GET /api/books/{id}` / `DELETE /api/books/{id}`
- `POST /api/books/{id}/chapters/preview` — 解析待追加的 txt/epub（multipart），
  返回章节清单（含与已有章节的查重标记 duplicate），不写盘，供前端勾选
- `POST /api/books/{id}/chapters` — 追加章节（JSON: `{chapters: [{title, body, format}]}`，
  粘贴文本走单章；文件追加由 preview 勾选后回传）
- `POST /api/books/{id}/glossary/generate` / `PUT /api/books/{id}/glossary` — 生成 / 保存术语表
- `POST /api/books/{id}/translate`（body: `{chapter_ids?, overwrite?}`）/ `POST .../stop`
- `POST /api/books/{id}/chapters/{cid}/retranslate` — 单章重译
- `GET /api/books/{id}/export?fmt=txt|epub` — 导出
- `WebDAV /webdav/` — 只读书库（PROPFIND 列出 EPUB、GET 下载），需在设置中开启
