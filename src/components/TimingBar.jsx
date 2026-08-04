// ============================================================
// components/TimingBar.jsx — head-to-head run time
//
// The two parsers run as two separate SQL statements (see /api/compare
// in server.js), so each one's duration is measured on its own. This bar
// sits above the side-by-side results and puts those two numbers next to
// each other, with a proportional bar so the gap reads at a glance.
//
// Caveats it has to be honest about:
//   • A cached result reports the duration of the run that produced it,
//     not of the instant cache hit.
//   • A scale-to-zero endpoint's first call includes cold-start time,
//     which says more about provisioning than about parse speed.
//   • The custom endpoint parses ONE page; native parses the whole
//     document. On a multi-page PDF that favors the custom side, so we
//     say so rather than implying a clean win.
// ============================================================

function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function Row({ side, label, ms, failure, widthPct, faster }) {
  return (
    <div className={`timing-row side-${side} ${failure ? 'failed' : ''}`}>
      <span className={`pill pill-${side}`}>{side}</span>
      <span className="timing-label">{label}</span>
      <span className="timing-track">
        <span className="timing-fill" style={{ width: `${widthPct}%` }} />
      </span>
      <span className="timing-value">
        {failure ? 'failed' : formatDuration(ms)}
        {faster && !failure && <span className="timing-badge">fastest</span>}
      </span>
    </div>
  )
}

export default function TimingBar({ result, endpoint }) {
  const custom = result.metrics.custom
  const native = result.metrics.native
  const c = custom.durationMs
  const n = native.durationMs

  // Scale both bars against the slower of the two.
  const max = Math.max(c || 0, n || 0) || 1
  const pct = (ms) => (ms == null ? 0 : Math.max(2, (ms / max) * 100))

  // Only claim a winner when both actually produced a time.
  const bothRan = c != null && n != null
  const ratio = bothRan && Math.min(c, n) > 0 ? Math.max(c, n) / Math.min(c, n) : null
  const nativeFaster = bothRan && n < c

  return (
    <div className="timing-bar">
      <div className="timing-head">
        <h3>Parse time</h3>
        {ratio != null && ratio >= 1.1 && (
          <span className="timing-summary">
            {nativeFaster ? 'ai_parse_document' : 'custom endpoint'} was{' '}
            <strong>{ratio.toFixed(1)}×</strong> faster
          </span>
        )}
        {result.cached && (
          <span className="timing-note">from cache — times are from the original run</span>
        )}
      </div>

      <Row
        side="custom"
        label={endpoint || 'serving endpoint'}
        ms={c}
        failure={custom.failure}
        widthPct={pct(c)}
        faster={bothRan && !nativeFaster}
      />
      <Row
        side="native"
        label="ai_parse_document"
        ms={n}
        failure={native.failure}
        widthPct={pct(n)}
        faster={bothRan && nativeFaster}
      />

      <p className="timing-caveat">
        Measured per statement, run back to back on the same warehouse.{' '}
        {native.pages > 1 && (
          <>
            The custom endpoint parsed 1 page; <code>ai_parse_document</code> parsed
            all {native.pages}.{' '}
          </>
        )}
        A cold scale-to-zero endpoint includes start-up time.
      </p>

      {(custom.failure || native.failure) && (
        <p className="timing-failure">
          {custom.failure && <>custom: {custom.failure}<br /></>}
          {native.failure && <>native: {native.failure}</>}
        </p>
      )}
    </div>
  )
}
