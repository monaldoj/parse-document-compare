import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import { PDFDocument } from 'pdf-lib'

import {
  DOCUMENTS_PATH,
  DEFAULT_ENDPOINT,
  IMAGE_OUTPUT_PATH,
  CUSTOM_RENDER_DPI,
  PARSE_SCHEMA,
  compareQuery,
  pageImagesQuery,
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
    await new Promise((r) => setTimeout(r, 3000))
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

  const columns = data.manifest?.schema?.columns?.map((c) => c.name) || []
  const rows = (data.result?.data_array || []).map((row) => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
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
async function pageSpaces({ filePath, nativeImage, pageIndex, token }) {
  const native = imageSize(nativeImage)
  const isPdf = filePath.toLowerCase().endsWith('.pdf')

  if (!isPdf) {
    // Same source raster for both parsers → one shared space.
    return { native, custom: native }
  }

  // PDF: the custom endpoint rasterized the page itself at its own DPI.
  try {
    const pdf = await PDFDocument.load(await readVolumeFile(filePath, token), {
      ignoreEncryption: true,
    })
    const page = pdf.getPage(Math.min(pageIndex, pdf.getPageCount() - 1))
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

// A JSON_ARRAY column as a real array. The warehouse returns these as
// JSON text, and a NULL column arrives as null/"null".
function parseArray(text) {
  if (!text || text === 'null') return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

// Convert one envelope's elements into page-relative fractions, keeping
// only the elements that have a box on the requested page.
function normalizeElements(envelope, pageIndex, space) {
  const elements = envelope?.document?.elements || []
  const out = []
  elements.forEach((el, idx) => {
    const boxes = (el.bbox || []).filter((b) => Number(b?.page_id) === Number(pageIndex))
    if (!boxes.length) return
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
    if (!rects.length) return
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

// ------------------------------------------------------------
// Comparison cache.
//
// A single comparison costs minutes of warehouse + GPU time (the custom
// endpoint runs a vision model and an LLM reformat pass). Paging through
// a PDF, switching between the three views, or a browser reload would
// otherwise re-pay that every time. Results are pure functions of
// (document, endpoint, page), so we memoize them in-process.
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

// B. The comparison itself — one SQL statement, both parsers, one page.
//
// Returns both raw envelopes (for the JSON diff and the markdown panes)
// plus page-relative bounding boxes for the overlay view.
app.post('/api/compare', async (req, res) => {
  const { path: filePath, endpoint = DEFAULT_ENDPOINT, pageIndex = 0, refresh = false } = req.body || {}
  if (!filePath) return res.status(400).json({ error: 'path required' })
  if (!SUPPORTED_EXTENSIONS.some((ext) => filePath.toLowerCase().endsWith(ext))) {
    return res.status(400).json({ error: 'only PDF, PNG, JPG, and JPEG files are supported' })
  }
  // Reject a blank/implausible endpoint here rather than paying for a
  // warehouse round trip that can only fail inside ai_query.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(String(endpoint).trim())) {
    return res.status(400).json({ error: 'a valid Model Serving endpoint name is required' })
  }
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const page = Math.max(0, parseInt(pageIndex, 10) || 0)
    const cacheKey = `${filePath}|${endpoint}|${page}`
    if (!refresh) {
      const cached = cacheGet(cacheKey)
      // `cached: true` lets the UI explain why a result was instant.
      if (cached) return res.json({ ...cached, cached: true })
    }
    const { rows, sql, elapsedMs } = await runSql(
      compareQuery({ path: filePath, endpoint, pageIndex: page }), token,
    )
    if (!rows.length) return res.status(404).json({ error: 'file not found by read_files' })
    const row = rows[0]

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

    const custom = parseEnvelope(row.custom_json, 'custom')
    const native = parseEnvelope(row.native_json, 'native')
    const pages = native?.document?.pages || []

    // The native page image is both what we draw on and how we learn
    // the native coordinate space.
    const pageMeta = pages.find((p) => Number(p.id) === page) || pages[0]
    let spaces = { native: null, custom: null }
    if (pageMeta?.image_uri) {
      const buffer = await readVolumeFile(pageMeta.image_uri, token)
      spaces = await pageSpaces({ filePath, nativeImage: buffer, pageIndex: page, token })
    }

    const payload = {
      path: row.path,
      pageIndex: page,
      pageCount: pages.length || 1,
      pageImage: pageMeta?.image_uri
        ? `/api/page-image?uri=${encodeURIComponent(pageMeta.image_uri)}`
        : null,
      // Macro metrics for the summary strip.
      metrics: {
        fileSize: Number(row.file_size || 0),
        custom: {
          elements: Number(row.custom_elements || 0),
          pages: Number(row.custom_pages || 0),
          types: parseArray(row.custom_types),
          version: row.custom_version,
          errors: parseArray(row.custom_errors),
        },
        native: {
          elements: Number(row.native_elements || 0),
          pages: Number(row.native_pages || 0),
          types: parseArray(row.native_types),
          version: row.native_version,
          errors: parseArray(row.native_errors),
        },
      },
      // Page-relative boxes + content for the overlay/markdown views.
      elements: {
        custom: normalizeElements(custom, page, spaces.custom),
        native: normalizeElements(native, page, spaces.native),
      },
      // Full envelopes for the JSON diff view.
      envelopes: { custom, native },
      sql, elapsedMs,
    }

    cacheSet(cacheKey, payload)
    res.json(payload)
  } catch (err) {
    console.error('compare error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// C. Page count + images without re-running the custom endpoint. Used
// when the analyst pages through a PDF before comparing that page.
app.post('/api/pages', async (req, res) => {
  const { path: filePath } = req.body || {}
  if (!filePath) return res.status(400).json({ error: 'path required' })
  const token = await getToken()
  if (!token) return res.status(503).json({ error: 'no Databricks credentials' })

  try {
    const { rows, sql, elapsedMs } = await runSql(pageImagesQuery({ path: filePath }), token)
    if (!rows.length) return res.status(404).json({ error: 'file not found by read_files' })
    const pages = parseArray(rows[0]?.pages)
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

// D. Proxy a rendered page image out of the Unity Catalog volume.
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
const PAGE_IMAGE_NAME = /^[0-9a-f]{16,128}\.(jpg|jpeg|png)$/i

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
  console.log(`  endpoint:  ${DEFAULT_ENDPOINT}`)
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
