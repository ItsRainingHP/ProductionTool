# Normal Processing Procedure

Use this procedure for every real-data job. The operator and reviewer must be different people for filings, productions, privilege logs, or any external disclosure.

## 1. Intake

- Record the matter/work identifier, authorized purpose, authoritative source location, source-system export identifier, operator, reviewer, release image digest, and applicable hold or retention instruction in the controlled matter workspace.
- Confirm the source is an approved Everlaw or Logikcull export and has passed the organization's malware or trusted-export control.
- Calculate and record the source SHA-256 before upload. Do not rename, resave, or open malformed-test candidates in spreadsheet software.
- Confirm the external evidence archive is writable and access-restricted. Do not begin if only the Production Tool scratch volume is available.

## 2. Operator processing

1. Access the tool through the approved HTTPS gateway and confirm the expected environment banner/hostname.
2. Upload the source and record the job ID without placing matter names or confidential text in unapproved logs.
3. Verify detected platform, workflow, row and column counts, Bates headers, prefixes, gaps, duplicates, warnings, and personal-data advisories against the intake record.
4. Treat personal-data detection as advisory only. It is not privacy, privilege, redaction, or disclosure clearance.
5. Configure the workflow and mapping. For every warning, record the business reason for proceeding and its expected effect; do not merely check the acknowledgement box.
6. Review the preview, but do not treat the first five rows or ranges as full-file verification.
7. Finalize once and download the output plus the JSON receipt. Retain the text receipt only when the matter procedure calls for a human-readable copy.
8. Calculate the downloaded output SHA-256 and compare it with the JSON receipt. Record the comparison result.

Stop and follow [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) for an unexpected platform, unexplained count, checksum mismatch, missing receipt, inaccessible archive, wrong matter/source, suspected unauthorized access, or output that differs from the approved mapping.

## 3. Independent reviewer

The reviewer must inspect the source, output, receipt, mapping/settings, and warning dispositions, then record:

- source hash matches intake;
- output hash matches receipt;
- input/output row counts and skipped rows are explained;
- Bates gaps, duplicates, prefixes, shortened ranges, and ordering are expected;
- all required output columns are present and source-field mappings are correct;
- formula escapes and normalization are expected;
- a risk-based sample includes the first, last, warning-affected, blank, long, quoted, and Unicode records;
- personal-data and privilege/privacy review occurred under the matter's separate procedure;
- destination and filename are correct;
- release image digest is on the approved dossier.

The reviewer records approve/reject, UTC time, identity, comments, and any remediation. Rejected output must not be released.

## 4. Evidence package and closure

Archive these items together in the controlled matter repository:

1. authoritative source file, or immutable repository locator plus verified source hash;
2. generated output and verified output hash;
3. JSON processing receipt;
4. mapping/settings export or reviewer-readable configuration record;
5. operator and reviewer checklist with warning rationale;
6. application version, image digest, source revision/build ID, and release-dossier reference;
7. gateway audit request/event references;
8. destination or transfer record when output leaves the organization.

Have the reviewer reopen the archived files and repeat both hash checks. Only then may the operator select **Finish** or **Process another CSV**. Record the closure time and, where supported, the deletion audit event. The external repository controls retention and legal hold.
