import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import { PDFDocument } from 'pdf-lib'

import {
  DOCUMENTS_PATH,
  DEFAULT_ENDPOINT,
  DEFAULT_LEFT,
  DEFAULT_RIGHT,
  DEFAULT_MODE,
  EXECUTION_MODES,
  IMAGE_OUTPUT_PATH,
  CUSTOM_RENDER_DPI,
  PARSE_SCHEMA,
  PARSERS,
  getParser,
  parseQueryFor,
  pageImagesQuery,
  makeNativeRestPayload,
  makeEndpointPayload,
  renderRestRequest,
} from './queries.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

// Databricks workspace host — normalized to include the scheme.
// Required: set DATABRICKS_HOST per-workspace (in a deployed Databricks
// App it is injected automatically).
const rawHost = process.env.DATABRICKS_HOST || ''
const DB_HOST = rawHost.startsWith('http') ? rawHost : rawHost ? `https://${rawHost}` : ''

// Warehouse that runs the parsing SQL. Prefer WAREHOUSE_ID; otherwise
// derive it from a classic SQL_WAREHOUSE_HTTP_PATH like
// /sql/1.0/warehouses/<id> so either env var works. Required per-workspace.
const WAREHOUSE_ID =
  process.env.WAREHOUSE_ID ||
  (process.env.SQL_WAREHOUSE_HTTP_PATH || '').split('/').pop() ||
  ''

// Documents the browser will list. Only these extensions are parseable.
const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg']

function mimeForPath(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

// Volume files the UI may preview. Normalize first so `..` cannot escape
// `/Volumes`, then require a supported extension.
function resolveDocumentPath(filePath) {
  const uri = path.posix.normalize((filePath || '').toString())
  if (!uri.startsWith('/Volumes/')) return null
  if (!SUPPORTED_EXTENSIONS.some((ext) => uri.toLowerCase().endsWith(ext))) return null
  return uri
}

// ------------------------------------------------------------
// Auth — Databricks Apps uses M2M OAuth; locally we accept a PAT.
// Same token ladder as Repo A (cotraveler): PAT -> cached OAuth ->
// client_credentials exchange -> mounted token file.
// ------------------------------------------------------------
let cachedToken = null
let tokenExpiry = 0

async function getToken() {
  // Method 1: explicit PAT (local dev)
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN

  // Method 2: cached OAuth token (valid ~1 hour)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  // Method 3: M2M OAuth client_credentials exchange (Databricks Apps)
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    try {
      const resp = await fetch(`${DB_HOST}/oidc/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.DATABRICKS_CLIENT_ID,
          client_secret: process.env.DATABRICKS_CLIENT_SECRET,
          scope: 'all-apis',
        }),
      })
      if (resp.ok) {
        const data = await resp.json()
        cachedToken = data.access_token
        tokenExpiry = Date.now() + (data.expires_in - 60) * 1000 // refresh 1 min early
        console.log('OAuth token acquired, expires in', data.expires_in, 'seconds')
        return cachedToken
      }
      console.error('OAuth token exchange failed:', resp.status, await resp.text())
    } catch (err) {
      console.error('OAuth error:', err.message)
    }
  }

  // Method 4: mounted token file
  for (const p of ['/var/run/secrets/databricks/token', '/databricks/.databricks/token']) {
    try { if (existsSync(p)) return readFileSync(p, 'utf-8').trim() } catch {}
  }

  return null
}

// ------------------------------------------------------------
// SQL Statement Execution API — single seam to Databricks.
// Accepts named-parameter markers (:name) + typed parameters,
// exactly like the databricks-sql cursor params. Returns rows as
// an array of objects keyed by column name.
//
// Parsing is slow (the custom endpoint runs a VLM + an LLM reformat
// pass, and scale-to-zero endpoints cold-start), so we submit
// asynchronously and poll rather than relying on a single wait_timeout.
// ------------------------------------------------------------
async function executeSql({ statement, parameters = [] }, token, { timeoutMs = 900000 } = {}) {
  const submit = await fetch(`${DB_HOST}/api/2.0/sql/statements/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: WAREHOUSE_ID,
      statement,
      parameters,
      // Return as soon as it finishes if it's quick; otherwise we poll.
      wait_timeout: '30s',
      on_wait_timeout: 'CONTINUE',
      format: 'JSON_ARRAY',
      disposition: 'INLINE',
    }),
  })
  // Poll fast: these durations are shown to the user as a head-to-head
  // comparison, and a coarse interval quantizes the faster method's
  // number (a 3s poll measures a 25s parse to only ±12%).
  const POLL_MS = 400

  if (!submit.ok) {
    const text = await submit.text()
    throw new Error(`SQL HTTP ${submit.status}: ${text.slice(0, 300)}`)
  }

  let data = await submit.json()
  const statementId = data.statement_id
  const deadline = Date.now() + timeoutMs

  // Poll while the warehouse works through it.
  while (['PENDING', 'RUNNING'].includes(data.status?.state)) {
    if (Date.now() > deadline) {
      // Don't leave an orphaned statement burning warehouse time.
      try {
        await fetch(`${DB_HOST}/api/2.0/sql/statements/${statementId}/cancel`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        })
      } catch {}
      throw new Error(`SQL timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    const poll = await fetch(`${DB_HOST}/api/2.0/sql/statements/${statementId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!poll.ok) throw new Error(`SQL poll HTTP ${poll.status}`)
    data = await poll.json()
  }

  if (data.status?.state !== 'SUCCEEDED') {
    const msg = data.status?.error?.message || JSON.stringify(data.status)
    throw new Error(`SQL state ${data.status?.state}: ${msg?.slice?.(0, 400) || msg}`)
  }

  if (data.manifest?.truncated) {
    throw new Error('SQL result was truncated — try fewer pages or a smaller document')
  }

  const columns = data.manifest?.schema?.columns?.map((c) => c.name) || []
  const toObjects = (arr) => (arr || []).map((row) => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
  const rows = toObjects(data.result?.data_array)
  // Fan-out parses return one row per page; INLINE results can span
  // multiple chunks. Follow the links so we don't silently drop pages.
  let nextLink = data.result?.next_chunk_internal_link
  let nextIndex = data.result?.next_chunk_index
  const seenChunks = new Set()
  while (nextLink || nextIndex != null) {
    const key = nextLink || `idx:${nextIndex}`
    if (seenChunks.has(key) || seenChunks.size > 200) break
    seenChunks.add(key)
    const url = nextLink
      ? (nextLink.startsWith('http') ? nextLink : `${DB_HOST}${nextLink}`)
      : `${DB_HOST}/api/2.0/sql/statements/${statementId}/result/chunks/${nextIndex}`
    const chunkResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!chunkResp.ok) throw new Error(`SQL chunk HTTP ${chunkResp.status}`)
    const chunk = await chunkResp.json()
    rows.push(...toObjects(chunk.data_array || chunk.result?.data_array))
    nextLink = chunk.next_chunk_internal_link || chunk.result?.next_chunk_internal_link || null
    nextIndex = chunk.next_chunk_index ?? chunk.result?.next_chunk_index
    if (nextIndex == null && !nextLink) break
  }
  return rows
}

// Render a { statement, parameters } pair into a single display-friendly
// SQL string: the named markers (:name) are substituted with their bound
// values and the indentation is trimmed. This is for the UI overlay only
// — the warehouse still runs the safe, parameterized statement. Strings
// are quoted; numbers ride bare. Longer names are replaced first so :page
// doesn't clobber the front of :pageIndex, etc.
function renderSql({ statement, parameters = [] }) {
  let sql = statement
  for (const p of [...parameters].sort((a, b) => b.name.length - a.name.length)) {
    const isNumeric = ['INT', 'DOUBLE', 'BIGINT', 'FLOAT', 'DECIMAL'].includes(p.type)
    const literal = isNumeric ? p.value : `'${String(p.value).replace(/'/g, "''")}'`
    sql = sql.replaceAll(`:${p.name}`, literal)
  }
  const lines = sql.replace(/^\n/, '').replace(/\s+$/, '').split('\n')
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
  )
  return lines.map((l) => l.slice(indent)).join('\n')
}

// Wrap executeSql to also surface the SQL text + the time the warehouse
// took to run it. Endpoints return these alongside their results so the
// UI can optionally show each parsing query (and its run time) as it
// fires. `sql`/`elapsedMs` are otherwise inert metadata.
async function runSql(query, token, options) {
  const started = Date.now()
  const rows = await executeSql(query, token, options)
  return { rows, sql: renderSql(query), elapsedMs: Date.now() - started }
}

// ------------------------------------------------------------
// Real-time REST API execution — calls Databricks Document Intelligence
// (`POST /api/2.0/ai-functions/ai-parse-document`) for native
// `ai_parse_document` and Model Serving (`POST /serving-endpoints/<name>/invocations`)
// for custom endpoints like `ai-parse-document-fmapi`.
// ------------------------------------------------------------
function formatErrorStatusItem(item) {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    if (item.error_message) {
      return item.page_id != null
        ? `Page ${item.page_id}: ${item.error_message}`
        : String(item.error_message)
    }
    return JSON.stringify(item)
  }
  return String(item)
}

function envelopeToRow(parser, envelope, { path: filePath, fileSize = 0, pageIndex = null }) {
  const prefix = parser.kind === 'native' ? 'native' : 'custom'
  const elements = Array.isArray(envelope?.document?.elements) ? envelope.document.elements : []
  const pages = Array.isArray(envelope?.document?.pages) ? envelope.document.pages : []
  const types = [...new Set(elements.map((e) => e?.type).filter(Boolean))].sort()
  const version = envelope?.metadata?.version ?? null
  const rawErrors = Array.isArray(envelope?.error_status) ? envelope.error_status : []
  const errors = rawErrors.map(formatErrorStatusItem)
  const resolvedSize = Number(fileSize || envelope?.metadata?.file_metadata?.file_size || 0)
  return {
    path: filePath,
    ...(pageIndex != null ? { page_index: pageIndex } : {}),
    file_size: resolvedSize,
    [`${prefix}_elements`]: elements.length,
    [`${prefix}_pages`]: pages.length,
    [`${prefix}_types`]: types,
    [`${prefix}_version`]: version,
    [`${prefix}_errors`]: errors,
    [`${prefix}_json`]: JSON.stringify(envelope || {}),
  }
}

async function executeNativeRest({ path: filePath }, token, { timeoutMs = 900000 } = {}) {
  const body = makeNativeRestPayload({ path: filePath })
  const started = Date.now()
  const resp = await fetch(`${DB_HOST}/api/2.0/ai-functions/ai-parse-document`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const elapsedMs = Date.now() - started
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`ai_parse_document REST HTTP ${resp.status}: ${text.slice(0, 400)}`)
  }
  const envelope = await resp.json()
  return { envelope, elapsedMs }
}

async function executeEndpointRest(
  { endpoint, path: filePath, fileBuffer, pageIndex = 0 },
  token,
  { timeoutMs = 900000 } = {},
) {
  const record = makeEndpointPayload({
    path: filePath,
    fileBuffer,
    mimeType: mimeForPath(filePath),
    pageIndex,
    pageLimit: 1,
  })
  const started = Date.now()
  const resp = await fetch(
    `${DB_HOST}/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dataframe_records: [record] }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  )
  const elapsedMs = Date.now() - started
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Serving endpoint HTTP ${resp.status}: ${text.slice(0, 400)}`)
  }
  const data = await resp.json()
  // Matches: response_text = response.predictions[0]["response"]
  const pred = Array.isArray(data?.predictions) ? data.predictions[0] : data?.predictions ?? data
  const responseText =
    pred && typeof pred === 'object' && 'response' in pred ? pred.response : pred
  let envelope = {}
  if (typeof responseText === 'string' && responseText !== 'null') {
    envelope = JSON.parse(responseText)
  } else if (responseText && typeof responseText === 'object') {
    envelope = responseText
  }
  return { envelope: envelope && typeof envelope === 'object' ? envelope : {}, elapsedMs }
}

// ------------------------------------------------------------
// Unity Catalog Files API — read a volume file's bytes, and list a
// volume directory. Page images that ai_parse_document rendered live
// in a volume, so the browser can't fetch them directly; we proxy.
// ------------------------------------------------------------
async function readVolumeFile(filePath, token) {
  const resp = await fetch(
    `${DB_HOST}/api/2.0/fs/files${filePath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!resp.ok) throw new Error(`Files API HTTP ${resp.status} for ${filePath}`)
  return Buffer.from(await resp.arrayBuffer())
}

async function listVolumeDirectory(directory, token) {
  const resp = await fetch(
    `${DB_HOST}/api/2.0/fs/directories${directory.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!resp.ok) throw new Error(`Files API HTTP ${resp.status} for ${directory}`)
  const data = await resp.json()
  return data.contents || []
}

async function writeVolumeFile(filePath, buffer, token) {
  const resp = await fetch(
    `${DB_HOST}/api/2.0/fs/files${filePath.split('/').map(encodeURIComponent).join('/')}?overwrite=true`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    },
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Files API HTTP ${resp.status} writing ${filePath}: ${text.slice(0, 300)}`)
  }
}

function sanitizeUploadName(name) {
  const base = path.posix.basename(String(name || '').replace(/\\/g, '/'))
  if (!base || base === '.' || base === '..' || base.includes('\0')) return null
  if (!SUPPORTED_EXTENSIONS.some((ext) => base.toLowerCase().endsWith(ext))) return null
  return base
}

function resolveUploadDirectory(directory) {
  const uri = path.posix.normalize((directory || DOCUMENTS_PATH).toString())
  if (!uri.startsWith('/Volumes/')) return null
  return uri.replace(/\/+$/, '') || null
}

// ------------------------------------------------------------
// Bounding-box normalization.
//
// The two parsers report coordinates in DIFFERENT pixel spaces, and
// neither states its page size in the response:
//
//   • native  — pixels of the page image it rendered into the volume
//               (`pages[].image_uri`). We read that JPEG's real
//               dimensions, so its boxes are exact by construction.
//   • custom  — pixels of ITS own render at CUSTOM_RENDER_DPI. For a
//               PDF we recover that space from the page's PDF point
//               size (pdf-lib) × dpi/72. For a raster image both
//               parsers see the same file, so the space is identical.
//
// Both are converted to fractions of their page (0..1) here, on the
// server, so the frontend just multiplies by the rendered size it is
// displaying and never has to know about DPI at all.
// ------------------------------------------------------------
function jpegSize(buffer) {
  let i = 2
  // Every read is bounds-checked: a truncated file would otherwise make
  // readUInt16BE throw past the end of the buffer.
  while (i + 1 < buffer.length) {
    if (buffer[i] !== 0xff) { i++; continue }
    const marker = buffer[i + 1]
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      if (i + 8 >= buffer.length) return null
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (i + 3 >= buffer.length) return null
    const segment = buffer.readUInt16BE(i + 2)
    // A zero-length segment would spin this loop forever.
    if (segment < 2) return null
    i += 2 + segment
  }
  return null
}

function pngSize(buffer) {
  if (buffer.length < 24) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// Dimensions of a page image, or null if they can't be trusted. A zero
// or missing dimension must be null rather than 0 — callers divide by it.
function imageSize(buffer) {
  let size = null
  if (buffer.length > 1 && buffer[0] === 0x89 && buffer[1] === 0x50) size = pngSize(buffer)
  else if (buffer.length > 1 && buffer[0] === 0xff && buffer[1] === 0xd8) size = jpegSize(buffer)
  if (!size || !(size.width > 0) || !(size.height > 0)) return null
  return size
}

// The pixel space each side's coordinates live in, for one page.
// `nativeImage` is optional: endpoint-only comparisons still need the
// custom space (PDF points × DPI, or the source raster's dimensions)
// so boxes and Markdown survive without a native `image_uri`.
async function pageSpaces({ filePath, nativeImage, pageIndex, token }) {
  const native = nativeImage ? imageSize(nativeImage) : null
  const isPdf = filePath.toLowerCase().endsWith('.pdf')

  if (!isPdf) {
    // Same source raster for both parsers → one shared space.
    if (native) return { native, custom: native }
    try {
      const size = imageSize(await readVolumeFile(filePath, token))
      return { native: size, custom: size }
    } catch (err) {
      console.error('source image size probe failed:', err.message)
      return { native: null, custom: null }
    }
  }

  // PDF: the custom endpoint rasterized the page itself at its own DPI.
  try {
    const pdf = await PDFDocument.load(await readVolumeFile(filePath, token), {
      ignoreEncryption: true,
    })
    const page = pdf.getPage(Math.min(pageIndex, Math.max(pdf.getPageCount() - 1, 0)))
    const { width, height } = page.getSize()   // PDF points (72/inch)
    const scale = CUSTOM_RENDER_DPI / 72
    return {
      native,
      custom: { width: Math.round(width * scale), height: Math.round(height * scale) },
    }
  } catch (err) {
    console.error('PDF size probe failed:', err.message)
    // Fall back to the native space — better a slight offset than no boxes.
    return { native, custom: native }
  }
}

function customSpaceFromPdf(pdf, pageIndex) {
  const page = pdf.getPage(Math.min(pageIndex, Math.max(pdf.getPageCount() - 1, 0)))
  const { width, height } = page.getSize()
  const scale = CUSTOM_RENDER_DPI / 72
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

// Overlay metadata for one page: the rendered JPEG (if any), aspect ratio,
// and the pixel spaces each parser's boxes live in.
async function loadPageVisual({ filePath, pages, pageIndex, token, pdfDoc = null }) {
  const pageMeta = (pages || []).find((p) => Number(p.id) === pageIndex) || pages?.[pageIndex]
  let nativeBuffer = null
  if (pageMeta?.image_uri) {
    try {
      nativeBuffer = await readVolumeFile(pageMeta.image_uri, token)
    } catch (err) {
      console.error('page image read failed:', err.message)
    }
  }

  let spaces
  if (pdfDoc) {
    const native = nativeBuffer ? imageSize(nativeBuffer) : null
    let custom = native
    try {
      custom = customSpaceFromPdf(pdfDoc, pageIndex)
    } catch {
      custom = native
    }
    spaces = { native, custom }
  } else {
    spaces = await pageSpaces({ filePath, nativeImage: nativeBuffer, pageIndex, token })
  }

  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  const sourceFile = `/api/document-file?path=${encodeURIComponent(filePath)}`
  const drawnSpace = spaces.native || spaces.custom
  const pageAspect = drawnSpace?.width > 0 && drawnSpace?.height > 0
    ? drawnSpace.width / drawnSpace.height
    : null
  return {
    spaces,
    sourceFile,
    pageAspect,
    pageImage: pageMeta?.image_uri
      ? `/api/page-image?uri=${encodeURIComponent(pageMeta.image_uri)}`
      : (isPdf ? null : sourceFile),
  }
}

function aggregateCustomMetrics(rows) {
  let elements = 0
  const types = new Set()
  const errors = []
  let version = null
  let fileSize = 0
  let path = null
  for (const row of rows) {
    if (!path && row.path) path = row.path
    fileSize = Number(row.file_size || fileSize)
    elements += Number(row.custom_elements || 0)
    for (const t of parseArray(row.custom_types)) types.add(t)
    if (!version) version = row.custom_version
    errors.push(...parseArray(row.custom_errors))
  }
  return {
    path,
    fileSize,
    elements,
    pages: rows.length,
    types: [...types].sort(),
    version,
    errors: [...new Set(errors)],
  }
}

function sliceComparePayload(payload, pageIndex) {
  const slice = payload.pageCache?.[pageIndex] ?? payload.pageCache?.[String(pageIndex)]
  if (!slice) return { ...payload, pageIndex }
  return {
    ...payload,
    pageIndex,
    pageImage: slice.pageImage,
    pageAspect: slice.pageAspect,
    elements: slice.elements,
    envelopes: slice.envelopes,
  }
}

// A JSON_ARRAY column as a real array. The warehouse usually returns
// these as JSON text; NULL arrives as null/"null". INLINE JSON_ARRAY
// can also hand back an already-parsed array.
function parseArray(text) {
  if (Array.isArray(text)) return text
  if (!text || text === 'null') return []
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function boxPageId(box) {
  if (box?.page_id == null || box?.page_id === '') return null
  const n = Number(box.page_id)
  return Number.isFinite(n) ? n : null
}

function distinctPageIds(envelope) {
  const ids = new Set()
  for (const el of envelope?.document?.elements || []) {
    for (const box of el.bbox || []) {
      const id = boxPageId(box)
      if (id != null) ids.add(id)
    }
  }
  return ids
}

function elementOnPage(el, pageIndex) {
  const page = Number(pageIndex)
  return (el?.bbox || []).some((b) => boxPageId(b) === page)
}

// Convert one envelope's elements into page-relative fractions.
//
// Overlay and Markdown share this list. Two things used to empty both
// views even when the parser returned a full envelope:
//
//   • Serving endpoints parse one page per call and often stamp
//     `page_id: 0` (or omit it) on every box. The UI pager is the
//     real page index, so a strict page_id filter dropped everything
//     on page 2+.
//   • Pixel boxes need a page size. That used to come only from a
//     native `image_uri`, so skipping `ai_parse_document` in the
//     dropdowns dropped every box — and Markdown with it.
//
// `keepUnboxed` (endpoint parses) still surfaces content with no
// drawable rect so Markdown isn't hostage to the overlay.
function normalizeElements(envelope, pageIndex, space, { keepUnboxed = false } = {}) {
  const elements = envelope?.document?.elements || []
  const page = Number(pageIndex)
  const ids = distinctPageIds(envelope)
  const remapTo = !ids.has(page) && ids.size === 1 ? [...ids][0] : null
  const out = []
  elements.forEach((el, idx) => {
    const boxes = (el.bbox || []).filter((b) => {
      const id = boxPageId(b)
      if (id === page) return true
      if (remapTo != null && id === remapTo) return true
      if (keepUnboxed && id == null) return true
      return false
    })
    const rects = boxes
      .map((b) => {
        const c = (b.coord || []).map(Number)
        if (c.length < 4 || c.some((v) => !Number.isFinite(v))) return null
        const [x0, y0, x1, y1] = [
          Math.min(c[0], c[2]), Math.min(c[1], c[3]),
          Math.max(c[0], c[2]), Math.max(c[1], c[3]),
        ]
        // Coordinates already normalized (0..1) come through untouched.
        const normalized = x1 <= 1.01 && y1 <= 1.01
        if (normalized) {
          return {
            left: x0 * 100, top: y0 * 100,
            width: (x1 - x0) * 100, height: (y1 - y0) * 100,
          }
        }
        // Otherwise they're pixels, and we need a trustworthy page size to
        // divide by. Without one, drop the box: a wrong overlay is worse
        // than a missing one, since the whole point is spatial accuracy.
        if (!(space?.width > 0) || !(space?.height > 0)) return null
        return {
          left: (x0 / space.width) * 100,
          top: (y0 / space.height) * 100,
          width: ((x1 - x0) / space.width) * 100,
          height: ((y1 - y0) / space.height) * 100,
        }
      })
      .filter(Boolean)
    const hasContent = Boolean(el.content || el.description)
    if (!rects.length && !(keepUnboxed && hasContent)) return
    out.push({
      // `idx` is the element's position in the envelope — the stable key
      // the overlay and the markdown pane use to cross-highlight.
      idx,
      id: el.id ?? idx,
      type: el.type || 'unknown',
      content: el.content ?? null,
      description: el.description ?? null,
      confidence: el.confidence ?? null,
      rects,
    })
  })
  return out
}

// Native page rasters for the overlay. Used when a comparison side is
// `ai_parse_document`, and also on its own when neither dropdown is —
// the overlay still needs the JPEGs `imageOutputPath` writes.
async function loadNativePageImages(filePath, token, mode = DEFAULT_MODE) {
  if (mode === 'rest') {
    const { envelope, elapsedMs } = await executeNativeRest({ path: filePath }, token)
    const pages = Array.isArray(envelope?.document?.pages) ? envelope.document.pages : []
    const sql = renderRestRequest(
      { kind: 'native', id: 'ai_parse_document' },
      { path: filePath },
    )
    return { pages, sql, elapsedMs }
  }
  const { rows, sql, elapsedMs } = await runSql(pageImagesQuery({ path: filePath }), token)
  return { pages: parseArray(rows[0]?.pages), sql, elapsedMs }
}

async function countDocumentPages(filePath, token) {
  if (!filePath.toLowerCase().endsWith('.pdf')) return 1
  try {
    const pdf = await PDFDocument.load(await readVolumeFile(filePath, token), {
      ignoreEncryption: true,
    })
    return pdf.getPageCount() || 1
  } catch (err) {
    console.error('page count probe failed:', err.message)
    return 1
  }
}

// ------------------------------------------------------------
// Comparison cache.
//
// A single comparison costs minutes of warehouse + GPU time (the custom
// endpoint runs a vision model and an LLM reformat pass). Paging through
// a PDF, switching between the three views, or a browser reload would
// otherwise re-pay that every time. Results are pure functions of
// (document, left parser, right parser, page), so we memoize them.
//
// Bounded so a long session can't grow without limit; entries expire so
// a redeployed endpoint isn't compared against indefinitely.
// ------------------------------------------------------------
const compareCache = new Map()
const CACHE_MAX = 64
const CACHE_TTL_MS = Number(process.env.COMPARE_CACHE_TTL_MS || 6 * 60 * 60 * 1000)

function cacheGet(key) {
  const hit = compareCache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expires) { compareCache.delete(key); return null }
  // Refresh LRU position.
  compareCache.delete(key)
  compareCache.set(key, hit)
  return hit.value
}

function cacheSet(key, value) {
  compareCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS })
  // Evict the oldest once past the cap.
  while (compareCache.size > CACHE_MAX) {
    compareCache.delete(compareCache.keys().next().value)
  }
}

app.use(express.json())
// Serve the built React app from dist/ (same as Repo A).
app.use(express.static(path.join(__dirname, 'dist')))

// ============================================================
// API
// ============================================================

// Health + config probe — lets the frontend know the defaults and
// whether we have a live warehouse connection.
app.get('/api/config', async (req, res) => {
  const token = await getToken()
  res.json({
    host: DB_HOST,
    warehouseId: WAREHOUSE_ID,
    documentsPath: DOCUMENTS_PATH,
    defaultEndpoint: DEFAULT_ENDPOINT,
    defaultLeft: DEFAULT_LEFT,
    defaultRight: DEFAULT_RIGHT,
    defaultMode: DEFAULT_MODE,
    modes: EXECUTION_MODES,
    parsers: PARSERS,
    imageOutputPath: IMAGE_OUTPUT_PATH,
    schema: PARSE_SCHEMA,
    connected: Boolean(token),
  })
})

// A. List parseable documents in a Unity Catalog volume directory.
app.get('/api/documents', async (req, res) => {
  const directory = (req.query.path || DOCUMENTS_PATH).toString()
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const contents = await listVolumeDirectory(directory, token)
    const documents = contents
      .filter((entry) => !entry.is_directory)
      .filter((entry) => SUPPORTED_EXTENSIONS.some((ext) => entry.path.toLowerCase().endsWith(ext)))
      .map((entry) => ({
        path: entry.path,
        name: entry.name || entry.path.split('/').pop(),
        size: Number(entry.file_size || 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json({ directory, documents })
  } catch (err) {
    console.error('documents error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// A2. Upload a parseable document into the Unity Catalog volume directory.
// Raw body with filename + directory in query params avoids extra multipart
// dependencies while handling up to 50 MB PDFs/images.
app.post(
  '/api/documents/upload',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const directory = resolveUploadDirectory(req.query.directory || DOCUMENTS_PATH)
    const filename = sanitizeUploadName(req.query.filename)
    if (!directory) {
      return res.status(400).json({ error: 'directory must be under /Volumes' })
    }
    if (!filename) {
      return res.status(400).json({
        error: `filename must end in one of: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      })
    }
    const buffer = req.body
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'empty file upload' })
    }
    const token = await getToken()
    if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

    const targetPath = `${directory}/${filename}`
    try {
      await writeVolumeFile(targetPath, buffer, token)
      res.json({
        document: {
          path: targetPath,
          name: filename,
          size: buffer.length,
        },
      })
    } catch (err) {
      console.error('upload error:', err.message)
      res.status(500).json({ error: err.message })
    }
  },
)

// B. The comparison itself — the two parsers as two separate statements,
// run one after another so each method's duration is measured on its own.
//
// Sequential, not concurrent: this workspace runs an X-Small warehouse,
// so firing both at once would make them contend and inflate both
// numbers. Sequential costs little in practice because the two are
// lopsided (native seconds, the custom endpoint minutes) and it is the
// only way the head-to-head timing is meaningful.
//
// Each side is also independently fault-tolerant — if one parser fails,
// the other's result and timing still come back, with the failure
// reported in that side's `error`.
//
// Returns both raw envelopes (for the JSON diff and the markdown panes)
// plus page-relative bounding boxes for the overlay view.
app.post('/api/compare', async (req, res) => {
  const {
    path: filePath,
    left = DEFAULT_LEFT,
    right = DEFAULT_RIGHT,
    mode: rawMode = DEFAULT_MODE,
    pageIndex = 0,
    pageMode: pageModeRaw = 'current',
    refresh = false,
  } = req.body || {}
  const pageMode = pageModeRaw === 'all' ? 'all' : 'current'
  if (!filePath) return res.status(400).json({ error: 'path required' })
  if (!resolveDocumentPath(filePath)) {
    return res.status(400).json({ error: 'only PDF, PNG, JPG, and JPEG files are supported' })
  }
  const mode = rawMode === 'rest' ? 'rest' : 'dbsql'
  const leftParser = getParser(left)
  const rightParser = getParser(right)
  if (!leftParser || !rightParser) {
    return res.status(400).json({
      error: `unknown parser — choose one of: ${PARSERS.map((p) => p.id).join(', ')}`,
    })
  }
  const leftActive = leftParser.kind !== 'none'
  const rightActive = rightParser.kind !== 'none'
  if (!leftActive && !rightActive) {
    return res.status(400).json({ error: 'choose at least one parser — both sides are No model' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const page = Math.max(0, parseInt(pageIndex, 10) || 0)
    // An `all` parse caches the whole document once; paging on the client
    // or re-requesting a different page index hits the same entry and
    // slices out the requested page.
    const cacheKey = pageMode === 'all'
      ? `${mode}|${filePath}|${leftParser.id}|${rightParser.id}|all`
      : `${mode}|${filePath}|${leftParser.id}|${rightParser.id}|page|${page}`
    if (!refresh) {
      const cached = cacheGet(cacheKey)
      // `cached: true` lets the UI explain why a result was instant.
      if (cached) {
        const sliced = pageMode === 'all' ? sliceComparePayload(cached, page) : cached
        return res.json({ ...sliced, cached: true })
      }
    }
    // `from_json` yields SQL NULL (-> null / "null") when a side's payload
    // doesn't match the 2.0 schema at all, and a wedged endpoint can return
    // something that isn't JSON. Treat either as an empty envelope so the
    // other parser's result still renders and the metrics show the gap,
    // rather than failing the whole comparison.
    const parseEnvelope = (text, side) => {
      if (!text || text === 'null') return {}
      try {
        const value = JSON.parse(text)
        return value && typeof value === 'object' ? value : {}
      } catch (err) {
        console.error(`${side} envelope was not valid JSON:`, err.message)
        return {}
      }
    }

    // For `all` mode we need the document page count up front so custom
    // endpoints can fan out `sequence(0, maxPageIndex)` in DBSQL or fan
    // out parallel page requests in REST.
    const discoveredPages = await countDocumentPages(filePath, token)
    const maxPageIndex = Math.max(0, discoveredPages - 1)
    const timeoutMs = pageMode === 'all' ? 1_800_000 : 900_000

    // Run one statement, timing it on its own and surviving its failure.
    // `elapsedMs` here is that method's parse duration — the number the
    // UI puts head-to-head.
    const runSqlSide = async (side, query) => {
      try {
        const { rows, sql, elapsedMs } = await runSql(query, token, { timeoutMs })
        if (!rows.length) throw new Error('file not found by read_files')
        return { side, row: rows[0], rows, sql, elapsedMs, error: null, skipped: false }
      } catch (err) {
        console.error(`${side} parse failed:`, err.message)
        return { side, row: {}, rows: [], sql: renderSql(query), elapsedMs: null, error: err.message, skipped: false }
      }
    }

    // In REST mode, Model Serving endpoints take the file bytes as base64
    // in `dataframe_records`. Deduplicate concurrent reads with a shared
    // promise so parallel endpoint calls only fetch the volume file once,
    // and pre-read before starting the inference timer.
    let fileBufferPromise = null
    const getFileBuffer = () => {
      if (!fileBufferPromise) {
        fileBufferPromise = readVolumeFile(filePath, token)
      }
      return fileBufferPromise
    }

    const runRestSide = async (parser) => {
      const side = parser.id
      const mimeType = mimeForPath(filePath)
      let fileBuffer = null
      try {
        if (parser.kind === 'endpoint') {
          fileBuffer = await getFileBuffer()
        }
        const sql = renderRestRequest(parser, {
          path: filePath,
          mimeType,
          fileSize: fileBuffer?.length || 0,
          pageIndex: page,
          pageMode,
          maxPageIndex,
        })
        if (parser.kind === 'native') {
          const { envelope, elapsedMs } = await executeNativeRest({ path: filePath }, token)
          const row = envelopeToRow(parser, envelope, {
            path: filePath,
            fileSize: fileBuffer?.length || 0,
          })
          return { side, row, rows: [row], sql, elapsedMs, error: null, skipped: false }
        }
        if (pageMode === 'all' && maxPageIndex > 0) {
          // Fan out one REST call per page in parallel on the serving
          // endpoint, measuring total wall-clock time across all pages.
          const pageIndices = Array.from({ length: maxPageIndex + 1 }, (_, idx) => idx)
          const t0 = Date.now()
          const pageResults = await Promise.all(
            pageIndices.map((idx) =>
              executeEndpointRest(
                { endpoint: parser.endpoint, path: filePath, fileBuffer, pageIndex: idx },
                token,
              ),
            ),
          )
          const elapsedMs = Date.now() - t0
          const rows = pageResults.map((res, idx) =>
            envelopeToRow(parser, res.envelope, {
              path: filePath,
              fileSize: fileBuffer?.length || 0,
              pageIndex: idx,
            }),
          )
          return { side, row: rows[0] || {}, rows, sql, elapsedMs, error: null, skipped: false }
        }
        const { envelope, elapsedMs } = await executeEndpointRest(
          { endpoint: parser.endpoint, path: filePath, fileBuffer, pageIndex: page },
          token,
        )
        const row = envelopeToRow(parser, envelope, {
          path: filePath,
          fileSize: fileBuffer?.length || 0,
          pageIndex: page,
        })
        return { side, row, rows: [row], sql, elapsedMs, error: null, skipped: false }
      } catch (err) {
        console.error(`${side} REST parse failed:`, err.message)
        const sql = renderRestRequest(parser, {
          path: filePath,
          mimeType,
          fileSize: fileBuffer?.length || 0,
          pageIndex: page,
          pageMode,
          maxPageIndex,
        })
        return { side, row: {}, rows: [], sql, elapsedMs: null, error: err.message, skipped: false }
      }
    }

    const skippedRun = (parser) => ({
      side: parser.id,
      row: {},
      rows: [],
      sql: null,
      elapsedMs: null,
      error: null,
      skipped: true,
    })

    const runParser = (parser) => {
      if (parser.kind === 'none') return Promise.resolve(skippedRun(parser))
      if (mode === 'rest') return runRestSide(parser)
      return runSqlSide(
        parser.id,
        parseQueryFor(parser, { path: filePath, pageIndex: page, pageMode, maxPageIndex }),
      )
    }

    // Overlay rasters come from ai_parse_document's imageOutputPath, not
    // from the serving endpoints. When neither dropdown is native, write
    // those JPEGs so the overlay is populated even though native isn't a
    // selected model. In DBSQL mode we run it before the parser statements
    // so it doesn't contend with the warehouse; in REST mode we run it in
    // parallel with the serving endpoint calls.
    const needsImagePass = leftParser.kind !== 'native' && rightParser.kind !== 'native'
    let pages = null
    let imagePassPromise = null
    if (needsImagePass) {
      if (mode === 'rest') {
        imagePassPromise = loadNativePageImages(filePath, token, mode)
          .then((r) => r.pages)
          .catch((err) => {
            console.error('page images failed:', err.message)
            return []
          })
      } else {
        try {
          pages = (await loadNativePageImages(filePath, token, mode)).pages
        } catch (err) {
          console.error('page images failed:', err.message)
          pages = []
        }
      }
    }

    // In REST mode, each parser runs on its own independent compute
    // (Document Intelligence service vs Model Serving endpoint), so we
    // fire both in parallel with Promise.all while still timing each call
    // individually. In DBSQL mode, both statements share the SQL warehouse,
    // so we run them sequentially (native first) to avoid warehouse
    // contention. Same engine on both sides runs once and is reused.
    let leftRun
    let rightRun
    if (leftParser.id === rightParser.id) {
      leftRun = await runParser(leftParser)
      rightRun = leftRun
    } else if (!leftActive) {
      leftRun = skippedRun(leftParser)
      rightRun = await runParser(rightParser)
    } else if (!rightActive) {
      rightRun = skippedRun(rightParser)
      leftRun = await runParser(leftParser)
    } else if (mode === 'rest') {
      if (leftParser.kind === 'endpoint' || rightParser.kind === 'endpoint') {
        // Pre-warm the volume file buffer before kicking off parallel calls
        // so neither endpoint's timer or start time waits on the Files API.
        try { await getFileBuffer() } catch {}
      }
      ;[leftRun, rightRun] = await Promise.all([
        runParser(leftParser),
        runParser(rightParser),
      ])
    } else if (leftParser.kind === 'native') {
      leftRun = await runParser(leftParser)
      rightRun = await runParser(rightParser)
    } else if (rightParser.kind === 'native') {
      rightRun = await runParser(rightParser)
      leftRun = await runParser(leftParser)
    } else {
      leftRun = await runParser(leftParser)
      rightRun = await runParser(rightParser)
    }

    if (imagePassPromise) {
      pages = await imagePassPromise
    }

    // Nothing to show if every side that was asked to run failed.
    const leftFailed = Boolean(leftRun.error)
    const rightFailed = Boolean(rightRun.error)
    if ((leftActive ? leftFailed : true) && (rightActive ? rightFailed : true)) {
      const parts = []
      if (leftActive && leftFailed) parts.push(`${leftParser.label}: ${leftRun.error}`)
      if (rightActive && rightFailed) parts.push(`${rightParser.label}: ${rightRun.error}`)
      return res.status(502).json({
        error: parts.length > 1
          ? `both parsers failed — ${parts.join(' | ')}`
          : `parse failed — ${parts[0]}`,
      })
    }

    // Endpoint queries alias columns as custom_*; native as native_*.
    const emptyMetrics = {
      elements: null,
      pages: null,
      types: null,
      version: null,
      errors: [],
      durationMs: null,
      failure: null,
      skipped: true,
    }
    const extractRow = (parser, row, run) => {
      const prefix = parser.kind === 'native' ? 'native' : 'custom'
      const r = row || {}
      return {
        path: r.path,
        fileSize: Number(r.file_size || 0),
        envelope: parseEnvelope(r[`${prefix}_json`], parser.id),
        metrics: {
          elements: Number(r[`${prefix}_elements`] || 0),
          pages: Number(r[`${prefix}_pages`] || 0),
          types: parseArray(r[`${prefix}_types`]),
          version: r[`${prefix}_version`],
          errors: parseArray(r[`${prefix}_errors`]),
          durationMs: run.elapsedMs,
          failure: run.error,
          skipped: false,
        },
      }
    }

    // Build a per-page lookup of extracted envelopes for a side. Native
    // parses the whole document in one row; custom endpoints in `all`
    // mode return one row per page tagged with `page_index`.
    const extractsByPage = (parser, run) => {
      if (parser.kind === 'none' || run.skipped) {
        return { single: { path: null, fileSize: 0, envelope: {}, metrics: emptyMetrics }, byPage: null }
      }
      if (parser.kind === 'endpoint' && pageMode === 'all' && Array.isArray(run.rows) && run.rows.length > 0) {
        const byPage = new Map()
        for (const r of run.rows) {
          const idx = Number(r.page_index ?? 0)
          byPage.set(idx, extractRow(parser, r, run))
        }
        const agg = aggregateCustomMetrics(run.rows)
        const first = byPage.get(page) || byPage.get(0) || extractRow(parser, run.row, run)
        return {
          single: {
            path: agg.path || first.path,
            fileSize: agg.fileSize || first.fileSize,
            envelope: first.envelope,
            metrics: {
              elements: agg.elements,
              pages: agg.pages,
              types: agg.types,
              version: agg.version,
              errors: agg.errors,
              durationMs: run.elapsedMs,
              failure: run.error,
              skipped: false,
            },
          },
          byPage,
        }
      }
      return { single: extractRow(parser, run.row, run), byPage: null }
    }

    const leftPack = extractsByPage(leftParser, leftRun)
    const rightPack = extractsByPage(rightParser, rightRun)
    const leftExtract = leftPack.single
    const rightExtract = rightPack.single
    const row = { ...leftRun.row, ...rightRun.row }

    // Prefer pages from a native comparison side; otherwise keep the
    // image pass we ran up front, or fetch now if native was selected
    // but failed to return pages.
    const pagesFrom = (parser, extracted) => {
      if (parser.kind !== 'native' || extracted.metrics.failure) return null
      const found = extracted.envelope?.document?.pages
      return Array.isArray(found) && found.length ? found : null
    }
    pages = pagesFrom(leftParser, leftExtract) || pagesFrom(rightParser, rightExtract) || pages
    if (!pages) {
      try {
        pages = (await loadNativePageImages(filePath, token, mode)).pages
      } catch (err) {
        console.error('page images failed:', err.message)
        pages = []
      }
    }

    const sideMeta = (parser) => ({
      id: parser.id,
      label: parser.label,
      shortLabel: parser.shortLabel,
      kind: parser.kind,
      endpoint: parser.endpoint || null,
    })
    const pageCount = (pages && pages.length) || discoveredPages
    const clampedPage = Math.min(page, Math.max(pageCount - 1, 0))

    // Load the PDF once if we need to compute custom page spaces across
    // multiple pages.
    let pdfDoc = null
    if (filePath.toLowerCase().endsWith('.pdf')) {
      try {
        pdfDoc = await PDFDocument.load(await getFileBuffer(), {
          ignoreEncryption: true,
        })
      } catch (err) {
        console.error('PDF load for spaces failed:', err.message)
      }
    }

    const envelopeAt = (pack, idx) => {
      if (pack.byPage) return pack.byPage.get(idx)?.envelope || {}
      return pack.single.envelope
    }

    // In single-page mode, `ai_parse_document` still parses the whole PDF,
    // so raw `native_elements`/`native_pages` reflect all pages while a
    // custom endpoint only ran on `clampedPage`. Scope the headline metrics
    // to the active page so the summary strip compares like with like.
    const metricsFor = (parser, pack) => {
      const base = pack.single.metrics
      if (base.skipped || base.failure || pageMode === 'all' || parser.kind !== 'native') {
        return base
      }
      const allElements = pack.single.envelope?.document?.elements
      if (!Array.isArray(allElements)) return base
      const onPage = allElements.filter((el) => elementOnPage(el, clampedPage))
      const pageTypes = [...new Set(onPage.map((el) => el?.type).filter(Boolean))].sort()
      return {
        ...base,
        elements: onPage.length,
        pages: 1,
        types: pageTypes,
      }
    }

    const buildSlice = async (idx) => {
      const visual = await loadPageVisual({
        filePath, pages, pageIndex: idx, token, pdfDoc,
      })
      const spaceFor = (parser) => (parser.kind === 'native' ? visual.spaces.native : visual.spaces.custom)
      const leftEnv = envelopeAt(leftPack, idx)
      const rightEnv = envelopeAt(rightPack, idx)
      // Custom endpoint envelopes are already single-page (their elements
      // report page_id 0 regardless of which PDF page was rendered), so
      // normalize against page 0 when pulling from a per-page row.
      const leftTargetPage = leftPack.byPage ? 0 : idx
      const rightTargetPage = rightPack.byPage ? 0 : idx
      return {
        pageImage: visual.pageImage,
        pageAspect: visual.pageAspect,
        sourceFile: visual.sourceFile,
        elements: {
          custom: leftActive
            ? normalizeElements(leftEnv, leftTargetPage, spaceFor(leftParser), {
              keepUnboxed: leftParser.kind === 'endpoint',
            })
            : [],
          native: rightActive
            ? normalizeElements(rightEnv, rightTargetPage, spaceFor(rightParser), {
              keepUnboxed: rightParser.kind === 'endpoint',
            })
            : [],
        },
        envelopes: { custom: leftEnv, native: rightEnv },
      }
    }

    let pageCache = null
    let currentSlice
    if (pageMode === 'all' && pageCount > 1) {
      pageCache = {}
      const indices = Array.from({ length: pageCount }, (_, i) => i)
      const built = await Promise.all(indices.map((i) => buildSlice(i)))
      indices.forEach((i, k) => { pageCache[i] = built[k] })
      currentSlice = pageCache[clampedPage] || built[0]
    } else {
      currentSlice = await buildSlice(clampedPage)
    }

    const payload = {
      path: row.path || filePath,
      mode,
      pageIndex: clampedPage,
      pageCount,
      pageMode,
      pageImage: currentSlice.pageImage,
      // Source file the overlay can rasterize when native JPEGs are
      // missing (endpoint-only compare, image pass failed, etc.).
      sourceFile: currentSlice.sourceFile,
      pageAspect: currentSlice.pageAspect,
      // Left pane stays `custom`, right pane stays `native` — the CSS
      // and view components already key off those slot names.
      sides: { custom: sideMeta(leftParser), native: sideMeta(rightParser) },
      // Macro metrics for the summary strip. `durationMs` is per method,
      // measured around that method's own statement.
      metrics: {
        fileSize: leftExtract.fileSize || rightExtract.fileSize || Number(row.file_size || 0),
        custom: metricsFor(leftParser, leftPack),
        native: metricsFor(rightParser, rightPack),
      },
      // Page-relative boxes + content for the overlay/markdown views.
      elements: currentSlice.elements,
      // Full envelopes for the JSON diff view.
      envelopes: currentSlice.envelopes,
      // When `pageMode === 'all'`, include per-page slices so paging in
      // the UI is instantaneous and doesn't re-query Databricks.
      ...(pageCache ? { pageCache } : {}),
      // Each method's statement, for the "show parsing queries" overlay.
      sqlByMethod: { custom: leftRun.sql, native: rightRun.sql },
      // `sql`/`elapsedMs` keep the shape the query overlay expects; in
      // DBSQL mode the total is the sum of sequential statements, while in
      // REST mode the two calls run in parallel so wall clock is the max.
      sql: (() => {
        const parts = []
        if (leftRun.sql) parts.push(`-- ${leftParser.label}\n${leftRun.sql}`)
        if (rightRun.sql && leftParser.id !== rightParser.id) {
          parts.push(`-- ${rightParser.label}\n${rightRun.sql}`)
        }
        return parts.join('\n\n')
      })(),
      elapsedMs: leftParser.id === rightParser.id
        ? (leftRun.elapsedMs || 0)
        : mode === 'rest'
          ? Math.max(leftRun.elapsedMs || 0, rightRun.elapsedMs || 0)
          : (leftRun.elapsedMs || 0) + (rightRun.elapsedMs || 0),
    }

    // Only cache a clean run. A parse that failed on one side is usually
    // transient (cold endpoint timing out, endpoint mid-redeploy), and
    // caching it would pin that failure for the whole TTL — the analyst
    // would have to know to hit "Re-run" to escape it.
    if (!leftRun.error && !rightRun.error) cacheSet(cacheKey, payload)
    res.json(payload)
  } catch (err) {
    console.error('compare error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// C. Preview metadata — page count from the file itself, no SQL parse.
// Picking a document in the UI loads this so the analyst can see the
// file before spending minutes on a comparison.
app.post('/api/preview', async (req, res) => {
  const filePath = resolveDocumentPath(req.body?.path)
  if (!filePath) {
    return res.status(400).json({ error: 'a PDF, PNG, JPG, or JPEG volume path is required' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    let pageCount = 1
    if (filePath.toLowerCase().endsWith('.pdf')) {
      const pdf = await PDFDocument.load(await readVolumeFile(filePath, token), {
        ignoreEncryption: true,
      })
      pageCount = pdf.getPageCount() || 1
    }
    res.json({
      path: filePath,
      pageCount,
      fileUrl: `/api/document-file?path=${encodeURIComponent(filePath)}`,
      mime: mimeForPath(filePath),
    })
  } catch (err) {
    console.error('preview error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// D. Proxy a source document out of a Unity Catalog volume so the UI can
// preview it. Same constraint as listing: `/Volumes/…` + a parseable
// extension, after `.`/`..` normalization.
app.get('/api/document-file', async (req, res) => {
  const filePath = resolveDocumentPath(req.query.path)
  if (!filePath) {
    return res.status(400).json({ error: 'path must be a PDF or image under /Volumes' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const buffer = await readVolumeFile(filePath, token)
    res.set('Content-Type', mimeForPath(filePath))
    res.set('Content-Disposition', `inline; filename="${filePath.split('/').pop()}"`)
    res.set('Cache-Control', 'private, max-age=300')
    res.send(buffer)
  } catch (err) {
    console.error('document-file error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// E. Page count + images without re-running a serving endpoint. Used
// when the analyst pages through a PDF before comparing that page.
app.post('/api/pages', async (req, res) => {
  const { path: filePath } = req.body || {}
  if (!filePath) return res.status(400).json({ error: 'path required' })
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const { pages, sql, elapsedMs } = await loadNativePageImages(filePath, token)
    res.json({
      pageCount: pages.length,
      pages: pages.map((p) => ({
        id: Number(p.id),
        image: p.image_uri ? `/api/page-image?uri=${encodeURIComponent(p.image_uri)}` : null,
      })),
      sql, elapsedMs,
    })
  } catch (err) {
    console.error('pages error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// F. Proxy a rendered page image out of the Unity Catalog volume.
//
// This endpoint reads with the APP's credentials, so the path has to be
// constrained or it becomes a read-any-file proxy. Two gates:
//   1. Normalize away `.`/`..` segments FIRST, then require the result to
//      sit under the configured image volume. A bare `startsWith` check
//      is not enough — `<volume>/../../other/secret.png` starts with the
//      volume prefix but escapes it.
//   2. Require a single content-addressed filename directly in the
//      volume, which is exactly what ai_parse_document writes
//      (`<sha256>.jpg`). No subdirectories, no traversal, no surprises.
const PAGE_IMAGE_NAME = /^[0-9a-zA-Z._-]+\.(jpg|jpeg|png)$/i

app.get('/api/page-image', async (req, res) => {
  const uri = path.posix.normalize((req.query.uri || '').toString())
  const root = IMAGE_OUTPUT_PATH.replace(/\/+$/, '')
  const name = uri.startsWith(`${root}/`) ? uri.slice(root.length + 1) : null
  if (!name || !PAGE_IMAGE_NAME.test(name)) {
    return res.status(400).json({
      error: 'uri must be a rendered page image directly under the image output path',
    })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const buffer = await readVolumeFile(`${root}/${name}`, token)
    res.set('Content-Type', uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    // Page images are content-addressed (sha filenames), so cache hard.
    res.set('Cache-Control', 'private, max-age=86400, immutable')
    res.send(buffer)
  } catch (err) {
    console.error('page-image error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// SPA fallback — serve index.html for all non-API routes.
app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`PARSER COMPARE server running on port ${PORT}`)
  console.log(`  host:      ${DB_HOST || '(unset — set DATABRICKS_HOST)'}`)
  console.log(`  warehouse: ${WAREHOUSE_ID || '(unset — set WAREHOUSE_ID or SQL_WAREHOUSE_HTTP_PATH)'}`)
  console.log(`  documents: ${DOCUMENTS_PATH}`)
  console.log(`  parsers:   ${PARSERS.map((p) => p.id).join(', ')}`)
  console.log(`  default:   ${DEFAULT_LEFT} vs ${DEFAULT_RIGHT}`)
  console.log(`  images:    ${IMAGE_OUTPUT_PATH}`)
  if (!DB_HOST) console.warn('WARNING: DATABRICKS_HOST is not set — SQL calls will fail.')
  if (!WAREHOUSE_ID) console.warn('WARNING: no warehouse configured — set WAREHOUSE_ID or SQL_WAREHOUSE_HTTP_PATH.')

  // Warm the warehouse so the first parse doesn't also pay for a cold
  // warehouse start (mirrors cotraveler).
  setTimeout(async () => {
    const token = await getToken()
    if (!token) { console.log('No token — running without live data'); return }
    try {
      await executeSql({ statement: 'SELECT 1', parameters: [] }, token, { timeoutMs: 120000 })
      console.log('SQL warehouse warm')
    } catch (err) { console.error('Warehouse warmup failed:', err.message) }
  }, 1000)
})
