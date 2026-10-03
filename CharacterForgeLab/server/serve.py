# -*- coding: utf-8 -*-
"""CharacterForgeLab 本地服务。

除静态文件外，提供 CharacterStudio V4 的项目、目录、资产、工作区、
回收区和后台转换任务 API。所有响应禁用普通缓存；版本化 Three.js
运行时使用长期不可变缓存。
"""

from __future__ import annotations

import datetime as dt
import http.server
import json
import mimetypes
import os
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser
from pathlib import Path
from typing import Any

from platform_store import (
    CONFIRM_BROWSER_LIMIT,
    DIRECT_BROWSER_LIMIT,
    PlatformStore,
    is_within,
    now_iso,
    read_json,
    safe_slug,
    write_json_atomic,
)
from job_scheduler import PersistentJobScheduler


ROOT_PATH = Path(__file__).resolve().parents[1]
ROOT = str(ROOT_PATH)
PORT = int(os.environ.get("PORT", "8788"))
PORT_ATTEMPTS = 20
MAX_UPLOAD_BYTES = int(
    os.environ.get("ANIMOTION_MAX_UPLOAD_BYTES", str(DIRECT_BROWSER_LIMIT))
)
MAX_JSON_BYTES = 12 * 1024 * 1024

THREE_VENDOR = ROOT_PATH / "node_modules" / "three"
THREE_PACKAGE = read_json(THREE_VENDOR / "package.json", {})
THREE_VERSION = str(THREE_PACKAGE.get("version") or "").strip()
if not THREE_VERSION:
    raise RuntimeError(f"Three.js vendor package is missing or invalid: {THREE_VENDOR}")
THREE_RUNTIME_BASE = f"/_runtime/three/{THREE_VERSION}/"

STUDIO = ROOT_PATH / "runtime"
STUDIO_RECIPES = STUDIO / "recipes"
CHARACTER_FORGE_LAB_DIST = ROOT_PATH / "dist"
STORE = PlatformStore(ROOT_PATH)

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/octet-stream", ".fbx")


def public_path(path: Path) -> str:
    """Return the stable browser URL for a file inside this project."""
    resolved = path.resolve()
    if is_within(resolved, STUDIO):
        return "/CharacterStudio/" + resolved.relative_to(STUDIO).as_posix()
    if is_within(resolved, ROOT_PATH):
        return "/" + resolved.relative_to(ROOT_PATH).as_posix()
    raise ValueError(f"Path is outside CharacterForgeLab: {resolved}")


def find_blender() -> Path | None:
    configured = os.environ.get("ANIMOTION_BLENDER")
    candidates = [
        Path(configured) if configured else None,
        Path(r"E:\SteamLibrary\steamapps\common\Blender\blender.exe"),
        Path(r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe"),
        Path(r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe"),
    ]
    return next((path for path in candidates if path and path.is_file()), None)


def run_cancellable_process(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    cancel_event: threading.Event | None,
) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            stdout, stderr = process.communicate(timeout=0.75)
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            if cancel_event and cancel_event.is_set():
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise InterruptedError("任务已取消")
            if time.monotonic() >= deadline:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise subprocess.TimeoutExpired(command, timeout_seconds)


def run_blender_fbx_job(
    job_id: str,
    input_glb: Path,
    output_fbx: Path,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    blender = find_blender()
    if not blender:
        STORE.update_job(
            job_id,
            status="blocked",
            error="未找到 Blender；设置 ANIMOTION_BLENDER 后重试",
        )
        return
    script = ROOT_PATH / "server" / "blender" / "blender_glb_to_fbx.py"
    STORE.update_job(job_id, status="running", progress=10)
    command = [
        str(blender),
        "--background",
        "--python",
        str(script),
        "--",
        str(input_glb),
        str(output_fbx),
    ]
    try:
        completed = run_cancellable_process(
            command,
            cwd=ROOT_PATH,
            timeout_seconds=30 * 60,
            cancel_event=cancel_event,
        )
        log_path = output_fbx.parent / "blender.log"
        log_path.write_text(
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
            encoding="utf-8",
        )
        if completed.returncode != 0 or not output_fbx.is_file():
            STORE.update_job(
                job_id,
                status="failed",
                progress=100,
                error=f"Blender 转换失败，退出码 {completed.returncode}",
                result={"log": public_path(log_path)},
            )
            return
        STORE.update_job(
            job_id,
            status="completed",
            progress=100,
            result={
                "file": public_path(output_fbx),
                "size_bytes": output_fbx.stat().st_size,
                "log": public_path(log_path),
            },
        )
    except subprocess.TimeoutExpired:
        STORE.update_job(job_id, status="failed", progress=100, error="Blender 转换超过 30 分钟")
    except InterruptedError:
        STORE.update_job(job_id, status="cancelled", progress=100, error="任务已取消")
    except OSError as exc:
        STORE.update_job(job_id, status="failed", progress=100, error=str(exc))


def run_blender_auto_rig_job(
    job_id: str,
    input_glb: Path,
    baseline_glb: Path,
    output_glb: Path,
    profile_id: str,
    source_pose: str,
    name: str,
    source_asset_id: str | None,
    *,
    cancel_event: threading.Event | None = None,
) -> None:
    blender = find_blender()
    if not blender:
        STORE.update_job(
            job_id,
            status="blocked",
            error="未找到 Blender；当前浏览器基础蒙皮仍可继续使用",
        )
        return
    script = ROOT_PATH / "server" / "blender" / "blender_auto_rig.py"
    STORE.update_job(job_id, status="running", progress=10)
    command = [
        str(blender),
        "--background",
        "--python",
        str(script),
        "--",
        str(input_glb),
        str(baseline_glb),
        str(output_glb),
        profile_id,
        source_pose,
    ]
    try:
        completed = run_cancellable_process(
            command,
            cwd=ROOT_PATH,
            timeout_seconds=45 * 60,
            cancel_event=cancel_event,
        )
        log_path = output_glb.parent / "blender-auto-rig.log"
        log_path.write_text(
            (completed.stdout or "") + "\n" + (completed.stderr or ""),
            encoding="utf-8",
        )
        validation_path = output_glb.with_suffix(output_glb.suffix + ".validation.json")
        validation = read_json(validation_path, {}) if validation_path.is_file() else {}
        if completed.returncode != 0 or not output_glb.is_file():
            STORE.update_job(
                job_id,
                status="failed",
                progress=100,
                error=f"Blender 自动蒙皮失败，退出码 {completed.returncode}；浏览器预览未被覆盖",
                result={
                    "log": public_path(log_path),
                    "validation": validation or None,
                },
            )
            return
        STORE.update_job(job_id, progress=85)
        with output_glb.open("rb") as stream:
            asset = STORE.import_stream(
                stream,
                output_glb.stat().st_size,
                f"{name}-auto-rig.glb",
                "hub-character-studio",
                "dir-character-derived",
                "character",
                "root",
            )
        asset = STORE.annotate_derived_character(
            asset["id"],
            profile_id,
            source_asset_id=source_asset_id,
            job_id=job_id,
        )
        STORE.update_job(
            job_id,
            status="completed",
            progress=100,
            result={
                "asset_id": asset["id"],
                "file": (asset.get("preview") or {}).get("runtime_file"),
                "size_bytes": output_glb.stat().st_size,
                "profile_id": profile_id,
                "quality": "blender_auto",
                "validation": validation,
                "log": public_path(log_path),
            },
        )
    except subprocess.TimeoutExpired:
        STORE.update_job(
            job_id,
            status="failed",
            progress=100,
            error="Blender 自动蒙皮超过 45 分钟；浏览器预览未被覆盖",
        )
    except InterruptedError:
        STORE.update_job(job_id, status="cancelled", progress=100, error="任务已取消")
    except (OSError, ValueError) as exc:
        STORE.update_job(job_id, status="failed", progress=100, error=str(exc))


JOB_SCHEDULER = PersistentJobScheduler(
    STORE,
    max_workers=int(os.environ.get("ANIMOTION_JOB_WORKERS", "1")),
)


def persisted_job_path(value: str | None) -> Path | None:
    if not value:
        return None
    candidate = (ROOT_PATH / value.lstrip("/")).resolve()
    return candidate if is_within(candidate, ROOT_PATH) else None


def recover_persisted_jobs() -> None:
    for job in STORE.list_jobs().get("items", []):
        if job.get("status") not in {"queued", "running", "cancel_requested"}:
            continue
        job_id = str(job.get("id") or "")
        payload = job.get("payload") or {}
        input_path = persisted_job_path(payload.get("input"))
        if not job_id or not input_path or not input_path.is_file():
            if job_id:
                STORE.update_job(
                    job_id,
                    status="failed",
                    progress=100,
                    error="服务恢复任务时找不到输入文件",
                )
            continue
        if job.get("status") == "cancel_requested":
            STORE.update_job(
                job_id,
                status="cancelled",
                progress=100,
                error="服务重启前已请求取消",
            )
            continue
        job_dir = input_path.parent
        if job.get("type") == "blender_fbx_export":
            name = safe_slug(payload.get("name"), "character")
            JOB_SCHEDULER.submit(
                job_id,
                run_blender_fbx_job,
                input_path,
                job_dir / f"{name}.fbx",
                recovered=True,
            )
        elif job.get("type") == "blender_auto_rig":
            profile_id = str(payload.get("profile_id") or "")
            baseline_path = STORE.content_path(str(payload.get("baseline_asset_id") or ""))
            if not baseline_path or not baseline_path.is_file():
                STORE.update_job(
                    job_id,
                    status="failed",
                    progress=100,
                    error="服务恢复任务时找不到系统基准骨架",
                )
                continue
            name = safe_slug(payload.get("name"), "character")
            JOB_SCHEDULER.submit(
                job_id,
                run_blender_auto_rig_job,
                input_path,
                baseline_path,
                job_dir / f"{name}-auto-rig.glb",
                profile_id,
                str(payload.get("source_pose") or "source"),
                name,
                payload.get("source_asset_id"),
                recovered=True,
            )


recover_persisted_jobs()


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "CharacterForgeLab/4.0"

    def translate_path(self, path: str) -> str:
        route = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if route in {"/", "/CharacterStudio", "/CharacterStudio/"}:
            return str(CHARACTER_FORGE_LAB_DIST / "index.html")
        if route.startswith("/CharacterStudio/assets/"):
            relative = route[len("/CharacterStudio/assets/"):]
            parts = [part for part in relative.split("/") if part not in {"", "."}]
            if not parts or any(part == ".." or "\\" in part or ":" in part for part in parts):
                return str(CHARACTER_FORGE_LAB_DIST / "__invalid_asset_path__")
            candidate = (CHARACTER_FORGE_LAB_DIST / "assets").joinpath(*parts).resolve()
            if not is_within(candidate, CHARACTER_FORGE_LAB_DIST):
                return str(CHARACTER_FORGE_LAB_DIST / "__invalid_asset_path__")
            return str(candidate)
        if route.startswith("/CharacterStudio/"):
            relative = route[len("/CharacterStudio/"):]
            parts = [part for part in relative.split("/") if part not in {"", "."}]
            public_roots = {"data", "library", "jobs"}
            if (
                not parts
                or parts[0] not in public_roots
                or any(part == ".." or "\\" in part or ":" in part for part in parts)
            ):
                return str(CHARACTER_FORGE_LAB_DIST / "__invalid_runtime_path__")
            candidate = STUDIO.joinpath(*parts).resolve()
            if not is_within(candidate, STUDIO):
                return str(CHARACTER_FORGE_LAB_DIST / "__invalid_runtime_path__")
            return str(candidate)
        if route.startswith(THREE_RUNTIME_BASE):
            relative = route[len(THREE_RUNTIME_BASE):]
            parts = [part for part in relative.split("/") if part not in {"", "."}]
            if not parts or any(part == ".." or "\\" in part or ":" in part for part in parts):
                return str(THREE_VENDOR / "__invalid_runtime_path__")
            candidate = THREE_VENDOR.joinpath(*parts).resolve()
            if not is_within(candidate, THREE_VENDOR):
                return str(THREE_VENDOR / "__invalid_runtime_path__")
            return str(candidate)
        return str(CHARACTER_FORGE_LAB_DIST / "__not_found__")

    def end_headers(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if route.startswith(THREE_RUNTIME_BASE):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def log_message(self, *_args: Any) -> None:
        pass

    def send_json(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_JSON_BYTES:
            raise ValueError("JSON 请求体为空或超过 12 MiB")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON 请求体必须是对象")
        return value

    @property
    def parsed_url(self) -> urllib.parse.SplitResult:
        return urllib.parse.urlsplit(self.path)

    @property
    def route(self) -> str:
        value = self.parsed_url.path.rstrip("/")
        return value or "/"

    @property
    def query(self) -> dict[str, list[str]]:
        return urllib.parse.parse_qs(self.parsed_url.query)

    def do_GET(self) -> None:
        try:
            if self.route == "/api/health":
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "service": "CharacterForgeLab",
                        "api_version": 4,
                        "three": THREE_VERSION,
                        "three_runtime_base": THREE_RUNTIME_BASE,
                        "limits": {
                            "confirmation_bytes": CONFIRM_BROWSER_LIMIT,
                            "direct_browser_bytes": DIRECT_BROWSER_LIMIT,
                        },
                        "asset_registry_v3": STORE.v3_registry.is_file(),
                    },
                )
                return
            if self.route == "/api/projects":
                self.send_json(200, STORE.projects())
                return
            if self.route == "/api/directories":
                project_id = (self.query.get("project_id") or [None])[0]
                self.send_json(200, STORE.directories(project_id))
                return
            if self.route == "/api/assets":
                self.send_json(200, STORE.assets(self.query))
                return
            if self.route.startswith("/api/assets/") and self.route.endswith("/content"):
                asset_id = urllib.parse.unquote(self.route.split("/")[3])
                self.send_asset_content(asset_id)
                return
            if self.route == "/api/skeleton-profiles":
                self.send_json(200, STORE.skeleton_profiles())
                return
            if self.route.startswith("/api/assets/") and self.route.endswith("/usage"):
                asset_id = urllib.parse.unquote(self.route.split("/")[3])
                self.send_json(200, STORE.usage(asset_id))
                return
            if self.route == "/api/workspaces":
                self.send_json(200, STORE.list_workspaces())
                return
            if self.route.startswith("/api/workspaces/"):
                workspace_id = safe_slug(self.route.split("/")[-1], "")
                path = STORE.workspaces_root / f"{workspace_id}.json"
                if not path.is_file():
                    self.send_json(404, {"ok": False, "error": "工作区不存在"})
                else:
                    self.send_json(200, read_json(path, {}))
                return
            if self.route == "/api/jobs":
                self.send_json(200, STORE.list_jobs())
                return
            if self.route.startswith("/api/jobs/"):
                job_id = urllib.parse.unquote(self.route.split("/")[-1])
                job = next(
                    (
                        item for item in STORE.list_jobs().get("items", [])
                        if item.get("id") == job_id
                    ),
                    None,
                )
                self.send_json(200 if job else 404, job or {"ok": False, "error": "任务不存在"})
                return

            # v1/v2 兼容接口
            if self.route == "/api/character-assets/catalog":
                self.send_json(200, STORE.legacy_catalog())
                return
            if self.route == "/api/character-assets/recipes":
                recipes = []
                if STUDIO_RECIPES.is_dir():
                    for path in sorted(STUDIO_RECIPES.glob("*.json")):
                        data = read_json(path, {})
                        recipes.append(
                            {
                                "id": data.get("id") or path.stem,
                                "name": data.get("name") or path.stem,
                                "updated": data.get("updated"),
                                "layers": len(data.get("layers", [])),
                            }
                        )
                self.send_json(200, {"items": recipes})
                return
            super().do_GET()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except OSError as exc:
            self.send_json(500, {"ok": False, "error": "本地文件操作失败", "detail": str(exc)})

    def send_asset_content(self, asset_id: str) -> None:
        path = STORE.content_path(asset_id)
        if not path or not path.is_file():
            self.send_json(404, {"ok": False, "error": "资产文件不存在"})
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f'inline; filename="{safe_slug(path.name, "asset.glb")}"')
        self.end_headers()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                self.wfile.write(chunk)

    def do_POST(self) -> None:
        try:
            if self.route == "/api/projects":
                self.send_json(201, {"ok": True, "item": STORE.upsert_project(self.read_json_body())})
                return
            if self.route == "/api/directories":
                self.send_json(200, {"ok": True, "item": STORE.mutate_directory(self.read_json_body())})
                return
            if self.route in {"/api/assets/import", "/api/character-assets/import"}:
                self.import_asset()
                return
            if self.route.startswith("/api/assets/"):
                self.asset_action()
                return
            if self.route == "/api/workspaces":
                workspace = STORE.save_workspace(self.read_json_body())
                self.send_json(200, {"ok": True, "workspace": workspace})
                return
            if self.route == "/api/character-assets/recipes":
                self.save_legacy_recipe()
                return
            if self.route.startswith("/api/jobs/") and self.route.endswith("/cancel"):
                job_id = urllib.parse.unquote(self.route.split("/")[3])
                self.send_json(200, {"ok": True, "job": JOB_SCHEDULER.cancel(job_id)})
                return
            if self.route == "/api/jobs/fbx-export":
                self.create_fbx_job()
                return
            if self.route == "/api/jobs/auto-rig":
                self.create_auto_rig_job()
                return
            if self.route == "/api/jobs/unreal-import":
                self.create_unreal_import_job()
                return
            if self.route == "/api/admin/rebuild-asset-registry":
                self.send_json(200, {"ok": True, "registry": STORE.rebuild_v3_registry()["summary"]})
                return
            self.send_json(404, {"ok": False, "error": "未知 API"})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except OSError as exc:
            self.send_json(500, {"ok": False, "error": "本地文件操作失败", "detail": str(exc)})

    def do_DELETE(self) -> None:
        try:
            if self.route.startswith("/api/assets/"):
                parts = self.route.split("/")
                asset_id = urllib.parse.unquote(parts[3]) if len(parts) > 3 else ""
                confirmation = (self.query.get("confirm") or [""])[0]
                result = STORE.delete_asset_permanently(asset_id, confirmation)
                self.send_json(200, {"ok": True, "tombstone": result})
                return
            self.send_json(404, {"ok": False, "error": "未知 API"})
        except ValueError as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except OSError as exc:
            self.send_json(500, {"ok": False, "error": "本地文件操作失败", "detail": str(exc)})

    def save_legacy_recipe(self) -> None:
        recipe = self.read_json_body()
        if not isinstance(recipe.get("layers"), list):
            raise ValueError("装配配方必须包含 layers 数组")
        recipe_id = safe_slug(
            str(recipe.get("id") or ""), "recipe-" + uuid.uuid4().hex[:12]
        )
        recipe["id"] = recipe_id
        recipe["name"] = str(recipe.get("name") or recipe_id)[:160]
        recipe["schema_version"] = 1
        recipe["updated"] = now_iso()
        target = STUDIO_RECIPES / f"{recipe_id}.json"
        write_json_atomic(target, recipe)
        self.send_json(200, {"ok": True, "recipe": recipe, "file": str(target)})

    def import_asset(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("没有收到模型文件")
        if length > min(MAX_UPLOAD_BYTES, DIRECT_BROWSER_LIMIT):
            raise ValueError("文件超过 256 MiB：禁止直接进入浏览器，请先生成优化 GLB")
        filename = self.headers.get("X-Asset-Filename") or "asset.glb"
        project_id = self.headers.get("X-Project-Id") or "hub-character-studio"
        directory_id = self.headers.get("X-Directory-Id") or "dir-character-imports"
        asset_class = (self.headers.get("X-Asset-Class") or "prop").strip().lower()
        body_slot = (self.headers.get("X-Body-Slot") or "free").strip().lower()
        confirmed = self.headers.get("X-Large-File-Confirmed") == "1"
        record = STORE.import_stream(
            self.rfile,
            length,
            filename,
            project_id,
            directory_id,
            asset_class,
            body_slot,
            confirmed,
        )
        self.send_json(201, {"ok": True, "item": record})

    def asset_action(self) -> None:
        parts = self.route.split("/")
        if len(parts) < 5:
            raise ValueError("缺少资产操作")
        asset_id = urllib.parse.unquote(parts[3])
        action = parts[4]
        payload = self.read_json_body() if int(self.headers.get("Content-Length", "0")) else {}
        if action == "trash":
            result = STORE.trash_asset(asset_id)
        elif action == "restore":
            result = STORE.restore_asset(asset_id)
        elif action == "rename":
            result = STORE.rename_asset(asset_id, str(payload.get("display_name") or ""))
        elif action == "delete":
            result = STORE.delete_asset_permanently(asset_id, str(payload.get("confirm") or ""))
        elif action == "relink":
            result = STORE.relink_asset(asset_id, str(payload.get("path") or ""))
        else:
            raise ValueError("未知资产操作")
        self.send_json(200, {"ok": True, "result": result})

    def create_fbx_job(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > DIRECT_BROWSER_LIMIT:
            raise ValueError("FBX 转换输入必须是 0–256 MiB 的 GLB")
        name = safe_slug(self.headers.get("X-Export-Name"), "character")
        job = STORE.create_job("blender_fbx_export", {"name": name, "input_bytes": length})
        job_dir = STORE.jobs_root / job["id"]
        job_dir.mkdir(parents=True, exist_ok=False)
        input_path = job_dir / "input.glb"
        remaining = length
        with input_path.open("wb") as output:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("GLB 上传中途结束")
                output.write(chunk)
                remaining -= len(chunk)
        output_path = job_dir / f"{name}.fbx"
        STORE.update_job(
            job["id"],
            payload={
                **job["payload"],
                "input": public_path(input_path),
            },
        )
        JOB_SCHEDULER.submit(
            job["id"],
            run_blender_fbx_job,
            input_path,
            output_path,
        )
        self.send_json(202, {"ok": True, "job": STORE.update_job(job["id"])})

    def create_auto_rig_job(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > DIRECT_BROWSER_LIMIT:
            raise ValueError("自动蒙皮输入必须是 0–256 MiB 的 GLB")
        profile_id = str(self.headers.get("X-Rig-Profile") or "").strip()
        if profile_id not in {"ue5-mannequin-simple", "uefn-mannequin"}:
            raise ValueError("自动蒙皮仅支持 Manny Simple 或 UEFN Mannequin")
        source_pose = str(self.headers.get("X-Source-Pose") or "").strip().lower()
        if source_pose not in {"t", "a", "source"}:
            raise ValueError("源姿势必须是 T Pose、A Pose 或 source")
        baseline_asset_id = str(self.headers.get("X-Baseline-Asset-Id") or "").strip()
        baseline_asset = STORE.asset(baseline_asset_id)
        baseline_path = STORE.content_path(baseline_asset_id)
        baseline_profile = (baseline_asset or {}).get("skeleton", {}).get("profile_id")
        if not baseline_path or not baseline_path.is_file() or baseline_profile != profile_id:
            raise ValueError("系统基准骨架资产无效或与所选骨架不一致")
        name = safe_slug(
            urllib.parse.unquote(self.headers.get("X-Rig-Name") or "character"),
            "character",
        )
        source_asset_id = str(self.headers.get("X-Source-Asset-Id") or "").strip() or None
        job = STORE.create_job(
            "blender_auto_rig",
            {
                "name": name,
                "profile_id": profile_id,
                "source_pose": source_pose,
                "baseline_asset_id": baseline_asset_id,
                "source_asset_id": source_asset_id,
                "input_bytes": length,
            },
        )
        job_dir = STORE.jobs_root / job["id"]
        job_dir.mkdir(parents=True, exist_ok=False)
        input_path = job_dir / "input.glb"
        remaining = length
        with input_path.open("wb") as output:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("自动蒙皮 GLB 上传中途结束")
                output.write(chunk)
                remaining -= len(chunk)
        output_path = job_dir / f"{name}-auto-rig.glb"
        STORE.update_job(
            job["id"],
            payload={
                **job["payload"],
                "input": public_path(input_path),
            },
        )
        JOB_SCHEDULER.submit(
            job["id"],
            run_blender_auto_rig_job,
            input_path,
            baseline_path,
            output_path,
            profile_id,
            source_pose,
            name,
            source_asset_id,
        )
        self.send_json(202, {"ok": True, "job": STORE.update_job(job["id"])})

    def create_unreal_import_job(self) -> None:
        payload = self.read_json_body()
        asset_id = str(payload.get("asset_id") or "")
        project_id = str(payload.get("project_id") or "")
        destination = str(payload.get("destination") or "/Game/CharacterForgeLab").rstrip("/")
        asset = STORE.asset(asset_id)
        project = next(
            (
                item for item in STORE.projects().get("items", [])
                if item.get("id") == project_id
            ),
            None,
        )
        if not asset:
            raise ValueError("待导入资产不存在")
        if not project or project.get("type") != "unreal":
            raise ValueError("目标必须是已登记 Unreal 项目")
        if not destination.startswith("/Game") or ".." in destination or "\\" in destination:
            raise ValueError("Unreal 目标目录必须位于 /Game 下")
        task_payload = {
            "asset_id": asset_id,
            "project_id": project_id,
            "uproject": project.get("uproject"),
            "destination": destination,
            "source_file": (asset.get("source") or {}).get("managed_path")
            or (asset.get("source") or {}).get("original_path"),
            "created": now_iso(),
        }
        job = STORE.create_job("unreal_import", task_payload)
        task_path = STORE.tasks_root / "unreal_import" / f"{job['id']}.json"
        write_json_atomic(task_path, {"job_id": job["id"], **task_payload})
        job = STORE.update_job(
            job["id"],
            status="awaiting_unreal",
            progress=0,
            result={
                "task_file": str(task_path),
                "note": "已生成受控 Unreal 导入任务；需由 Unreal Python 执行器消费",
            },
        )
        self.send_json(202, {"ok": True, "job": job})


def create_server(start_port: int) -> http.server.ThreadingHTTPServer:
    """优先绑定指定端口；被占用时依次尝试后续端口。"""
    last_error: OSError | None = None
    for port in range(start_port, start_port + PORT_ATTEMPTS):
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
        except OSError as exc:
            last_error = exc
            print(f"端口 {port} 不可用，尝试 {port + 1}…")
    if last_error:
        raise last_error
    raise RuntimeError("没有可用端口")


if __name__ == "__main__":
    os.chdir(ROOT)
    server = create_server(PORT)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}/"
    print(f"CharacterForgeLab 服务：{url}（根目录 {ROOT}，Three.js {THREE_VERSION}）")
    if os.environ.get("NO_BROWSER") != "1":
        opener = threading.Timer(0.3, webbrowser.open, args=(url,))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
