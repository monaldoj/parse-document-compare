// ============================================================
// components/MarkdownView.jsx — side-by-side extracted content
//
// The same elements as the overlay view, rendered as the markdown each
// parser actually produced, in reading order. This is the "Formatted"
// half of the Databricks document-parsing UI: element type headings,
// tables as real HTML tables, figures as their description.
//
// Hover/selection state is shared with the overlay view, so pointing at
// a paragraph here highlights the same paragraph's box there.
// ============================================================
import { marked } from 'marked'
import { colorForType } from './colors.js'

marked.setOptions({ gfm: true, breaks: false })

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

// Strip anything executable out of parser-produced HTML before it reaches
// dangerouslySetInnerHTML. Every element's text is model output, so it is
// untrusted: `marked` passes raw HTML through verbatim (it has no
// sanitizer since v5) and a table's markup is HTML by contract. We keep
// the structural markup that makes the view readable and drop script
// vectors: script/style/iframe-style tags and on* / javascript: handlers.
function sanitizeHtml(html) {
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    // Inline event handlers, quoted or bare.
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
}

// An element's content as display HTML. Tables arrive as HTML table
// markup (the 2.0 contract requires it) so they keep their structure;
// figures have no content and are represented by their description.
function elementHtml(el) {
  if (el.type === 'table' && el.content) return sanitizeHtml(el.content)
  if (el.content) return sanitizeHtml(marked.parse(el.content))
  if (el.description) return `<p class="figure-desc"><em>${escapeHtml(el.description)}</em></p>`
  return '<p class="muted">No content</p>'
}

function MarkdownPane({ side, pill, title, elements, hiddenTypes, active, onHover, onSelect }) {
  const visible = elements.filter((el) => !hiddenTypes.has(el.type))

  return (
    <section className="pane">
      <header className="pane-head">
        <span className={`pill pill-${side}`}>{pill || side}</span>
        <h3>{title}</h3>
        <span className="pane-stat">{visible.length} elements</span>
      </header>

      <div className="markdown-scroll">
        {!visible.length ? (
          <p className="muted">No elements returned for this page</p>
        ) : (
          visible.map((el) => {
            const token = `${side}:${el.idx}`
            const isActive = active === token
            return (
              <article
                key={el.idx}
                className={`md-item ${isActive ? 'active' : ''}`}
                style={{ '--box-color': colorForType(el.type) }}
                onMouseEnter={() => onHover(token)}
                onMouseLeave={() => onHover(null)}
                onClick={() => onSelect(token)}
              >
                <div className="md-meta">
                  <span className="md-type">{el.type}</span>
                  {el.confidence != null && (
                    <span className="md-confidence">
                      {(Number(el.confidence) * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
                <div
                  className="md-body"
                  dangerouslySetInnerHTML={{ __html: elementHtml(el) }}
                />
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}

export default function MarkdownView({ result, hiddenTypes, active, onHover, onSelect }) {
  const left = result.sides?.custom
  const right = result.sides?.native
  const leftSkipped = left?.kind === 'none'
  const rightSkipped = right?.kind === 'none'
  const leftTitle = left?.kind === 'endpoint' ? (left.endpoint || left.label) : (left?.label || result.path.split('/').pop())
  const rightTitle = right?.kind === 'endpoint' ? (right.endpoint || right.label) : (right?.label || 'ai_parse_document')

  return (
    <div className={`compare-grid${leftSkipped || rightSkipped ? ' single' : ''}`}>
      {!leftSkipped && (
        <MarkdownPane
          side="custom"
          pill={left?.shortLabel || 'left'}
          title={leftTitle}
          elements={result.elements.custom}
          hiddenTypes={hiddenTypes}
          active={active}
          onHover={onHover}
          onSelect={onSelect}
        />
      )}
      {!rightSkipped && (
        <MarkdownPane
          side="native"
          pill={right?.shortLabel || 'right'}
          title={rightTitle}
          elements={result.elements.native}
          hiddenTypes={hiddenTypes}
          active={active}
          onHover={onHover}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}
