# Parser Compare — `ai_parse_document` vs a Model Serving endpoint

An interactive Databricks App that parses one document **two ways** —
Databricks' built-in `ai_parse_document` and any Model Serving endpoint
you point it at via `ai_query` — then shows the difference three ways:
**bounding boxes** on the rendered page, **extracted markdown**, or a
**JSON diff** of the two envelopes. Each method runs as its **own SQL
statement**, so the app also reports how long each one took.

```
┌─────────────┐   /api/compare        ┌──────────────┐  parse SQL  ┌──────────────────┐
│  React      │ ───────────────────▶  │  Express      │ ─────────▶  │ Databricks       │
│  3-view     │   /api/documents      │  (server.js)  │  REST API   │ SQL warehouse    │
│  comparison │ ◀───────────────────  │  + queries.js │ ◀─────────  │ ai_parse_document│
└─────────────┘                       └──────────────┘             │ + ai_query(...)  │
                                                                   └──────────────────┘
```

Both parsers are cast through the **same `ai_parse_document` 2.0 schema**
with `from_json`, so schema drift surfaces as null fields instead of
being hidden by a permissive parse.

---

## Project structure

```
parse_document_compare/
├── app.yaml              # Databricks App manifest (command, env, resources)
├── package.json          # node deps (express, pdf-lib) + build deps (vite, react)
├── server.js             # Express backend: auth ladder + /api/* + bbox normalization
├── queries.js            # Parameterized SQL: one statement per parser (the data layer)
├── databricks.yml        # Asset Bundle (app + sql-warehouse binding)
├── vite.config.js        # dev server + /api proxy + build config
├── index.html            # SPA entry
├── public/favicon.svg
├── src/
│   ├── main.jsx          # React bootstrap
│   ├── App.jsx           # layout + view toggle + comparison state
│   ├── api.js            # fetch wrapper for /api/*
│   ├── styles.css
│   └── components/
│       ├── ControlPanel.jsx  # sidebar: volume, endpoint, metrics, type filter
│       ├── PageViewer.jsx    # side-by-side bounding-box overlay
│       ├── MarkdownView.jsx  # side-by-side extracted markdown
│       ├── JsonDiff.jsx      # aligned structural diff + raw JSON
│       ├── TimingBar.jsx     # per-method run time, head to head
│       └── colors.js         # shared element-type palette
└── dist/                 # built frontend (created by `npm run build`)
```

---

## The three comparison views

| View | What it answers |
|---|---|
| **Bounding boxes** | *Where* did each parser think the content was? Both panes draw the **same** rendered page image with a different parser's boxes on it, so any difference is attributable to the parser and not to the rendering. |
| **Markdown** | *What* did each parser extract? Elements in reading order — tables as real HTML tables, figures as their description, with per-element confidence. |
| **JSON diff** | *How do the envelopes differ structurally?* Leaf JSON paths aligned side by side and classified as changed / custom-only / native-only, with a "differences only" filter. |

Element types can be toggled off in the sidebar; the filter applies to
both the overlay and the markdown panes. Clicking an element pins it, so
it stays highlighted when you switch views.

---

## Run-time comparison

A **Parse time** bar sits above all three views with each method's
duration side by side and a proportional bar, so the gap reads at a
glance. Measured on a warm endpoint against a receipt PNG:

| method | time |
|---|---|
| `ai_parse_document` | **8.5 s** |
| Florence-2 serving endpoint | **5 m 23 s** (37.9× slower) |

To make those numbers mean something, the two parsers run as **two
separate statements, one after the other**:

* **Separate**, because a combined statement yields one blended duration
  and lets the optimizer interleave the two calls.
* **Sequential, not concurrent**, because firing both at once makes them
  contend for the same warehouse and inflates both numbers. Sequential
  costs little here — the two are lopsided, so the total is dominated by
  the slow side either way.

Splitting them also makes each side **independently fault-tolerant**: if
the custom endpoint 404s or times out, `ai_parse_document`'s result and
timing still render, with the failure reported on the custom row. (In the
combined design, either failure killed the whole comparison.)

The bar is explicit about what the numbers *don't* prove: a cold
scale-to-zero endpoint includes start-up time, a cached result reports
the original run's duration, and on a multi-page PDF the custom endpoint
parsed one page while `ai_parse_document` parsed all of them. Failed runs
are never cached, so a transient failure isn't pinned for the whole TTL.

---

## How the bounding boxes line up

This is the part that needs care: **the two parsers report coordinates in
different pixel spaces, and neither states its page size in the
response.**

* **`ai_parse_document`** — pixels of the page image *it* rendered. We
  pass the `imageOutputPath` option so it writes that image to a Unity
  Catalog volume and returns the path in `pages[].image_uri`. The server
  reads that JPEG's real dimensions, so the native boxes are exact by
  construction — and that same image is what both panes display.
* **The custom endpoint** — pixels of *its own* raster at
  `CUSTOM_RENDER_DPI` (200 in the reference notebook). For a PDF the
  server recovers that space from the page's PDF point size (`pdf-lib`)
  × `dpi/72`. For a PNG/JPG both parsers see the same file, so the space
  is identical.

The server converts both into **page-relative percentages** before they
reach the browser, so the frontend just positions boxes with CSS
percentages and never does DPI math. Verified against a live workspace: on
a 20-page PDF the same `page_header` element lands at 4.55%/1.05% (custom)
vs 4.63%/1.22% (native) — sub-0.2% agreement.

> **Multi-page caveat.** The custom endpoint's contract parses **one page
> per call** (`page_index`), while `ai_parse_document` parses the whole
> document at once. So envelope-wide totals aren't comparable on a
> multi-page PDF, and the sidebar reports a per-page element count
> alongside the document totals. Changing page re-runs the comparison.

---

## Data & prerequisites

* **Documents** — any PDF / PNG / JPG / JPEG in a Unity Catalog volume
  (`DOCUMENTS_PATH`).
* **A page-image volume** (`IMAGE_OUTPUT_PATH`) — must already exist;
  `ai_parse_document` writes rendered pages here. Create it once:
  ```sql
  CREATE VOLUME IF NOT EXISTS justinm_demo.parse.page_images;
  ```
* **A serving endpoint** whose signature matches the reference notebook:
  it takes `file_b64`, `mime_type`, `file_path`, `file_name`,
  `file_size`, `page_limit`, `page_index`, `reformat` and returns a
  `response` column holding an `ai_parse_document` 2.0 JSON envelope.

The default endpoint (`florence-2-large-ft-ai-parse-document`) is built
by the **Florence-2 → `ai_parse_document` 2.0** notebook: Florence-2
runs `<OCR_WITH_REGION>` + `<DENSE_REGION_CAPTION>` on each page, DSPy
calls `databricks-claude-sonnet-5` with a typed Pydantic signature to
group and classify the spans, and a deterministic finalization pass
validates the envelope. Any endpoint honoring that contract can be
swapped in from the sidebar.

> **Cost note.** One comparison runs a vision model plus an LLM reformat
> pass, and a scale-to-zero endpoint may cold-start — expect anywhere
> from ~25 s (warm) to ~6 min (cold). Results are memoized per
> (document, endpoint, page); **Re-run comparison** bypasses the cache.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABRICKS_HOST` | yes\*\* | Workspace URL. Injected automatically in a deployed Databricks App. |
| `DATABRICKS_TOKEN` | local only | PAT for local dev. In a deployed App auth is automatic (M2M OAuth) and this is **not** set. |
| `WAREHOUSE_ID` | yes\* | SQL warehouse id, e.g. `abc123def456`. |
| `SQL_WAREHOUSE_HTTP_PATH` | yes\* | Alternative to the above — `/sql/1.0/warehouses/<id>`; the id is parsed from the tail. |
| `DOCUMENTS_PATH` | no | Volume folder to browse. Default `/Volumes/justinm_demo/bio_track/unstructured`. |
| `IMAGE_OUTPUT_PATH` | no | Volume `ai_parse_document` renders page images into. Default `/Volumes/justinm_demo/parse/page_images`. **Must exist.** |
| `CUSTOM_ENDPOINT_NAME` | no | Default endpoint to compare (editable in the UI). |
| `CUSTOM_RENDER_DPI` | no | DPI the custom endpoint rasterizes PDFs at. Default `200`. |
| `COMPARE_CACHE_TTL_MS` | no | Comparison cache lifetime. Default 6 h. |

\* Provide **either** `WAREHOUSE_ID` **or** `SQL_WAREHOUSE_HTTP_PATH`.

\*\* Required locally or when deploying outside the bundle. The Apps
runtime injects `DATABRICKS_HOST` and the OAuth credentials automatically.

---

## Run locally

> **npm registry note:** `package-lock.json` is **not committed** (it's in
> `.gitignore` and excluded from the bundle `sync`). The Databricks Apps
> build runs `npm install` and resolves dependencies itself, so it needs no
> lockfile.
>
> This is deliberate. On the Databricks corporate network the public npm
> registry is unreachable, so local installs need the internal proxy — but
> npm **rewrites the lockfile's `resolved` hosts to whatever registry it
> fetched from**. A lockfile generated locally therefore pins all ~186
> entries to `npm-proxy.cloud.databricks.com`, which the Apps builder
> cannot reach, and the deploy build fails. Keeping the lockfile out avoids
> that entirely.
>
> ```bash
> export NPM_CONFIG_REGISTRY=https://npm-proxy.cloud.databricks.com/   # corp network only
> ```
>
> Tradeoff: builds are not byte-reproducible — the semver ranges in
> `package.json` are the only version pin. If you ever want reproducible
> builds back, generate the lockfile explicitly against the public registry
> (`npm install --registry=https://registry.npmjs.org/`) and un-ignore it;
> do **not** commit one produced through the proxy.

```bash
cd parse_document_compare
npm install

export DATABRICKS_HOST="https://my-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="dapi..."                     # your PAT
export WAREHOUSE_ID="<your-warehouse-id>"
export DOCUMENTS_PATH="/Volumes/catalog/schema/volume"
export IMAGE_OUTPUT_PATH="/Volumes/catalog/schema/page_images"
export CUSTOM_ENDPOINT_NAME="my-parse-document-endpoint"

# Option 1 — production-style: build the SPA, serve everything from Express
npm run build
npm start                 # http://localhost:8000

# Option 2 — hot-reload dev: Vite frontend + Express backend together
npm start &               # backend on :8000
npm run dev               # frontend on :5173, proxies /api -> :8000
```

> Need an interactive Databricks login instead of a PAT? In this Claude
> Code session you can run
> `! databricks auth login --host https://my-workspace.cloud.databricks.com`
> and export the resulting token.

---

## Deploy as a Databricks App (Asset Bundle)

The repo ships a workspace-agnostic bundle (`databricks.yml`) — the
warehouse id is passed in at deploy time.

```bash
export DATABRICKS_HOST="https://my-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="dapi..."

# 1. Build the frontend (the app serves dist/ — no build step on the app side)
npm install && npm run build

# 2. Deploy, passing your warehouse id
databricks bundle deploy -t dev --var="warehouse_id=<your-warehouse-id>"

# 3. Start the app
databricks bundle run parse-document-compare -t dev
```

`warehouse_id` binds the SQL warehouse as a `CAN_USE` resource named
`sql-warehouse`; `app.yaml` reads its id at runtime via
`valueFrom: sql-warehouse` and exposes it as `WAREHOUSE_ID`. (App env
vars only deploy from `app.yaml` and resource bindings — *not* from a
bundle `config.env` block — so the id has to travel through the binding.)

**Set the volume paths and endpoint before deploying.** `DOCUMENTS_PATH`,
`IMAGE_OUTPUT_PATH`, `CUSTOM_ENDPOINT_NAME`, and `CUSTOM_RENDER_DPI` have
no resource to bind to and `app.yaml` cannot use `${var.*}`
interpolation, so they are **hardcoded in `app.yaml`** — edit them there.

Targets are `dev` (default) and `prod` (`-t prod` deploys under
`/Workspace/Shared`).

**After the first deploy**, grant the app's service principal `READ
VOLUME` on the documents volume, `READ VOLUME` + `WRITE VOLUME` on the
page-image volume, and `CAN QUERY` on the serving endpoint. No token is
needed inside the deployed app — it uses the injected M2M OAuth
credentials.

---

## Tested against a live workspace

Verified end-to-end on a SQL warehouse with the
`florence-2-large-ft-ai-parse-document` endpoint:

* **Receipt PNG** (1179×2556) — custom returned 37 fine-grained text
  boxes, native 14 semantic elements (the whole receipt table as one
  `table`, the logo as a `figure`). All boxes in bounds on both sides.
* **20-page clinical PDF** — per page, custom 8 elements vs native 6;
  bounding boxes agreed to within 0.2% of page width. Native's
  `error_status` was empty; the custom side surfaced a
  `reformat_failed` fallback on one document, which the sidebar reports.
