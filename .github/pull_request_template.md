## Summary

Describe the user-visible behavior and the reason for the change.

## Validation

- [ ] Backend tests pass.
- [ ] Frontend type checking, linting, unit tests, and production build pass.
- [ ] CSV production validation passes when processing or fixture behavior changes.
- [ ] Production-container browser tests pass when the UI or deployment changes.
- [ ] Tests cover the changed behavior.

## Data safety

- [ ] This change contains no confidential, client-derived, personal, privileged, or production data.
- [ ] New examples and fixtures are fictional, synthetic, or sanitized.

## Release and operations

- [ ] `python deploy/verify_release_metadata.py` passes, or this change does not affect release identity.
- [ ] Docker, dependency, or deployment changes pass the production-container and image security checks.
- [ ] Upload-limit or processing changes include representative boundary and cleanup tests.
