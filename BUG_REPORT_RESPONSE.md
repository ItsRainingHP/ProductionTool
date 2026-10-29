# Response to Production Tool 1.2.0 bug report

The report examined version 1.2.0 at `f162e97`. This response reflects version 2.0.1 on `main` at `20893aa` and describes source behavior, not the state of any deployed image.

| ID | Action and current behavior |
| --- | --- |
| PT-01 | Production `/api` requests now pass through a streaming proxy directly to uvicorn. Next.js's external rewrite is limited to development. A production-container test confirms an upload with an 11 MiB CSV payload succeeds. |
| PT-02 | `next` and `eslint-config-next` were updated to 16.4.0. The production dependency audit reports zero vulnerabilities in this review. |
| PT-03 | Numbered ROG tag columns are recognized alongside RFP columns and included in pleading output. |
| PT-04 | A combined request cell recognizes additional numbered RFP or ROG requests after a semicolon or comma while preserving accompanying free text. |
| PT-05 | Uneven rows are explicitly described as excluded, and their count appears in the RFP preview and output statistics. |
| PT-06 | The CSV field limit is 16 MiB. An oversized field receives its own error instead of a broken-quote diagnosis. |
| PT-07 | Ordinary Windows-1252 CSVs are accepted when UTF-8 decoding fails. Unsupported encoding markers and undefined bytes still receive an encoding error. |
| PT-08 | Numeric Bates values without a prefix are accepted, subject to the existing width and range checks. |
| PT-09 | Leaving the wizard aborts browser upload and polling operations, preventing a late route change back into the wizard. A job already accepted by the server may continue until it is deleted or expires. |
| PT-10 | An analysis failure without an analysis result stays on Upload and displays the job error, including when a job is resumed. Version 2.0.1 also gives each analysis retry fresh scratch space and removes its temporary files, avoiding a collision with stale scratch data after a worker lease restart. |
| PT-11 | Reloading Review restores the job's acknowledged warning codes before Finalize. |
| PT-12 | Cancel stops the finalize poll and resets cancellation state, so its late result does not leave an error on a new upload. |
| PT-13 | The client displays FastAPI validation messages and checks duplicate output-column names before submission. |
| PT-14 | Preview requests wait for a review-ready or complete job, discard stale responses, and clear a preview error after success. |
| PT-15 | Browser storage failures are shown to the user. Template import validates names, source fields, transform settings, delimiters, and duplicates. |
| PT-16 | The upload endpoint streams the raw CSV body. A known oversized `Content-Length` is rejected before reading; uploads without a length are checked as chunks arrive. |
| PT-17 | The email pattern has a bounded local part, and a regression test covers the reported hostile cell shape. Private-network access lowers exposure but does not make resource limits unnecessary. |
| PT-18 | This remains a deployment-specific, unverified scenario. Network failures, access denials, and unexpected HTML responses now produce private-network or service-operator guidance. The application does not assume every such failure means a login expired. |

## Changes in 2.0.1

- Analysis retries now use scratch directories tied to their worker lease. A regression test starts with stale SQLite scratch data after a simulated lease restart and confirms analysis completes with a clean scratch directory.
- The capacity-fixture generator now makes deterministic CSVs of the requested **exact byte size** and returns their SHA-256 hash. Tests verify the hash and complete rows for both workflows. This improves boundary-test inputs; it does not by itself establish 500 MiB processing capacity in a deployment.
- Upload and template size labels now use binary units (`KiB`, `MiB`, `GiB`). The configured upload limit remains 524,288,000 bytes (500 MiB).
- Version files and release metadata now identify 2.0.1. The API contract remains at 2.0.0, so this release adds no further upload-contract change.

## Deployment scope

Production Tool is intended for a trusted private network and has no application-level login. Shared deployments need an HTTPS gateway with access control, and direct access to the container IP must also be restricted. Gateway audit logging, encrypted storage, and retention are deployment responsibilities. The report's Azure App Service Authentication scenario applies only if that identity layer is added at the gateway; its session-expiry behavior must be tested there.

The 11 MiB production-route test verifies removal of the reported Next.js threshold. The default 500 MiB setting is an **upload byte limit**, not a measured processing-capacity guarantee. Before relying on that size for shared work, measure processing time and resource use on the target host and configure the gateway request-body limit accordingly. Version 2.0.1 removed the former `deploy/QUALIFICATION_500MB.md` runbook; the current guidance is in the [README](README.md) and [security policy](SECURITY.md).

## Verification

The complete suites passed against the 2.0.1 source merged to `main` at `20893aa`:

- Backend: **345 passed**.
- Frontend unit tests: **98 passed**.
- Production-container browser tests: **8 passed**, including the **11 MiB CSV upload through the production route**.
- Standalone streaming proxy test: **1 passed**.
- Production image build and release-metadata check: **passed**.
- Production dependency audit: **zero vulnerabilities**.

The browser tests used a freshly built production image labeled with the `main` commit. The test container and its temporary resources were removed afterward. No application code was changed, and no image was published or deployed for this review.
