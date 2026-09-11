// Overlay background: prefer the JPEG ai_parse_document wrote, then the
// source raster, then the source PDF in the browser. Endpoint-only
// comparisons often have no native image_uri; this still puts boxes on
// a real page instead of the empty-state copy.
import { useEffect, useState } from 'react'

export default function PageBackdrop({
  pageImage, sourceFile, pageIndex, path, side, pageAspect,
}) {
  const isPdf = (path || '').toLowerCase().endsWith('.pdf')
  const [nativeFailed, setNativeFailed] = useState(false)

  useEffect(() => { setNativeFailed(false) }, [pageImage])

  if (pageImage && !nativeFailed) {
    return (
      <img
        src={pageImage}
        alt={`Rendered page (${side})`}
        className="page-image"
        onError={() => setNativeFailed(true)}
      />
    )
  }
  if (!isPdf && sourceFile) {
    return <img src={sourceFile} alt={`Source page (${side})`} className="page-image" />
  }
  if (isPdf && sourceFile) {
    const src = `${sourceFile}#page=${(pageIndex || 0) + 1}&view=FitH&toolbar=0`
    return (
      <iframe
        className="page-image page-pdf-fallback"
        title={`Page ${(pageIndex || 0) + 1}`}
        src={src}
        style={pageAspect ? { aspectRatio: String(pageAspect) } : undefined}
      />
    )
  }
  return <p className="muted">No rendered page image available</p>
}
