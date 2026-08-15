import type {
  Book,
  BookSummary,
  ChapterPreviewResult,
  Config,
  GlossaryTerm,
  NewChapter,
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
  retranslateChapter: (id: string, cid: string): Promise<{ ok: boolean }> =>
    req(`/api/books/${id}/chapters/${cid}/retranslate`, { method: 'POST' }),
  chapterContent: (id: string, cid: string, translated = false): Promise<string> =>
    reqText(`/api/books/${id}/chapters/${cid}/content${translated ? '?translated=true' : ''}`),
  exportUrl: (id: string, fmt: string): string => `/api/books/${id}/export?fmt=${fmt}`,
}
