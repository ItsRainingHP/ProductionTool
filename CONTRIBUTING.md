# Contributing

Contributions should be focused, reviewable, and supported by tests. Never submit confidential, client-derived, personal, privileged, or production data. Reproduction files and fixtures must be fictional, synthetic, or sanitized.

## Local validation

Install the backend dependencies and run its tests:

```powershell
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest
```

Install the frontend dependencies and run its checks:

```powershell
cd frontend
npm ci
npm run typecheck
npm run lint
npm run check:unused
npm run test
npm run build
```

Changes to CSV handling or fixtures must also run the complete production lifecycle validation:

```powershell
cd backend
python scripts/validate_production_corpus.py --json-report ../artifacts/csv-production-report/report.json --markdown-report ../artifacts/csv-production-report/report.md
```

UI or deployment changes must be checked against the production container with `npm run test:e2e` after installing the Playwright Chromium browser.

## Pull requests

Explain the behavior change, identify the validation performed, and keep generated caches, local environment files, browser reports, and job data out of the contribution. Update synthetic fixtures and their manifest expectations whenever processing behavior intentionally changes.
