"""Qualify retained-volume upgrades from the published 2.0.4 image using synthetic jobs."""

from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PREVIOUS_IMAGE = "itsraininghp/production-tool@sha256:478a35c5a3ab8d7b7e7a2d530e187dafc196395b030d4d65d2be7247926adc15"
HEADERS = {
    "logikcull": "Bates/Control #,End Bates/Control #",
    "everlaw": "Begin Bates Num from Production,End Bates Num from Production",
    "unknown": "Begin Bates,End Bates",
}
QUEUE_FINALIZATIONS = """
import json
import sqlite3
import sys

with sqlite3.connect('/data/jobs/catalog.sqlite') as connection:
    job_ids = json.loads(sys.argv[1])
    for job_id in job_ids:
        row = connection.execute('SELECT payload FROM jobs WHERE job_id=?', (job_id,)).fetchone()
        job = json.loads(row[0])
        job['status'] = 'processing'
        job['progress'].update(phase='Queued for output generation', percent=5)
        task = dict(output_filename='queued.csv', acknowledged=[])
        reservation = job['review_stats']['output_size_bytes'] + 1024 * 1024
        connection.execute(
            'UPDATE jobs SET payload=?,task=?,task_payload=?,reserved_bytes=?, '
            'lease_until=NULL,lease_owner=NULL,lease_token=NULL,last_heartbeat=NULL WHERE job_id=?',
            (json.dumps(job), 'finalize', json.dumps(task), reservation, job_id),
        )
print(json.dumps(dict(queued=len(job_ids))))
"""


def docker(*args: str) -> str:
    result = subprocess.run(["docker", *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def request(base: str, method: str, endpoint: str, data: object = None, *, raw: bool = False) -> object:
    payload = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
    headers = {"Content-Type": "text/csv" if isinstance(data, bytes) else "application/json"}
    if isinstance(data, bytes):
        headers["X-File-Name"] = "synthetic-column-upgrade.csv"
    with urllib.request.urlopen(
        urllib.request.Request(base + endpoint, payload, headers, method=method),
        timeout=15,
    ) as response:
        body = response.read()
    return body if raw else json.loads(body) if body else None


def wait(base: str, job_id: str, status: str) -> dict:
    for _ in range(300):
        job = request(base, "GET", f"/api/v1/jobs/{job_id}")
        assert job["status"] != "failed", job
        if job["status"] == status:
            return job
        time.sleep(0.1)
    raise AssertionError(f"Job did not reach {status}")


def start(image: str, container: str, volume: str) -> str:
    digest = docker("image", "inspect", "--format", "{{.Id}}", image)
    docker(
        "run",
        "--detach",
        "--name",
        container,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        f"source={volume},target=/data",
        "--env",
        f"IMAGE_DIGEST={digest}",
        "--env",
        "MAX_ACTIVE_JOBS=30",
        "--publish",
        "127.0.0.1::3000",
        image,
    )
    port = docker("port", container, "3000/tcp").rsplit(":", 1)[1]
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        try:
            request(base, "GET", "/api/healthz")
            return base
        except (OSError, urllib.error.URLError):
            time.sleep(0.5)
    raise AssertionError("Container did not become healthy")


def rejected(base: str, method: str, endpoint: str, data: object = None) -> None:
    try:
        request(base, method, endpoint, data)
    except urllib.error.HTTPError as error:
        assert error.code == 409
        return
    raise AssertionError("An obsolete review was accepted")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--previous-image", default=PREVIOUS_IMAGE)
    parser.add_argument(
        "--expected-version", default=(Path(__file__).resolve().parents[2] / "VERSION").read_text().strip()
    )
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    name = f"production-tool-true-upgrade-{uuid.uuid4().hex[:12]}"
    volume = name + "-data"
    cases = []
    docker("pull", args.previous_image)
    docker("volume", "create", volume)
    try:
        base = start(args.previous_image, name, volume)
        for platform, headers in HEADERS.items():
            for enabled in (True, False):
                for state in ("configured", "reviewed", "queued", "complete"):
                    job_id = request(base, "POST", "/api/v1/jobs")["job_id"]
                    endpoint = f"/api/v1/jobs/{job_id}"
                    source = (
                        headers + ",Subject,Tag: Attorney Client\nSYN_000001,SYN_000001,Is this statement true?,TRUE\n"
                    ).encode()
                    request(base, "PUT", endpoint + "/source", source)
                    job = wait(base, job_id, "needs_configuration")
                    assert job["analysis"]["platform"] == platform
                    request(base, "PUT", endpoint + "/workflow", {"workflow": "privilege_log"})
                    columns = [
                        {"id": "subject", "name": "Subject", "source_fields": ["Subject"]},
                        {"id": "flag", "name": "Reason", "source_fields": ["Tag: Attorney Client"]},
                    ]
                    request(
                        base,
                        "PUT",
                        endpoint + "/mapping",
                        {
                            "columns": columns,
                            "replace_true_with_header": enabled,
                        },
                    )
                    case = {"id": job_id, "platform": platform, "enabled": enabled, "state": state}
                    if state != "configured":
                        request(base, "POST", endpoint + "/review", {})
                        reviewed = wait(base, job_id, "ready_for_review")
                        case["token"] = reviewed["review_token"]
                    if state == "complete":
                        request(
                            base,
                            "POST",
                            endpoint + "/finalize",
                            {
                                "output_filename": "synthetic",
                                "review_token": case["token"],
                            },
                        )
                        wait(base, job_id, "complete")
                        case["receipt"] = request(base, "GET", endpoint + "/receipt.json", raw=True)
                        case["output"] = request(base, "GET", endpoint + "/download", raw=True)
                    cases.append(case)
        docker("rm", "--force", name)
        # Recreate committed, unleased finalization tasks while the old service is stopped.
        # This avoids timing a fast finalization against container shutdown.
        queued_ids = [case["id"] for case in cases if case["state"] == "queued"]
        queued = docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--mount",
            f"source={volume},target=/data",
            "--entrypoint",
            "python",
            args.previous_image,
            "-c",
            QUEUE_FINALIZATIONS,
            json.dumps(queued_ids),
        )
        assert json.loads(queued)["queued"] == len(queued_ids)
        base = start(args.candidate_image, name, volume)
        for case in cases:
            endpoint = f"/api/v1/jobs/{case['id']}"
            job = request(base, "GET", endpoint)
            effective = case["enabled"] and case["platform"] == "logikcull"
            assert [column["replace_true_with_header"] for column in job["mapping"]["columns"]] == [effective] * 2
            assert "replace_true_with_header" not in job["mapping"]
            if case["state"] == "complete":
                assert job["status"] == "complete"
                assert request(base, "GET", endpoint + "/receipt.json", raw=True) == case["receipt"]
                assert request(base, "GET", endpoint + "/download", raw=True) == case["output"]
            else:
                assert job["status"] == "needs_configuration"
                if case["state"] in {"reviewed", "queued"}:
                    assert job["error_code"] == "review_build_changed"
                    rejected(base, "GET", endpoint + "/preview")
                    rejected(
                        base,
                        "POST",
                        endpoint + "/finalize",
                        {
                            "output_filename": "stale",
                            "review_token": case["token"],
                        },
                    )
                request(base, "POST", endpoint + "/review", {})
                wait(base, case["id"], "ready_for_review")
                preview = request(base, "GET", endpoint + "/preview")
                assert preview["rows"] == [["Is this statement true?", "Attorney Client" if effective else "TRUE"]]
        # New explicit column settings work on every platform after migration.
        for platform in HEADERS:
            case = next(item for item in cases if item["platform"] == platform and item["state"] == "configured")
            endpoint = f"/api/v1/jobs/{case['id']}"
            request(
                base,
                "PUT",
                endpoint + "/mapping",
                {
                    "columns": [
                        {
                            "id": "on",
                            "name": "Reason",
                            "source_fields": ["Tag: Attorney Client"],
                            "replace_true_with_header": True,
                        },
                        {
                            "id": "off",
                            "name": "Raw",
                            "source_fields": ["Tag: Attorney Client"],
                            "replace_true_with_header": False,
                        },
                    ]
                },
            )
            request(base, "POST", endpoint + "/review", {})
            reviewed = wait(base, case["id"], "ready_for_review")
            assert request(base, "GET", endpoint + "/preview")["rows"] == [["Attorney Client", "TRUE"]]
            request(
                base,
                "POST",
                endpoint + "/finalize",
                {
                    "output_filename": "per-column",
                    "review_token": reviewed["review_token"],
                },
            )
            wait(base, case["id"], "complete")
            receipt = request(base, "GET", endpoint + "/receipt.json")
            assert receipt["app_version"] == args.expected_version and receipt["schema_version"] == 3
            assert [column["replace_true_with_header"] for column in receipt["mapping"]["columns"]] == [True, False]
        report = {
            "previous_image": args.previous_image,
            "candidate_image": args.candidate_image,
            "candidate_version": args.expected_version,
            "retained_job_scenarios": len(cases),
            "queued_finalization_scenarios": sum(case["state"] == "queued" for case in cases),
            "mixed_column_scenarios": len(HEADERS),
            "result": "passed",
        }
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
    finally:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True, check=False)
        subprocess.run(["docker", "volume", "rm", volume], capture_output=True, check=False)


if __name__ == "__main__":
    main()
