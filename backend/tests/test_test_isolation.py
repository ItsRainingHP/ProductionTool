"""Prove inherited job storage survives an API test subprocess."""
import os
import subprocess
import sys
from pathlib import Path


def test_pytest_preserves_inherited_job_storage(tmp_path):
    sentinel = tmp_path / "retained"
    sentinel.mkdir()
    source = sentinel / "source.csv"
    source.write_bytes(b"synthetic retained job")
    environment = dict(os.environ, JOB_DATA_DIR=str(sentinel))
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_api.py::test_rfp_job_lifecycle", "-q"],
        cwd=Path(__file__).resolve().parents[1], env=environment,
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert list(sentinel.iterdir()) == [source]
    assert source.read_bytes() == b"synthetic retained job"
