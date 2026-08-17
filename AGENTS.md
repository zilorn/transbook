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
    main.py        # FastAPI 路由（配置/书籍/章节追加/术语表/翻译控制/翻译队列/导出）
    store.py       # 持久化：data/config.json、data/queue.json 与 data/books/<id>/book.json
    parsing.py     # txt 正则分章、epub 解析/生成、HTML 翻译单元抽取
    deepseek.py    # DeepSeek API 客户端（chat 支持按 KeyPool 条目调用）
    translator.py  # 术语表生成 + KeyPool 多 key 并发翻译流水线 + 队列执行器（asyncio）
    crawlers/      # 站点爬虫包（main.py 经 `from .crawlers import syosetu, kakuyomu` 使用）
      http.py      # 共享限速 HTTP 出口 HttpGate（串行 + 抖动 + 风控退避），每站点一个实例
      tasks.py     # 共享抓取任务管理 CrawlRunner（整书抓取/增量更新/进度/停止/逐章落盘）
      syosetu.py   # syosetu.com：搜索/排行榜/目录/正文解析（站点专属逻辑）
      kakuyomu.py  # kakuyomu.jp：GraphQL 搜索/目录 + __NEXT_DATA__ 排行榜 + HTML 正文解析（站点专属逻辑）
    webdav.py      # 只读 WebDAV（/webdav/）：有章节的书打包 EPUB 暴露给阅读软件
  data/            # 运行时数据（书籍、译文、配置、翻译队列），已 gitignore
frontend/
  src/index.tsx  App.tsx（HashRouter + 响应式布局：桌面侧边栏，移动端顶栏+抽屉菜单）  state.ts（全局 config/设置弹窗信号）
  BookList.tsx  BookDetail.tsx  ReaderPage.tsx（阅读器）  TranslatePage.tsx  SearchPage.tsx  DiscoverPage.tsx  Settings.tsx
  CrawlJobs.tsx（搜索页/发现页共用的爬取任务列表 + 2s 轮询）  api.ts  types.ts
  路由：/ 书库、/books/:id 书籍详情、/books/:id/read(/:cid) 阅读器、/queue 翻译队列、/search 小说搜索
  （爬虫）、/discover 发现（排行榜）；用 HashRouter 是因后端 StaticFiles 无 SPA 回退，
  history 模式刷新深链接会 404。页面间跳转一律 useNavigate。
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
- **翻译协议**：正文按段落切成翻译单元，再按 `max_segment_chars` 分组（默认 8000，
  分段数尽量少），发给模型时带 `【N】` 编号标记，响应按编号解析回原文位置；
  缺失编号重试一次，仍缺失则保留原文。章节标题和书名用单独的提示词翻译，不走正文分段。
  翻译中的章节实时维护 `seg_total`/`seg_done`（正文分段数 + 1 个标题段），供前端做分段进度可视化。
- **多 API Key**：`config.api_keys` 为 `[{key, model, concurrency}]`，`model` 空 /
  `concurrency` 0 表示跟随统一的 `model`/`concurrency`；旧单 `api_key` 配置读取时自动迁移。
  配置接口对 key 脱敏返回（前 6 位 + `...`），原样回传时按位置回代原值。
- **术语表采样**：`translator._sample_text` 把预算（默认 12000 字符）均分到每章开头
  （单章 500~3000 字符），章节过多、预算不够分时按均匀间隔选章——覆盖全书而非只抽少数章节。
- **术语表去重**：重复生成术语时，提示词会附上已有术语让模型避开；生成结果再经
  `translator._merge_glossary` 按规范化 src（去空白、小写）去重合并，已有条目优先保留。
- **术语备注**：词条可带可选 `note` 字段（生成时提示模型：人名尽量标明性别、备注不超过
  15 字，可为空）；翻译提示词中以 `src = dst（note）` 形式附上，供模型参考。
- **首次翻译自动建术语表**：`translate_book` 启动时若术语表为空且尚无已译章节，
  会先自动执行一次 `generate_glossary` 再进入翻译；生成失败不阻塞翻译（无术语表继续）。
- **无需翻译标记**：`book.json` 的 `no_translate` 布尔字段（缺省 false）表示"仅托管"
  （阅读/导出/WebDAV，如托管本身已是译文的书）。标记后所有翻译入口（整书翻译、单章重译、
  重翻书名/目录、生成术语表、入队）一律 400 拒绝；标记时自动移出翻译队列，
  队列执行器遇到残留条目也会跳过出队。详情页有开关按钮，书库/详情页显示琥珀色徽章；
  标记后前端隐藏全部翻译相关 UI（进度条、状态徽章、章节状态/操作列、术语表标签页）。
- **并发**：`translator.KeyPool` 把每个 key 按自身并发数放入 `asyncio.Queue` 槽位，
  取用即占用、归还即释放，请求按 key 自动分摊，总并发 = 各 key 有效并发之和。
  章节之间并发、章节内分段并发，按索引重组，不会错乱。停止通过 `asyncio.Event` 协作式中断。
  注意每次翻译任务（含手动单章重译）各自建池，并行任务的总并发会叠加。
- **翻译队列**：`data/queue.json` 持久化 `[{book_id, chapter_ids, overwrite, added_at}]`，
  同书重复入队时替换旧条目。`translator._run_queue` 逐本顺序执行（书内仍并发），
  完成出队；停止时当前书保留在队列中，下次"一键开始"可继续。详情页的"排队翻译"只入队，
  统一在翻译队列页（`TranslatePage.tsx`）启动/停止并做进度可视化（每书一个可折叠收纳盒，
  章节小方块灰/蓝/绿/红四态 + 方块下方分段进度条）。
- **txt 分章**：`parsing.CHAPTER_PATTERNS` 按优先级匹配（第X章/卷/回、Chapter N、序/尾声、
  纯数字编号等），数值型要求至少出现 2 次才采用；识别不到则整本作为一章。
  txt 解码依次尝试 utf-8 → gb18030 → utf-16 → latin-1。
- **epub 解析**：按 spine 顺序取 ITEM_DOCUMENT，跳过 EpubNav/EpubNcx；导出 epub 时
  用 BeautifulSoup 抽取 body 内容重建干净文档（带 xml 声明的完整文档会让 ebooklib 崩溃）。
- **FastAPI 路由**：调用 `asyncio.create_task` 的接口必须是 `async def`
  （同步 def 会跑在线程池，没有 running event loop）。
- **爬虫通用约定**：爬虫集中在 `crawlers/` 包。所有请求经 `http.HttpGate` 单一出口：
  实例级锁串行、相邻请求间隔 >=1s + 0~0.5s 抖动、403/429/5xx 按 5/15/30s 退避重试
  3 次（规避风控）；每个站点模块各持有一个 HttpGate 实例。抓取任务生命周期统一由
  `tasks.CrawlRunner` 管理：站点模块注入 `source_key`/`fetch_info`/`fetch_chapter` 回调，
  抓取逐章落盘，中断不丢已抓部分；增量更新按 `src_ep` diff 只抓缺失话数。
- **syosetu 爬虫**：`crawlers/syosetu.py` 抓 syosetu.com。爬来的书 `book.json` 顶层带
  `source = {site, url, ncode}`（详情页 URL），章节带 `src_ep` 话数编号；正文按
  `<p>` 一行一段存为 txt 章节。排行榜（发现页）：`rankings(period, genre, kind)` 解析
  `/rank/list/type/{period}_{kind}/`（综合榜，kind=全部/连载/完结/短篇）与
  `/rank/genrelist/type/{period}_{genre}/`（分类榜），每榜 50 条；
  `RANK_PERIODS`/`RANK_GENRES`/`RANK_KINDS` 为合法参数及中文显示名。
- **kakuyomu 爬虫**：`crawlers/kakuyomu.py` 抓 kakuyomu.jp。搜索与目录走官方前端同用的
  GraphQL 接口（`POST /graphql`）：搜索 `searchWorks` 支持 `GENRES` 多选过滤
  （14 个类型，值为中文显示名），目录 `tableOfContents` 一次返回全部话数（含分章作品，
  拍平为单一章节流）；章节正文解析 HTML 页 `.widget-episodeBody`（`<p>` 一段一行，
  去 ruby 注音，标题取 `p.widget-episodeTitle`）。书的 `source = {site, url, work_id}`，
  章节 `src_ep` 存 episode ID 字符串（非数字序号）。排行榜（发现页）：
  `rankings(genre, period, variation)` 抓 `/rankings/{genre}/{period}?work_variation=`，
  页面类名为构建期哈希，数据解析自 `__NEXT_DATA__` 内嵌 JSON 的 `__APOLLO_STATE__`
  （ROOT_QUERY 的 `rankedWorks(...)` 键 → Work/UserAccount 归一化实体），每榜 100 条。
- **阅读器**：`ReaderPage.tsx`，全屏路由 `/books/:id/read(/:cid)`（App.tsx 的 Layout 按路径
  识别，不渲染侧边栏）。内容取译文优先（`status === 'done'` 先试 `?translated=true`，
  404 回退原文）；epub 章节渲染前去掉 `<img>`（epub 内部相对路径无法加载）和正文首个
  h1-h3（与阅读器标题栏重复）。阅读进度（`reader-progress:<bookId>` = `{cid, y}`，含滚动
  位置）与字号/主题设置（`reader-settings`）存 localStorage；进入阅读页自动续读。
  主题（白纸/护眼/夜间）整页换背景，工具栏按钮用 `.reader-bar` 继承主题色。
- **界面中文化**：搜索/排行榜返回的 `status`（已完结/连载中/短篇）、`genre`、筛选项
  显示名一律后端出中文（`syosetu._GENRE_TEXT_ZH`、`kakuyomu.GENRES` 值），前端不做映射。
- **WebDAV**：`webdav.py` 在 `/webdav/` 实现只读 WebDAV（OPTIONS/PROPFIND/GET/HEAD，
  写操作 405），与 API 同端口 8300，`config.webdav_enabled` 开关（默认关），未开启时 404。
  列出全部有章节的书籍（未翻译章节回退原文，可托管本身已是译文的书），
  文件名为 `<译名或原名>.epub`（重名加 `_<id>`），
  EPUB 按需生成并缓存为 `books/<id>/webdav.epub`，源文件（book.json/章节）更新后自动重建。
  标记 `no_translate`（仅托管）且原始文件为 epub 的书直接返回原始 `source.epub`
  （`dav_file_path`），不重新打包；txt 源仍需打包。
  无认证，仅供局域网使用。

## API 一览

- `GET/PUT /api/config` — 设置（api_keys 多 Key（各可带 model/concurrency，空/0 跟随统一）、
  base_url、model、target_lang、concurrency、max_segment_chars）
- `POST /api/books` — 上传 epub/txt（multipart）
- `GET /api/books` / `GET /api/books/{id}` / `DELETE /api/books/{id}`
- `PUT /api/books/{id}/no_translate` — 标记/取消"无需翻译"（仅托管；标记后移出翻译队列）
- `POST /api/books/{id}/chapters/preview` — 解析待追加的 txt/epub（multipart），
  返回章节清单（含与已有章节的查重标记 duplicate），不写盘，供前端勾选
- `POST /api/books/{id}/chapters` — 追加章节（JSON: `{chapters: [{title, body, format}]}`，
  粘贴文本走单章；文件追加由 preview 勾选后回传）
- `POST /api/books/{id}/glossary/generate` / `PUT /api/books/{id}/glossary` — 生成 / 保存术语表
- `GET /api/syosetu/search?q=` — 搜索 syosetu.com 作品
- `GET /api/syosetu/rankings?period=&genre=&kind=` — 排行榜（发现页；响应附带 periods/genres/kinds 筛选项）
- `POST /api/syosetu/fetch` — 按作品链接/作品编号建书并后台爬取（逐章落盘）
- `GET /api/syosetu/status/{book_id}` / `POST /api/syosetu/stop/{book_id}` — 爬取进度 / 停止
- `POST /api/books/{id}/syosetu/update` — 增量更新，只抓最新章节
- `GET /api/kakuyomu/search?q=&genre=`（genre 可重复多选）/ `GET /api/kakuyomu/genres`
- `GET /api/kakuyomu/rankings?genre=&period=&variation=` — 排行榜（发现页；响应附带筛选项）
- `POST /api/kakuyomu/fetch` — 按作品/章节链接或作品 ID 建书并后台爬取（逐章落盘）
- `GET /api/kakuyomu/status/{book_id}` / `POST /api/kakuyomu/stop/{book_id}` — 爬取进度 / 停止
- `POST /api/books/{id}/kakuyomu/update` — 增量更新，只抓最新章节
- `POST /api/books/{id}/translate`（body: `{chapter_ids?, overwrite?}`）/ `POST .../stop`
- `GET/POST /api/queue`、`DELETE /api/queue/{book_id}` — 翻译队列查看/入队（同书替换）/移除
- `POST /api/queue/start` / `POST /api/queue/stop` — 一键开始 / 停止队列（逐本顺序执行）
- `GET /api/queue/status` — 队列 + 每书章节状态与分段进度（seg_total/seg_done），翻译页 2s 轮询
- `POST /api/books/{id}/chapters/{cid}/retranslate` — 单章重译
- `POST /api/books/{id}/title/retranslate` — 重翻书名（不动章节）
- `POST /api/books/{id}/toc/retranslate` — 重翻目录（全部章节标题；epub 已译章节的 HTML 标题元素同步更新）
- `GET /api/books/{id}/export?fmt=txt|epub` — 导出
- `WebDAV /webdav/` — 只读书库（PROPFIND 列出 EPUB、GET 下载），需在设置中开启
