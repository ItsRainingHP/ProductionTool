# Production Tool

Production Tool converts Everlaw and Logikcull CSV exports into formatted RFP/pleading text files or configurable privilege-log CSVs. It combines a Once UI/Next.js web interface with a streaming FastAPI processor and can run as a single container.

## Features

- Detects common Everlaw and Logikcull export structures.
- Validates CSV structure, encoding, required Bates fields, ranges, gaps, and duplicates before output is generated.
- Groups shortened, contiguous Bates ranges beneath each RFP heading.
- Builds privilege logs with direct fields, shortened Bates ranges, delimited combinations, and ordered first-nonblank fallback fields.
- Provides configurable pleading separators and an optional final “and.”
- Reports advisory-only findings for possible Social Security numbers, dates of birth, consumer email domains, and one-word names or usernames in people fields.
- Optionally normalizes contact text while protecting generated CSV cells from spreadsheet-formula execution.
- Runs analysis and finalization on a durable local queue that resumes unfinished work after restart.
- Saves reusable privilege-log mappings in the current browser and imports or exports versioned JSON templates.
- Produces JSON and text processing receipts with input/output hashes and applied settings.
- Deletes expired jobs automatically; the default retention period is four hours.

Personal-data findings are informational. They do not modify the uploaded CSV and do not block processing.

## Typical workflow

1. Upload a non-empty CSV export up to the configured size limit.
2. Review the detected platform, columns, validation results, and advisory personal-data findings.
3. Select RFP/pleading ranges or privilege-log output.
4. Configure the requested formatting or field mapping.
5. Review a preview, acknowledge any overrideable warnings, and download the generated file.

## Architecture

- `frontend/` — Next.js 16 and React 19 user interface, shared API types, client validation, and component tests.
- `backend/` — FastAPI endpoints, temporary job storage, CSV analysis and transformation, and Python tests.
- `examples/` — synthetic and sanitized CSV fixtures plus their machine-readable manifest.
- `deploy/` and `Dockerfile` — single-container production process configuration.

Uploaded sources, generated outputs, receipts, and the SQLite job catalog are stored in `JOB_DATA_DIR`. They are ephemeral unless that directory is backed by a persistent volume. Jobs survive an application restart when that volume survives, and expired job directories are removed automatically.

The canonical application version is stored in `VERSION`; `deploy/release-metadata.json` records the API/receipt schemas and digest-pinned base images. A deployable release is not approved until [deploy/RELEASE_DOSSIER.md](deploy/RELEASE_DOSSIER.md) is completed with an immutable image digest and named approvers.

## Requirements

For the container workflow, install Docker. For local development, install Python 3.13 or a compatible Python 3 release, Node.js 22, and npm.

## Run with Docker

```powershell
docker build -t production-tool .
docker run --rm --name production-tool -p 127.0.0.1:3000:3000 production-tool
```

Open `http://localhost:3000`. This loopback-only command is for local evaluation. It is not an approved shared or real-data deployment.

To retain active job data across a container restart while preserving automatic expiry:

```powershell
docker run --rm --name production-tool -p 127.0.0.1:3000:3000 -v production-tool-data:/data production-tool
```

For shared use, follow [deploy/OPERATIONS.md](deploy/OPERATIONS.md). The account-free application must remain behind an organization-managed TLS gateway and restricted private-network allowlist with immutable request audit logging.

### Publish to Docker Hub

The CI workflow calls `.github/workflows/docker-publish.yml` only after the backend, frontend, production-container, browser, SBOM, and vulnerability checks pass. Configure these GitHub Actions repository secrets:

- `DOCKER_USERNAME` — the Docker Hub account or organization that owns the image.
- `DOCKER_PASSWORD` — a Docker Hub personal access token with read/write permission.

Create a Docker Hub repository named `production-tool` in that namespace before the first run and select the approved visibility. Images are published to `docker.io/<docker-username>/production-tool`. A push to `main` publishes `main`, `latest`, and `sha-<full-commit>` tags. A tag such as `v1.2.0` must match `VERSION`; it publishes `1.2.0`, `latest`, and the commit tag. The workflow summary records the resulting OCI digest.

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

Runtime container dependencies are installed from the hash-locked `backend/requirements.lock`. After changing `requirements.txt`, regenerate it with `python -m piptools compile --generate-hashes --strip-extras --output-file=requirements.lock requirements.txt`.

Open `http://localhost:3000`. In development, Next.js proxies `/api` requests to `http://127.0.0.1:8000` by default.

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

Before approving the default 500 MiB limit in a target environment, run the resource, boundary, restart, and cleanup procedure in [deploy/QUALIFICATION_500MB.md](deploy/QUALIFICATION_500MB.md).

## Configuration

Copy `.env.example` when you need to override the defaults. Environment files containing local settings are ignored by source control.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MAX_UPLOAD_BYTES` | `524288000` | Maximum source CSV size (500 MB). |
| `JOB_TTL_SECONDS` | `14400` | Job lifetime in seconds (four hours). |
| `JOB_DATA_DIR` | `/data/jobs` | Directory used for uploaded and generated job files. |
| `MAX_CONCURRENT_JOBS` | `2` | Maximum simultaneous analysis/finalization jobs. |
| `MAX_ACTIVE_JOBS` | `20` | Maximum retained jobs, including jobs waiting for user input. |
| `MAX_TOTAL_JOB_BYTES` | `5368709120` | Maximum aggregate bytes retained in the job store (5 GiB). |
| `MAX_JOB_WORK_BYTES` | `2147483648` | Per-job output/work-file ceiling (2 GiB). |
| `MAX_JOB_CREATIONS_PER_MINUTE` | `30` | Process-local job creation rate limit. |
| `API_ORIGIN` | `http://127.0.0.1:8000` | FastAPI origin used by the Next.js server. |

## Privacy, security, and intended use

The application is designed for a trusted private network. It does not provide user accounts, authorization, malware scanning, permanent job history, or a substitute for an organization's legal, privacy, records-management, or security review. Do not expose it directly to the public Internet. Terminate TLS at a reverse proxy, require organization-approved network or identity access there, set the proxy request-body limit at or above `MAX_UPLOAD_BYTES`, encrypt and restrict the persistent job volume, and include that volume in operational monitoring and secure deletion procedures. Verify generated work product before relying on it.

Treat `JOB_DATA_DIR` as transient scratch space, never as the matter file or legal-hold repository. Archive the authoritative source or its immutable locator, generated output, JSON receipt, hashes, mapping/settings, release identity, and independent review in the organization's approved external matter repository before deleting or allowing a job to expire. See [deploy/NORMAL_PROCESSING.md](deploy/NORMAL_PROCESSING.md).

The web application emits a nonce-based Content Security Policy and restrictive browser headers. HSTS belongs at the TLS-terminating reverse proxy; only enable it after the deployment is exclusively available over HTTPS.

This software is a data-preparation aid and does not provide legal advice. Its validation and personal-data detection are best-effort checks and may produce false positives or false negatives.

## Operational governance

- [Operations standard](deploy/OPERATIONS.md) — owners, gateway, allowlist, TLS, audit logging, storage, monitoring, and go/no-go rules.
- [Normal processing](deploy/NORMAL_PROCESSING.md) — intake, maker-checker review, evidence package, and closure.
- [Incident response](deploy/INCIDENT_RESPONSE.md) — containment, preservation, investigation, and recovery authorization.
- [Recovery runbook](deploy/RECOVERY.md) — clean redeployment, controlled restoration, rollback, and exercises.
- [Release dossier](deploy/RELEASE_DOSSIER.md) — engineering, license, operational, and owner approvals.
- [500 MiB qualification](deploy/QUALIFICATION_500MB.md) — exact-limit, oversized, resource, concurrency, restart, and deletion tests.

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
