# -*- coding: utf-8 -*-
"""AnimotionHub 人物资产平台的数据底座。

这里集中处理稳定资产记录、项目/目录、工作区、回收区和后台任务元数据。
原有 v2 清单只读；v3 注册表与用户导入资产分开存放，避免重建清单时覆盖编辑结果。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.parse
import uuid
from pathlib import Path
from typing import Any


ASSET_CLASSES = {
    "character", "body_part", "wearable", "weapon", "prop", "scene", "animation"
}
BODY_SLOTS = {
    "root", "body", "head", "hair", "face", "neck", "torso", "torso_outer",
    "body_inner", "arms", "hands", "waist", "legs", "feet", "back", "left_hand",
    "right_hand", "both_hands", "full_body", "world", "free", "custom",
}
MODEL_EXTENSIONS = {".glb", ".gltf", ".fbx", ".obj", ".dae"}
DIRECT_BROWSER_LIMIT = 256 * 1024 * 1024
CONFIRM_BROWSER_LIMIT = 128 * 1024 * 1024
UTC = dt.timezone.utc


def now_iso() -> str:
    return dt.datetime.now(UTC).isoformat()


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        prefix=path.stem + "-", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def safe_slug(value: str | None, fallback: str) -> str:
    value = urllib.parse.unquote(value or "").strip()
    value = Path(value).name
    value = re.sub(r"[^\w.\-\u3400-\u9fff]+", "-", value, flags=re.UNICODE).strip("-.")
    return value[:120] or fallback


def stable_id(prefix: str, *parts: str) -> str:
    joined = "\0".join(str(part) for part in parts)
    return f"{prefix}_{hashlib.sha256(joined.encode('utf-8')).hexdigest()[:16]}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


class PlatformStore:
    """线程安全的 JSON 存储层，供本地 HTTP 服务调用。"""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.studio = self.root / "runtime"
        self.data = self.studio / "data"
        self.library = self.studio / "library"
        self.managed_root = self.library / "projects"
        self.trash_root = self.studio / ".trash"
        self.workspaces_root = self.studio / "workspaces"
        self.jobs_root = self.studio / "jobs"
        self.tasks_root = self.studio / ".tasks"
        self.recipes_root = self.studio / "recipes"

        self.v2_manifest = self.data / "asset_manifest_v2.json"
        self.v3_registry = self.data / "asset_registry_v3.json"
        self.legacy_imports = self.data / "imported_assets.json"
        self.managed_assets_file = self.data / "managed_assets_v3.json"
        self.projects_file = self.data / "projects.json"
        self.directories_file = self.data / "directories.json"
        self.tombstones_file = self.data / "tombstones.json"
        self.relinks_file = self.data / "relinks.json"
        self.asset_overrides_file = self.data / "asset_overrides.json"
        self.jobs_file = self.data / "jobs.json"
        self.skeleton_profiles_file = self.data / "skeleton_profiles.json"
        self.lock = threading.RLock()

        self.data.mkdir(parents=True, exist_ok=True)
        self.managed_root.mkdir(parents=True, exist_ok=True)
        self.workspaces_root.mkdir(parents=True, exist_ok=True)
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self.tasks_root.mkdir(parents=True, exist_ok=True)
        self.ensure_defaults()

    # ------------------------------------------------------------------
    # 初始化和迁移
    # ------------------------------------------------------------------
    def ensure_defaults(self) -> None:
        with self.lock:
            if not self.projects_file.is_file():
                write_json_atomic(self.projects_file, self._default_projects())
            if not self.directories_file.is_file():
                write_json_atomic(self.directories_file, self._default_directories())
            if not self.skeleton_profiles_file.is_file():
                write_json_atomic(self.skeleton_profiles_file, self._default_skeleton_profiles())
            else:
                profiles = read_json(self.skeleton_profiles_file, {"schema_version": 1, "items": []})
                uefn_profile = next(
                    (item for item in profiles.get("items", []) if item.get("id") == "uefn-mannequin"),
                    None,
                )
                if uefn_profile and uefn_profile.get("expected_bones") != 88:
                    uefn_profile["expected_bones"] = 88
                    profiles["updated"] = now_iso()
                    write_json_atomic(self.skeleton_profiles_file, profiles)
            if not self.managed_assets_file.is_file():
                write_json_atomic(
                    self.managed_assets_file,
                    {"schema_version": 3, "updated": now_iso(), "items": []},
                )
            directories = read_json(
                self.directories_file,
                {"schema_version": 1, "updated": now_iso(), "items": []},
            )
            if not any(
                item.get("id") == "dir-character-animations"
                for item in directories.get("items", [])
            ):
                directories.setdefault("items", []).append(
                    {
                        "id": "dir-character-animations",
                        "project_id": "hub-character-studio",
                        "parent_id": "dir-hub-character-studio-root",
                        "name": "动画",
                        "kind": "animation",
                        "sort": 45,
                        "created": now_iso(),
                        "updated": now_iso(),
                    }
                )
                directories["updated"] = now_iso()
                write_json_atomic(self.directories_file, directories)
            for directory_id, name, kind, sort in [
                ("dir-character-derived", "派生资产", "derived", 46),
                ("dir-character-imports", "导入暂存", "staging", 47),
            ]:
                if any(item.get("id") == directory_id for item in directories.get("items", [])):
                    continue
                directories.setdefault("items", []).append(
                    {
                        "id": directory_id,
                        "project_id": "hub-character-studio",
                        "parent_id": "dir-hub-character-studio-root",
                        "name": name,
                        "kind": kind,
                        "sort": sort,
                        "created": now_iso(),
                        "updated": now_iso(),
                    }
                )
                directories["updated"] = now_iso()
                write_json_atomic(self.directories_file, directories)
            if not self.tombstones_file.is_file():
                write_json_atomic(
                    self.tombstones_file,
                    {"schema_version": 1, "updated": now_iso(), "items": []},
                )
            if not self.relinks_file.is_file():
                write_json_atomic(
                    self.relinks_file,
                    {"schema_version": 1, "updated": now_iso(), "items": []},
                )
            if not self.asset_overrides_file.is_file():
                write_json_atomic(
                    self.asset_overrides_file,
                    {"schema_version": 1, "updated": now_iso(), "items": []},
                )
            if not self.jobs_file.is_file():
                write_json_atomic(
                    self.jobs_file,
                    {"schema_version": 1, "updated": now_iso(), "items": []},
                )
            if not self.v3_registry.is_file():
                self.rebuild_v3_registry()

    def _default_projects(self) -> dict[str, Any]:
        items = [
            self._hub_project("hub-character-studio", "CharacterForgeLab", "."),
        ]
        return {"schema_version": 1, "updated": now_iso(), "items": items}

    def _hub_project(self, project_id: str, name: str, relative_root: str) -> dict[str, Any]:
        return {
            "id": project_id,
            "name": name,
            "type": "hub",
            "root_path": str(self.root / relative_root),
            "managed_root": str(self.managed_root / project_id),
            "registered": True,
            "read_only_source": False,
            "created": now_iso(),
            "updated": now_iso(),
        }

    def _default_directories(self) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        projects = self._default_projects()["items"]
        for project in projects:
            root_id = f"dir-{project['id']}-root"
            items.append(
                {
                    "id": root_id,
                    "project_id": project["id"],
                    "parent_id": None,
                    "name": project["name"],
                    "kind": "project_root",
                    "sort": 0,
                    "created": now_iso(),
                    "updated": now_iso(),
                }
            )
            if project["id"] != "hub-character-studio":
                continue
            labels = [
                ("system-baselines", "系统基准角色", "system"),
                ("characters", "人物", "character"),
                ("body-parts", "身体部件", "body_part"),
                ("wearables", "头发与服装", "wearable"),
                ("weapons", "武器", "weapon"),
                ("props", "道具", "prop"),
                ("scenes", "场景", "scene"),
                ("animations", "动画", "animation"),
                ("derived", "派生资产", "derived"),
                ("imports", "导入暂存", "staging"),
            ]
            for order, (suffix, name, kind) in enumerate(labels, 10):
                items.append(
                    {
                        "id": f"dir-character-{suffix}",
                        "project_id": project["id"],
                        "parent_id": root_id,
                        "name": name,
                        "kind": kind,
                        "sort": order,
                        "created": now_iso(),
                        "updated": now_iso(),
                    }
                )
        return {"schema_version": 1, "updated": now_iso(), "items": items}

    def _default_skeleton_profiles(self) -> dict[str, Any]:
        aliases = {
            "root": ["root", "rootmotion", "root_motion"],
            "pelvis": ["pelvis", "hips", "hip", "bip001_pelvis"],
            "spine_01": ["spine_01", "spine1", "spine"],
            "spine_02": ["spine_02", "spine2"],
            "spine_03": ["spine_03", "spine3", "chest"],
            "neck_01": ["neck_01", "neck", "neck1"],
            "head": ["head", "head_01"],
            "clavicle_l": ["clavicle_l", "leftshoulder", "shoulder_l"],
            "upperarm_l": ["upperarm_l", "leftarm", "arm_l"],
            "lowerarm_l": ["lowerarm_l", "leftforearm", "forearm_l"],
            "hand_l": ["hand_l", "lefthand"],
            "clavicle_r": ["clavicle_r", "rightshoulder", "shoulder_r"],
            "upperarm_r": ["upperarm_r", "rightarm", "arm_r"],
            "lowerarm_r": ["lowerarm_r", "rightforearm", "forearm_r"],
            "hand_r": ["hand_r", "righthand"],
            "thigh_l": ["thigh_l", "leftupleg", "upleg_l"],
            "calf_l": ["calf_l", "leftleg", "leg_l"],
            "foot_l": ["foot_l", "leftfoot"],
            "ball_l": ["ball_l", "lefttoe", "toe_l"],
            "thigh_r": ["thigh_r", "rightupleg", "upleg_r"],
            "calf_r": ["calf_r", "rightleg", "leg_r"],
            "foot_r": ["foot_r", "rightfoot"],
            "ball_r": ["ball_r", "righttoe", "toe_r"],
        }
        profiles = [
            {
                "id": "ue5-manny-full",
                "name": "UE5 Manny 完整骨架",
                "family": "ue5-mannequin",
                "expected_bones": 161,
                "aliases": aliases,
            },
            {
                "id": "ue5-quinn-full",
                "name": "UE5 Quinn 完整骨架",
                "family": "ue5-mannequin",
                "expected_bones": 161,
                "aliases": aliases,
            },
            {
                "id": "ue5-mannequin-simple",
                "name": "UE5 Manny / Quinn Simple 骨架",
                "family": "ue5-mannequin-simple",
                "expected_bones": 89,
                "aliases": aliases,
            },
            {
                "id": "uefn-mannequin",
                "name": "UEFN Mannequin 骨架",
                "family": "uefn-mannequin",
                "expected_bones": 88,
                "aliases": aliases,
                "retarget_to": ["ue5-manny-full", "ue5-quinn-full"],
            },
            {
                "id": "generic-humanoid",
                "name": "通用人形骨架",
                "family": "humanoid",
                "expected_bones": None,
                "aliases": aliases,
            },
        ]
        return {"schema_version": 1, "updated": now_iso(), "items": profiles}

    def rebuild_v3_registry(self) -> dict[str, Any]:
        v2 = read_json(self.v2_manifest, {"items": [], "summary": {}})
        records = [self._legacy_to_v3(item) for item in v2.get("items", [])]
        legacy_imports = read_json(self.legacy_imports, {"items": []})
        records.extend(self._legacy_to_v3(item, imported=True) for item in legacy_imports.get("items", []))
        result = {
            "schema_version": 3,
            "built": now_iso(),
            "source_schema": 2,
            "source_manifest": str(self.v2_manifest),
            "migration": {
                "mode": "read_only",
                "original_overwritten": False,
                "notes": ["稳定 ID 沿用旧清单 ID", "外部源文件不移动", "未计算旧资产全量哈希"],
            },
            "summary": self._summarize(records),
            "items": records,
        }
        write_json_atomic(self.v3_registry, result)
        return result

    def _legacy_to_v3(self, item: dict[str, Any], imported: bool = False) -> dict[str, Any]:
        record_id = str(item.get("id") or stable_id("asset", str(item.get("runtime_file"))))
        name = str(item.get("name") or record_id)
        asset_class = str(item.get("asset_class") or "prop")
        runtime_file = item.get("runtime_file")
        local_preview = self.runtime_to_local(runtime_file)
        size_bytes = local_preview.stat().st_size if local_preview and local_preview.is_file() else None
        compatibility = item.get("compatibility") or {}
        capabilities = item.get("capabilities") or {}
        source_format = str(item.get("source_format") or Path(runtime_file or "").suffix.lstrip(".")).upper()
        browser_policy = self._browser_policy(size_bytes, source_format)
        availability_state = "ready" if local_preview and local_preview.is_file() else "missing"
        profile_id = self._baseline_profile(record_id, name, compatibility)
        directory_id = self._directory_for_record(record_id, asset_class)
        source_path = (item.get("provenance") or {}).get("source")
        return {
            "schema_version": 3,
            "id": record_id,
            "name": name,
            "display_name": name,
            "asset_class": asset_class,
            "subtype": item.get("subtype") or asset_class,
            "body_slot": item.get("body_slot") or "free",
            "attachment_mode": item.get("attachment_mode") or "free_transform",
            "project_id": "hub-character-studio",
            "directory_id": directory_id,
            "tags": [item.get("package"), item.get("category"), asset_class],
            "source": {
                "kind": "managed" if imported else "linked",
                "format": source_format,
                "original_path": source_path,
                "managed_path": str(local_preview) if imported and local_preview else None,
                "runtime_file": runtime_file,
                "size_bytes": size_bytes,
                "sha256": None,
                "hash_state": "legacy_not_computed",
                "managed": imported,
                "read_only": not imported,
            },
            "preview": {
                "runtime_file": runtime_file,
                "thumbnail": item.get("thumbnail"),
                "strategy": browser_policy["strategy"],
                "browser_ready": browser_policy["browser_ready"] and availability_state == "ready",
                "requires_confirmation": browser_policy["requires_confirmation"],
                "reason": browser_policy["reason"],
            },
            "skeleton": {
                "profile_id": profile_id,
                "signature": compatibility.get("skeleton_signature"),
                "rest_pose_signature": compatibility.get("rest_pose_signature"),
                "bone_count": compatibility.get("bone_count"),
                "has_skin": capabilities.get("has_skin"),
            },
            "animations": item.get("animations") or [],
            "animation_count": int(item.get("animation_count") or 0),
            "capabilities": {
                **capabilities,
                "binding_modes": capabilities.get("binding_modes")
                or ["free_transform", "rigid_attachment", "shared_skeleton", "retargeted_skeleton"],
            },
            "technical": item.get("technical") or {},
            "provenance": item.get("provenance") or {},
            "quality": item.get("quality") or {},
            "availability": {
                "state": availability_state,
                "reason": None if availability_state == "ready" else "preview_file_missing",
                "last_checked": now_iso(),
            },
            "dependencies": [],
            "legacy": {
                "schema_version": 2 if not imported else 1,
                "record": item.get("legacy") or {},
                "package": item.get("package"),
                "category": item.get("category"),
            },
            "created": now_iso(),
            "updated": now_iso(),
        }

    def _baseline_profile(
        self, record_id: str, name: str, compatibility: dict[str, Any]
    ) -> str | None:
        if record_id == "ue_941a94f604de":
            return "ue5-manny-full"
        if record_id == "ue_b16b7c31bf3e":
            return "ue5-quinn-full"
        if record_id in {"ue_c1393d399351", "ue_b0dcdb08ec6b"}:
            return "ue5-mannequin-simple"
        lower = name.lower()
        bones = compatibility.get("bone_count")
        if "manny" in lower and bones == 161:
            return "ue5-manny-full"
        if "quinn" in lower and bones == 161:
            return "ue5-quinn-full"
        if ("manny" in lower or "quinn" in lower) and bones == 89:
            return "ue5-mannequin-simple"
        return "generic-humanoid" if bones else None

    @staticmethod
    def _directory_for_record(record_id: str, asset_class: str) -> str:
        if record_id in {
            "ue_941a94f604de",
            "ue_c1393d399351",
            "ue_b16b7c31bf3e",
            "ue_b0dcdb08ec6b",
        }:
            return "dir-character-system-baselines"
        mapping = {
            "character": "dir-character-characters",
            "body_part": "dir-character-body-parts",
            "wearable": "dir-character-wearables",
            "weapon": "dir-character-weapons",
            "prop": "dir-character-props",
            "scene": "dir-character-scenes",
            "animation": "dir-character-animations",
        }
        return mapping.get(asset_class, "dir-character-imports")

    @staticmethod
    def _browser_policy(size_bytes: int | None, source_format: str) -> dict[str, Any]:
        if size_bytes is not None and size_bytes > DIRECT_BROWSER_LIMIT:
            return {
                "strategy": "optimized_glb_required",
                "browser_ready": False,
                "requires_confirmation": False,
                "reason": "over_256_mib",
            }
        requires_confirmation = bool(
            size_bytes is not None and size_bytes > CONFIRM_BROWSER_LIMIT
        )
        strategy = "direct" if source_format in {"GLB", "GLTF"} else "browser_loader"
        return {
            "strategy": strategy,
            "browser_ready": True,
            "requires_confirmation": requires_confirmation,
            "reason": "confirm_128_256_mib" if requires_confirmation else None,
        }

    @staticmethod
    def _summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
        states: dict[str, int] = {}
        classes: dict[str, int] = {}
        for record in records:
            state = (record.get("availability") or {}).get("state", "unknown")
            asset_class = record.get("asset_class", "unknown")
            states[state] = states.get(state, 0) + 1
            classes[asset_class] = classes.get(asset_class, 0) + 1
        return {
            "total": len(records),
            "state_counts": states,
            "class_counts": classes,
        }

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def runtime_to_local(self, runtime_file: str | None) -> Path | None:
        if not runtime_file:
            return None
        route = urllib.parse.unquote(str(runtime_file)).split("?", 1)[0]
        if not route.startswith("/"):
            return None
        studio_prefix = "/CharacterStudio/"
        if route.startswith(studio_prefix):
            candidate = (self.studio / route[len(studio_prefix):]).resolve()
            return candidate if is_within(candidate, self.studio) else None
        candidate = (self.root / route.lstrip("/")).resolve()
        return candidate if is_within(candidate, self.root) else None

    def local_to_runtime(self, path: Path) -> str | None:
        resolved = path.resolve()
        if is_within(resolved, self.studio):
            return "/CharacterStudio/" + resolved.relative_to(self.studio).as_posix()
        if is_within(resolved, self.root):
            return "/" + resolved.relative_to(self.root).as_posix()
        return None

    def projects(self) -> dict[str, Any]:
        return read_json(self.projects_file, {"schema_version": 1, "items": []})

    def directories(self, project_id: str | None = None) -> dict[str, Any]:
        data = read_json(self.directories_file, {"schema_version": 1, "items": []})
        if project_id:
            data = dict(data)
            data["items"] = [
                item for item in data.get("items", []) if item.get("project_id") == project_id
            ]
        return data

    def skeleton_profiles(self) -> dict[str, Any]:
        return read_json(self.skeleton_profiles_file, {"schema_version": 1, "items": []})

    def assets(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        with self.lock:
            registry = read_json(self.v3_registry, {"schema_version": 3, "items": []})
            managed = read_json(self.managed_assets_file, {"schema_version": 3, "items": []})
            tombstones = {
                item["asset_id"]: item
                for item in read_json(self.tombstones_file, {"items": []}).get("items", [])
            }
            relinks = {
                item["asset_id"]: item
                for item in read_json(self.relinks_file, {"items": []}).get("items", [])
            }
            overrides = {
                item["asset_id"]: item
                for item in read_json(self.asset_overrides_file, {"items": []}).get("items", [])
            }
            items = []
            for source in list(registry.get("items", [])) + list(managed.get("items", [])):
                record = json.loads(json.dumps(source))
                override = overrides.get(record["id"])
                if override and override.get("display_name"):
                    record["display_name"] = override["display_name"]
                self._refresh_asset_state(record, tombstones.get(record["id"]), relinks.get(record["id"]))
                items.append(record)

        query = query or {}
        project_id = self._first(query, "project_id")
        directory_id = self._first(query, "directory_id")
        asset_class = self._first(query, "asset_class")
        state = self._first(query, "state")
        search = (self._first(query, "q") or "").casefold()
        if project_id:
            items = [item for item in items if item.get("project_id") == project_id]
        if directory_id:
            items = [item for item in items if item.get("directory_id") == directory_id]
        if asset_class:
            items = [item for item in items if item.get("asset_class") == asset_class]
        if state:
            items = [
                item for item in items
                if (item.get("availability") or {}).get("state") == state
            ]
        if search:
            items = [
                item for item in items
                if search in (
                    " ".join(
                        [
                            str(item.get("name") or ""),
                            str(item.get("display_name") or ""),
                            " ".join(str(tag or "") for tag in item.get("tags", [])),
                        ]
                    ).casefold()
                )
            ]
        return {
            "schema_version": 3,
            "updated": now_iso(),
            "summary": self._summarize(items),
            "items": items,
        }

    @staticmethod
    def _first(query: dict[str, list[str]], key: str) -> str | None:
        values = query.get(key)
        return values[0] if values else None

    def _refresh_asset_state(
        self,
        record: dict[str, Any],
        tombstone: dict[str, Any] | None,
        relink: dict[str, Any] | None,
    ) -> None:
        if relink:
            record.setdefault("source", {})["original_path"] = relink.get("path")
            if relink.get("runtime_file"):
                record["source"]["runtime_file"] = relink["runtime_file"]
                record.setdefault("preview", {})["runtime_file"] = relink["runtime_file"]
        if tombstone:
            state = tombstone.get("state", "trash")
            record["availability"] = {
                "state": state,
                "reason": "asset_deleted" if state == "deleted" else "asset_in_trash",
                "last_checked": now_iso(),
            }
            record.setdefault("preview", {})["browser_ready"] = False
            record["tombstone"] = tombstone
            return

        runtime_file = (record.get("preview") or {}).get("runtime_file")
        local = self.runtime_to_local(runtime_file)
        source = record.get("source") or {}
        relink_path = Path(relink["path"]) if relink and relink.get("path") else None
        if relink_path is not None:
            exists = relink_path.is_file()
        elif local is not None:
            exists = local.is_file()
        elif source.get("kind") == "unreal":
            exists = bool(source.get("original_path") and Path(source["original_path"]).is_file())
        elif source.get("original_path") and Path(str(source["original_path"])).is_file():
            exists = True
        else:
            exists = False
        if not exists:
            record["availability"] = {
                "state": "missing",
                "reason": "source_or_preview_missing",
                "last_checked": now_iso(),
            }
            record.setdefault("preview", {})["browser_ready"] = False
        elif (record.get("availability") or {}).get("state") == "conversion_required":
            record.setdefault("preview", {})["browser_ready"] = False
        elif (record.get("availability") or {}).get("state") == "staged":
            record["availability"] = {
                "state": "staged",
                "reason": "awaiting_unreal_import",
                "last_checked": now_iso(),
            }
        else:
            record["availability"] = {
                "state": "ready",
                "reason": None,
                "last_checked": now_iso(),
            }

    def asset(self, asset_id: str) -> dict[str, Any] | None:
        for item in self.assets().get("items", []):
            if item.get("id") == asset_id:
                return item
        return None

    def legacy_catalog(self) -> dict[str, Any]:
        assets = self.assets()
        items = []
        for record in assets["items"]:
            source = record.get("source") or {}
            preview = record.get("preview") or {}
            skeleton = record.get("skeleton") or {}
            availability = record.get("availability") or {}
            items.append(
                {
                    "id": record["id"],
                    "name": record.get("name"),
                    "asset_class": record.get("asset_class"),
                    "subtype": record.get("subtype"),
                    "body_slot": record.get("body_slot"),
                    "attachment_mode": record.get("attachment_mode"),
                    "package": (record.get("legacy") or {}).get("package") or "人物资产平台",
                    "category": (record.get("legacy") or {}).get("category") or record.get("directory_id"),
                    "status": availability.get("state"),
                    "source_format": source.get("format"),
                    "runtime_file": preview.get("runtime_file"),
                    "thumbnail": preview.get("thumbnail"),
                    "animation_count": record.get("animation_count", 0),
                    "animations": record.get("animations", []),
                    "capabilities": record.get("capabilities", {}),
                    "compatibility": {
                        "status": "verified" if skeleton.get("profile_id") else "unverified",
                        "preferred_slot": record.get("body_slot"),
                        "skeleton_signature": skeleton.get("signature"),
                        "rest_pose_signature": skeleton.get("rest_pose_signature"),
                        "bone_count": skeleton.get("bone_count"),
                    },
                    "technical": record.get("technical", {}),
                    "provenance": record.get("provenance", {}),
                    "quality": {
                        **(record.get("quality") or {}),
                        "available": availability.get("state") == "ready",
                    },
                    "asset_ref": {
                        "asset_id": record["id"],
                        "project_id": record.get("project_id"),
                        "directory_id": record.get("directory_id"),
                    },
                    "availability": availability,
                    "preview_policy": preview,
                    "imported": source.get("managed", False),
                }
            )
        return {
            "schema_version": 2,
            "backed_by": "AssetRecordV3",
            "summary": assets["summary"],
            "items": items,
        }

    # ------------------------------------------------------------------
    # 项目和逻辑目录
    # ------------------------------------------------------------------
    def upsert_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("项目名称不能为空")
        project_type = str(payload.get("type") or "hub").lower()
        if project_type not in {"hub", "unreal"}:
            raise ValueError("项目类型必须是 hub 或 unreal")
        project_id = safe_slug(str(payload.get("id") or ""), "project-" + uuid.uuid4().hex[:10])
        with self.lock:
            data = self.projects()
            items = data.setdefault("items", [])
            existing = next((item for item in items if item.get("id") == project_id), None)
            now = now_iso()
            record = existing or {"id": project_id, "created": now}
            root_path = payload.get("root_path")
            uproject = payload.get("uproject")
            if project_type == "unreal" and not uproject:
                raise ValueError("Unreal 项目必须提供 .uproject 路径")
            if project_type == "unreal" and uproject:
                uproject_path = Path(str(uproject)).resolve()
                if uproject_path.suffix.lower() != ".uproject":
                    raise ValueError("Unreal 项目必须指向 .uproject")
                if not uproject_path.is_file():
                    raise ValueError(".uproject 文件不存在")
                root_path = str(uproject_path.parent)
            record.update(
                {
                    "name": name[:160],
                    "type": project_type,
                    "root_path": str(root_path or self.root),
                    "uproject": str(uproject) if uproject else None,
                    "managed_root": str(self.managed_root / project_id)
                    if project_type == "hub" else None,
                    "unreal_content_root": "/Game" if project_type == "unreal" else None,
                    "registered": True,
                    "read_only_source": project_type == "unreal",
                    "updated": now,
                }
            )
            if not existing:
                items.append(record)
                directories = read_json(self.directories_file, {"schema_version": 1, "items": []})
                directories.setdefault("items", []).append(
                    {
                        "id": f"dir-{project_id}-root",
                        "project_id": project_id,
                        "parent_id": None,
                        "name": name[:160],
                        "kind": "project_root",
                        "sort": 0,
                        "created": now,
                        "updated": now,
                    }
                )
                directories["updated"] = now
                write_json_atomic(self.directories_file, directories)
            data["updated"] = now
            write_json_atomic(self.projects_file, data)
            return record

    def mutate_directory(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action") or "create")
        with self.lock:
            data = read_json(self.directories_file, {"schema_version": 1, "items": []})
            items = data.setdefault("items", [])
            now = now_iso()
            if action == "create":
                project_id = str(payload.get("project_id") or "")
                if not any(item.get("id") == project_id for item in self.projects().get("items", [])):
                    raise ValueError("目标项目不存在")
                parent_id = payload.get("parent_id") or f"dir-{project_id}-root"
                parent = next((item for item in items if item.get("id") == parent_id), None)
                if not parent or parent.get("project_id") != project_id:
                    raise ValueError("父目录不存在或不属于目标项目")
                name = str(payload.get("name") or "").strip()
                if not name:
                    raise ValueError("目录名称不能为空")
                directory = {
                    "id": "dir-" + uuid.uuid4().hex[:12],
                    "project_id": project_id,
                    "parent_id": parent_id,
                    "name": name[:160],
                    "kind": str(payload.get("kind") or "custom"),
                    "sort": int(payload.get("sort") or 100),
                    "created": now,
                    "updated": now,
                }
                items.append(directory)
            else:
                directory_id = str(payload.get("id") or "")
                directory = next((item for item in items if item.get("id") == directory_id), None)
                if not directory:
                    raise ValueError("目录不存在")
                if directory.get("kind") == "project_root":
                    raise ValueError("不能修改或删除项目根目录")
                if action in {"rename", "move", "update"}:
                    if "name" in payload:
                        name = str(payload.get("name") or "").strip()
                        if not name:
                            raise ValueError("目录名称不能为空")
                        directory["name"] = name[:160]
                    if "parent_id" in payload:
                        parent_id = payload.get("parent_id")
                        parent = next((item for item in items if item.get("id") == parent_id), None)
                        if not parent or parent.get("project_id") != directory.get("project_id"):
                            raise ValueError("新的父目录无效")
                        if parent_id == directory_id:
                            raise ValueError("目录不能移动到自身")
                        descendants = {directory_id}
                        changed = True
                        while changed:
                            changed = False
                            for candidate in items:
                                if (
                                    candidate.get("parent_id") in descendants
                                    and candidate.get("id") not in descendants
                                ):
                                    descendants.add(candidate["id"])
                                    changed = True
                        if parent_id in descendants:
                            raise ValueError("目录不能移动到自己的子目录")
                        directory["parent_id"] = parent_id
                    directory["updated"] = now
                elif action == "delete":
                    if any(item.get("parent_id") == directory_id for item in items):
                        raise ValueError("目录仍有子目录，不能删除")
                    if any(item.get("directory_id") == directory_id for item in self.assets()["items"]):
                        raise ValueError("目录仍有资产，先移动资产再删除")
                    items.remove(directory)
                else:
                    raise ValueError("未知目录操作")
            data["updated"] = now
            write_json_atomic(self.directories_file, data)
            return directory

    # ------------------------------------------------------------------
    # 导入、引用、回收和重新定位
    # ------------------------------------------------------------------
    def import_stream(
        self,
        stream: Any,
        length: int,
        filename: str,
        project_id: str,
        directory_id: str,
        asset_class: str,
        body_slot: str,
        confirmed_large: bool = False,
    ) -> dict[str, Any]:
        filename = safe_slug(filename, "asset.glb")
        extension = Path(filename).suffix.lower()
        if extension not in MODEL_EXTENSIONS:
            raise ValueError("仅允许 GLB、GLTF、FBX、OBJ、DAE")
        if asset_class not in ASSET_CLASSES:
            raise ValueError("无效的资产类型")
        if body_slot not in BODY_SLOTS:
            raise ValueError("无效的人物槽位")
        if length > DIRECT_BROWSER_LIMIT:
            raise ValueError("文件超过 256 MiB：已在进入 Three.js 前拦截，请先生成优化 GLB")
        if length > CONFIRM_BROWSER_LIMIT and not confirmed_large:
            raise ValueError("文件为 128–256 MiB，必须确认大型文件风险后再导入")

        projects = self.projects().get("items", [])
        project = next((item for item in projects if item.get("id") == project_id), None)
        if not project:
            raise ValueError("目标项目不存在")
        directory = next(
            (
                item for item in self.directories(project_id).get("items", [])
                if item.get("id") == directory_id
            ),
            None,
        )
        if not directory:
            raise ValueError("目标目录不存在或不属于项目")

        asset_id = "asset_" + uuid.uuid4().hex[:16]
        if project.get("type") == "unreal":
            asset_dir = self.managed_root / project_id / "staging" / asset_id
            source_kind = "unreal_staging"
        else:
            asset_dir = self.managed_root / project_id / directory_id / asset_id
            source_kind = "managed"
        asset_dir.mkdir(parents=True, exist_ok=False)
        target = asset_dir / filename
        temporary = asset_dir / (filename + ".uploading")
        digest = hashlib.sha256()
        remaining = length
        try:
            with temporary.open("wb") as output:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("模型上传中途结束")
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            os.replace(temporary, target)
        except Exception:
            shutil.rmtree(asset_dir, ignore_errors=True)
            raise

        runtime_file = self.local_to_runtime(target)
        if runtime_file is None:
            raise ValueError("受管资产目标位于 CharacterForgeLab 目录之外")
        source_format = extension[1:].upper()
        preview_policy = self._browser_policy(length, source_format)
        record = {
            "schema_version": 3,
            "id": asset_id,
            "name": Path(filename).stem,
            "display_name": Path(filename).stem,
            "asset_class": asset_class,
            "subtype": "local_import",
            "body_slot": body_slot,
            "attachment_mode": (
                "rigid_attachment" if asset_class == "weapon"
                else "skinned_mesh" if asset_class in {"wearable", "body_part"}
                else "free_transform"
            ),
            "project_id": project_id,
            "directory_id": directory_id,
            "tags": ["本地导入", asset_class],
            "source": {
                "kind": source_kind,
                "format": source_format,
                "original_path": None,
                "managed_path": str(target),
                "runtime_file": runtime_file,
                "size_bytes": length,
                "sha256": digest.hexdigest(),
                "hash_state": "verified",
                "managed": True,
                "read_only": False,
            },
            "preview": {
                "runtime_file": runtime_file,
                "thumbnail": None,
                "strategy": preview_policy["strategy"],
                "browser_ready": True,
                "requires_confirmation": preview_policy["requires_confirmation"],
                "reason": preview_policy["reason"],
            },
            "skeleton": {
                "profile_id": None,
                "signature": None,
                "rest_pose_signature": None,
                "bone_count": None,
                "has_skin": None,
            },
            "animations": [],
            "animation_count": 0,
            "capabilities": {
                "can_preview": True,
                "has_skin": None,
                "has_morph_targets": None,
                "has_animation": None,
                "can_export_glb": True,
                "binding_modes": [
                    "free_transform", "rigid_attachment", "shared_skeleton",
                    "retargeted_skeleton",
                ],
            },
            "technical": {},
            "provenance": {
                "source": str(target),
                "license_note": None,
                "license_status": "unknown",
                "commercial_use": "unknown",
            },
            "quality": {
                "available": True,
                "issues": ["license_unverified", "browser_inspection_pending"],
            },
            "availability": {
                "state": "staged" if project.get("type") == "unreal" else "ready",
                "reason": "awaiting_unreal_import" if project.get("type") == "unreal" else None,
                "last_checked": now_iso(),
            },
            "dependencies": [],
            "legacy": None,
            "created": now_iso(),
            "updated": now_iso(),
        }
        with self.lock:
            data = read_json(self.managed_assets_file, {"schema_version": 3, "items": []})
            data.setdefault("items", []).append(record)
            data["updated"] = now_iso()
            write_json_atomic(self.managed_assets_file, data)
        return record

    def annotate_derived_character(
        self,
        asset_id: str,
        profile_id: str,
        *,
        source_asset_id: str | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        """为后台自动蒙皮结果登记骨架和派生关系。"""
        with self.lock:
            data = read_json(self.managed_assets_file, {"schema_version": 3, "items": []})
            record = next(
                (item for item in data.get("items", []) if item.get("id") == asset_id),
                None,
            )
            if not record:
                raise ValueError("派生人物资产不存在")
            record["subtype"] = "derived_auto_rig"
            record["attachment_mode"] = "shared_skeleton"
            record.setdefault("tags", []).extend(
                tag for tag in ["派生资产", "自动蒙皮", profile_id]
                if tag not in record["tags"]
            )
            record["skeleton"] = {
                "profile_id": profile_id,
                "signature": f"profile:{profile_id}",
                "rest_pose_signature": None,
                "bone_count": None,
                "has_skin": True,
            }
            record.setdefault("capabilities", {}).update(
                {
                    "has_skin": True,
                    "has_skeletal_animation": True,
                    "can_export_glb": True,
                }
            )
            record.setdefault("technical", {}).update(
                {
                    "derived": True,
                    "derivation": "blender_automatic_weights",
                    "source_asset_id": source_asset_id,
                    "job_id": job_id,
                }
            )
            record["updated"] = now_iso()
            data["updated"] = now_iso()
            write_json_atomic(self.managed_assets_file, data)
            return json.loads(json.dumps(record))

    def usage(self, asset_id: str) -> dict[str, Any]:
        references = []
        search_roots = [self.recipes_root, self.workspaces_root, self.tasks_root]
        for root in search_roots:
            if not root.is_dir():
                continue
            for path in root.rglob("*.json"):
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError:
                    continue
                if asset_id in text:
                    references.append(
                        {
                            "kind": root.name.strip("."),
                            "file": str(path),
                            "runtime_file": self.local_to_runtime(path),
                        }
                    )
        return {"asset_id": asset_id, "count": len(references), "items": references}

    def trash_asset(self, asset_id: str) -> dict[str, Any]:
        record = self.asset(asset_id)
        if not record:
            raise ValueError("资产不存在")
        usage = self.usage(asset_id)
        source = record.get("source") or {}
        tombstone = {
            "asset_id": asset_id,
            "state": "trash",
            "deleted_at": now_iso(),
            "project_id": record.get("project_id"),
            "directory_id": record.get("directory_id"),
            "display_name": record.get("display_name"),
            "source_managed": bool(source.get("managed")),
            "original_managed_path": source.get("managed_path"),
            "original_runtime_file": (record.get("preview") or {}).get("runtime_file"),
            "trash_path": None,
            "usage": usage,
        }
        managed_path = Path(source["managed_path"]) if source.get("managed_path") else None
        if managed_path and managed_path.is_file() and is_within(managed_path, self.managed_root):
            destination_dir = self.trash_root / asset_id
            destination_dir.parent.mkdir(parents=True, exist_ok=True)
            if destination_dir.exists():
                destination_dir = self.trash_root / f"{asset_id}-{uuid.uuid4().hex[:6]}"
            shutil.move(str(managed_path.parent), str(destination_dir))
            tombstone["trash_path"] = str(destination_dir)
        with self.lock:
            data = read_json(self.tombstones_file, {"schema_version": 1, "items": []})
            data["items"] = [
                item for item in data.get("items", []) if item.get("asset_id") != asset_id
            ]
            data["items"].append(tombstone)
            data["updated"] = now_iso()
            write_json_atomic(self.tombstones_file, data)
        return tombstone

    def restore_asset(self, asset_id: str) -> dict[str, Any]:
        with self.lock:
            data = read_json(self.tombstones_file, {"schema_version": 1, "items": []})
            tombstone = next(
                (item for item in data.get("items", []) if item.get("asset_id") == asset_id),
                None,
            )
            if not tombstone:
                raise ValueError("资产不在回收区")
            trash_path = Path(tombstone["trash_path"]) if tombstone.get("trash_path") else None
            original_path = (
                Path(tombstone["original_managed_path"])
                if tombstone.get("original_managed_path") else None
            )
            if trash_path and original_path:
                if not is_within(original_path, self.managed_root):
                    raise ValueError("恢复路径不属于受管目录")
                if not trash_path.exists():
                    raise ValueError("回收区物理文件已丢失")
                original_path.parent.parent.mkdir(parents=True, exist_ok=True)
                if original_path.parent.exists():
                    raise ValueError("原位置已存在同名资产目录")
                shutil.move(str(trash_path), str(original_path.parent))
            data["items"] = [
                item for item in data.get("items", []) if item.get("asset_id") != asset_id
            ]
            data["updated"] = now_iso()
            write_json_atomic(self.tombstones_file, data)
            return {"asset_id": asset_id, "restored": True}

    def rename_asset(self, asset_id: str, display_name: str) -> dict[str, Any]:
        record = self.asset(asset_id)
        if not record:
            raise ValueError("资产不存在")
        name = re.sub(r"\s+", " ", str(display_name or "")).strip()
        if not name:
            raise ValueError("资产名称不能为空")
        if len(name) > 120:
            raise ValueError("资产名称不能超过 120 个字符")
        if any(ord(character) < 32 for character in name):
            raise ValueError("资产名称不能包含控制字符")
        override = {
            "asset_id": asset_id,
            "display_name": name,
            "updated": now_iso(),
        }
        with self.lock:
            data = read_json(
                self.asset_overrides_file,
                {"schema_version": 1, "updated": now_iso(), "items": []},
            )
            data["items"] = [
                item for item in data.get("items", []) if item.get("asset_id") != asset_id
            ]
            data["items"].append(override)
            data["updated"] = now_iso()
            write_json_atomic(self.asset_overrides_file, data)
        return override

    def delete_asset_permanently(self, asset_id: str, confirmation: str) -> dict[str, Any]:
        if confirmation != asset_id:
            raise ValueError("永久删除需要用资产 ID 二次确认")
        with self.lock:
            data = read_json(self.tombstones_file, {"schema_version": 1, "items": []})
            tombstone = next(
                (item for item in data.get("items", []) if item.get("asset_id") == asset_id),
                None,
            )
            if not tombstone:
                raise ValueError("资产必须先移入回收区")
            trash_path = Path(tombstone["trash_path"]) if tombstone.get("trash_path") else None
            if trash_path and trash_path.exists():
                if not is_within(trash_path, self.trash_root):
                    raise ValueError("拒绝删除回收区以外的物理文件")
                shutil.rmtree(trash_path)
            tombstone["state"] = "deleted"
            tombstone["permanently_deleted_at"] = now_iso()
            tombstone["trash_path"] = None
            data["updated"] = now_iso()
            write_json_atomic(self.tombstones_file, data)
            return tombstone

    def relink_asset(self, asset_id: str, path_value: str) -> dict[str, Any]:
        if not self.asset(asset_id):
            raise ValueError("资产不存在")
        path = Path(path_value).expanduser().resolve()
        if not path.is_file():
            raise ValueError("重新定位的文件不存在")
        if path.suffix.lower() not in MODEL_EXTENSIONS:
            raise ValueError("重新定位目标必须是受支持的模型文件")
        runtime_file = (
            self.local_to_runtime(path)
        )
        if runtime_file is None:
            runtime_file = f"/api/assets/{urllib.parse.quote(asset_id)}/content"
        record = {
            "asset_id": asset_id,
            "path": str(path),
            "runtime_file": runtime_file,
            "updated": now_iso(),
        }
        with self.lock:
            data = read_json(self.relinks_file, {"schema_version": 1, "items": []})
            data["items"] = [
                item for item in data.get("items", []) if item.get("asset_id") != asset_id
            ]
            data["items"].append(record)
            data["updated"] = now_iso()
            write_json_atomic(self.relinks_file, data)
        return record

    def content_path(self, asset_id: str) -> Path | None:
        relink = next(
            (
                item for item in read_json(self.relinks_file, {"items": []}).get("items", [])
                if item.get("asset_id") == asset_id
            ),
            None,
        )
        if relink and relink.get("path"):
            path = Path(relink["path"]).resolve()
            return path if path.is_file() else None
        record = self.asset(asset_id)
        if not record:
            return None
        source = record.get("source") or {}
        for value in (source.get("managed_path"), source.get("original_path")):
            if not value:
                continue
            path = Path(str(value)).resolve()
            if path.is_file():
                return path
        return self.runtime_to_local((record.get("preview") or {}).get("runtime_file"))

    # ------------------------------------------------------------------
    # 工作区和后台任务
    # ------------------------------------------------------------------
    def list_workspaces(self) -> dict[str, Any]:
        items = []
        if self.workspaces_root.is_dir():
            for path in sorted(self.workspaces_root.glob("*.json")):
                data = read_json(path, {})
                items.append(
                    {
                        "id": data.get("id") or path.stem,
                        "name": data.get("name") or path.stem,
                        "schema_version": data.get("schema_version"),
                        "project_id": data.get("project_id"),
                        "updated": data.get("updated"),
                        "layers": len(data.get("layers", [])),
                    }
                )
        return {"schema_version": 4, "items": items}

    def save_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested_schema = int(payload.get("schema_version") or 0)
        if requested_schema >= 4:
            if not isinstance(payload.get("baseCharacter"), dict):
                raise ValueError("V4 人物项目必须包含 baseCharacter")
            if not isinstance(payload.get("components", []), list):
                raise ValueError("V4 人物项目 components 必须是数组")
            if not isinstance(payload.get("animationClips", []), list):
                raise ValueError("V4 人物项目 animationClips 必须是数组")
        elif not isinstance(payload.get("layers"), list):
            raise ValueError("旧版工作区必须包含 layers 数组")
        workspace_id = safe_slug(
            str(payload.get("id") or ""), "workspace-" + uuid.uuid4().hex[:12]
        )
        workspace = dict(payload)
        workspace.setdefault("layers", [])
        workspace.update(
            {
                "id": workspace_id,
                "name": str(payload.get("name") or workspace_id)[:160],
                "schema_version": max(3, requested_schema),
                "updated": now_iso(),
            }
        )
        target = self.workspaces_root / f"{workspace_id}.json"
        write_json_atomic(target, workspace)
        return workspace

    def list_jobs(self) -> dict[str, Any]:
        return read_json(self.jobs_file, {"schema_version": 1, "items": []})

    def create_job(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = "job_" + uuid.uuid4().hex[:14]
        job = {
            "id": job_id,
            "type": job_type,
            "status": "queued",
            "progress": 0,
            "payload": payload,
            "result": None,
            "error": None,
            "created": now_iso(),
            "updated": now_iso(),
        }
        with self.lock:
            data = self.list_jobs()
            data.setdefault("items", []).insert(0, job)
            data["items"] = data["items"][:500]
            data["updated"] = now_iso()
            write_json_atomic(self.jobs_file, data)
        return job

    def update_job(self, job_id: str, **changes: Any) -> dict[str, Any]:
        with self.lock:
            data = self.list_jobs()
            job = next((item for item in data.get("items", []) if item.get("id") == job_id), None)
            if not job:
                raise ValueError("后台任务不存在")
            job.update(changes)
            job["updated"] = now_iso()
            data["updated"] = now_iso()
            write_json_atomic(self.jobs_file, data)
            return job
