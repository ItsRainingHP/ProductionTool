# Incident Response Procedure

This procedure supplements the organization's incident-response, privacy, records, and legal processes. It does not replace them.

## Trigger events

Treat the following as incidents: unauthorized or unexplained access; wrong-user download; public/direct exposure; lost or stolen endpoint; wrong matter or source; unexpected output released externally; checksum mismatch; suspected source alteration; malware; missing or misleading audit data; failed deletion with possible remnants; volume or backup exposure; or a processing defect that may affect completed matters.

## Assigned incident roles

Before production use, record the following in the controlled service record: incident commander `[required]`, security lead `[required]`, responsible legal lead `[required]`, privacy/records lead `[required]`, service recovery lead `[required]`, communications owner `[required]`, and backups for each.

## Immediate actions

1. Record UTC discovery time, reporter, observed behavior, environment, job IDs, release/image digest, and potentially affected matters without copying confidential content into tickets.
2. Contain access at the gateway or firewall. For suspected disclosure or integrity failure, stop the application container to halt processing and automatic expiry; do not delete jobs or volumes.
3. Preserve gateway, container, host, endpoint, and deployment logs under the organization's evidence process. Preserve the encrypted job volume only when directed by the incident commander and responsible legal/records owner.
4. Revoke exposed sessions, links, credentials, or administrator access. Do not rotate or destroy evidence before preservation.
5. Notify the assigned security, responsible legal, privacy/records, and service owners through the approved confidential channel.

## Investigation and decisions

- Establish affected identities, job IDs, matters, source/output hashes, downloads, deletion attempts, time window, release version, and destination.
- Compare source and output against archived receipts and release metadata. Reproduce only with synthetic or formally approved sanitized data.
- The responsible legal/privacy owners decide privilege, legal-hold, contractual, regulatory, client, insurer, or law-enforcement notifications. Do not encode those decisions in application logs.
- Track known facts, hypotheses, decisions, evidence hashes, custodians, and transfers in the organization's incident system.

## Recovery and closure

Recovery requires an approved release or rollback, verified gateway policy, restored audit delivery, validated data/archive integrity, and written authorization from the incident commander plus service, security, and responsible legal owners. Follow [RECOVERY.md](RECOVERY.md), then document root cause, affected matters, notifications, corrective actions, recurrence tests, and evidence-retention disposition.

Run tabletops at least annually and after major architecture changes. Minimum scenarios are unauthorized output download, wrong transformation released externally, checksum mismatch, and incomplete deletion with residual privileged data.
