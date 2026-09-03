// Thin fetch wrapper around the Express /api/* endpoints. Keeping
// all network calls here mirrors Repo A's separation between the
// view layer and the data layer.

// Query observer — endpoints that run SQL echo back the statement they
// executed (`sql`) and how long the warehouse took (`elapsedMs`). Any
// listener registered via api.onQuery is notified for each such call,
// so the UI can surface the live parsing query when asked to.
const queryListeners = new Set()

function notifyQuery(url, data) {
  if (!data || data.sql == null) return
  const event = { endpoint: url.split('?')[0], sql: data.sql, elapsedMs: data.elapsedMs }
  for (const fn of queryListeners) {
    try { fn(event) } catch {}
  }
}

async function post(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  notifyQuery(url, data)
  return data
}

async function get(url) {
  const resp = await fetch(url)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  notifyQuery(url, data)
  return data
}

export const api = {
  config: () => get('/api/config'),

  // Subscribe to executed SQL queries. Returns an unsubscribe fn.
  onQuery: (fn) => {
    queryListeners.add(fn)
    return () => queryListeners.delete(fn)
  },

  // A. Parseable documents in a Unity Catalog volume directory.
  documents: (path) => get(`/api/documents?path=${encodeURIComponent(path)}`),

  // Preview a document (page count + file URL) without running either parser.
  preview: (path) => post('/api/preview', { path }),

  // B. The comparison — both parsers on one page of one document.
  // `refresh` forces a re-parse instead of reusing the server's cached
  // result (a parse costs minutes, so results are memoized by default).
  compare: ({ path, left, right, pageIndex, refresh }) =>
    post('/api/compare', { path, left, right, pageIndex, refresh }),

  // C. Page count + rendered page images, without re-running the
  // custom endpoint (used when paging through a PDF).
  pages: (path) => post('/api/pages', { path }),
}
