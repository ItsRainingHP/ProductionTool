"""Loopback-only qualification server with an isolated store and no update requests."""

import argparse
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--data-dir", type=Path, required=True)
parser.add_argument("--port", type=int, default=8016)
args = parser.parse_args()
test_root = args.data_dir.resolve()
existing_root = Path(os.getenv("JOB_DATA_DIR", str(Path(__file__).resolve().parents[2] / "data"))).resolve()
if test_root == existing_root or test_root.is_relative_to(existing_root):
    parser.error("Use a separate test data directory")
marker = test_root / ".local-rfp-test-store"
if test_root.exists() and any(test_root.iterdir()) and not marker.is_file():
    parser.error("Use an empty directory or an existing marked local RFP test store")
test_root.mkdir(parents=True, exist_ok=True)
marker.touch()
os.environ["JOB_DATA_DIR"] = str(test_root)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import uvicorn  # noqa: E402

from app import system_status  # noqa: E402

system_status.published_version = lambda: system_status.APP_VERSION
uvicorn.run("app.main:app", host="127.0.0.1", port=args.port)
