async function req(path, opts = {}) {
  const res = await fetch(path, opts)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}

async function reqText(path) {
  const res = await fetch(path)
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return res.text()
}

export const api = {
  config: () => req('/api/config'),
  saveConfig: (cfg) => req('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }),
  books: () => req('/api/books'),
  book: (id) => req(`/api/books/${id}`),
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return req('/api/books', { method: 'POST', body: fd })
  },
  previewChapters: (id, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return req(`/api/books/${id}/chapters/preview`, { method: 'POST', body: fd })
  },
  addChapters: (id, chapters) => req(`/api/books/${id}/chapters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapters }),
  }),
  deleteBook: (id) => req(`/api/books/${id}`, { method: 'DELETE' }),
  generateGlossary: (id) => req(`/api/books/${id}/glossary/generate`, { method: 'POST' }),
  saveGlossary: (id, terms) => req(`/api/books/${id}/glossary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terms }),
  }),
  translate: (id, body = {}) => req(`/api/books/${id}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  stop: (id) => req(`/api/books/${id}/stop`, { method: 'POST' }),
  retranslateChapter: (id, cid) =>
    req(`/api/books/${id}/chapters/${cid}/retranslate`, { method: 'POST' }),
  chapterContent: (id, cid, translated = false) =>
    reqText(`/api/books/${id}/chapters/${cid}/content${translated ? '?translated=true' : ''}`),
  exportUrl: (id, fmt) => `/api/books/${id}/export?fmt=${fmt}`,
}
