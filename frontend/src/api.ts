import type {
  Book,
  Bookmark,
  BookSummary,
  ChapterPreviewResult,
  Config,
  CrawlStatus,
  GlossaryTerm,
  KakuyomuRankingsResult,
  KakuyomuResult,
  NewChapter,
  QueueStatus,
  SyosetuRankingsResult,
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

async function reqBlob(path: string, opts: RequestInit = {}): Promise<Blob> {
  const res = await fetch(path, opts)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return res.blob()
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
  setNoTranslate: (id: string, noTranslate: boolean): Promise<{ ok: boolean; no_translate: boolean }> =>
    req(`/api/books/${id}/no_translate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no_translate: noTranslate }),
    }),
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
  getProgress: (id: string): Promise<{ cid: string | null; y: number }> =>
    req(`/api/books/${id}/progress`),
  saveProgress: (id: string, cid: string, y: number): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, y }),
    }),
  addBookmark: (id: string, bm: { cid: string; sis: number[]; text: string; ranges?: { si: number; start: number; end: number }[] }): Promise<Bookmark> =>
    req(`/api/books/${id}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bm),
    }),
  removeBookmark: (id: string, bmId: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/bookmarks/${bmId}`, { method: 'DELETE' }),
  ttsVoices: (): Promise<{ voices: Record<string, string>; default: string }> =>
    req('/api/tts/voices'),
  ttsSpeak: (text: string, voice: string, rate: number): Promise<Blob> =>
    reqBlob('/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, rate }),
    }),
  ttsWarm: (texts: string[], voice: string, rate: number): Promise<{ ok: boolean; done: number; failed: number }> =>
    req('/api/tts/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, voice, rate }),
    }),
  chapterImageUrl: (id: string, cid: string, src: string): string =>
    `/api/books/${id}/chapters/${cid}/image?src=${encodeURIComponent(src)}`,
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
  syosetuRankings: (period: string, genre: string, kind: string): Promise<SyosetuRankingsResult> =>
    req(`/api/syosetu/rankings?period=${period}&genre=${genre}&kind=${kind}`),
  kakuyomuRankings: (genre: string, period: string, variation: string): Promise<KakuyomuRankingsResult> =>
    req(`/api/kakuyomu/rankings?genre=${genre}&period=${period}&variation=${variation}`),
  exportUrl: (id: string, fmt: string): string => `/api/books/${id}/export?fmt=${fmt}`,
}
