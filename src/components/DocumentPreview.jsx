// Preview the selected volume file before any parser runs. Images render
// directly; PDFs use the browser's viewer, scrolled to the page the
// comparison will target once the analyst clicks Run comparison.

export default function DocumentPreview({ preview, pageIndex, loading }) {
  if (loading) {
    return (
      <div className="overlay-notice">
        <div className="spinner" />
        <p>Loading document…</p>
      </div>
    )
  }
  if (!preview) {
    return (
      <div className="empty">
        <p className="muted">
          Preview unavailable. Click <strong>Run comparison</strong> to parse this file.
        </p>
      </div>
    )
  }

  const name = preview.path.split('/').pop()
  const isPdf = preview.path.toLowerCase().endsWith('.pdf')
  const src = isPdf
    ? `${preview.fileUrl}#page=${pageIndex + 1}&view=FitH`
    : preview.fileUrl

  return (
    <div className="preview-wrap">
      <header className="preview-head">
        <h3>{name}</h3>
        <span className="muted">
          Preview only — click Run comparison to parse
          {preview.pageCount > 1 ? ` page ${pageIndex + 1}` : ' this file'}
        </span>
      </header>
      {isPdf ? (
        <iframe
          key={src}
          className="preview-frame"
          title={`Preview of ${name}`}
          src={src}
        />
      ) : (
        <div className="page-stage preview-stage">
          <img src={src} alt={name} className="page-image" />
        </div>
      )}
    </div>
  )
}
