# Recovery and Continuity Runbook

Production Tool is a transient processor. The authoritative source and approved evidence package must live outside the application. Default recovery is a clean redeployment followed by reprocessing from the authoritative source, not restoration of stale scratch jobs.

## Service objectives

Complete before approval: service owner `[required]`, recovery owner `[required]`, approved RTO `[required]`, approved RPO `[required; normally zero authoritative-record loss because records are external]`, rollback image digest `[required]`, and last exercise date `[required]`.

## Clean recovery

1. Open an operational event and preserve evidence if security, integrity, or confidentiality may be involved.
2. Identify the last approved image by immutable digest and verify its signed/controlled release dossier, SBOM, vulnerability result, and rollback status.
3. Recreate the encrypted scratch volume. Do not attach an old job volume unless records/privacy and responsible legal owners authorize it.
4. Start the container with a read-only root filesystem, bounded `/tmp`, dropped capabilities, `no-new-privileges`, the writable `/data` volume, and loopback-only publication.
5. Restore the approved gateway route, TLS, restricted private-network allowlist, body-size limit, and audit-log destination. Verify the container is unreachable through any bypass route.
6. Check health, security headers, runtime capabilities, release labels, centralized logs, storage limits, and a synthetic end-to-end job including receipt/hash verification and deletion.
7. Reprocess interrupted work from the authoritative source under [NORMAL_PROCESSING.md](NORMAL_PROCESSING.md). Never infer completion from files left on a recovered scratch volume.
8. Obtain service-owner and security-owner approval before reopening; obtain responsible-legal approval after an integrity or confidentiality incident.

## Scratch-volume restoration exception

If business requirements mandate restoration, record the authorization, snapshot identity and hash, encryption and access controls, backup timestamp, hold/retention status, expected job IDs, and restore destination. Restore into an isolated environment first. Verify SQLite integrity, file hashes, job expiry, malware controls, and matter authorization before reconnecting users. Delete superseded copies under the approved destruction process.

## Rollback and exercises

Keep the last approved image by digest and its dossier until the successor's rollback window closes. A rollback must preserve external evidence packages and use a fresh scratch volume unless the exception above is approved.

Exercise clean redeployment, gateway reconstruction, synthetic reprocessing, audit-log search, image rollback, and storage-full recovery at least annually. Record actual recovery time, data loss, gaps, corrective actions, and owner sign-off.
