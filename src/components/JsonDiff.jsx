// ============================================================
// components/JsonDiff.jsx — structural diff of the two envelopes
//
// Both parsers are cast through the same ai_parse_document 2.0 schema
// in SQL, so a field that only one side populates is real schema drift
// rather than a parsing artifact. We flatten each envelope to leaf
// JSON paths and align them, which makes three things obvious:
//
//   • changed  — both sides have the path, values differ
//   • custom-only / native-only — the path is missing on one side
//
// Deep element-by-element alignment is intentionally NOT attempted:
// the two parsers group text into different numbers of elements, so
// $.document.elements[7] is not the same element on both sides. The
// path-level diff tells you about the envelope's shape; the overlay
// and markdown views are where you compare content.
// ============================================================
import { useMemo, useState } from 'react'

const MISSING = Symbol('missing')

// Flatten to { 'json.path': leafValue }. Empty containers are kept as
// leaves so "one side has an empty array here" still shows up.
function flatten(value, path = '$', out = {}) {
  if (Array.isArray(value)) {
    if (!value.length) out[path] = '[]'
    else value.forEach((item, i) => flatten(item, `${path}[${i}]`, out))
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) out[path] = '{}'
    else keys.sort().forEach((k) => flatten(value[k], `${path}.${k}`, out))
  } else {
    out[path] = value
  }
  return out
}

function display(value) {
  if (value === MISSING) return '— missing —'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export default function JsonDiff({ custom, native }) {
  // 'diff' aligns leaf paths; 'raw' shows the two envelopes verbatim.
  const [mode, setMode] = useState('diff')
  // Hide paths that are identical on both sides — usually most of them.
  const [onlyDifferences, setOnlyDifferences] = useState(true)

  const { rows, counts } = useMemo(() => {
    const left = flatten(custom)
    const right = flatten(native)
    const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    const counts = { changed: 0, customOnly: 0, nativeOnly: 0, equal: 0 }

    const rows = paths.map((path) => {
      const a = path in left ? left[path] : MISSING
      const b = path in right ? right[path] : MISSING
      let state
      if (a === MISSING) { state = 'native-only'; counts.nativeOnly++ }
      else if (b === MISSING) { state = 'custom-only'; counts.customOnly++ }
      else if (JSON.stringify(a) !== JSON.stringify(b)) { state = 'changed'; counts.changed++ }
      else { state = 'equal'; counts.equal++ }
      return { path, a, b, state }
    })

    return { rows, counts }
  }, [custom, native])

  const shown = onlyDifferences ? rows.filter((r) => r.state !== 'equal') : rows

  return (
    <div className="json-view">
      <div className="json-toolbar">
        <div className="view-toggle small">
          <button
            type="button"
            className={mode === 'diff' ? 'active' : ''}
            onClick={() => setMode('diff')}
          >Aligned diff</button>
          <button
            type="button"
            className={mode === 'raw' ? 'active' : ''}
            onClick={() => setMode('raw')}
          >Raw JSON</button>
        </div>

        {mode === 'diff' && (
          <>
            <span className="pill pill-changed">{counts.changed} changed</span>
            <span className="pill pill-custom">{counts.customOnly} custom-only</span>
            <span className="pill pill-native">{counts.nativeOnly} native-only</span>
            <span className="muted">{counts.equal} identical</span>
            <label className="footer-toggle inline">
              <input
                type="checkbox"
                checked={onlyDifferences}
                onChange={() => setOnlyDifferences((v) => !v)}
              />
              <span>Differences only</span>
            </label>
          </>
        )}
      </div>

      {mode === 'diff' ? (
        <div className="diff-grid">
          <div className="diff-row diff-header">
            <div>JSON path</div>
            <div>custom endpoint</div>
            <div>ai_parse_document</div>
          </div>
          {!shown.length ? (
            <p className="muted">The two envelopes are structurally identical.</p>
          ) : (
            shown.map((r) => (
              <div key={r.path} className={`diff-row ${r.state}`}>
                <code className="diff-path">{r.path}</code>
                <pre className="diff-value">{display(r.a)}</pre>
                <pre className="diff-value">{display(r.b)}</pre>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="compare-grid">
          <section className="pane">
            <header className="pane-head">
              <span className="pill pill-custom">custom</span>
              <h3>Serving endpoint</h3>
            </header>
            <pre className="raw-json">{JSON.stringify(custom, null, 2)}</pre>
          </section>
          <section className="pane">
            <header className="pane-head">
              <span className="pill pill-native">native</span>
              <h3>ai_parse_document</h3>
            </header>
            <pre className="raw-json">{JSON.stringify(native, null, 2)}</pre>
          </section>
        </div>
      )}
    </div>
  )
}
