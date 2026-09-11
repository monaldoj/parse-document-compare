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

// Unity Catalog volume that ai_parse_document renders its page images
// into (`imageOutputPath`). This is what makes the bounding boxes
// pixel-exact: the native parser reports coordinates relative to the
// image it rendered, and that image is what the UI draws on. Supplied
// per-workspace so the app deploys anywhere without code changes.
export const IMAGE_OUTPUT_PATH =
  process.env.IMAGE_OUTPUT_PATH || '/Volumes/justinm_demo/parse/page_images'

// Volume directory the file browser lists documents from.
export const DOCUMENTS_PATH =
  process.env.DOCUMENTS_PATH || '/Volumes/justinm_demo/bio_track/unstructured'

// Serving-endpoint names. Florence, PaliGemma, and both Gemini endpoints
// honor the same ai_query contract — only the endpoint string differs.
// The UI picks among these (plus native ai_parse_document); it no longer
// types a name.
export const FLORENCE_ENDPOINT =
  process.env.CUSTOM_ENDPOINT_NAME || 'florence-2-large-ft-ai-parse-document'

export const PALIGEMMA_ENDPOINT =
  process.env.PALIGEMMA_ENDPOINT_NAME || 'paligemma2-3b-ai-parse-document'

export const GEMINI_ENDPOINT =
  process.env.GEMINI_ENDPOINT_NAME || 'gemini-3-5-flash-ai-parse-document'

// Gemini 3.8 Flash, served as ai-parse-document-gemini.
export const GEMINI_38_ENDPOINT =
  process.env.GEMINI_38_ENDPOINT_NAME || 'ai-parse-document-gemini'

// Kept so existing env / startup logs still have a single default.
export const DEFAULT_ENDPOINT = GEMINI_38_ENDPOINT

// The two dropdowns choose from this catalog. `kind: 'endpoint'` runs
// customParseQuery; `kind: 'native'` runs nativeParseQuery; `kind: 'none'`
// skips that side so a single parser can run on its own. SQL for each
// kind is shared — endpoint engines differ only by `:endpoint`.
export const PARSERS = [
  {
    id: 'gemini-3-8-flash',
    label: GEMINI_38_ENDPOINT,
    shortLabel: GEMINI_38_ENDPOINT,
    kind: 'endpoint',
    endpoint: GEMINI_38_ENDPOINT,
  },
  {
    id: 'florence',
    label: FLORENCE_ENDPOINT,
    shortLabel: FLORENCE_ENDPOINT,
    kind: 'endpoint',
    endpoint: FLORENCE_ENDPOINT,
  },
  {
    id: 'paligemma',
    label: PALIGEMMA_ENDPOINT,
    shortLabel: PALIGEMMA_ENDPOINT,
    kind: 'endpoint',
    endpoint: PALIGEMMA_ENDPOINT,
  },
  {
    id: 'gemini',
    label: GEMINI_ENDPOINT,
    shortLabel: GEMINI_ENDPOINT,
    kind: 'endpoint',
    endpoint: GEMINI_ENDPOINT,
  },
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

export const DEFAULT_LEFT = 'gemini-3-8-flash'
export const DEFAULT_RIGHT = 'ai_parse_document'

export function getParser(id) {
  return PARSERS.find((p) => p.id === id) || null
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
      param('imageOut', IMAGE_OUTPUT_PATH),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// ============================================================
// B. Page-image-only parse.
//
// Paging through a multi-page PDF re-runs the custom endpoint for the
// new page, but the native side has already parsed every page. This
// renders just the page images (no LLM work on the custom side) so the
// viewer can show a page it hasn't compared yet.
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
      param('imageOut', IMAGE_OUTPUT_PATH),
      param('schema', PARSE_SCHEMA),
    ],
  }
}

// Dispatch to the builders above. Endpoint engines share one SQL shape;
// native stays on ai_parse_document. `none` has no statement.
export function parseQueryFor(parser, { path, pageIndex = 0 }) {
  if (parser.kind === 'none') return null
  if (parser.kind === 'native') return nativeParseQuery({ path })
  return customParseQuery({ path, endpoint: parser.endpoint, pageIndex })
}
