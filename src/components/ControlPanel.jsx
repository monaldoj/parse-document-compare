// ============================================================
// components/ControlPanel.jsx — sidebar
//
// Top to bottom: the volume directory to browse, the documents in it,
// the two parser dropdowns (one per pane), and — once a comparison has
// run — the macro metrics and the element type filter. The SQL toggle
// is pinned to the footer.
// ============================================================
import { colorForType } from './colors.js'

// One metric row: the two parsers side by side, plus the delta where
// a signed number is meaningful.
function MetricRow({ label, custom, native, delta = false }) {
  const isNumeric = typeof custom === 'number' && typeof native === 'number'
  const diff = isNumeric ? custom - native : null
  const display = (v) =>
    Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v == null ? '—' : String(v)

  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{display(custom)}</td>
      <td>{display(native)}</td>
      {delta && (
        <td className={`delta ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`}>
          {isNumeric ? (diff > 0 ? `+${diff}` : String(diff)) : '—'}
        </td>
      )}
    </tr>
  )
}

export default function ControlPanel({
  documentsPath, setDocumentsPath, onReloadDocuments,
  documents, loadingDocuments, selectedPath, onSelectDocument,
  parsers, leftParser, rightParser, setLeftParser, setRightParser,
  onParse, comparing, loadingPreview, result, error,
  presentTypes, hiddenTypes, onToggleType,
  showQueries, onToggleQueries,
}) {
  const metrics = result?.metrics
  const left = result?.sides?.custom
  const right = result?.sides?.native
  const leftLabel = left?.shortLabel || 'left'
  const rightLabel = right?.shortLabel || 'right'
  const mixedPageScope = (left?.kind === 'endpoint' && right?.kind === 'native')
    || (left?.kind === 'native' && right?.kind === 'endpoint')
  const enginesDirty = result && (
    left?.id !== leftParser || right?.id !== rightParser
  )
  // An endpoint parses ONE page per call while ai_parse_document parses
  // the whole document, so envelope-wide totals aren't comparable on a
  // multi-page PDF. The per-page counts are — both sides are already
  // filtered to the page on screen.
  const perPage = result
    ? {
        custom: result.elements.custom.length,
        native: result.elements.native.length,
      }
    : null

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        <h1>Parser Compare</h1>
        <p className="subtitle">
          Two parsers side by side on Databricks SQL
        </p>

        <form onSubmit={(e) => { e.preventDefault(); onReloadDocuments() }}>
          <label>
            Volume directory
            <input
              type="text"
              value={documentsPath}
              onChange={(e) => setDocumentsPath(e.target.value)}
              placeholder="/Volumes/catalog/schema/volume"
              autoComplete="off"
              spellCheck="false"
            />
          </label>

          <label>
            Left parser
            <select
              value={leftParser}
              onChange={(e) => setLeftParser(e.target.value)}
              disabled={comparing || !parsers.length}
            >
              {parsers.map((p) => (
                <option key={p.id} value={p.id}>{p.endpoint || p.label}</option>
              ))}
            </select>
          </label>

          <label>
            Right parser
            <select
              value={rightParser}
              onChange={(e) => setRightParser(e.target.value)}
              disabled={comparing || !parsers.length}
            >
              {parsers.map((p) => (
                <option key={p.id} value={p.id}>{p.endpoint || p.label}</option>
              ))}
            </select>
          </label>
        </form>

        {error && <p className="error">{error}</p>}

        {/* Documents in the volume. Picking one loads a preview; parsing
            waits for the button below. */}
        <div className="result">
          <h2>
            Documents
            <span className="badge">
              {loadingDocuments ? '…' : `${documents.length}`}
            </span>
          </h2>
          {loadingDocuments ? (
            <p className="muted">Listing volume…</p>
          ) : !documents.length ? (
            <p className="muted">No PDF or image files found</p>
          ) : (
            <ul className="doc-list">
              {documents.map((doc) => (
                <li key={doc.path}>
                  <button
                    type="button"
                    className={`doc-row ${selectedPath === doc.path ? 'selected' : ''}`}
                    onClick={() => onSelectDocument(doc.path)}
                    disabled={comparing}
                  >
                    <span className="doc-name">{doc.name}</span>
                    <span className="doc-size">
                      {(doc.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selectedPath && (
          <button
            type="button"
            className="rerun-btn"
            onClick={onParse}
            disabled={comparing || loadingPreview}
          >
            {comparing
              ? 'Parsing…'
              : enginesDirty
                ? 'Re-run to apply parser changes'
                : result
                  ? 'Re-run comparison'
                  : 'Run comparison'}
          </button>
        )}

        {/* Macro metrics — the "are these even close?" answer. */}
        {metrics && (
          <div className="result">
            <h2>Metrics</h2>
            <table className="metrics">
              <thead>
                <tr>
                  <th />
                  <th className="side-custom">{leftLabel}</th>
                  <th className="side-native">{rightLabel}</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow
                  label="Elements (page)"
                  custom={perPage.custom}
                  native={perPage.native}
                  delta
                />
                <MetricRow label="Elements (doc)" custom={metrics.custom.elements} native={metrics.native.elements} />
                <MetricRow label="Pages parsed" custom={metrics.custom.pages} native={metrics.native.pages} />
                <MetricRow label="Version" custom={metrics.custom.version} native={metrics.native.version} />
                <MetricRow label="Types" custom={metrics.custom.types} native={metrics.native.types} />
              </tbody>
            </table>

            {mixedPageScope && (metrics.custom.pages > 1 || metrics.native.pages > 1) && (
              <p className="metrics-note">
                Serving endpoints parse one page per call;{' '}
                <code>ai_parse_document</code> parses the whole document at
                once. Only the per-page row compares like with like.
              </p>
            )}

            {/* error_status from either side is the thing you most want
                to notice — the custom endpoint falls back to a
                spans-only envelope when its LLM reformat pass fails. */}
            {(metrics.custom.errors?.length > 0 || metrics.native.errors?.length > 0) && (
              <div className="parse-errors">
                {metrics.custom.errors?.map((e, i) => (
                  <p key={`c${i}`} className="parse-error">
                    <strong>{leftLabel}:</strong> {e}
                  </p>
                ))}
                {metrics.native.errors?.map((e, i) => (
                  <p key={`n${i}`} className="parse-error">
                    <strong>{rightLabel}:</strong> {e}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Element type filter — shared by the overlay and markdown
            views so both hide the same things. */}
        {presentTypes.length > 0 && (
          <div className="result">
            <h2>
              Element types
              <span className="badge">{presentTypes.length - hiddenTypes.size} shown</span>
            </h2>
            <div className="type-chips">
              {presentTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`chip ${hiddenTypes.has(type) ? 'off' : ''}`}
                  style={{ '--chip-color': colorForType(type) }}
                  onClick={() => onToggleType(type)}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Pinned footer — reveal the parsing SQL that actually ran. */}
      <div className="sidebar-footer">
        <label className="footer-toggle">
          <input type="checkbox" checked={showQueries} onChange={onToggleQueries} />
          <span>Show parsing queries</span>
        </label>
      </div>
    </aside>
  )
}
