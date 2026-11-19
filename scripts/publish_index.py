#!/usr/bin/env python3
"""Publish the built Pull ZIP and generate the Valenced repository index."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = "pull"


def main() -> None:
    manifest_path = ROOT / "plugins" / PLUGIN / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plugin_id = manifest["id"]
    version = str(manifest["version"])
    archive = ROOT / "build" / "dist" / f"{plugin_id}@{version}.zip"
    if not archive.is_file():
        raise SystemExit(f"Missing built ZIP: {archive}")

    pool = ROOT / "pool"
    pool.mkdir(parents=True, exist_ok=True)
    published = pool / archive.name
    shutil.copy2(archive, published)

    data = published.read_bytes()
    ref = quote(os.environ.get("GITHUB_REF_NAME") or "main", safe="/")
    entry = {
        "name": manifest["name"],
        "description": manifest["description"],
        "author": manifest["author"],
        "channels": {"latest": version},
        "versions": {
            version: {
                "url": f"https://raw.githubusercontent.com/LiFawaz/pull/{ref}/pool/{archive.name.replace('@', '%40')}",
                "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data),
                "dependencies": manifest["dependencies"],
            }
        },
    }
    index = {
        "format": 1,
        "name": "LiFawaz Pull",
        "description": "Valenced plugin repository for Pull.",
        "plugins": {plugin_id: entry},
    }
    (ROOT / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Published {published.name} ({len(data)} bytes) for ref {ref}")


if __name__ == "__main__":
    main()
