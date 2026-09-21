# Synthetic Discovery CSV Test Corpus

This directory contains only synthetic fixtures for testing discovery and public-record response workflows. It contains no retained client values, source filenames, Bates prefixes, matter descriptions, or source row patterns.

All people, organizations, companies, government bodies, legal matters, document collections, events, names, email addresses, identifiers, Bates numbers, dates, filenames, narratives, and other values in these fixtures are fictional, synthetic, or sanitized. They do not represent any real person or entity; any resemblance to actual persons, living or dead, or to real entities or events is entirely coincidental.

## Contents

- `reference-sanitized/`: ten synthetic reconstructions of the structural export families found in the original examples.
- `generated/`: 102 fixtures covering Logikcull and Everlaw pleading/RFP and privilege-log workflows, including two focused personal-data and contact-normalization fixtures.
- `manifest.json`: the machine-readable source of truth for every fixture, its expected status, seeded conditions, expected contiguous RFP ranges, and production-wizard output statistics and hash.

Each generated platform/type set contains 15 valid or edge-valid fixtures and 10 intentionally invalid fixtures. `validation_error` means the file is parseable CSV but violates structural or Bates rules. `parse_error` means byte decoding or strict CSV parsing should fail.

## Synthetic conventions

- Bates identifiers begin with `SYN` and use a zero-padded numeric suffix.
- General-purpose fixture email addresses use reserved `.test` or `.example` domains. The focused safety fixtures use conspicuously synthetic local parts with real consumer-provider domains so domain detection is exercised without retaining source data.
- SSNs and dates of birth in focused safety fixtures are fabricated test values and do not represent source records.
- People, entities, subjects, filenames, RFP descriptions, and narratives are explicitly marked synthetic.
- Valid pleading results in the manifest contain contiguous ranges only. Gaps and different prefixes remain separate.
- Focused privilege fixtures cover quoted and angle-bracket contact forms, one-word usernames, advisory personal-data findings, and normalization/formula-escaping interactions.

Malformed files must not be opened and resaved by spreadsheet software because that can repair the intentionally seeded corruption.

## Production lifecycle validation

`backend/scripts/validate_production_corpus.py` submits every fixture through the same create, upload, configure, review, preview, finalize, download, and delete API lifecycle used by the browser wizard. Processable downloads are checked against the manifest's row, cell, byte, skipped-row, formula-escape, and SHA-256 expectations. Blocking fixtures must remain unable to enter review, preview, or finalization.

The validator emits a detailed JSON report and a Markdown report suitable for the GitHub Actions job summary. Runtime measurements are reported for diagnostics but are not acceptance thresholds.
