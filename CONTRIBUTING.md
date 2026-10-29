# Contributing

Contributions should be focused, reviewable, and supported by tests. Never submit confidential, client-derived, personal, privileged, or production data. Reproduction files and fixtures must be fictional, synthetic, or sanitized.

## Local validation

Install the backend dependencies and run its tests:

```powershell
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest
```

Regenerate both Python lockfiles together on Linux under Python 3.14 after changing dependency inputs. Their shared production packages must match. Linux CI installs `requirements-dev.lock` with `--require-hashes`; Windows development uses the input file to resolve platform-specific dependencies. Run `python deploy/verify_release_metadata.py` from the repository root and audit the complete Linux development lock with `python -m pip_audit -r backend/requirements-dev.lock`.

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

Run `npm audit --audit-level=low` for the full frontend dependency graph. Production images must pass the configured Trivy scan at every severity with unfixed findings included. Verify the installed SQLite, Node, Python, and locked package versions with `docker exec <container> python /app/verify_runtime.py`.

Changes to CSV handling or fixtures must also run the complete production lifecycle validation:

```powershell
cd backend
python scripts/validate_production_corpus.py --json-report ../artifacts/csv-production-report/report.json --markdown-report ../artifacts/csv-production-report/report.md
```

UI or deployment changes must be checked against the production container with `npm run test:e2e` after installing the Playwright Chromium browser.

## Pull requests

Explain the behavior change, identify the validation performed, and keep generated caches, local environment files, browser reports, and job data out of the contribution. Update synthetic fixtures and their manifest expectations whenever processing behavior intentionally changes.
