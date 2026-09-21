# Production Tool Operations Standard

This standard is a deployment gate for any confidential, privileged, personal, or production data. Production Tool is an internal transient processor, not a system of record, identity provider, legal-hold repository, malware scanner, privilege-review system, or substitute for legal review.

## Assigned owners

Replace every placeholder before approving an environment.

| Role | Named owner | Backup | Responsibilities |
| --- | --- | --- | --- |
| Business owner | `[required]` | `[required]` | Approves purpose, users, service level, and residual risk. |
| Service owner | `[required]` | `[required]` | Deployment, monitoring, patching, capacity, recovery, and evidence. |
| Security owner | `[required]` | `[required]` | Gateway, allowlist, logging, vulnerability and incident response. |
| Records/privacy owner | `[required]` | `[required]` | Retention, legal hold, approved archive, deletion, and data classification. |
| Responsible legal approver | `[required]` | `[required]` | Workflow suitability, maker-checker rules, and output-release approval. |
| Release approver | `[required]` | `[required]` | Dossier completeness, image digest, SBOM, licenses, and rollback approval. |

Record contacts, escalation methods, coverage hours, and approval dates in the environment's controlled service record; do not commit personal contact details here.

## Required deployment boundary

The container must never be directly Internet-accessible. A private-network label alone is not sufficient.

- Publish the application only on loopback or an isolated container network. For a host proxy, use `--publish 127.0.0.1:3000:3000`, never `--publish 3000:3000`.
- Terminate TLS at an organization-managed gateway. Redirect HTTP to HTTPS and enable HSTS only after HTTPS exclusivity is verified.
- Do not add application accounts or require identity headers. Default-deny all traffic except the restricted private CIDR/VPN allowlist used by the approved legal operations network.
- Record source network/device identity when available, request correlation ID, action, job ID, result, and timestamp in immutable gateway audit logs without treating those records as application user accounts.
- Document allowlist exceptions, expiry, and approver, and prove there is no direct route around the gateway.
- Set the gateway request-body limit above `MAX_UPLOAD_BYTES` to allow multipart overhead; for the default 500 MiB file limit, use at least 550 MiB unless the gateway vendor requires a different calculation.
- Encrypt the host, job volume, snapshots, backups, and operator endpoints. Limit volume and Docker-administrator access to named service administrators.
- Disable request/response body logging. Never log CSV content, privilege descriptions, personal data, filenames containing matter details, cookies, or identity tokens.
- Block unnecessary outbound network access from the container. Apply `no-new-privileges`, drop Linux capabilities, use a read-only root filesystem, and provide writable mounts only for `/data` and a bounded temporary filesystem.
- Use an approved malware-scanning or trusted-export-only intake control before upload. The application does not scan files.

Example host-side hardening, still requiring an approved TLS gateway and restricted network allowlist:

```powershell
docker volume create production-tool-data
docker run --detach --name production-tool `
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m `
  --cap-drop ALL --security-opt no-new-privileges:true `
  --mount source=production-tool-data,target=/data `
  --publish 127.0.0.1:3000:3000 `
  production-tool@sha256:<approved-image-digest>
```

## Gateway audit requirements

Retain immutable events for job creation, upload completion, job/status reads, configuration changes, warning acknowledgement, preview, finalization, output and receipt downloads, and deletion. Each event must include UTC timestamp, source device or network identity, request ID, action, job ID, HTTP result, and gateway policy decision. If the organization records a human operator identity, it belongs in the external gateway or matter workflow rather than an application account. Logs must exclude filenames, file bodies, CSV contents, and secrets.

Before go-live, demonstrate that an auditor can answer who created, reviewed, finalized, downloaded, and deleted a selected job. Document the retention period and legal-hold process for these logs.

## Transient storage and external archive policy

- `JOB_DATA_DIR` is scratch storage. Its default four-hour expiry starts when the job is created.
- Never use the job catalog, output directory, or processing receipt as the authoritative matter repository.
- Before selecting **Finish** or **Process another CSV**, archive the required evidence package using [NORMAL_PROCESSING.md](NORMAL_PROCESSING.md).
- Legal holds apply to the authoritative source, approved evidence package, audit logs, and downstream work product. If an incident requires preservation, stop the service before automatic cleanup and follow [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).
- Do not back up scratch storage by default. If business requirements mandate a backup, the records/privacy owner must approve encryption, access, retention, legal hold, restoration, and destruction controls.
- A successful application delete is not proof of storage-media sanitization. The service owner must cover filesystem remnants, snapshots, backups, host caches, browser downloads, and decommissioned media in the deletion standard.

## Monitoring and routine operation

Monitor `/api/healthz`, container health, restarts, queue depth, active jobs, stored bytes, volume capacity, gateway denials, deletion failures, TLS expiry, certificate trust, and centralized-log delivery. Alert thresholds and recipients must be recorded in the environment service record.

At least quarterly, and after material platform changes:

1. Revalidate the private-network allowlist, TLS, direct-route denial, request correlation, and audit searches.
2. Exercise recovery and rollback using [RECOVERY.md](RECOVERY.md).
3. Confirm archive and legal-hold ownership.
4. Review administrator membership and browser/endpoint controls.
5. Re-run the release dossier and the 500 MiB qualification when limits, dependencies, infrastructure, or CSV processing change.

## Operational go/no-go

Do not admit real data when any required owner is blank, direct access bypasses the gateway, TLS or the restricted allowlist is unverified, centralized audit logging is unavailable, the encrypted volume is unavailable, the approved image digest is unknown, or the evidence archive cannot be written and independently verified.
