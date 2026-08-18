# TransBook — 书本翻译 Web 应用

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
start.sh                     # 一键启动：构建前端后由 FastAPI 托管 dist，Ctrl+C 停止
backend/
  app/
    main.py        # FastAPI 路由（配置/书籍/章节追加/术语表/翻译控制/翻译队列/导出）
    store.py       # 持久化：data/config.json、data/queue.json 与 data/books/<id>/book.json
    parsing.py     # txt 正则分章、epub 解析/生成、HTML 翻译单元抽取
    deepseek.py    # DeepSeek API 客户端（chat 支持按 KeyPool 条目调用）
    translator.py  # 术语表生成 + KeyPool 多 key 并发翻译流水线 + 队列执行器（asyncio）
    tts.py         # 听书（edge-tts）：任意文本合成，mp3 按 音色+倍速+文本 哈希全局缓存（data/tts_cache/）
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
./start.sh                          # 一键启动（构建前端后 FastAPI 托管，仅后端 8300），Ctrl+C 停止；SKIP_BUILD=1 跳过构建
uv sync                             # 安装/同步 Python 依赖（根目录执行）
bun install                         # 安装 JS 依赖（根目录执行）
cd frontend && bun run build        # 构建前端到 frontend/dist（后端会自动挂载为静态站）
cd frontend && bun run typecheck    # TypeScript 类型检查（tsc --noEmit）
uv run uvicorn app.main:app --port 8300   # 在 backend/ 下单独起后端
docker compose up -d --build              # Docker 一键部署：镜像内构建前端，数据卷挂 ./backend/data
```

注意：后端固定用 **8300**。生产模式由 FastAPI 托管
`frontend/dist`（`main.py` 末尾 StaticFiles 挂载），前端只需访问 8300 一个端口；
仅开发调试时才单独跑 `cd frontend && bun run dev`（vite 代理 `/api` → 8300）。
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
- **并发**：`translator.KeyPool` 把每个 key 按自身并发数放入 `asyncio.Queue` 槽位，
  取用即占用、归还即释放，请求按 key 自动分摊，总并发 = 各 key 有效并发之和。
  章节之间并发、章节内分段并发，按索引重组，不会错乱。停止通过 `asyncio.Event` 协作式中断。
  注意每次翻译任务（含手动单章重译）各自建池，并行任务的总并发会叠加。
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
- **听书（edge-tts，逐句）**：**前端自行分句、直接把每句文本发给后端合成**——渲染的句
  与朗读的句天然是同一份，逐句高亮必然对齐，后端不参与分句/对齐。`POST /api/tts/speak`
  （`{text, voice, rate}`）合成任意文本为 mp3，按 `sha1(音色+倍速+文本)` 全局缓存到
  `data/tts_cache/`（跨书复用；合成写唯一临时文件，完成转正，中断删残片）；
  文本上限 `MAX_TEXT_CHARS`（1000 字）防滥用。音色白名单 `tts.VOICES`（中文显示名），
  非法音色 400。前端分句规则 `SEG_RE`（句读标点/换行）：txt 始终按句渲染
  `span[data-si]`；epub 用 `splitEpubHtml`（DOMParser 处理 HTML 字符串，按章节缓存）
  同步拆出句级 span 并收集句文本——**不依赖渲染后 DOM 的 effect/ref 时序**（曾因竞态
  导致句清单为空），渲染的句与朗读的句是同一份数据；拆句跳过 style/script/title
  内的文本与纯空白节点。纯标点段（不含任何字母/数字/汉字，如异常分割出的
  「」、——、※※）也不朗读：txt 记 si=-1、epub 按原样渲染不包 span，
  均不进朗读句清单（`speakable` 判断）。
  章节标题也朗读：可朗读的标题（`titleText`，译名优先）固定为朗读句清单第 0 句，
  正文句号从 1 起编（`titleOffset`；epub 拆句缓存 key 含 titleOffset），
  正文 `<h1>` 标题带 `data-si="0"` 参与高亮/滚动（标题不可朗读时不编号、正文仍从 0 起）。
  播放走内存 Blob 缓存（`audioCache`：句号 → 合成 Promise，失败不缓存）：播放当前句时
  逐句预取随后 5 句（兜底），主力预取走**批量预热**：`prefetchAll` 从当前朗读位置起
  按 30 句/批发 `POST /api/tts/warm`，后端 `tts.warm_cache` 以 12 并发合成落盘
  （跳句后从新位置重启预取；切章/换音色由 `prefetchGen` 作废旧批）。
  逐句预取受浏览器同源连接数限制，冷合成每句约 1.5s，冷缓存设备（手机首次播放、
  音色与桌面端不同导致服务端缓存全 miss）会被播放追上，表现为每句"语音生成中"——
  批量预热不受浏览器连接数限制；合成/播放失败自动跳下一句
  （连续失败 5 句才停止），播完自动接下一句/下一章；当前朗读句加 `.tts-active` 高亮
  并自动滚动到视野中部（`ttsFollow` 信号门控：用户滚轮/触摸/键盘翻页键即停止自动
  跟读——程序性 smooth 滚动不触发这些事件不会误停——朗读与高亮继续，控制面板出现
  「返回跟读」按钮，点击置回 true 重触滚动 effect 滚回当前句；切章/换音色/关闭听书
  时重置为开）；切章/换音色时若处于播放意图（`wantPlay`）
  自动换源续播（换音色重读当前句）。朗读句清单以 `contentCid` 门控：content 必须属于
  当前章节，否则切章后内容未加载完时会拿上一章的句子接着读。用户点播放按钮全新开播
  （非暂停续播）时，若已滚动阅读过则从视口第一行起读（`firstVisibleIdx` 取 sticky 顶栏
  之下第一个 `span[data-si]`，全滚过取末句；`playTts(true)`）——章末连播切章的续播
  不走可见句定位（此刻滚动位置还是上一章的），仍从首句开始。播放/暂停按钮只随播放意图
  （`wantPlay`/`setWant`）变化；
  暂停/关闭/切章时递增 `playGen`，在途的下一句合成等待被作废（句间隙暂停也能立刻停住）。
- **书签/文本选取（阅读器）**：监听 `selectionchange`（去抖 120ms，移动端拖动句柄停手后才出条）
  在选区上方弹自定义工具条（复制/书签/朗读），工具条 `pointerdown` preventDefault 防点按钮前选区被清；
  选取覆盖到任一书签句（`selSis` ∩ `bmSis`，哪怕只命中一半）时书签按钮变为「取消书签」，
  点击删除本章所有与选取相交的书签（`unbookmarkSel`）；
  正文容器 `[-webkit-touch-callout:none]` + `contextmenu` preventDefault 屏蔽原生 callout/右键菜单
  （Android Chrome 选中后的系统浮动菜单无法用 Web API 完全屏蔽）。书签存 `book.json` 的
  `bookmarks`（`{id, cid, sis[], text, created_at, ranges?}`）：`sis` 为章节内朗读句下标（`span[data-si]`，
  重译后下标可能漂移，`text` 是添加时的文本快照）；`ranges`（`{si, start, end}[]`）记录选取在每句内
  覆盖的字符区间（相对该句文本的偏移），下划线精确到选取的字：新书签只给区间内的字加 `.bm-mark`
  橙色下划线（txt 用 `markParts` 把句文本切成划线/普通片段渲染，epub 用 `wrapTextRange`
  把句 span 内对应文本包 `.bm-mark.bm-part`，重刷前先拆旧包裹还原；跨界包裹失败兜底整句切类）；
  无 `ranges` 的旧书签仍整句划线（txt 走 Solid classList，epub 走 effect 切类，与 `.tts-active` 同套路）。
  epub 正文容器的 ref `segEl`
  必须是 signal（`createSignal`）而非普通变量：div 创建晚于首批 effect 执行，普通变量
  不触发重跑，依赖它的 effect 在 ref 赋值前 bailout 后不再重跑，会导致直开章节时
  `.bm-mark`/`.tts-active` 不显示。朗读起点取选区内第一个含文字
  （`\p{L}\p{N}`）字符所在的句（首字符是标点则顺延）。书签查看/删除：目录抽屉「书签」页签 +
  书籍详情页「书签」标签页；跳转页内直接 `scrollIntoView`，跨页经 sessionStorage
  `reader-jump:<bookId>`（60s 内有效，消费即删），跳转到目标章时不恢复旧滚动位置。
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

服务器路由 `/openapi.json` 中可查看所有API.