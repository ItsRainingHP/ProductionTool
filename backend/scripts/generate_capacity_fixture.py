# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Generate deterministic synthetic CSVs for production capacity qualification."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def generate(path: Path, target_bytes: int, workflow: str) -> tuple[int, int, str]:
    header = (
        b"Bates/Control #,End Bates/Control #,RFP,Author,Subject\r\n"
        if workflow == "rfp_ranges"
        else b"Bates/Control #,End Bates/Control #,Author,Subject\r\n"
    )

    def make_row(number: int) -> bytes:
        begin = number * 2 - 1
        end = number * 2
        subject = f"Synthetic capacity row {number} " + "x" * 900
        if workflow == "rfp_ranges":
            return (
                f"SYNTH_{begin:012d},SYNTH_{end:012d},RFP {(number % 250) + 1:03d},"
                f"Synthetic Person {number % 1000},{subject}\r\n"
            ).encode()
        formula = "=SYNTHETIC_FORMULA_RISK" if number % 10_000 == 0 else f"Synthetic Person {number % 1000}"
        return f"SYNTH_{begin:012d},SYNTH_{end:012d},{formula},{subject}\r\n".encode()

    if workflow not in {"rfp_ranges", "privilege_log"}:
        raise ValueError(f"Unsupported workflow: {workflow}")
    if target_bytes < len(header) + len(make_row(1)):
        raise ValueError("Target size is too small for a valid CSV row")

    path.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    digest = hashlib.sha256()
    with path.open("wb") as handle:
        handle.write(header)
        digest.update(header)
        while handle.tell() < target_bytes:
            line = make_row(rows + 1)
            remaining = target_bytes - handle.tell()
            if len(line) > remaining:
                raise ValueError("Target size cannot fit the final CSV row")
            if remaining > len(line) and remaining - len(line) < len(make_row(rows + 2)):
                line = line[:-2] + b"x" * (remaining - len(line)) + b"\r\n"
            handle.write(line)
            digest.update(line)
            rows += 1
    if path.stat().st_size != target_bytes:
        raise RuntimeError("Generated CSV size does not match the requested size")
    return path.stat().st_size, rows, digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--bytes", type=int, default=500 * 1024 * 1024)
    parser.add_argument("--workflow", choices=("rfp_ranges", "privilege_log"), required=True)
    args = parser.parse_args()
    size, rows, sha256 = generate(args.output, args.bytes, args.workflow)
    print(f"path={args.output.resolve()}")
    print(f"bytes={size}")
    print(f"rows={rows}")
    print(f"sha256={sha256}")


if __name__ == "__main__":
    main()
