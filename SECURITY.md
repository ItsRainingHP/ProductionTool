# Security Policy

## Supported version

Security fixes are applied to the latest version available from the repository's default branch. Older snapshots and downstream modifications are not separately supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for a suspected vulnerability and do not attach confidential, client-derived, personal, privileged, or production data.

Include a concise description, affected component, impact, reproduction steps using synthetic data, and any suggested mitigation. Maintainers will acknowledge the report, assess severity, and coordinate remediation and disclosure through the private report.

## Deployment boundary

Production Tool assumes a trusted private network and intentionally has no application-level authentication. Deploy it behind a TLS-terminating reverse proxy and organization-approved network or identity access. Do not expose the application directly to the public Internet. Protect and encrypt the persistent job volume because it contains uploaded source material, generated work product, receipts, and a local SQLite job catalog until automatic expiry or explicit deletion.

The gateway must default-deny every network except the restricted private-network allowlist and retain immutable source-network/action/job/outcome audit events with a request correlation ID, without request or response bodies. The tool intentionally does not require accounts or identity headers. Publish the container only on loopback or an isolated network; the frontend must not be reachable through a gateway bypass.

The runtime must use the approved image digest, encrypted storage, a non-root user, dropped capabilities, `no-new-privileges`, a read-only root filesystem, bounded temporary storage, and a dedicated writable job volume. Malware or trusted-export screening, endpoint protection, DLP, backups, legal hold, and permanent evidence retention are external organizational controls.

Full deployment and evidence requirements are in [deploy/OPERATIONS.md](deploy/OPERATIONS.md) and [deploy/RELEASE_DOSSIER.md](deploy/RELEASE_DOSSIER.md).

## Security and data incidents

GitHub private vulnerability reporting is for product vulnerabilities only. Do not place confidential matter facts or client data in repository issues.

Suspected unauthorized access, disclosure, wrong-recipient download, checksum mismatch, malicious input, failed deletion, public exposure, or incorrect output already used in legal work must follow the organization's confidential incident channel and [deploy/INCIDENT_RESPONSE.md](deploy/INCIDENT_RESPONSE.md). Stop automatic processing/expiry when preservation is required, preserve logs and encrypted evidence under assigned incident leadership, and do not delete affected jobs before the responsible security, records/privacy, and legal owners decide disposition.
