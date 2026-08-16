import type {
  Book,
  BookSummary,
  ChapterPreviewResult,
  Config,
  CrawlStatus,
  GlossaryTerm,
  KakuyomuResult,
  NewChapter,
  QueueStatus,
  SyosetuResult,
  TranslateOptions,
} from './types'

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, opts)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

async function reqText(path: string): Promise<string> {
  const res = await fetch(path)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return res.text()
}

export const api = {
  config: (): Promise<Config> => req('/api/config'),
  saveConfig: (cfg: Config): Promise<Config> => req('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }),
  books: (): Promise<BookSummary[]> => req('/api/books'),
  book: (id: string): Promise<Book> => req(`/api/books/${id}`),
  upload: (file: File): Promise<Book> => {
    const fd = new FormData()
    fd.append('file', file)
    return req('/api/books', { method: 'POST', body: fd })
  },
  previewChapters: (id: string, file: File): Promise<ChapterPreviewResult> => {
    const fd = new FormData()
    fd.append('file', file)
    return req(`/api/books/${id}/chapters/preview`, { method: 'POST', body: fd })
  },
  addChapters: (id: string, chapters: NewChapter[]): Promise<{ ok: boolean; added: number; total: number }> =>
    req(`/api/books/${id}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters }),
    }),
  deleteBook: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}`, { method: 'DELETE' }),
  generateGlossary: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/glossary/generate`, { method: 'POST' }),
  saveGlossary: (id: string, terms: GlossaryTerm[]): Promise<{ ok: boolean; count: number }> =>
    req(`/api/books/${id}/glossary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms }),
    }),
  translate: (id: string, body: TranslateOptions = {}): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  stop: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/stop`, { method: 'POST' }),
  queue: (): Promise<{ running: boolean; entries: { book_id: string; overwrite: boolean }[] }> =>
    req('/api/queue'),
  enqueue: (id: string, overwrite = false): Promise<{ ok: boolean }> =>
    req('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, overwrite }),
    }),
  dequeue: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/queue/${id}`, { method: 'DELETE' }),
  startQueue: (): Promise<{ ok: boolean }> =>
    req('/api/queue/start', { method: 'POST' }),
  stopQueue: (): Promise<{ ok: boolean }> =>
    req('/api/queue/stop', { method: 'POST' }),
  queueStatus: (): Promise<QueueStatus> => req('/api/queue/status'),
  retranslateChapter: (id: string, cid: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/chapters/${cid}/retranslate`, { method: 'POST' }),
  retranslateTitle: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/title/retranslate`, { method: 'POST' }),
  retranslateToc: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/toc/retranslate`, { method: 'POST' }),
  chapterContent: (id: string, cid: string, translated = false): Promise<string> =>
    reqText(`/api/books/${id}/chapters/${cid}/content${translated ? '?translated=true' : ''}`),
  syosetuSearch: (q: string): Promise<{ results: SyosetuResult[] }> =>
    req(`/api/syosetu/search?q=${encodeURIComponent(q)}`),
  syosetuFetch: (url: string): Promise<Book> =>
    req('/api/syosetu/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  syosetuStatus: (id: string): Promise<CrawlStatus> => req(`/api/syosetu/status/${id}`),
  syosetuStop: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/syosetu/stop/${id}`, { method: 'POST' }),
  syosetuUpdate: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/syosetu/update`, { method: 'POST' }),
  kakuyomuGenres: (): Promise<{ genres: Record<string, string> }> =>
    req('/api/kakuyomu/genres'),
  kakuyomuSearch: (q: string, genres: string[]): Promise<{ results: KakuyomuResult[] }> =>
    req(`/api/kakuyomu/search?q=${encodeURIComponent(q)}${genres.map((g) => `&genre=${g}`).join('')}`),
  kakuyomuFetch: (url: string): Promise<Book> =>
    req('/api/kakuyomu/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  kakuyomuStatus: (id: string): Promise<CrawlStatus> => req(`/api/kakuyomu/status/${id}`),
  kakuyomuStop: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/kakuyomu/stop/${id}`, { method: 'POST' }),
  kakuyomuUpdate: (id: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/kakuyomu/update`, { method: 'POST' }),
  exportUrl: (id: string, fmt: string): string => `/api/books/${id}/export?fmt=${fmt}`,
}
