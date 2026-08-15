// API 返回类型（与 backend/app/main.py、store.py 的响应结构对应）

export interface Config {
  api_key: string
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
