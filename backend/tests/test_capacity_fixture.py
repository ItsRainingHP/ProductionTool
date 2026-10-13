# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

import csv
import hashlib
from pathlib import Path

import pytest

from scripts.generate_capacity_fixture import generate


@pytest.mark.parametrize("workflow", ["rfp_ranges", "privilege_log"])
def test_capacity_fixture_is_deterministic_and_exact(tmp_path: Path, workflow: str) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    first_result = generate(first, 64 * 1024, workflow)
    second_result = generate(second, 64 * 1024, workflow)

    assert first_result == second_result
    assert first_result[0] == 64 * 1024
    assert first_result[2] == hashlib.sha256(first.read_bytes()).hexdigest()
    assert first.read_bytes() == second.read_bytes()
    with first.open(newline="", encoding="utf-8") as handle:
        parsed = list(csv.reader(handle))
    assert len(parsed) == first_result[1] + 1
    assert all(len(row) == len(parsed[0]) for row in parsed)


def test_capacity_fixture_rejects_a_target_too_small_for_a_row(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="too small"):
        generate(tmp_path / "small.csv", 32, "rfp_ranges")
