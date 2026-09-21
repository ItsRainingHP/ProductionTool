# Release Approval Dossier

Copy this checklist into the controlled release record. A repository copy with unchecked boxes is a template, not approval.

## Release identity

- Application version: `[from VERSION]`
- Source revision or immutable source-archive SHA-256: `[required]`
- Build workflow/run: `[required]`
- Build UTC time: `[required]`
- OCI image digest: `[required]`
- Previous approved/rollback image digest: `[required]`
- Release owner: `[required]`
- Deployment environment(s): `[required]`

`deploy/release-metadata.json` is the repository source of release metadata. `deploy/verify_release_metadata.py` must pass. The API contract and receipt schema may version independently, but their declared values must match current source. The production image must be referenced by digest, not a mutable tag.

## Engineering evidence

- [ ] Backend dependency integrity, audit, lint, type check, tests, and coverage passed.
- [ ] Frontend lockfile install, dependency audit, type check, lint, unused-code check, tests, and production build passed.
- [ ] Full CSV corpus passed with expected processable, warning, and blocked outcomes.
- [ ] Production-container browser workflows passed.
- [ ] Runtime capabilities and security headers matched the approved configuration.
- [ ] Container ran as non-root with read-only root, dropped capabilities, `no-new-privileges`, bounded temporary storage, and a dedicated writable data volume.
- [ ] High/critical fixed vulnerabilities are absent or an exception is attached with owner and expiry.
- [ ] SPDX SBOM and third-party license summary are present, parseable, reviewed, and hashed.
- [ ] Base-image references match the verified digests in `deploy/release-metadata.json`.
- [ ] OCI labels contain the application version, source revision, build time, and MIT license.
- [ ] Release evidence artifact checksums were independently verified.

## Operational evidence

- [ ] TLS, certificate chain, HTTPS redirect, and HSTS readiness were verified.
- [ ] Restricted private-network access, administrator restrictions, TLS, request audit logging, and direct-route denial were tested.
- [ ] Gateway audit events identify the source/network identity, action, job ID, request ID, outcome, and UTC time without filename, body, or CSV-content logging. Human attribution, when required, is recorded in the external matter workflow.
- [ ] Encrypted scratch storage, monitoring, expiry, deletion-failure handling, and downstream archive access were verified.
- [ ] Normal-processing maker-checker and evidence-package procedures completed with synthetic data.
- [ ] Recovery/rollback exercise passed within approved objectives.
- [ ] Incident contacts and escalation routes are current.
- [ ] [QUALIFICATION_500MB.md](QUALIFICATION_500MB.md) passed for the target environment or a dated, approved applicability exception is attached.

## Approval

| Role | Name | Decision | UTC date | Evidence/comments |
| --- | --- | --- | --- | --- |
| Business owner | `[required]` | `[approve/reject]` | `[required]` | |
| Service owner | `[required]` | `[approve/reject]` | `[required]` | |
| Security owner | `[required]` | `[approve/reject]` | `[required]` | |
| Records/privacy owner | `[required]` | `[approve/reject]` | `[required]` | |
| Responsible legal approver | `[required]` | `[approve/reject]` | `[required]` | |
| Release approver | `[required]` | `[approve/reject]` | `[required]` | |

Any blank required field, failed check, mutable image reference, unavailable rollback, or expired risk exception is a no-go.
