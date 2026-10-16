// ============================================================
// queries.js — Parameterized parsing SQL for the Parser Compare app
//
// Both sides of the comparison run in ONE Databricks SQL statement
// so the two parsers see byte-identical input:
//
//   • custom  → ai_query(<serving endpoint>, named_struct(...))
//   • native  → ai_parse_document(content, map('version','2.0'))
//
// Each result is cast through the SAME ai_parse_document 2.0 schema
// with from_json, so schema drift shows up as null fields instead of
// being hidden by a permissive parse.
//
// Connector style mirrors Repo A (cotraveler): we go through the SQL
// Statement Execution REST API rather than a native driver. The
// `executeSql()` helper in server.js is the single seam — swap it for
// a databricks-sql cursor in a Python port without touching the SQL.
// ============================================================

import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function stripYamlScalar(raw) {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed.replace(/\s+#.*$/, '').trim()
}

// Read the `variables:` defaults from `databricks.yml` so `databricks.yml`
// is the single source of truth for defaults locally and in Databricks Apps
// (even when the Apps runtime passes uninterpolated `${var.*}` strings from
// `app.yaml`).
function loadBundleVariables() {
  const vars = {}
  const candidates = [
    path.join(__dirname, 'databricks.yml'),
    path.join(__dirname, 'databricks.yaml'),
  ]
  const bundlePath = candidates.find((p) => existsSync(p))
  if (!bundlePath) return vars

  try {
    const content = readFileSync(bundlePath, 'utf-8')
    const lines = content.split(/\r?\n/)
    let inVariables = false
    let currentVar = null
    for (const line of lines) {
      if (/^\s*#/.test(line) || !line.trim()) continue
      if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
        inVariables = /^variables\s*:/.test(line)
        currentVar = null
        continue
      }
      if (!inVariables) continue
      const varMatch = line.match(/^  ([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
      if (varMatch) {
        currentVar = varMatch[1]
        const inlineVal = varMatch[2].trim()
        if (inlineVal && !inlineVal.startsWith('#')) {
          vars[currentVar] = stripYamlScalar(inlineVal)
        }
        continue
      }
      if (currentVar) {
        const defMatch = line.match(/^    default\s*:\s*(.+)$/)
        if (defMatch) {
          vars[currentVar] = stripYamlScalar(defMatch[1])
        }
      }
    }
  } catch {
    // Fall back to built-in defaults if databricks.yml cannot be read.
  }
  return vars
}

const BUNDLE_VARS = loadBundleVariables()

function isUnresolvedVarRef(val) {
  return typeof val === 'string' && /^\$\{var\.[^}]+\}$/.test(val.trim())
}

export function resolveConfigValue(envNames, bundleVarNames, fallback) {
  // 1. Explicit environment variable (if set and not an uninterpolated `${var.*}` reference)
  for (const name of envNames) {
    const val = process.env[name]
    if (val && !isUnresolvedVarRef(val)) return val.trim()
  }
  // 2. BUNDLE_VAR_<var> environment variable
  for (const varName of bundleVarNames) {
    const val = process.env[`BUNDLE_VAR_${varName}`]
    if (val && !isUnresolvedVarRef(val)) return val.trim()
  }
  // 3. If an env var holds `${var.<name>}`, resolve `<name>` from databricks.yml
  for (const name of envNames) {
    const val = process.env[name]
    const match = typeof val === 'string' && val.trim().match(/^\$\{var\.([^}]+)\}$/)
    if (match && BUNDLE_VARS[match[1]]) {
      return BUNDLE_VARS[match[1]]
    }
  }
  // 4. `variables.<name>.default` from databricks.yml
  for (const varName of bundleVarNames) {
    if (BUNDLE_VARS[varName]) return BUNDLE_VARS[varName]
  }
  return fallback
}

// Volume directory the file browser lists documents from.
export const DOCUMENTS_PATH = resolveConfigValue(
  ['DOCUMENTS_PATH'],
  ['documents_path'],
  '/Volumes/<catalog>/<schema>/docs',
)

const DOC_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg']

// Derive the page-images directory (`<documents_path>/page_images`) from
// either a volume directory path or a document file path inside it. Even
// when the user enters a different volume directory in the UI, rendered
// page images are written to `<that_directory>/page_images` in the same
// volume without needing a separate image_output_path setting.
export function imageOutputPathFor(pathOrDir = DOCUMENTS_PATH) {
  const raw = String(pathOrDir || DOCUMENTS_PATH).trim().replace(/\/+$/, '')
  const lower = raw.toLowerCase()
  const isFile = DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))
  const baseDir = isFile ? path.posix.dirname(raw) : raw
  return baseDir.endsWith('/page_images') ? baseDir : `${baseDir}/page_images`
}

export const IMAGE_OUTPUT_PATH = imageOutputPathFor(DOCUMENTS_PATH)

// Comma-separated list of custom Model Serving endpoints configured in
// `databricks.yml` (`custom_endpoint_names` / `custom_endpoint_name`).
export const CUSTOM_ENDPOINT_NAMES_RAW = resolveConfigValue(
  ['CUSTOM_ENDPOINT_NAMES', 'CUSTOM_ENDPOINT_NAME', 'FMAPI_ENDPOINT_NAME'],
  ['custom_endpoint_names', 'custom_endpoint_name'],
  'ai-parse-document-fmapi',
)

const parsedEndpoints = [
  ...new Set(
    CUSTOM_ENDPOINT_NAMES_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
]

export const CUSTOM_ENDPOINTS = parsedEndpoints.length
  ? parsedEndpoints
  : ['ai-parse-document-fmapi']

// Kept so existing env / startup logs still have a single default.
export const DEFAULT_ENDPOINT = CUSTOM_ENDPOINTS[0]

// The two dropdowns choose from this catalog: every custom serving
// endpoint from `custom_endpoint_names`, plus `ai_parse_document` and
// `No model`. `kind: 'endpoint'` runs customParseQuery; `kind: 'native'`
// runs nativeParseQuery; `kind: 'none'` skips that side so a single
// parser can run on its own.
export const PARSERS = [
  ...CUSTOM_ENDPOINTS.map((endpoint) => ({
    id: endpoint,
    label: endpoint,
    shortLabel: endpoint,
    kind: 'endpoint',
    endpoint,
  })),
  {
    id: 'ai_parse_document',
    label: 'ai_parse_document',
    shortLabel: 'ai_parse_document',
    kind: 'native',
  },
  {
    id: 'none',
    label: 'No model',
    shortLabel: 'No model',
    kind: 'none',
  },
]

export const DEFAULT_LEFT = CUSTOM_ENDPOINTS[0]
export const DEFAULT_RIGHT = 'ai_parse_document'

// Execution modes: DBSQL (runs ai_parse_document / ai_query on the SQL
// Warehouse) vs Real-time REST API (calls /api/2.0/ai-functions/ai-parse-document
// and /serving-endpoints/<name>/invocations directly).
export const EXECUTION_MODES = [
  {
    id: 'dbsql',
    label: 'DBSQL',
    description: 'Run via SQL Warehouse (ai_parse_document & ai_query)',
  },
  {
    id: 'rest',
    label: 'REST API',
    description: 'Run via real-time REST APIs (/api/2.0/ai-functions & /serving-endpoints)',
  },
]

export const DEFAULT_MODE = 'dbsql'

export function getParser(id) {
  return PARSERS.find((p) => p.id === id || p.endpoint === id) || null
}

// DPI the custom endpoint rasterizes PDF pages at before running OCR.
// Its bounding boxes are in that rendered-pixel space, so the server
// needs the same number to normalize them (see pageSpaces in server.js).
export const CUSTOM_RENDER_DPI = Number(process.env.CUSTOM_RENDER_DPI || 200)

// Exact ai_parse_document schema version 2.0. Both sides are cast
// through this one definition — that is the whole point of the diff.
export const PARSE_SCHEMA = `
STRUCT<
  document: STRUCT<
    pages: ARRAY<STRUCT<id: INT, image_uri: STRING>>,
    elements: ARRAY<STRUCT<
      id: INT,
      type: STRING,
      content: STRING,
      confidence: DOUBLE,
      bbox: ARRAY<STRUCT<coord: ARRAY<DOUBLE>, page_id: INT>>,
      description: STRING
    >>
  >,
  error_status: ARRAY<STRING>,
  metadata: STRUCT<
    id: STRING,
    version: STRING,
    file_metadata: STRUCT<
      file_path: STRING,
      file_name: STRING,
      file_size: BIGINT,
      file_modification_time: STRING
    >
  >
>`.trim()

// ------------------------------------------------------------
// Parameter binding
//
// The SQL Statement Execution API takes named markers (:name) plus a
// typed `parameters` array — the safe, injection-proof path, exactly
// like databricks-sql cursor params. Every builder below returns
// { statement, parameters } ready to POST. Note that even the schema
// string binds as a parameter: from_json accepts a bound STRING for
// its schema argument, so no user value is ever concatenated in.
// ------------------------------------------------------------
function param(name, value, type = 'STRING') {
  return { name, value: String(value), type }
}

// The `files` CTE both parsers start from. Reading the bytes is shared
// setup, not parsing work, so it sits identically in front of each
// statement — neither side gets a head start.
const FILES_CTE = `
    WITH files AS (
      SELECT
        path,
        content,
        base64(content) AS file_b64,
        CASE
          WHEN lower(path) LIKE '%.pdf' THEN 'application/pdf'
          WHEN lower(path) LIKE '%.png' THEN 'image/png'
          ELSE 'image/jpeg'
        END AS mime_type
      FROM read_files(:path, format => 'binaryFile')
    )`

// ============================================================
// A. The custom Model Serving endpoint, on its own.
//
// Deliberately a SEPARATE statement from the native parse below so each
// method's run time is measurable in isolation. Running both in one
// statement (the previous design) gave a single combined duration and
// let the optimizer interleave them; running them concurrently would
// make them contend for the same warehouse. One at a time is the only
// way the two numbers mean anything.
//
// `pageIndex` is passed through so the endpoint parses exactly the page
// the UI is showing — its contract renders one page per call, which is
// the throughput pattern the source notebook uses.
// ============================================================
export function customParseQuery({ path, endpoint, pageIndex = 0 }) {
  const statement = `${FILES_CTE},
    parsed AS (
      SELECT
        path,
        length(content) AS file_size,
        from_json(
          ai_query(
            :endpoint,
            named_struct(
              'file_b64', file_b64,
              'mime_type', mime_type,
              'file_path', path,
              'file_name', regexp_extract(path, '[^/]+$', 0),
              'file_size', length(content),
              'page_limit', 1,
              'page_index', :pageIndex,
              'reformat', true
            )
          ).response,
          :schema
        ) AS custom
      FROM files
    )
    SELECT
      path,
      file_size,
      size(custom.document.elements) AS custom_elements,
      size(custom.document.pages)    AS custom_pages,
      array_sort(array_distinct(transform(custom.document.elements, x -> x.type))) AS custom_types,
      custom.metadata.version AS custom_version,
      custom.error_status     AS custom_errors,
      to_json(custom)         AS custom_json
    FROM parsed
    LIMIT 1
  `
  return {
    statement,
    parameters: [
      param('path', path),
      param('endpoint', endpoint),
      param('pageIndex', pageIndex, 'INT'),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// ============================================================
// A2. Custom endpoint, every page in parallel.
//
// Serving endpoints honor a one-page-per-call contract (`page_limit=1`,
// `page_index=N`). To parse a whole PDF we explode one row per page
// index and let the warehouse run `ai_query` across those rows in one
// statement — the same fan-out the source notebook uses.
//
// `maxPageIndex` is the PDF's last 0-based page (pageCount - 1), from
// the file itself. A hardcoded ceiling (e.g. 7) would either miss pages
// or spend `ai_query` calls on empty slots; images only keep
// `page_index = 0`.
//
// The serving endpoint's return type already has `.response`. Passing
// `failOnError => false` wraps that in `{result, errorMessage}` and
// `.response` then fails with FIELD_NOT_FOUND — so this call matches
// the one-page query and the source notebook: `ai_query(...).response`.
// ============================================================
export function customFanoutParseQuery({ path, endpoint, maxPageIndex = 0 }) {
  const statement = `${FILES_CTE},
    pages AS (
      SELECT f.*, page_index
      FROM files f
      LATERAL VIEW explode(sequence(0, :maxPageIndex)) AS page_index
      WHERE mime_type = 'application/pdf' OR page_index = 0
    ),
    parsed AS (
      SELECT
        path,
        page_index,
        length(content) AS file_size,
        from_json(
          ai_query(
            :endpoint,
            named_struct(
              'file_b64', file_b64,
              'mime_type', mime_type,
              'file_path', path,
              'file_name', regexp_extract(path, '[^/]+$', 0),
              'file_size', length(content),
              'page_limit', 1,
              'page_index', page_index,
              'reformat', true
            )
          ).response,
          :schema
        ) AS custom
      FROM pages
    )
    SELECT
      path,
      page_index,
      file_size,
      size(custom.document.elements) AS custom_elements,
      size(custom.document.pages)    AS custom_pages,
      array_sort(array_distinct(transform(custom.document.elements, x -> x.type))) AS custom_types,
      custom.metadata.version AS custom_version,
      custom.error_status     AS custom_errors,
      to_json(custom)         AS custom_json
    FROM parsed
    ORDER BY page_index
  `
  return {
    statement,
    parameters: [
      param('path', path),
      param('endpoint', endpoint),
      param('maxPageIndex', maxPageIndex, 'INT'),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// ============================================================
// B. Native ai_parse_document, on its own.
//
// Parses the whole document in one shot (unlike the custom endpoint's
// one-page-per-call contract), so the UI filters its elements by
// page_id client-side. `imageOutputPath` makes it write each rendered
// page to a volume — that image is what the overlay draws on and how
// the server learns the native coordinate space.
// ============================================================
export function nativeParseQuery({ path }) {
  const statement = `${FILES_CTE},
    parsed AS (
      SELECT
        path,
        length(content) AS file_size,
        from_json(
          to_json(
            ai_parse_document(
              content,
              map('version', '2.0', 'imageOutputPath', :imageOut)
            )
          ),
          :schema
        ) AS native
      FROM files
    )
    SELECT
      path,
      file_size,
      size(native.document.elements) AS native_elements,
      size(native.document.pages)    AS native_pages,
      array_sort(array_distinct(transform(native.document.elements, x -> x.type))) AS native_types,
      native.metadata.version AS native_version,
      native.error_status     AS native_errors,
      to_json(native)         AS native_json
    FROM parsed
    LIMIT 1
  `
  return {
    statement,
    parameters: [
      param('path', path),
      param('imageOut', imageOutputPathFor(path)),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// ============================================================
// B. Page-image-only parse.
//
// Writes rendered page JPEGs via imageOutputPath without running a
// serving endpoint. Used when paging before a comparison, and when
// neither comparison dropdown is ai_parse_document — the overlay still
// needs those rasters even though native isn't a selected model.
// ============================================================
export function pageImagesQuery({ path }) {
  const statement = `
    WITH files AS (
      SELECT content FROM read_files(:path, format => 'binaryFile')
    )
    SELECT
      to_json(
        from_json(
          to_json(
            ai_parse_document(
              content,
              map('version', '2.0', 'imageOutputPath', :imageOut)
            )
          ),
          :schema
        ).document.pages
      ) AS pages
    FROM files
    LIMIT 1
  `
  return {
    statement,
    parameters: [
      param('path', path),
      param('imageOut', imageOutputPathFor(path)),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// Dispatch to the builders above. Endpoint engines share one SQL shape;
// native stays on ai_parse_document. `none` has no statement.
// `pageMode === 'all'` fans out every PDF page in one statement; a
// single-page image (maxPageIndex 0) stays on the one-page query.
export function parseQueryFor(parser, { path, pageIndex = 0, pageMode = 'current', maxPageIndex = 0 }) {
  if (parser.kind === 'none') return null
  if (parser.kind === 'native') return nativeParseQuery({ path })
  if (pageMode === 'all' && maxPageIndex > 0) {
    return customFanoutParseQuery({ path, endpoint: parser.endpoint, maxPageIndex })
  }
  return customParseQuery({ path, endpoint: parser.endpoint, pageIndex })
}

// ============================================================
// C. Real-time REST API payloads.
//
//   • native   → POST /api/2.0/ai-functions/ai-parse-document
//                Passes the UC volume path in `content` plus `options`
//                with schema version 2.0 and `image_output_path`.
//   • endpoint → POST /serving-endpoints/<name>/invocations
//                Passes `dataframe_records: [makeEndpointPayload(...)]`,
//                matching `query_client.serving_endpoints.query(...)`.
// ============================================================
export function makeNativeRestPayload({ path }) {
  return {
    content: path,
    options: {
      version: '2.0',
      image_output_path: imageOutputPathFor(path),
    },
  }
}

export function makeEndpointPayload({
  path,
  fileBuffer,
  mimeType,
  pageIndex = 0,
  pageLimit = 1,
}) {
  return {
    file_b64: fileBuffer.toString('base64'),
    mime_type: mimeType,
    file_path: path,
    file_name: path.split('/').pop(),
    file_size: fileBuffer.length,
    page_limit: pageLimit,
    page_index: pageIndex,
    reformat: true,
  }
}

// Display-friendly representation of a REST API call for the UI query
// overlay (analogous to renderSql in server.js). Truncates `file_b64` so
// multi-megabyte base64 strings don't flood the overlay.
export function renderRestRequest(
  parser,
  { path, mimeType, fileSize = 0, pageIndex = 0, pageMode = 'current', maxPageIndex = 0 },
) {
  if (!parser || parser.kind === 'none') return null
  if (parser.kind === 'native') {
    const body = makeNativeRestPayload({ path })
    return `POST /api/2.0/ai-functions/ai-parse-document\n${JSON.stringify(body, null, 2)}`
  }
  const makePreviewRecord = (idx) => ({
    file_b64: `<base64 · ${Number(fileSize || 0).toLocaleString()} bytes>`,
    mime_type: mimeType,
    file_path: path,
    file_name: path.split('/').pop(),
    file_size: Number(fileSize || 0),
    page_limit: 1,
    page_index: idx,
    reformat: true,
  })
  if (pageMode === 'all' && maxPageIndex > 0) {
    const totalPages = maxPageIndex + 1
    return (
      `POST /serving-endpoints/${parser.endpoint}/invocations` +
      ` (${totalPages} pages fanned out in parallel: page_index 0..${maxPageIndex})\n` +
      JSON.stringify({ dataframe_records: [makePreviewRecord(`0..${maxPageIndex}`)] }, null, 2)
    )
  }
  return `POST /serving-endpoints/${parser.endpoint}/invocations\n${JSON.stringify(
    { dataframe_records: [makePreviewRecord(pageIndex)] },
    null,
    2,
  )}`
}
