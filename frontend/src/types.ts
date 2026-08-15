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
}

export type BookStatus = 'ready' | 'glossary' | 'translating' | 'paused' | 'done' | 'error'

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
