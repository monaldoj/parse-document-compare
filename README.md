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

* **Documents volume** (`DOCUMENTS_PATH`) — any Unity Catalog volume
  folder holding PDF / PNG / JPG / JPEG files. `ai_parse_document`
  automatically writes its rendered page images to a `/page_images`
  subdirectory inside this same volume (`<documents_path>/page_images`),
  even when you switch to a different volume directory in the UI.
* **A serving endpoint** whose signature matches the reference notebook:
  it takes `file_b64`, `mime_type`, `file_path`, `file_name`,
  `file_size`, `page_limit`, `page_index`, `reformat` and returns a
  `response` column holding an `ai_parse_document` 2.0 JSON envelope.

The default comparison is native `ai_parse_document` vs the
`ai-parse-document-fmapi` serving endpoint. Additional custom endpoints
honoring that contract can be configured as a comma-separated list via
`custom_endpoint_names` in `databricks.yml` (or `CUSTOM_ENDPOINT_NAMES`
in the environment).

> **Cost note.** One comparison runs a vision model plus an LLM reformat
> pass, and a scale-to-zero endpoint may cold-start — expect anywhere
> from ~25 s (warm) to ~6 min (cold). Results are memoized per
> (document, endpoint, page); **Re-run comparison** bypasses the cache.

---

## Bundle & Environment variables

Defaults live in `databricks.yml` under `variables:` and flow into `app.yaml` / `queries.js`:

| Bundle variable (`databricks.yml`) | Env variable (`app.yaml`) | Default | Purpose |
|---|---|---|---|
| `app_name` | *(injected as `DATABRICKS_APP_NAME`)* | `parse-document-compare` | Name of the deployed Databricks App. |
| — | `DATABRICKS_HOST` | *(injected in Apps)* | Workspace URL. Required locally. |
| — | `DATABRICKS_TOKEN` | *(local only)* | PAT for local dev. Deployed Apps use automatic M2M OAuth. |
| `warehouse_id` | `WAREHOUSE_ID` | `<sql warehouse_id>` | SQL warehouse id that runs `ai_parse_document` and `ai_query`. |
| `documents_path` | `DOCUMENTS_PATH` | `/Volumes/<catalog>/<schema>/docs` | Volume folder holding PDFs and images to parse. Rendered page images are written to `<documents_path>/page_images`. |
| `custom_endpoint_names` | `CUSTOM_ENDPOINT_NAMES` | `ai-parse-document-fmapi` | Comma-separated list of Model Serving endpoints populating the parser dropdowns (alongside `ai_parse_document` and `No model`). |
| — | `CUSTOM_RENDER_DPI` | `200` | DPI the custom endpoints rasterize PDFs at. |
| — | `COMPARE_CACHE_TTL_MS` | `21600000` (6 h) | Comparison cache lifetime. |

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
export DOCUMENTS_PATH="/Volumes/catalog/schema/docs"
export CUSTOM_ENDPOINT_NAMES="ai-parse-document-fmapi"

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

The repo ships a workspace-agnostic Databricks Asset Bundle (`databricks.yml`).
All workspace-specific configuration lives under `variables:` in `databricks.yml`:

* `app_name` — Name of the deployed Databricks App (default: `"parse-document-compare"`)
* `warehouse_id` — SQL warehouse ID (default: `"<sql warehouse_id>"`)
* `documents_path` — Unity Catalog volume folder with PDFs/images to parse (default: `"/Volumes/<catalog>/<schema>/docs"`). Rendered page images from `ai_parse_document` are automatically written to `<documents_path>/page_images` in the same volume.
* `custom_endpoint_names` — Comma-separated list of Model Serving endpoint names for the parser dropdowns (default: `"ai-parse-document-fmapi"`)

Because `lifecycle.started: true` is set on the app resource in `databricks.yml`, deploying the bundle automatically pushes the source code and starts (or restarts) the app — no separate `bundle run` step is required.

---

### Option 1: Deploy from a local machine (Databricks CLI)

1. **Authenticate the Databricks CLI** (requires CLI `>= v0.239.0`):
   ```bash
   databricks auth login --host https://my-workspace.cloud.databricks.com --profile my-profile
   ```
   *(Alternatively, export `DATABRICKS_HOST` and `DATABRICKS_TOKEN` in your shell.)*

2. **Set your bundle variables** — either edit the `default:` values under `variables:` in `databricks.yml`, or pass them on the command line with `--var`:
   ```bash
   # Validate the bundle configuration
   databricks bundle validate -t dev --profile my-profile \
     --var="warehouse_id=<your-warehouse-id>" \
     --var="documents_path=/Volumes/<catalog>/<schema>/docs" \
     --var="custom_endpoint_names=ai-parse-document-fmapi"

   # Deploy and start the app
   databricks bundle deploy -t dev --profile my-profile \
     --var="warehouse_id=<your-warehouse-id>" \
     --var="documents_path=/Volumes/<catalog>/<schema>/docs" \
     --var="custom_endpoint_names=ai-parse-document-fmapi"
   ```
   If you updated the defaults directly in `databricks.yml`, you can simply run:
   ```bash
   databricks bundle deploy -t dev --profile my-profile
   ```
   Targets are `dev` (default) and `prod` (`-t prod` deploys under `/Workspace/Shared`).

---

### Option 2: Deploy from a DAB in the Databricks Workspace

You can also deploy and manage the bundle directly from the Databricks Workspace UI without installing the CLI locally:

1. **Import the repository into your Workspace**:
   * In the left sidebar, click **Workspace** → navigate to your user folder (or `/Workspace/Shared`).
   * Click **Create** → **Git folder**, paste the repository URL, and click **Create Git folder** (or upload the project folder directly into Workspace files).
2. **Configure `databricks.yml` variables**:
   * Open `databricks.yml` in the Workspace editor and set your workspace's values for `warehouse_id`, `documents_path`, and `custom_endpoint_names` under `variables:` (or override them in the Bundles UI panel).
3. **Deploy from the Asset Bundles UI**:
   * Open the **Bundle** view in the left-hand sidebar of the Git folder (the bundle icon next to the file tree).
   * Select your target (`dev` or `prod`).
   * Click **Validate** to verify the configuration, then click **Deploy**.
   * Because `lifecycle.started: true` is configured on `resources.apps.parse-document-compare`, clicking **Deploy** will create the app, bind the SQL warehouse, sync the source files, and start the app compute automatically.
   * Once deployed, open **Compute** → **Apps** → **parse-document-compare** to view the running app URL and logs.

---

### Post-deploy permissions

* **SQL Warehouse**: `warehouse_id` binds the SQL warehouse as a `CAN_USE` resource named `sql-warehouse`, so the app's service principal is granted `CAN_USE` automatically on deploy.
* **Volume & Serving Endpoints**: After the first deploy, grant the app's service principal:
  * `READ VOLUME` + `WRITE VOLUME` on the `documents_path` volume (used both for reading/uploading documents and for writing rendered page images under `<documents_path>/page_images`)
  * `CAN QUERY` on each Model Serving endpoint listed in `custom_endpoint_names`

No PAT is needed inside the deployed app — it uses the M2M OAuth credentials injected automatically by the Databricks Apps runtime.
