// ============================================================
// components/PageViewer.jsx — side-by-side bounding-box overlay
//
// Both panes draw the SAME rendered page image (the one
// ai_parse_document wrote to the volume via imageOutputPath) with a
// different parser's boxes on top. That is deliberate: overlaying both
// parsers on one identical raster is the only way a difference in boxes
// is attributable to the parser rather than to the rendering.
//
// The server already converted every box into page-relative percentages
// (see normalizeElements in server.js), so positioning is just a CSS
// percentage — no DPI or image-size math in the browser.
// ============================================================
import { colorForType } from './colors.js'

function BoxPane({ side, pill, title, elements, pageImage, hiddenTypes, active, onHover, onSelect }) {
  const visible = elements.filter((el) => !hiddenTypes.has(el.type))

  return (
    <section className="pane">
      <header className="pane-head">
        <span className={`pill pill-${side}`}>{pill || side}</span>
        <h3>{title}</h3>
        <span className="pane-stat">{visible.length} boxes</span>
      </header>

      <div className="page-stage">
        {pageImage ? (
          <img src={pageImage} alt={`Rendered page (${side})`} className="page-image" />
        ) : (
          <p className="muted">No rendered page image available</p>
        )}

        {visible.map((el) =>
          el.rects.map((rect, i) => {
            const token = `${side}:${el.idx}`
            const isActive = active === token
            return (
              <button
                key={`${el.idx}-${i}`}
                type="button"
                className={`bbox ${isActive ? 'active' : ''}`}
                style={{
                  left: `${rect.left}%`,
                  top: `${rect.top}%`,
                  width: `${rect.width}%`,
                  height: `${rect.height}%`,
                  '--box-color': colorForType(el.type),
                }}
                title={`${el.type}: ${(el.content || el.description || '').slice(0, 160)}`}
                onMouseEnter={() => onHover(token)}
                onMouseLeave={() => onHover(null)}
                onClick={() => onSelect(token)}
              >
                <span className="bbox-label">{el.type}</span>
              </button>
            )
          }),
        )}
      </div>
    </section>
  )
}

export default function PageViewer({ result, hiddenTypes, active, onHover, onSelect }) {
  const left = result.sides?.custom
  const right = result.sides?.native
  const leftTitle = left?.kind === 'endpoint' ? (left.endpoint || left.label) : (left?.label || result.path.split('/').pop())
  const rightTitle = right?.kind === 'endpoint' ? (right.endpoint || right.label) : (right?.label || 'ai_parse_document')

  return (
    <div className="compare-grid">
      <BoxPane
        side="custom"
        pill={left?.shortLabel || 'left'}
        title={leftTitle}
        elements={result.elements.custom}
        pageImage={result.pageImage}
        hiddenTypes={hiddenTypes}
        active={active}
        onHover={onHover}
        onSelect={onSelect}
      />
      <BoxPane
        side="native"
        pill={right?.shortLabel || 'right'}
        title={rightTitle}
        elements={result.elements.native}
        pageImage={result.pageImage}
        hiddenTypes={hiddenTypes}
        active={active}
        onHover={onHover}
        onSelect={onSelect}
      />
    </div>
  )
}
