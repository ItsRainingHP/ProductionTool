# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Generate deterministic synthetic CSVs for production capacity qualification."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def generate(path: Path, target_bytes: int, workflow: str) -> tuple[int, int, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    digest = hashlib.sha256()
    header = (
        b"Bates/Control #,End Bates/Control #,RFP,Author,Subject\r\n"
        if workflow == "rfp_ranges"
        else b"Bates/Control #,End Bates/Control #,Author,Subject\r\n"
    )
    with path.open("wb") as handle:
        handle.write(header)
        digest.update(header)
        while handle.tell() < target_bytes:
            rows += 1
            begin = rows * 2 - 1
            end = rows * 2
            if workflow == "rfp_ranges":
                line = (
                    f"SYNTH_{begin:012d},SYNTH_{end:012d},RFP {(rows % 250) + 1:03d},"
                    f"Synthetic Person {rows % 1000},Synthetic capacity row {rows}\r\n"
                ).encode()
            else:
                formula = "=SYNTHETIC_FORMULA_RISK" if rows % 10_000 == 0 else f"Synthetic Person {rows % 1000}"
                line = (f"SYNTH_{begin:012d},SYNTH_{end:012d},{formula},Synthetic capacity row {rows}\r\n").encode()
            handle.write(line)
            digest.update(line)
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
