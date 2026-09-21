# 500 MiB Upload Qualification

Run this controlled qualification in each target infrastructure profile before approving the default `MAX_UPLOAD_BYTES=524288000` limit, and repeat after changes to the processor, gateway, resource limits, container runtime, storage, or platform. Use only deterministic synthetic data.

Do not run this workload in routine CI. It intentionally consumes substantial CPU, memory, disk, time, and artifact storage.

## Preconditions

- Use the exact candidate image digest and production-equivalent gateway, TLS, restricted private-network allowlist, logging, encrypted storage, container limits, and monitoring.
- Confirm at least 5 GiB free in the job store plus host/runtime headroom.
- Set the proxy body limit to accommodate a 500 MiB file plus multipart overhead; 550 MiB is the minimum recommended starting point.
- Record environment, image digest, release dossier, CPU/memory/storage limits, owners, start time, and agreed performance thresholds: upload `[required]`, analysis `[required]`, finalization `[required]`, peak memory `[required]`, peak scratch bytes `[required]`.

## Create boundary files

From an empty controlled directory, use the bundled Python runtime or another approved Python 3 interpreter:

```powershell
@'
import shutil
from pathlib import Path

target = 524_288_000
accepted = Path("qualification-500m.csv")
rejected = Path("qualification-500m-plus-one.csv")
header = b"Bates/Control #,End Bates/Control #,RFP,Notes\r\n"
minimum = b"Q000000000,Q000000000,RFP 01,\r\n"

with accepted.open("wb") as handle:
    handle.write(header)
    index = 1
    while True:
        bates = f"Q{index:09d}".encode("ascii")
        row = bates + b"," + bates + b",RFP 01," + (b"x" * 900) + b"\r\n"
        remaining_after = target - handle.tell() - len(row)
        if remaining_after < len(minimum):
            break
        handle.write(row)
        index += 1
    remaining = target - handle.tell()
    bates = f"Q{index:09d}".encode("ascii")
    prefix = bates + b"," + bates + b",RFP 01,"
    suffix = b"\r\n"
    padding = remaining - len(prefix) - len(suffix)
    if padding < 0:
        raise RuntimeError("Unable to create an exact-size final CSV row")
    handle.write(prefix + (b"z" * padding) + suffix)

if accepted.stat().st_size != target:
    raise RuntimeError(f"Expected {target} bytes, got {accepted.stat().st_size}")
shutil.copyfile(accepted, rejected)
with rejected.open("ab") as handle:
    handle.write(b"x")
print(accepted.stat().st_size, rejected.stat().st_size)
'@ | python -

Get-FileHash -Algorithm SHA256 qualification-500m.csv
Get-FileHash -Algorithm SHA256 qualification-500m-plus-one.csv
```

The second copy temporarily requires another 500 MiB. Delete both securely after evidence is approved and no hold applies.

## Test cases

1. **Exact limit:** Upload the 524,288,000-byte file. Confirm gateway and application accept it, analysis and finalization complete within approved thresholds, the UI remains responsive, output/receipt download succeeds, and source/output hashes verify.
2. **Limit plus one:** Upload the 524,288,001-byte file. Confirm HTTP 413, a clear user message, no final output, no retained partial source, and an attributable gateway event.
3. **Proxy boundary:** Confirm the accepted file is not rejected by the gateway and the oversized case is rejected by the application rather than an ambiguous proxy timeout. Record configured and effective gateway limits.
4. **Resource pressure:** During exact-limit processing, capture peak container/host CPU, memory, scratch bytes, queue depth, response latency, and health status. Confirm no OOM, restart, storage alert, or unrelated-job corruption.
5. **Concurrency:** Submit the approved number of concurrent exact-limit jobs for the environment, within the aggregate 5 GiB limit. Confirm queue behavior, isolation, health responsiveness, and capacity alerts. If concurrent 500 MiB processing is not approved, set and document a lower operational concurrency limit.
6. **Restart:** During a synthetic exact-limit analysis or finalization, restart the container under the approved procedure. Confirm the durable queue resumes or fails safely, the source remains attributable, and no duplicate/mixed output is released.
7. **Expiry and deletion:** Archive test evidence, delete the jobs, wait through a cleanup cycle, and confirm job directories/catalog records are absent. Inspect logs for deletion errors and verify storage usage returns to baseline.

## Acceptance record

Attach input hashes, exact sizes, timestamps, gateway/application results, receipt and output hashes, performance graphs, health/restart events, job IDs, deletion evidence, image digest, configuration export, exceptions, and operator/reviewer identities to the release dossier.

The qualification fails on timeout, unexplained restart, checksum mismatch, mixed-job data, retained partial source, missing audit event, unbounded resource growth, unavailable output/receipt, unexplained row counts, deletion error, or any threshold breach. Remediate and rerun; do not waive an integrity or confidentiality failure.
