#!/usr/bin/env python3
"""Create an installable Valenced ZIP from a built plugin."""
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
        fail("usage: python scripts/package_plugin.py <plugin-folder>")

    name = sys.argv[1]
    plugin_dir = ROOT / "plugins" / name
    manifest_path = plugin_dir / "manifest.json"
    built_script = plugin_dir / "build" / "js" / "index.js"

    if not manifest_path.is_file():
        fail(f"missing manifest: {manifest_path}")
    if not built_script.is_file():
        fail(f"missing built script: {built_script}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plugin_id = manifest.get("id")
    version = manifest.get("version")
    if not plugin_id or not version:
        fail("manifest must include id and version")

    output_dir = ROOT / "build" / "dist"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"{plugin_id}@{version}.zip"

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(manifest_path, "manifest.json")
        archive.write(built_script, "index.js")

        assets_dir = plugin_dir / "assets"
        if assets_dir.is_dir():
            for asset in sorted(assets_dir.rglob("*")):
                if asset.is_file():
                    archive.write(asset, str(Path("assets") / asset.relative_to(assets_dir)))

    print(f"Created {archive_path}")


if __name__ == "__main__":
    main()
