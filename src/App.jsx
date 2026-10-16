// ============================================================
// App.jsx — layout + reactive state
//
// One document, two parsers, three ways to look at the difference:
//
//   1. Pick a document to preview it. Choose two parsers, then click
//      Run comparison -> one SQL statement per side.
//   2. Toggle the comparison view: Overlay (bounding boxes drawn on the
//      rendered page), Markdown (the extracted content), or JSON (a
//      structural diff of the two envelopes).
//   3. Page through a multi-page PDF. Preview follows the pager; click
//      Run comparison to parse the page on screen.
//
// Overlay and Markdown are both side-by-side: the left dropdown on
// the left, the right dropdown on the right.
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
import TimingBar from './components/TimingBar.jsx'
import DocumentPreview from './components/DocumentPreview.jsx'
import { api } from './api.js'

// The three comparison views.
const VIEWS = [
  { id: 'overlay', label: 'Bounding boxes' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON diff' },
]

const FALLBACK_PARSERS = [
  { id: 'ai-parse-document-fmapi', label: 'ai-parse-document-fmapi', shortLabel: 'ai-parse-document-fmapi', kind: 'endpoint', endpoint: 'ai-parse-document-fmapi' },
  { id: 'ai_parse_document', label: 'ai_parse_document', shortLabel: 'ai_parse_document', kind: 'native' },
  { id: 'none', label: 'No model', shortLabel: 'No model', kind: 'none' },
]

export default function App() {
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)

  // Document selection.
  const [documentsPath, setDocumentsPath] = useState('')
  const [documents, setDocuments] = useState([])
  const [loadingDocuments, setLoadingDocuments] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [selectedPath, setSelectedPath] = useState(null)

  // Each pane's parser. Defaults come from /api/config
  // (ai-parse-document-fmapi vs ai_parse_document).
  const [leftParser, setLeftParser] = useState('ai-parse-document-fmapi')
  const [rightParser, setRightParser] = useState('ai_parse_document')
  const [parsers, setParsers] = useState(FALLBACK_PARSERS)
  // Execution mode: 'dbsql' (SQL Warehouse) or 'rest' (real-time REST API).
  const [mode, setMode] = useState('dbsql')
  // Whether to parse only page 1 or fan out across every page in the PDF.
  const [pageMode, setPageMode] = useState('current')

  // Comparison result for the current document + page.
  const [result, setResult] = useState(null)
  const [comparing, setComparing] = useState(false)
  const [preview, setPreview] = useState(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
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
  const previewSeq = useRef(0)
  // Latest result's SQL/REST request, read when the overlay is switched on
  // so the seeding effect doesn't have to depend on (and resubscribe for)
  // every new result.
  const resultSqlRef = useRef(null)
  resultSqlRef.current = result
    ? { mode: result.mode || 'dbsql', sql: result.sql, elapsedMs: result.elapsedMs }
    : null

  useEffect(() => {
    api.config().then((cfg) => {
      setConfig(cfg)
      setDocumentsPath(cfg.documentsPath)
      if (cfg.parsers?.length) setParsers(cfg.parsers)
      if (cfg.defaultLeft) setLeftParser(cfg.defaultLeft)
      if (cfg.defaultRight) setRightParser(cfg.defaultRight)
      if (cfg.defaultMode) setMode(cfg.defaultMode)
    }).catch((err) => setError(err.message))
  }, [])

  // While the query overlay is on, append every executed SQL statement /
  // REST request to the history. Subscribing only when on keeps a no-op
  // tap out of the path; we clear the history when toggled back off.
  //
  // Turning it on seeds the history with the statement behind the
  // result already on screen — otherwise the overlay would sit empty
  // until the next parse, which for a cached result may never come.
  useEffect(() => {
    if (!showQueries) { setQueryLog({ history: [], idx: -1 }); return }
    const seed = resultSqlRef.current
    if (seed?.sql) {
      setQueryLog({
        history: [{
          endpoint: '/api/compare',
          mode: seed.mode,
          sql: seed.sql,
          elapsedMs: seed.elapsedMs,
        }],
        idx: 0,
      })
    } else {
      setQueryLog({ history: [], idx: -1 })
    }
    return api.onQuery((q) => {
      setQueryLog((cur) => {
        const history = [...cur.history, q].slice(-QUERY_HISTORY_MAX)
        // Always jump to the newest query when a fresh comparison runs so
        // switching from REST -> DBSQL (or vice versa) immediately displays
        // the latest run's query instead of staying parked on an older entry.
        return { history, idx: history.length - 1 }
      })
    })
  }, [showQueries])

  // Arrow through the query history. Clamped to the visible range.
  function stepQuery(delta, maxLen) {
    setQueryLog((cur) => {
      const len = maxLen ?? cur.history.length
      if (!len) return cur
      const base = Math.min(len - 1, Math.max(0, cur.idx))
      const idx = Math.min(len - 1, Math.max(0, base + delta))
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

  // Run one or both parsers over one page (or all pages). Guarded against
  // out-of-order responses; a parse can take minutes, so a stale one must not win.
  const runCompare = useCallback(async (filePath, page, refresh = false) => {
    if (!filePath) return
    if (leftParser === 'none' && rightParser === 'none') {
      setError('Choose at least one parser.')
      return
    }
    const seq = ++reqSeq.current
    setComparing(true)
    setError(null)
    try {
      const data = await api.compare({
        path: filePath, left: leftParser, right: rightParser, mode, pageIndex: page, pageMode, refresh,
      })
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
  }, [leftParser, rightParser, mode, pageMode])

  // Pick a document — load a preview only. Parsing waits for the
  // sidebar button so the analyst can see the file first.
  function onSelectDocument(filePath) {
    setSelectedPath(filePath)
    setPageIndex(0)
    setPageCount(1)
    setResult(null)
    setPreview(null)
    setHiddenTypes(new Set())
    setPinned(null)
    setHovered(null)
    setError(null)
    const seq = ++previewSeq.current
    setLoadingPreview(true)
    api.preview(filePath).then((data) => {
      if (seq !== previewSeq.current) return
      setPreview(data)
      setPageCount(data.pageCount || 1)
    }).catch((err) => {
      if (seq !== previewSeq.current) return
      setError(err.message)
    }).finally(() => {
      if (seq === previewSeq.current) setLoadingPreview(false)
    })
  }

  // Upload a PDF or image to the current volume directory, refresh the
  // document list, and select the uploaded file for preview.
  async function onUploadFile(file) {
    if (!file || !documentsPath) return
    setUploading(true)
    setError(null)
    try {
      const { document } = await api.upload(documentsPath, file)
      await loadDocuments(documentsPath)
      if (document?.path) onSelectDocument(document.path)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  // Slice a full-document (`pageMode === 'all'`) result to a specific page
  // using the server-returned `pageCache`, so paging through an already-
  // parsed document is instantaneous.
  function withPage(res, page) {
    const slice = res?.pageCache?.[page] ?? res?.pageCache?.[String(page)]
    if (!slice) return null
    return {
      ...res,
      pageIndex: page,
      pageImage: slice.pageImage,
      pageAspect: slice.pageAspect,
      elements: slice.elements,
      envelopes: slice.envelopes,
    }
  }

  // Page through a multi-page PDF. When an all-pages parse is loaded we
  // swap in that page's cached slice; otherwise preview follows the pager
  // and clicking Run comparison parses the page on screen.
  function onChangePage(next) {
    const page = Math.max(0, Math.min(pageCount - 1, next))
    if (page === pageIndex || !selectedPath) return
    setPageIndex(page)
    setPinned(null)
    setHovered(null)
    if (result?.pageMode === 'all' && result.pageCache) {
      const sliced = withPage(result, page)
      if (sliced) {
        setResult(sliced)
        return
      }
    }
    setResult(null)
  }

  // Parse the current page (or all pages). A first run may reuse the server
  // cache; clicking again on the same engines + mode + scope bypasses it.
  function onParse() {
    if (!selectedPath) return
    const targetPage = pageMode === 'current' ? 0 : pageIndex
    if (pageMode === 'current' && pageIndex !== 0) setPageIndex(0)
    const sameEngines = result
      && result.sides?.custom?.id === leftParser
      && result.sides?.native?.id === rightParser
      && (result.mode || 'dbsql') === mode
      && (result.pageMode || 'current') === pageMode
    runCompare(selectedPath, targetPage, Boolean(sameEngines))
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
  const singleParse = leftParser === 'none' || rightParser === 'none'
  const leftResultSkipped = result?.sides?.custom?.kind === 'none'
  const rightResultSkipped = result?.sides?.native?.kind === 'none'

  return (
    <div className="app">
      <ControlPanel
        documentsPath={documentsPath}
        setDocumentsPath={setDocumentsPath}
        onReloadDocuments={() => loadDocuments(documentsPath)}
        documents={documents}
        loadingDocuments={loadingDocuments}
        uploading={uploading}
        onUploadFile={onUploadFile}
        selectedPath={selectedPath}
        onSelectDocument={onSelectDocument}
        parsers={parsers}
        leftParser={leftParser}
        rightParser={rightParser}
        setLeftParser={setLeftParser}
        setRightParser={setRightParser}
        mode={mode}
        setMode={setMode}
        pageMode={pageMode}
        setPageMode={setPageMode}
        pageCount={pageCount}
        onParse={onParse}
        comparing={comparing}
        loadingPreview={loadingPreview}
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

          {selectedPath && pageCount > 1 && (
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
              <span className="pill pill-mode">
                {result.mode === 'rest' ? 'REST API' : 'DBSQL'}
              </span>
              {!leftResultSkipped && (
                <span className="pill pill-custom">
                  {result.sides?.custom?.shortLabel || 'left'} {result.metrics.custom.elements}
                </span>
              )}
              {!rightResultSkipped && (
                <span className="pill pill-native">
                  {result.sides?.native?.shortLabel || 'right'} {result.metrics.native.elements}
                </span>
              )}
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
              <p>
                {pageMode === 'all' && pageCount > 1
                  ? `Parsing all ${pageCount} pages`
                  : 'Parsing page 1'}
                {singleParse ? '…' : ' with both parsers…'}
                {' '}({mode === 'rest' ? 'REST API' : 'DBSQL'})
              </p>
              <p className="muted">
                {pageMode === 'all' && pageCount > 1
                  ? mode === 'rest'
                    ? 'In REST API mode, custom endpoints fan out parallel /serving-endpoints/<name>/invocations calls across every page while ai_parse_document parses the whole document in a single /api/2.0/ai-functions/ai-parse-document call.'
                    : 'In DBSQL mode, custom endpoints fan out across every page in parallel inside a single SQL statement (explode(sequence(0, N))). A cold scale-to-zero endpoint can take a few minutes.'
                  : mode === 'rest'
                    ? singleParse
                      ? 'Calling the selected parser directly via its real-time REST API. A serving endpoint runs a vision model plus an LLM reformat pass; a cold scale-to-zero endpoint can take a few minutes.'
                      : 'Calling both parsers in parallel via their real-time REST APIs (/api/2.0/ai-functions/ai-parse-document and /serving-endpoints/<name>/invocations) and timing each call independently.'
                    : singleParse
                      ? 'The selected parser runs as its own Databricks SQL statement. A serving endpoint runs a vision model plus an LLM reformat pass; a cold scale-to-zero endpoint can take a few minutes.'
                      : 'Each parser runs as its own statement, one after the other, so their run times can be compared. A serving endpoint runs a vision model plus an LLM reformat pass; a cold scale-to-zero endpoint can take a few minutes.'}
              </p>
            </div>
          )}

          {!comparing && !result && !selectedPath && (
            <div className="empty">
              <h2>Compare two document parsers side by side</h2>
              <p className="muted">
                Choose <strong>DBSQL</strong> or <strong>REST API</strong> mode and a
                parser for each pane — or <strong>No model</strong> on one
                side to run a single parser. Pick a PDF or image from the volume
                to preview it, choose <strong>First page</strong> or <strong>All pages</strong>,
                then click <strong>Run comparison</strong> when you are ready.
                Each selected side is timed independently so run times, bounding
                boxes, markdown, and JSON can be compared directly.
              </p>
            </div>
          )}

          {!comparing && !result && selectedPath && (
            <DocumentPreview
              preview={preview}
              pageIndex={pageIndex}
              pageMode={pageMode}
              loading={loadingPreview}
            />
          )}

          {/* Run time head-to-head, above whichever view is selected. */}
          {!comparing && result && <TimingBar result={result} />}

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
              sides={result.sides}
            />
          )}
        </div>

        {/* Live SQL / REST request overlay — the parsing statement that just ran. */}
        {showQueries && (
          <div className="query-overlay">
            {(() => {
              // Filter history to match the active mode (or current result's mode)
              // so toggling between DBSQL and REST API never shows a stale REST
              // payload when inspecting DBSQL queries (or vice versa).
              const activeMode = result?.mode || mode
              const matching = queryLog.history.filter(
                (item) => !item.mode || item.mode === activeMode,
              )
              // Fall back to the current result's sql if it matches the mode
              // and isn't in history yet, or to full history if nothing matches.
              const list = matching.length
                ? matching
                : (result?.sql && (result.mode || 'dbsql') === activeMode)
                  ? [{
                      endpoint: '/api/compare',
                      mode: activeMode,
                      sql: result.sql,
                      elapsedMs: result.elapsedMs,
                    }]
                  : queryLog.history
              if (!list.length) {
                return (
                  <span className="muted">
                    {activeMode === 'rest'
                      ? 'Waiting for a REST request…'
                      : 'Waiting for a parsing query…'}
                  </span>
                )
              }
              const clampedIdx = Math.min(list.length - 1, Math.max(0, queryLog.idx))
              const cur = list[clampedIdx]
              const atOldest = clampedIdx <= 0
              const atNewest = clampedIdx >= list.length - 1
              return (
                <>
                  <div className="query-head">
                    <span className="query-endpoint">
                      {cur.endpoint}
                      {cur.mode ? ` (${cur.mode === 'rest' ? 'REST API' : 'DBSQL'})` : ''}
                    </span>
                    {cur.elapsedMs != null && (
                      <span className="query-time">{cur.elapsedMs.toLocaleString()} ms</span>
                    )}
                    <span className="query-nav">
                      <button
                        type="button"
                        onClick={() => stepQuery(-1, list.length)}
                        disabled={atOldest}
                        aria-label="Previous query"
                      >←</button>
                      <span className="query-pos">{clampedIdx + 1}/{list.length}</span>
                      <button
                        type="button"
                        onClick={() => stepQuery(1, list.length)}
                        disabled={atNewest}
                        aria-label="Next query"
                      >→</button>
                    </span>
                  </div>
                  <pre className="query-sql">{cur.sql}</pre>
                </>
              )
            })()}
          </div>
        )}

        <div className="status">
          {comparing
            ? (singleParse ? 'Parsing…' : 'Running both parsers…')
            : result
              ? `${result.path.split('/').pop()} · page ${pageIndex + 1} of ${pageCount}${result.pageMode === 'all' && pageCount > 1 ? ' (all pages parsed)' : ''}`
              : selectedPath
                ? `Previewing ${selectedPath.split('/').pop()} · page ${pageIndex + 1} of ${pageCount}`
                : 'No document selected'}
          {config && (
            <span className="conn">
              {config.connected ? ' · live' : ' · no warehouse'} ·{' '}
              {mode === 'rest' ? 'REST API' : 'DBSQL'} ·{' '}
              {parsers.find((p) => p.id === leftParser)?.label || leftParser}
              {' vs '}
              {parsers.find((p) => p.id === rightParser)?.label || rightParser}
            </span>
          )}
        </div>
      </main>
    </div>
  )
}
