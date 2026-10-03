# -*- coding: utf-8 -*-
"""在 Unreal Editor 的 Python 环境中消费一个 AnimotionHub 导入任务。

示例：
UnrealEditor-Cmd.exe Project.uproject -run=pythonscript
  -script="unreal_import_task.py D:/.../job_xxx.json"
"""

import json
from pathlib import Path
import sys

import unreal


def main() -> None:
    if len(sys.argv) < 2:
        raise RuntimeError("缺少导入任务 JSON")
    task_path = Path(sys.argv[-1]).resolve()
    task = json.loads(task_path.read_text(encoding="utf-8"))
    source = Path(task["source_file"]).resolve()
    destination = str(task["destination"]).rstrip("/")
    if not source.is_file():
        raise FileNotFoundError(source)
    if not destination.startswith("/Game") or ".." in destination:
        raise RuntimeError("非法 Unreal 目标目录")

    import_task = unreal.AssetImportTask()
    import_task.filename = str(source)
    import_task.destination_path = destination
    import_task.automated = True
    import_task.save = True
    import_task.replace_existing = False
    import_task.replace_existing_settings = False
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([import_task])
    if not import_task.imported_object_paths:
        raise RuntimeError("Unreal 导入未产生资产")
    task["status"] = "completed"
    task["imported_object_paths"] = list(import_task.imported_object_paths)
    task_path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    unreal.log(f"AnimotionHub import completed: {task['imported_object_paths']}")


main()

