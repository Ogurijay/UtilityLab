# -*- coding: utf-8 -*-
"""从只读 asset_manifest_v2.json 构建稳定的 AssetRecordV3 注册表。"""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = ROOT / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from platform_store import PlatformStore  # noqa: E402


def main() -> int:
    store = PlatformStore(ROOT)
    result = store.rebuild_v3_registry()
    summary = result["summary"]
    print(
        "AssetRecordV3 已构建："
        f"{summary['total']} 条，状态 {summary['state_counts']}，"
        f"输出 {store.v3_registry}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
