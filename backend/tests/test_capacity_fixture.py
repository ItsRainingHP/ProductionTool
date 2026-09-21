# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

from pathlib import Path

import pytest

from scripts.generate_capacity_fixture import generate


@pytest.mark.parametrize("workflow", ["rfp_ranges", "privilege_log"])
def test_capacity_fixture_is_deterministic_and_reaches_target(tmp_path: Path, workflow: str) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    first_result = generate(first, 64 * 1024, workflow)
    second_result = generate(second, 64 * 1024, workflow)

    assert first_result == second_result
    assert first_result[0] >= 64 * 1024
    assert first.read_bytes() == second.read_bytes()
