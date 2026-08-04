// Element-type palette, shared by the overlay boxes, the markdown
// pane, and the sidebar filter chips so one type is always one color.
//
// The hues follow the Databricks document-parsing UI convention:
// structural headings warm (red/pink), body content cool (teal/blue),
// so a page reads at a glance even before you look at the labels.
export const TYPE_COLORS = {
  title: '#f2617a',
  section_header: '#f2617a',
  page_header: '#ff9a6b',
  page_footer: '#ff9a6b',
  page_number: '#ff9a6b',
  text: '#3bd2b5',
  caption: '#7cc7ff',
  footnote: '#a78bfa',
  table: '#ffd92f',
  figure: '#c46bf2',
}

export const FALLBACK_COLOR = '#8b949e'

export function colorForType(type) {
  return TYPE_COLORS[String(type || '').toLowerCase()] || FALLBACK_COLOR
}
