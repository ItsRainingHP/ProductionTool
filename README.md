# Production Tool

Production Tool converts Everlaw and Logikcull CSV exports into formatted RFP/pleading text files or configurable privilege-log CSVs. It combines a Once UI/Next.js web interface with a streaming FastAPI processor and can run as a single container.

## Features

- Detects common Everlaw and Logikcull export structures.
- Validates CSV structure, encoding, required Bates fields, ranges, gaps, and duplicates before output is generated.
- Groups shortened, contiguous Bates ranges beneath each RFP heading.
- Builds privilege logs with direct fields, shortened Bates ranges, delimited combinations, and ordered first-nonblank fallback fields.
- Uses unpadded ending numbers in shortened Bates ranges, for example `EXAMPLE_000001-92`.
- Optionally replaces whole-cell `TRUE` values with source headings in any privilege log, including Everlaw and Logikcull. Enable **Replace TRUE cells with source headings** below **Normalize names and emails** for each output column; it starts disabled and affects only that column’s mapped inputs. Matching ignores case and surrounding whitespace, removes a leading `Tag:` from the source heading, and runs before Direct, Join, or Fill and normalization. Text containing `TRUE` is preserved. Bates range columns do not use this setting.
- Provides configurable pleading separators and an optional final “and.”
- Reports advisory-only findings for possible Social Security numbers, dates of birth, consumer email domains, and one-word names or usernames in people fields.
- Optionally normalizes contact text while protecting generated CSV cells from spreadsheet-formula execution.
- Runs analysis and finalization on a durable local queue that resumes unfinished work after restart.
- Saves reusable privilege-log mappings in the current browser and imports or exports versioned JSON templates.
- Offers a skippable first-use tour after **Start Processing**, with component highlights, separate introductions for each output path, and optional mapping/formatting help. Pause inside the tour and use **Help** in the production workspace to resume or replay guidance. Tour preferences stay in browser storage; the bundled tour uses no external service or analytics. The home page has no tour popup.
- Produces JSON and text processing receipts with input/output hashes and applied settings.
- Deletes expired jobs automatically; the default retention period is four hours.

Personal-data findings are informational. They do not modify the uploaded CSV and do not block processing.

## Typical workflow

1. Upload a non-empty CSV export up to the configured size limit.
2. Review the detected platform, columns, validation results, and advisory personal-data findings.
3. Select RFP/pleading ranges or privilege-log output.
4. Configure the requested formatting or field mapping.
5. Review a preview, acknowledge any overrideable warnings, and download the generated file.

### Per-column TRUE replacement in 2.0.5

Mapping requests now put `replace_true_with_header` on each output column (default `false`). The deprecated job-wide request flag remains accepted for legacy clients only: it retains its previous Logikcull-only behavior and cannot be combined with explicit column flags. Mixed requests return HTTP 422 with instructions to reload or update the request. Saved mappings and responses contain only column settings.

Existing job settings and tab drafts migrate automatically, preserving the previous effective platform behavior. New template exports and tab drafts use schema 2; schema 1 templates import with replacement disabled because they did not store the global choice. New receipts use schema 3 and record each column’s setting. Existing completed receipts and downloads are retained unchanged. Pending output requires a new review after upgrading; clearing job data is unnecessary.

Take a snapshot of the retained job volume before upgrading. Version 2.0.4 cannot represent independent per-column TRUE settings, so a rollback must restore the pre-upgrade volume snapshot or use a separate job volume and reconfigure newly uploaded sources. Completed evidence exported before rollback remains readable independently of the running application.

### API upload change in 2.0.0

Upload clients must send the CSV bytes as a raw `PUT /api/v1/jobs/{job_id}/source` request, with a supported CSV `Content-Type` and URL-encoded `X-File-Name` header. Multipart transport has been removed and returns HTTP 415. This is a breaking change for clients that previously sent a multipart `file` field; migrate them to the raw request before upgrading. The browser already uses raw uploads.

## Architecture

- `frontend/` — Next.js 16 and React 19 user interface, shared API types, client validation, and component tests.
- `backend/` — FastAPI endpoints, temporary job storage, CSV analysis and transformation, and Python tests.
- `examples/` — synthetic and sanitized CSV fixtures plus their machine-readable manifest.
- `deploy/` and `Dockerfile` — single-container production process configuration.

Uploaded sources, generated outputs, receipts, and the SQLite job catalog are stored in `JOB_DATA_DIR`. They are ephemeral unless that directory is backed by a persistent volume. Jobs survive an application restart when that volume survives, and expired job directories are removed automatically.
Pending review artifacts record the application version, build ID, source revision, and image digest that generated them. After a build change, older or unmarked pending artifacts and queued finalizations are invalidated. The uploaded CSV and settings are retained, and the job returns to Advanced to generate and review a new preview before finalizing. Existing completed downloads and their original receipts are retained until expiry or deletion.
RFP processing scratch and SQLite disk-based temporary files also use the job volume, so capacity monitoring must include them.

The canonical application version is stored in `VERSION`; `deploy/release-metadata.json` records the API/receipt schemas, digest-pinned base images, and qualified runtime versions. The production runtime uses Wolfi packages with SQLite 3.54.1 or newer, Python 3.14, and Node 22.23.4. The application retains UID/GID 999 for compatibility with existing job volumes. CI verifies this identity, the installed versions, and the production Python lockfile inside the image before testing the browser workflows.

Security gates audit all frontend and Python development dependencies and scan the complete production image at every severity, including unfixed findings. A successful run has no known vulnerability findings in these audits; scans must be repeated as advisory data changes.

### Footer Systems Status

The footer shows **Systems Status** below the version number. Its circle is green with the browser hover text `ready`, or yellow with `update available` when a newer stable ProductionTool version is published. These messages appear only as native hover text on the circle, never as permanent footer text. Screen readers receive the status through the circle's accessible label. This is an update indicator; it does not install updates or measure service health.

`GET /api/v1/system-status` returns `current_version`, nullable `latest_version`, and `update_available`. The backend checks the `APP_VERSION` environment entry in the published `docker.io/itsraininghp/production-tool:latest` Linux/amd64 image configuration, using anonymous, pull-scoped Docker Registry API requests. It retrieves metadata only, with a five-second timeout per request and a one-MiB limit per response. The server requires outbound HTTPS to `auth.docker.io`, `registry-1.docker.io`, and Docker's metadata CDN redirects; browser clients contact only the local application. Uploaded files and job data are never sent with these checks.

Status requests immediately return cached results while one background worker refreshes metadata. Successful checks are shared across clients and cached in memory for one hour. Failed checks retain the last confirmed result and retry after five minutes; before any successful check, the circle stays green. This cache resets on application restart. Visible browser tabs refresh their local status every five minutes and when becoming visible, retaining their last color on request failure and across page navigation.

## Requirements

For the container workflow, install Docker. For local development, install Python 3.13 or a compatible Python 3 release, Node.js 22, and npm.

## Run with Docker

```powershell
docker build -t production-tool .
$localImageDigest = docker image inspect --format '{{.Id}}' production-tool
docker run --rm --name production-tool -e IMAGE_DIGEST=$localImageDigest -p 127.0.0.1:3000:3000 production-tool
```

Open `http://localhost:3000`. This loopback-only command is for local evaluation; it does not configure access control, TLS, or encrypted job storage.

To retain active job data across a container restart while preserving automatic expiry:

```powershell
$localImageDigest = docker image inspect --format '{{.Id}}' production-tool
docker run --rm --name production-tool -e IMAGE_DIGEST=$localImageDigest -p 127.0.0.1:3000:3000 -v production-tool-data:/data production-tool
```

For shared use, put the account-free application behind an HTTPS gateway with appropriate access control. Restrict direct access to the container IP as well: publishing only to host loopback does not necessarily block other Docker bridge containers. Restrict and encrypt the job volume, and configure the gateway's request-body limit for the intended CSV size. Gateway audit logging and data-retention policy are deployment responsibilities; the application does not identify individual users.

### Publish to Docker Hub

The CI workflow calls `.github/workflows/docker-publish.yml` only after the backend, frontend, production-container, browser, SBOM, and vulnerability checks pass. Configure these GitHub Actions repository secrets:

- `DOCKER_USERNAME` — the Docker Hub account or organization that owns the image.
- `DOCKER_PASSWORD` — a Docker Hub personal access token with read/write permission.

Create a Docker Hub repository named `production-tool` in that namespace before the first run and select the approved visibility. Images are published to `docker.io/<docker-username>/production-tool`. A push to `main` publishes `main`, `latest`, and `sha-<full-commit>` tags. A tag such as `v2.0.4` must match `VERSION`; it publishes `2.0.4`, `latest`, and the commit tag. The workflow summary records the resulting OCI digest.

Mutable tags are convenient for discovery, but production deployments must pin the digest reported by the successful workflow:

```powershell
docker pull docker.io/<docker-username>/production-tool@sha256:<published-digest>
```

## Local development

Start the API from the repository root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python -m uvicorn app.main:app --reload --port 8000
```

In another terminal, start the web app:

```powershell
cd frontend
npm install
npm run dev
```

Runtime container dependencies are installed from the hash-locked `backend/requirements.lock`; Linux CI uses `backend/requirements-dev.lock` with `--require-hashes`. These locks are generated on Linux with Python 3.14; Windows development uses `requirements-dev.txt` so platform-specific packages such as uvloop are resolved correctly. After changing either input file, regenerate both locks in the qualified Linux environment with `python -m piptools compile --allow-unsafe --generate-hashes --strip-extras --output-file=requirements.lock requirements.txt` and `python -m piptools compile --allow-unsafe --constraint=requirements.lock --generate-hashes --strip-extras --output-file=requirements-dev.lock requirements-dev.txt`. The `--allow-unsafe` option includes hashed pins for packaging tools required by CI. Release validation rejects mismatched direct pins or production/development lock versions. Keep TypeScript 5 and Node 22 declarations aligned with the API generator and deployed runtime, and update Vitest and its coverage provider together.

Open `http://localhost:3000`. In development, Next.js proxies `/api` requests to `http://127.0.0.1:8000` by default.

### Security compatibility for frontend tooling

All frontend tooling uses the patched `minimatch` 11.0.4 through a pinned development dependency and npm override. The existing ESLint, React/accessibility/import plugins and API generator still require older module exports. `npm ci` runs `frontend/scripts/secure-tooling.mjs` to preserve their callable CommonJS and default ESM imports. It also changes the import plugin's two removed `makeRe` calls to predicates backed by the patched matcher; it does not restore the old regular-expression engine or alter minimatch's matching implementation.

The adapter verifies the exact versions and SHA-256 hashes of the three published files before writing anything, accepts only its exact prepared result on repeated runs, and fails installation for unknown source changes. Keep npm install scripts enabled. A production-only install that omits these development dependencies does not need the adapter. Do not update the expected versions or hashes without reviewing the upstream changes and repeating qualification.

Run `npm run test:tooling` to exercise the actual ESLint configuration, import restrictions, React render-prop handling, accessibility controls, ESM configuration, OpenAPI header matching/type generation, source-integrity rejection and bounded processing of amplifying glob input. CI also verifies `npm ls --all` and retains the full `npm audit --audit-level=low` gate. Remove the compatibility adapter and its legacy-specific checks when the parent tools support the patched API directly; this is a compatibility migration, not a vulnerability exception.

## Validation

Run the backend test suite:

```powershell
cd backend
python -m pytest
```

Run the frontend checks:

```powershell
cd frontend
npm run typecheck
npm run lint
npm run test:tooling
npm run check:unused
npm run test
npm run build
```

The backend suite exercises every CSV described by `examples/manifest.json`, including valid, validation-error, parse-error, personal-data, and contact-normalization fixtures. To run every fixture through the complete production API lifecycle and produce report artifacts:

```powershell
cd backend
python scripts/validate_production_corpus.py --json-report ../artifacts/csv-production-report/report.json --markdown-report ../artifacts/csv-production-report/report.md
```

Production-container browser smoke tests use Playwright. Build and start the container, install Chromium once with `npx playwright install chromium`, then run `npm run test:e2e` from `frontend/`.

The default 500 MiB value is an upload byte limit. Measure processing time and resource use on the target host before relying on that capacity for shared work.

## Configuration

Copy `.env.example` when you need to override the defaults. Environment files containing local settings are ignored by source control.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MAX_UPLOAD_BYTES` | `524288000` | Maximum source CSV size (500 MiB). |
| `JOB_TTL_SECONDS` | `14400` | Job lifetime in seconds (four hours). |
| `JOB_DATA_DIR` | `/data/jobs` | Directory used for uploaded and generated job files. |
| `SQLITE_TMPDIR` | `/data/jobs/.sqlite-tmp` in the container | Monitored scratch for SQLite sort files; the job store creates this directory and directs SQLite to it. |
| `MAX_CONCURRENT_JOBS` | `2` | Maximum simultaneous analysis/finalization jobs. |
| `MAX_ACTIVE_JOBS` | `20` | Maximum retained jobs, including jobs waiting for user input. |
| `MAX_TOTAL_JOB_BYTES` | `5368709120` | Maximum aggregate bytes retained in the job store (5 GiB). |
| `MAX_JOB_WORK_BYTES` | `2147483648` | Per-job analysis spool and combined RFP spool/staged-output ceiling (2 GiB); privilege output uses the same ceiling. |
| `MAX_JOB_CREATIONS_PER_MINUTE` | `30` | Process-local job creation rate limit. |
| `IMAGE_DIGEST` | required in the container | Exact `sha256:` image digest injected by deployment for processing receipts. |
| `API_ORIGIN` | `http://127.0.0.1:8000` | FastAPI origin used by the Next.js server. |

## Privacy, security, and intended use

The application is designed for a trusted private network. It does not provide user accounts, authorization, malware scanning, permanent job history, or legal or privacy review. Do not expose it directly to the public Internet. Use an HTTPS gateway with access control, protect the job volume, and verify generated work product before relying on it.

`JOB_DATA_DIR` is transient scratch space. Download anything needed before the job expires or is deleted. The downloadable evidence ZIP contains the generated output, JSON/text receipts, and their hash manifest; it does not contain the source CSV or a human review record. Retain those separately if your workflow requires them.

The web application emits a nonce-based Content Security Policy and restrictive browser headers. HSTS belongs at the TLS-terminating reverse proxy; only enable it after the deployment is exclusively available over HTTPS.

This software is a data-preparation aid and does not provide legal advice. Its validation and personal-data detection are best-effort checks and may produce false positives or false negatives.

## Example-data disclaimer

All sample, demonstration, test, fixture, and screenshot data included with this project is fictional, synthetic, or sanitized for software testing. It does not represent, describe, or refer to any real person, client, organization, company, government body, legal matter, document collection, or other entity. Names, email addresses, identifiers, Bates numbers, dates, filenames, narratives, and other example values are fabricated; any resemblance to actual persons, living or dead, or to real entities or events is entirely coincidental.

The intentionally malformed fixtures under `examples/` are designed to exercise validation failures. Do not open and resave them in spreadsheet software, which can repair or alter the seeded corruption. See `examples/README.md` for corpus details.

## Contributing

Contributions should preserve the privacy guarantees above, include tests for behavior changes, and pass the backend and frontend validation commands. Do not commit confidential, client-derived, or personally identifying data.

## Author

Production Tool was created and is maintained by Brent Coleman.

## License

Production Tool is free to use, copy, modify, distribute, and sublicense under the [MIT License](LICENSE), subject to preserving its copyright and permission notice. The software is provided without warranty. Third-party packages and UI assets remain subject to their own licenses.

Copyright (c) 2026 Brent Coleman.
