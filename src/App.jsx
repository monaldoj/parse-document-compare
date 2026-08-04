// ============================================================
// App.jsx — layout + reactive state
//
// One document, two parsers, three ways to look at the difference:
//
//   1. Pick a document (and the Model Serving endpoint to compare
//      against ai_parse_document) -> run one SQL statement that parses
//      it both ways.
//   2. Toggle the comparison view: Overlay (bounding boxes drawn on the
//      rendered page), Markdown (the extracted content), or JSON (a
//      structural diff of the two envelopes).
//   3. Page through a multi-page PDF. The native parser already returned
//      every page, but the custom endpoint parses one page per call, so
//      changing page re-runs the comparison for that page.
//
// Overlay and Markdown are both side-by-side: custom endpoint on the
// left, ai_parse_document on the right.
//
// Element selection is deliberately NOT cross-parser: the two parsers
// group text into different numbers of elements, so custom element 7
// has no counterpart in the native envelope. What selection does buy is
// continuity across views — click a box in the overlay, switch to
// Markdown, and the same element is highlighted there.
// ============================================================
import { useState, useEffect, useRef, useCallback } from 'react'
import ControlPanel from './components/ControlPanel.jsx'
import PageViewer from './components/PageViewer.jsx'
import MarkdownView from './components/MarkdownView.jsx'
import JsonDiff from './components/JsonDiff.jsx'
import { api } from './api.js'

// The three comparison views.
const VIEWS = [
  { id: 'overlay', label: 'Bounding boxes' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON diff' },
]

export default function App() {
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)

  // Document selection.
  const [documentsPath, setDocumentsPath] = useState('')
  const [documents, setDocuments] = useState([])
  const [loadingDocuments, setLoadingDocuments] = useState(false)
  const [selectedPath, setSelectedPath] = useState(null)

  // The endpoint compared against ai_parse_document. Editable so any
  // serving endpoint honoring the same contract can be swapped in.
  const [endpoint, setEndpoint] = useState('')

  // Comparison result for the current document + page.
  const [result, setResult] = useState(null)
  const [comparing, setComparing] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)

  // Which of the three views is showing.
  const [view, setView] = useState('overlay')

  // The element the analyst is pointing at, as `${side}:${idx}`, shared
  // by the overlay and markdown panes so they highlight in lockstep.
  const [hovered, setHovered] = useState(null)
  // A clicked element stays highlighted after the pointer leaves.
  const [pinned, setPinned] = useState(null)

  // Element types toggled off are hidden from the overlay — a busy
  // receipt is much easier to read one type at a time.
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set())

  // Optional "show me the SQL" overlay, same as cotraveler: subscribe to
  // the api query observer and keep a rolling history of the statements
  // that ran (text + warehouse time). `idx` is the cursor the user arrows
  // through; -1 means "nothing yet". When a new query lands while the
  // cursor is parked on the newest entry we follow it, but if the user has
  // arrowed back into history we leave their position alone.
  const [showQueries, setShowQueries] = useState(false)
  const [queryLog, setQueryLog] = useState({ history: [], idx: -1 })
  const QUERY_HISTORY_MAX = 50

  // Track the latest comparison request so a slow earlier parse can't
  // overwrite a newer one (parses take minutes — this matters here).
  const reqSeq = useRef(0)
  // Latest result's SQL, read when the overlay is switched on so the
  // seeding effect doesn't have to depend on (and resubscribe for)
  // every new result.
  const resultSqlRef = useRef(null)
  resultSqlRef.current = result ? { sql: result.sql, elapsedMs: result.elapsedMs } : null

  useEffect(() => {
    api.config().then((cfg) => {
      setConfig(cfg)
      setDocumentsPath(cfg.documentsPath)
      setEndpoint(cfg.defaultEndpoint)
    }).catch((err) => setError(err.message))
  }, [])

  // While the query overlay is on, append every executed SQL statement
  // to the history. Subscribing only when on keeps a no-op tap out of
  // the path; we clear the history when toggled back off.
  //
  // Turning it on seeds the history with the statement behind the
  // result already on screen — otherwise the overlay would sit empty
  // until the next parse, which for a cached result may never come.
  useEffect(() => {
    if (!showQueries) { setQueryLog({ history: [], idx: -1 }); return }
    const seed = resultSqlRef.current
    if (seed?.sql) {
      setQueryLog({
        history: [{ endpoint: '/api/compare', sql: seed.sql, elapsedMs: seed.elapsedMs }],
        idx: 0,
      })
    }
    return api.onQuery((q) => {
      setQueryLog((cur) => {
        const history = [...cur.history, q].slice(-QUERY_HISTORY_MAX)
        const wasAtNewest = cur.idx === cur.history.length - 1 || cur.idx === -1
        const evicted = cur.history.length === QUERY_HISTORY_MAX
        const idx = wasAtNewest
          ? history.length - 1
          : Math.max(0, cur.idx - (evicted ? 1 : 0))
        return { history, idx }
      })
    })
  }, [showQueries])

  // Arrow through the query history. Clamped to the available range.
  function stepQuery(delta) {
    setQueryLog((cur) => {
      if (!cur.history.length) return cur
      const idx = Math.min(cur.history.length - 1, Math.max(0, cur.idx + delta))
      return { ...cur, idx }
    })
  }

  // Load the document list for a volume directory.
  const loadDocuments = useCallback(async (dir) => {
    if (!dir) return
    setLoadingDocuments(true)
    setError(null)
    try {
      const { documents } = await api.documents(dir)
      setDocuments(documents)
      if (!documents.length) setError(`No PDF or image files under ${dir}`)
    } catch (err) {
      setError(err.message)
      setDocuments([])
    } finally {
      setLoadingDocuments(false)
    }
  }, [])

  useEffect(() => {
    if (config?.documentsPath) loadDocuments(config.documentsPath)
  }, [config?.documentsPath, loadDocuments])

  // Run both parsers over one page. Guarded against out-of-order
  // responses; a parse can take minutes, so a stale one must not win.
  const runCompare = useCallback(async (filePath, page, refresh = false) => {
    if (!filePath) return
    // Tell the analyst why nothing happened instead of failing silently.
    if (!endpoint.trim()) {
      setError('Enter a Model Serving endpoint to compare against ai_parse_document.')
      return
    }
    const seq = ++reqSeq.current
    setComparing(true)
    setError(null)
    try {
      const data = await api.compare({ path: filePath, endpoint, pageIndex: page, refresh })
      if (seq !== reqSeq.current) return
      setResult(data)
      setPageCount(data.pageCount || 1)
      // A fresh parse invalidates any element the analyst had pinned.
      setPinned(null)
      setHovered(null)
    } catch (err) {
      if (seq === reqSeq.current) { setError(err.message); setResult(null) }
    } finally {
      if (seq === reqSeq.current) setComparing(false)
    }
  }, [endpoint])

  // Pick a document — reset to page 1 and compare it.
  function onSelectDocument(filePath) {
    setSelectedPath(filePath)
    setPageIndex(0)
    setResult(null)
    setHiddenTypes(new Set())
    runCompare(filePath, 0)
  }

  // Page through a multi-page PDF. The custom endpoint parses one page
  // per call, so a page change means a fresh comparison.
  function onChangePage(next) {
    const page = Math.max(0, Math.min(pageCount - 1, next))
    if (page === pageIndex || !selectedPath) return
    setPageIndex(page)
    runCompare(selectedPath, page)
  }

  // Re-run the current page, bypassing the cached result (e.g. after
  // redeploying the endpoint under the same name).
  function onRerun() {
    if (selectedPath) runCompare(selectedPath, pageIndex, true)
  }

  function onToggleType(type) {
    setHiddenTypes((cur) => {
      const next = new Set(cur)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // Clicking an element pins it; clicking the same one again unpins.
  function onSelectElement(token) {
    setPinned((cur) => (cur === token ? null : token))
  }

  // Every element type present on this page, for the filter chips.
  const presentTypes = result
    ? [...new Set([
        ...result.elements.custom.map((e) => e.type),
        ...result.elements.native.map((e) => e.type),
      ])].sort()
    : []

  const active = pinned || hovered

  return (
    <div className="app">
      <ControlPanel
        documentsPath={documentsPath}
        setDocumentsPath={setDocumentsPath}
        onReloadDocuments={() => loadDocuments(documentsPath)}
        documents={documents}
        loadingDocuments={loadingDocuments}
        selectedPath={selectedPath}
        onSelectDocument={onSelectDocument}
        endpoint={endpoint}
        setEndpoint={setEndpoint}
        onRerun={onRerun}
        comparing={comparing}
        result={result}
        error={error}
        presentTypes={presentTypes}
        hiddenTypes={hiddenTypes}
        onToggleType={onToggleType}
        showQueries={showQueries}
        onToggleQueries={() => setShowQueries((on) => !on)}
      />

      <main className="workspace">
        {/* Toolbar: the view toggle + the page pager, mirroring the
            Databricks document-parsing UI. */}
        <div className="toolbar">
          <div className="view-toggle">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={view === v.id ? 'active' : ''}
                onClick={() => setView(v.id)}
                disabled={!result}
              >
                {v.label}
              </button>
            ))}
          </div>

          {result && pageCount > 1 && (
            <div className="pager">
              <button
                type="button"
                onClick={() => onChangePage(pageIndex - 1)}
                disabled={pageIndex === 0 || comparing}
                aria-label="Previous page"
              >‹</button>
              <span className="page-pos">{pageIndex + 1} / {pageCount}</span>
              <button
                type="button"
                onClick={() => onChangePage(pageIndex + 1)}
                disabled={pageIndex >= pageCount - 1 || comparing}
                aria-label="Next page"
              >›</button>
            </div>
          )}

          {result && (
            <div className="toolbar-stats">
              <span className="pill pill-custom">
                custom {result.metrics.custom.elements}
              </span>
              <span className="pill pill-native">
                native {result.metrics.native.elements}
              </span>
              <span className="muted">
                {result.cached
                  ? 'cached'
                  : result.elapsedMs != null
                    ? `${(result.elapsedMs / 1000).toFixed(1)}s`
                    : ''}
              </span>
            </div>
          )}
        </div>

        {/* Body: whichever comparison view is selected. */}
        <div className="view-body">
          {comparing && (
            <div className="overlay-notice">
              <div className="spinner" />
              <p>Parsing page {pageIndex + 1} with both parsers…</p>
              <p className="muted">
                The custom endpoint runs a vision model plus an LLM reformat pass;
                a cold scale-to-zero endpoint can take a few minutes.
              </p>
            </div>
          )}

          {!comparing && !result && (
            <div className="empty">
              <h2>Compare a document parser against <code>ai_parse_document</code></h2>
              <p className="muted">
                Pick a PDF or image from the volume on the left. Both parsers run in a
                single Databricks SQL statement, then compare their bounding boxes,
                extracted markdown, or raw JSON.
              </p>
            </div>
          )}

          {!comparing && result && view === 'overlay' && (
            <PageViewer
              result={result}
              hiddenTypes={hiddenTypes}
              active={active}
              onHover={setHovered}
              onSelect={onSelectElement}
            />
          )}

          {!comparing && result && view === 'markdown' && (
            <MarkdownView
              result={result}
              hiddenTypes={hiddenTypes}
              active={active}
              onHover={setHovered}
              onSelect={onSelectElement}
            />
          )}

          {!comparing && result && view === 'json' && (
            <JsonDiff
              custom={result.envelopes.custom}
              native={result.envelopes.native}
            />
          )}
        </div>

        {/* Live SQL overlay — the parsing statement that just ran. */}
        {showQueries && (
          <div className="query-overlay">
            {queryLog.history.length ? (
              (() => {
                const cur = queryLog.history[queryLog.idx]
                const atOldest = queryLog.idx <= 0
                const atNewest = queryLog.idx >= queryLog.history.length - 1
                return (
                  <>
                    <div className="query-head">
                      <span className="query-endpoint">{cur.endpoint}</span>
                      {cur.elapsedMs != null && (
                        <span className="query-time">{cur.elapsedMs.toLocaleString()} ms</span>
                      )}
                      <span className="query-nav">
                        <button
                          type="button"
                          onClick={() => stepQuery(-1)}
                          disabled={atOldest}
                          aria-label="Previous query"
                        >←</button>
                        <span className="query-pos">{queryLog.idx + 1}/{queryLog.history.length}</span>
                        <button
                          type="button"
                          onClick={() => stepQuery(1)}
                          disabled={atNewest}
                          aria-label="Next query"
                        >→</button>
                      </span>
                    </div>
                    <pre className="query-sql">{cur.sql}</pre>
                  </>
                )
              })()
            ) : (
              <span className="muted">Waiting for a parsing query…</span>
            )}
          </div>
        )}

        <div className="status">
          {comparing
            ? 'Running both parsers…'
            : result
              ? `${result.path.split('/').pop()} · page ${pageIndex + 1} of ${pageCount}`
              : 'No document parsed yet'}
          {config && (
            <span className="conn">
              {config.connected ? ' · live' : ' · no warehouse'} · {endpoint || 'no endpoint'}
            </span>
          )}
        </div>
      </main>
    </div>
  )
}
