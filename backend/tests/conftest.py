"""Isolate the application store before test modules import the application."""
import os
import sys
import tempfile
from pathlib import Path

_storage = None
_previous = None


def pytest_configure(config):
    global _storage, _previous
    _previous = os.environ.get("JOB_DATA_DIR")
    _storage = tempfile.TemporaryDirectory(prefix="production-tool-pytest-")
    os.environ["JOB_DATA_DIR"] = _storage.name
    config.production_test_root = Path(_storage.name).resolve()


def pytest_unconfigure(config):
    module = sys.modules.get("app.main")
    if module is not None:
        module.status_checker.stop()
        module.store.stop()
    if _storage is not None:
        _storage.cleanup()
    if _previous is None:
        os.environ.pop("JOB_DATA_DIR", None)
    else:
        os.environ["JOB_DATA_DIR"] = _previous
