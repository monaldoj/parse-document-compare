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
//   • An endpoint parses ONE page; ai_parse_document parses the whole
//     document. On a multi-page PDF that favors the endpoint side, so we
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

function Row({ side, pill, label, ms, failure, widthPct, faster }) {
  return (
    <div className={`timing-row side-${side} ${failure ? 'failed' : ''}`}>
      <span className={`pill pill-${side}`}>{pill}</span>
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

function sideCopy(side) {
  if (!side) return { pill: 'parser', label: 'parser' }
  if (side.kind === 'none') {
    return { pill: side.shortLabel || 'No model', label: side.label || 'No model' }
  }
  if (side.kind === 'endpoint') {
    return { pill: side.shortLabel, label: side.endpoint || side.label }
  }
  return { pill: side.shortLabel, label: side.label }
}

export default function TimingBar({ result }) {
  const custom = result.metrics.custom
  const native = result.metrics.native
  const left = result.sides?.custom
  const right = result.sides?.native
  const leftCopy = sideCopy(left)
  const rightCopy = sideCopy(right)
  const leftSkipped = left?.kind === 'none' || custom?.skipped
  const rightSkipped = right?.kind === 'none' || native?.skipped
  const c = custom.durationMs
  const n = native.durationMs
  const sameEngine = left?.id && left.id === right?.id && !leftSkipped && !rightSkipped

  // Scale both bars against the slower of the two (or the one that ran).
  const max = Math.max(c || 0, n || 0) || 1
  const pct = (ms) => (ms == null ? 0 : Math.max(2, (ms / max) * 100))

  // Only claim a winner when both actually produced a time.
  const bothRan = c != null && n != null && !sameEngine && !leftSkipped && !rightSkipped
  const ratio = bothRan && Math.min(c, n) > 0 ? Math.max(c, n) / Math.min(c, n) : null
  const rightFaster = bothRan && n < c
  const mixedPageScope = ((left?.kind === 'endpoint' && right?.kind === 'native')
    || (left?.kind === 'native' && right?.kind === 'endpoint'))
    && result.pageMode !== 'all'
  const wholeDocPages = Math.max(custom.pages || 0, native.pages || 0)

  return (
    <div className="timing-bar">
      <div className="timing-head">
        <h3>Parse time</h3>
        {sameEngine && (
          <span className="timing-note">same engine on both sides — parsed once</span>
        )}
        {(leftSkipped || rightSkipped) && !sameEngine && (
          <span className="timing-note">single parser — the other side was No model</span>
        )}
        {ratio != null && ratio >= 1.1 && (
          <span className="timing-summary">
            {rightFaster ? rightCopy.pill : leftCopy.pill} was{' '}
            <strong>{ratio.toFixed(1)}×</strong> faster
          </span>
        )}
        {result.cached && (
          <span className="timing-note">from cache — times are from the original run</span>
        )}
      </div>

      {!leftSkipped && (
        <Row
          side="custom"
          pill={leftCopy.pill}
          label={leftCopy.label}
          ms={c}
          failure={custom.failure}
          widthPct={pct(c)}
          faster={bothRan && !rightFaster}
        />
      )}
      {!rightSkipped && (
        <Row
          side="native"
          pill={rightCopy.pill}
          label={rightCopy.label}
          ms={n}
          failure={native.failure}
          widthPct={pct(n)}
          faster={bothRan && rightFaster}
        />
      )}

      <p className="timing-caveat">
        Measured per statement
        {!leftSkipped && !rightSkipped ? ', run back to back on the same warehouse' : ''}
        .{' '}
        {mixedPageScope && wholeDocPages > 1 && (
          <>
            The serving endpoint parsed 1 page; <code>ai_parse_document</code> parsed
            all {wholeDocPages}.{' '}
          </>
        )}
        {result.pageMode === 'all' && wholeDocPages > 1 && (
          <>
            All {wholeDocPages} pages were parsed
            {left?.kind === 'endpoint' || right?.kind === 'endpoint'
              ? ' — serving endpoints fanned out in parallel'
              : ''}
            .{' '}
          </>
        )}
        A cold scale-to-zero endpoint includes start-up time.
      </p>

      {(custom.failure || native.failure) && (
        <p className="timing-failure">
          {custom.failure && <>{leftCopy.pill}: {custom.failure}<br /></>}
          {native.failure && <>{rightCopy.pill}: {native.failure}</>}
        </p>
      )}
    </div>
  )
}
