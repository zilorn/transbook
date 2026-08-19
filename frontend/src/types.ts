// API 返回类型（与 backend/app/main.py、store.py 的响应结构对应）

// 单个 API Key 配置：model 为空字符串 = 跟随统一模型；concurrency 为 0 = 跟随统一并发数
export interface ApiKeyEntry {
  key: string
  model: string
  concurrency: number
}

export interface Config {
  api_key: string
  api_keys: ApiKeyEntry[]
  api_key_set: boolean
  base_url: string
  model: string
  target_lang: string
  concurrency: number
  max_segment_chars: number
  webdav_enabled: boolean
  update_repo: string
  update_branch: string
  github_token: string
}

// GET /api/update/status 的返回
export type UpdateState = 'idle' | 'checking' | 'available' | 'updating' | 'restarting' | 'restart_required' | 'error'

export interface UpdateStatus {
  status: UpdateState
  error: string | null
  repo: string
  branch: string
  current_sha: string
  remote_sha: string | null
  remote_msg: string | null
  last_check: number | null
  update_available: boolean
  in_docker: boolean
  cooldown_min: number
}

export type BookStatus = 'ready' | 'glossary' | 'translating' | 'paused' | 'done' | 'error'

// 书籍网络来源（syosetu / kakuyomu）；上传的书没有该字段
export interface BookSource {
  site: string
  url: string
  ncode?: string
  work_id?: string
}

// GET /api/books 的列表条目
export interface BookSummary {
  id: string
  title: string
  title_translated: string
  author: string
  format: string
  status: BookStatus
  created_at: number
  chapters: number
  done: number
  glossary_count: number
  source?: BookSource | null
  // 无需翻译标记：仅托管（阅读/导出/WebDAV），不参与翻译
  no_translate: boolean
  // 阅读进度：上次读到的章节（序号 + 标题，译名优先），从未阅读为 null
  read_progress?: { index: number; title: string } | null
  // 最近阅读时间戳（秒），从未阅读为 null；列表按 max(最近阅读, 导入时间) 倒序
  last_read_at?: number | null
}

export type ChapterStatus = 'pending' | 'translating' | 'done' | 'error'

export interface Chapter {
  id: string
  title: string
  title_translated: string | null
  status: ChapterStatus
  error: string | null
  format: string
  // 分段翻译进度（翻译中的章节由后端实时更新）
  seg_total?: number | null
  seg_done?: number | null
}

export interface GlossaryTerm {
  src: string
  dst: string
  type: string
  note?: string
}

// 阅读器书签：cid + 句号列表定位（si 为章节内朗读句下标），text 为选中时的文本快照
export interface Bookmark {
  id: string
  cid: string
  sis: number[]
  text: string
  created_at: number
  /** 句内选取的字符区间（相对该句文本的偏移）；缺省（旧数据）表示整句划线 */
  ranges?: { si: number; start: number; end: number }[]
}

// GET /api/books/{id} / POST /api/books 的整书结构
export interface Book {
  id: string
  title: string
  title_translated: string | null
  author: string
  format: string
  source_file: string
  created_at: number
  status: BookStatus
  error: string | null
  running: boolean
  glossary: GlossaryTerm[]
  chapters: Chapter[]
  source?: BookSource | null
  // 无需翻译标记：仅托管（阅读/导出/WebDAV），不参与翻译
  no_translate?: boolean
  // 阅读器书签（旧数据没有该字段）
  bookmarks?: Bookmark[]
}

// 追加章节时提交的条目
export interface NewChapter {
  title: string
  body: string
  format: string
}

// POST /api/books/{id}/chapters/preview 返回的章节条目
export interface ChapterPreview extends NewChapter {
  chars: number
  snippet: string
  duplicate: boolean
}

export interface ChapterPreviewResult {
  chapters: ChapterPreview[]
  existing: number
}

export interface TranslateOptions {
  chapter_ids?: string[]
  overwrite?: boolean
}

// GET /api/queue/status 返回的队列条目（含章节与分段进度）
export interface QueueStatusEntry {
  book_id: string
  overwrite: boolean
  chapter_ids: string[] | null
  title: string
  title_translated: string | null
  status: BookStatus
  error: string | null
  running: boolean
  chapters: Omit<Chapter, 'format'>[]
}

export interface QueueStatus {
  running: boolean
  entries: QueueStatusEntry[]
}

// GET /api/syosetu/search 的单条结果
export interface SyosetuResult {
  ncode: string
  url: string
  title: string
  author: string
  synopsis: string
  status: string
  episodes: number
}

// GET /api/kakuyomu/search 的单条结果
export interface KakuyomuResult {
  work_id: string
  url: string
  title: string
  author: string
  synopsis: string
  status: string
  episodes: number
  genre: string
}

// GET /api/syosetu/status/{book_id} 的爬取进度
export interface CrawlStatus {
  running: boolean
  total: number
  done: number
  added: number
  current: string
  error: string | null
}

// GET /api/{syosetu,kakuyomu}/rankings 的单条条目（发现页）
export interface RankItem {
  rank: number
  url: string
  title: string
  author: string
  synopsis: string
  status: string
  genre: string
  points: number
  chars: number
  episodes: number
  ncode?: string
  work_id?: string
}

// GET /api/syosetu/rankings 的响应
export interface SyosetuRankingsResult {
  results: RankItem[]
  periods: Record<string, string>
  genres: Record<string, string>
  kinds: Record<string, string>
}

// GET /api/kakuyomu/rankings 的响应
export interface KakuyomuRankingsResult {
  results: RankItem[]
  periods: Record<string, string>
  genres: Record<string, string>
  variations: Record<string, string>
}
