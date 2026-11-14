#!/usr/bin/env python3
"""Verify the installable ZIP produced for a Valenced plugin."""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise SystemExit("ERROR: " + message)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: python scripts/check_zip.py <plugin-folder>")

    plugin_dir = ROOT / "plugins" / sys.argv[1]
    manifest_path = plugin_dir / "manifest.json"
    if not manifest_path.is_file():
        fail(f"missing manifest: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    archive_path = ROOT / "build" / "dist" / f"{manifest['id']}@{manifest['version']}.zip"
    if not archive_path.is_file():
        fail(f"missing package: {archive_path}")

    with zipfile.ZipFile(archive_path) as archive:
        bad_entry = archive.testzip()
        if bad_entry:
            fail(f"corrupt ZIP entry: {bad_entry}")

        names = set(archive.namelist())
        if not {"manifest.json", "index.js"}.issubset(names):
            fail(f"package is missing required files: {sorted(names)}")

        for name in names:
            if name.startswith("/") or ".." in Path(name).parts:
                fail(f"unsafe ZIP path: {name}")

        packaged_manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        if packaged_manifest.get("id") != manifest.get("id"):
            fail("package manifest ID does not match source manifest")
        if str(packaged_manifest.get("version")) != str(manifest.get("version")):
            fail("package manifest version does not match source manifest")

    print(f"PASS: {archive_path.name} is a valid Valenced install ZIP.")


if __name__ == "__main__":
    main()
