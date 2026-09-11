// ============================================================
// components/PageViewer.jsx — side-by-side bounding-box overlay
//
// Both panes draw the SAME page raster with a different parser's boxes
// on top. Prefer the JPEG ai_parse_document wrote via imageOutputPath;
// if native wasn't a selected model (or that write is missing), fall
// back to the source image or the source PDF so endpoint-only
// comparisons still have a page to overlay.
//
// The server already converted every box into page-relative percentages
// (see normalizeElements in server.js), so positioning is just a CSS
// percentage — no DPI or image-size math in the browser.
// ============================================================
import { colorForType } from './colors.js'
import PageBackdrop from './PageBackdrop.jsx'

function BoxPane({
  side, pill, title, elements, pageImage, sourceFile, pageIndex, path, pageAspect,
  hiddenTypes, active, onHover, onSelect,
}) {
  const visible = elements.filter((el) => !hiddenTypes.has(el.type))
  const boxed = visible.filter((el) => el.rects?.length)

  return (
    <section className="pane">
      <header className="pane-head">
        <span className={`pill pill-${side}`}>{pill || side}</span>
        <h3>{title}</h3>
        <span className="pane-stat">{boxed.length} boxes</span>
      </header>

      <div className="page-stage">
        <PageBackdrop
          pageImage={pageImage}
          sourceFile={sourceFile}
          pageIndex={pageIndex}
          path={path}
          side={side}
          pageAspect={pageAspect}
        />

        {boxed.map((el) =>
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
  const leftSkipped = left?.kind === 'none'
  const rightSkipped = right?.kind === 'none'
  const leftTitle = left?.kind === 'endpoint' ? (left.endpoint || left.label) : (left?.label || result.path.split('/').pop())
  const rightTitle = right?.kind === 'endpoint' ? (right.endpoint || right.label) : (right?.label || 'ai_parse_document')
  const backdrop = {
    pageImage: result.pageImage,
    sourceFile: result.sourceFile
      || (result.path ? `/api/document-file?path=${encodeURIComponent(result.path)}` : null),
    pageIndex: result.pageIndex || 0,
    path: result.path,
    pageAspect: result.pageAspect,
  }

  return (
    <div className={`compare-grid${leftSkipped || rightSkipped ? ' single' : ''}`}>
      {!leftSkipped && (
        <BoxPane
          side="custom"
          pill={left?.shortLabel || 'left'}
          title={leftTitle}
          elements={result.elements.custom}
          hiddenTypes={hiddenTypes}
          active={active}
          onHover={onHover}
          onSelect={onSelect}
          {...backdrop}
        />
      )}
      {!rightSkipped && (
        <BoxPane
          side="native"
          pill={right?.shortLabel || 'right'}
          title={rightTitle}
          elements={result.elements.native}
          hiddenTypes={hiddenTypes}
          active={active}
          onHover={onHover}
          onSelect={onSelect}
          {...backdrop}
        />
      )}
    </div>
  )
}
