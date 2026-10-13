# Security Policy

## Supported version

Security fixes are applied to the latest version available from the repository's default branch. Older snapshots and downstream modifications are not separately supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue for a suspected vulnerability and do not attach confidential, client-derived, personal, privileged, or production data.

Include a concise description, affected component, impact, reproduction steps using synthetic data, and any suggested mitigation. Maintainers will acknowledge the report, assess severity, and coordinate remediation and disclosure through the private report.

## Deployment boundary

Production Tool assumes a trusted private network and has no application-level authentication. Do not expose it directly to the public Internet. Shared deployments need an HTTPS gateway with access control. Protect the persistent job volume because it contains uploaded source material, generated work product, receipts, and a local SQLite job catalog until automatic expiry or explicit deletion.

The application does not identify individual users or provide a gateway audit trail. Configure access restrictions, audit logging, TLS, and retention in the environment where it runs. Avoid logging CSV contents or other confidential data. Publishing only on host loopback does not necessarily block other Docker bridge containers from reaching the container IP; restrict that direct route in shared deployments.

The image runs as a non-root user; CI also tests a read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded temporary storage, and a writable job volume. These settings, encrypted storage, malware screening, backups, and permanent evidence retention must be configured or provided by the deployment environment.

## Security and data incidents

GitHub private vulnerability reporting is for product vulnerabilities only. Do not place confidential matter facts or client data in repository issues.

Report suspected unauthorized access, disclosure, checksum mismatch, failed deletion, public exposure, or incorrect output through the organization's confidential incident channel. If evidence may need preservation, account for the application's automatic job expiry before deleting or restarting data storage.
