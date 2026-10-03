# -*- coding: utf-8 -*-
"""Blender 后台人物自动蒙皮。

用法：
    blender --background --python blender_auto_rig.py -- \
        input.glb baseline.glb output.glb profile_id source_pose

脚本只写入 output.glb；输入人物与系统基准资产始终只读。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


def arguments() -> tuple[Path, Path, Path, str, str]:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(values) < 5:
        raise RuntimeError("缺少 input、baseline、output、profile_id 或 source_pose 参数")
    return Path(values[0]), Path(values[1]), Path(values[2]), values[3], values[4]


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_glb(path: Path) -> set[bpy.types.Object]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return set(bpy.data.objects) - before


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [
        obj.matrix_world @ Vector(corner)
        for obj in objects
        for corner in obj.bound_box
    ]
    if not points:
        raise RuntimeError("人物没有可计算边界的网格")
    minimum = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    maximum = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return minimum, maximum


def make_target_static(meshes: list[bpy.types.Object], imported: set[bpy.types.Object]) -> None:
    for mesh in meshes:
        world = mesh.matrix_world.copy()
        for modifier in list(mesh.modifiers):
            if modifier.type == "ARMATURE":
                mesh.modifiers.remove(modifier)
        mesh.parent = None
        mesh.matrix_world = world
        mesh.vertex_groups.clear()
    for obj in list(imported):
        if obj.type == "ARMATURE":
            bpy.data.objects.remove(obj, do_unlink=True)


def armature_points(armature: bpy.types.Object) -> list[Vector]:
    ignored = ("ik_", "weapon_", "attach", "interaction", "center_of_mass")
    points: list[Vector] = []
    for bone in armature.data.bones:
        if not bone.use_deform or bone.name.lower().startswith(ignored):
            continue
        points.extend(
            [
                armature.matrix_world @ bone.head_local,
                armature.matrix_world @ bone.tail_local,
            ]
        )
    if not points:
        raise RuntimeError("系统基准骨架没有可用于对齐的变形骨骼")
    return points


def armature_bounds(armature: bpy.types.Object) -> tuple[Vector, Vector]:
    points = armature_points(armature)
    minimum = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    maximum = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return minimum, maximum


def apply_t_pose(armature: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    for side in ("l", "r"):
        for name, child_name in (
            (f"upperarm_{side}", f"lowerarm_{side}"),
            (f"lowerarm_{side}", f"hand_{side}"),
        ):
            bone = armature.pose.bones.get(name)
            child = armature.pose.bones.get(child_name)
            if not bone or not child:
                raise RuntimeError(f"T Pose 缺少骨骼：{name} 或 {child_name}")
            current = (child.head - bone.head).normalized()
            sign = 1.0 if current.x >= 0 else -1.0
            desired = Vector((sign, 0.0, 0.0))
            delta = current.rotation_difference(desired)
            pivot = bone.head.copy()
            bone.matrix = (
                Matrix.Translation(pivot)
                @ delta.to_matrix().to_4x4()
                @ Matrix.Translation(-pivot)
                @ bone.matrix
            )
            bpy.context.view_layer.update()
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()


def align_armature(
    armature: bpy.types.Object,
    target_min: Vector,
    target_max: Vector,
) -> dict[str, float]:
    rig_min, rig_max = armature_bounds(armature)
    target_height = max(target_max.z - target_min.z, 1e-6)
    rig_height = max(rig_max.z - rig_min.z, 1e-6)
    scale = target_height / rig_height
    armature.scale *= scale
    bpy.context.view_layer.update()

    rig_min, rig_max = armature_bounds(armature)
    target_center = (target_min + target_max) * 0.5
    rig_center = (rig_min + rig_max) * 0.5
    offset = Vector(
        (
            target_center.x - rig_center.x,
            target_center.y - rig_center.y,
            target_min.z - rig_min.z,
        )
    )
    armature.location += offset
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.view_layer.update()
    return {
        "scale": float(scale),
        "offset_x": float(offset.x),
        "offset_y": float(offset.y),
        "offset_z": float(offset.z),
    }


def parent_with_auto_weights(mesh: bpy.types.Object, armature: bpy.types.Object) -> None:
    if not mesh.data.vertices:
        return
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    mesh["animotionhub_auto_rig"] = True
    if not mesh.vertex_groups:
        raise RuntimeError(f"Blender 未能为网格 {mesh.name} 生成任何自动权重")
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(
        group_select_mode="ALL",
        lock_active=False,
    )


def validate_weights(
    meshes: list[bpy.types.Object],
    armature: bpy.types.Object,
) -> dict[str, int | bool | float]:
    deform_bones = {bone.name for bone in armature.data.bones if bone.use_deform}
    vertex_count = 0
    unweighted = 0
    invalid_sum = 0
    over_four = 0
    maximum_influences = 0
    for mesh in meshes:
        group_names = {
            group.index: group.name
            for group in mesh.vertex_groups
            if group.name in deform_bones
        }
        for vertex in mesh.data.vertices:
            vertex_count += 1
            weights = [
                group.weight
                for group in vertex.groups
                if group.group in group_names and group.weight > 1e-6
            ]
            maximum_influences = max(maximum_influences, len(weights))
            if not weights:
                unweighted += 1
                continue
            if len(weights) > 4:
                over_four += 1
            if abs(sum(weights) - 1.0) > 0.002:
                invalid_sum += 1
    return {
        "ok": vertex_count > 0
        and not unweighted
        and not invalid_sum
        and not over_four,
        "vertex_count": vertex_count,
        "unweighted_vertices": unweighted,
        "invalid_weight_sum_vertices": invalid_sum,
        "over_four_influence_vertices": over_four,
        "maximum_influences": maximum_influences,
    }


def sampled_deformed_positions(
    mesh: bpy.types.Object,
    sample_limit: int = 4096,
) -> list[Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    evaluated_mesh = evaluated.to_mesh()
    try:
        count = len(evaluated_mesh.vertices)
        stride = max(1, math.ceil(count / max(sample_limit, 1)))
        return [
            evaluated.matrix_world @ evaluated_mesh.vertices[index].co
            for index in range(0, count, stride)
        ]
    finally:
        evaluated.to_mesh_clear()


def validate_deformation(
    meshes: list[bpy.types.Object],
    armature: bpy.types.Object,
) -> dict[str, bool | float | str]:
    probe = armature.pose.bones.get("upperarm_l")
    if not probe:
        return {
            "ok": False,
            "maximum_displacement": 0.0,
            "error": "缺少 upperarm_l，无法执行变形探针",
        }
    before = [sampled_deformed_positions(mesh) for mesh in meshes]
    original_mode = probe.rotation_mode
    original_quaternion = probe.rotation_quaternion.copy()
    probe.rotation_mode = "QUATERNION"
    probe.rotation_quaternion = (
        Quaternion((0.0, 0.0, 1.0), math.radians(8.0))
        @ original_quaternion
    )
    bpy.context.view_layer.update()
    try:
        after = [sampled_deformed_positions(mesh) for mesh in meshes]
        maximum = max(
            (
                (point_before - point_after).length
                for mesh_before, mesh_after in zip(before, after)
                for point_before, point_after in zip(mesh_before, mesh_after)
            ),
            default=0.0,
        )
    finally:
        probe.rotation_quaternion = original_quaternion
        probe.rotation_mode = original_mode
        bpy.context.view_layer.update()
    return {
        "ok": math.isfinite(maximum) and maximum > 1e-7,
        "maximum_displacement": float(maximum),
        "error": "" if maximum > 1e-7 else "骨骼旋转没有驱动任何采样顶点",
    }


def write_validation(
    output_path: Path,
    *,
    profile_id: str,
    source_pose: str,
    alignment: dict[str, float],
    weights: dict[str, int | bool | float],
    deformation: dict[str, bool | float | str],
) -> Path:
    report_path = output_path.with_suffix(output_path.suffix + ".validation.json")
    report = {
        "schema_version": 1,
        "profile_id": profile_id,
        "source_pose": source_pose,
        "ok": bool(weights.get("ok") and deformation.get("ok")),
        "alignment": alignment,
        "weights": weights,
        "deformation": deformation,
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report_path


def main() -> None:
    input_path, baseline_path, output_path, profile_id, source_pose = arguments()
    if not input_path.is_file() or not baseline_path.is_file():
        raise RuntimeError("输入人物或基准骨架文件不存在")
    clear_scene()

    target_import = import_glb(input_path)
    imported_meshes = [
        obj
        for obj in target_import
        if obj.type == "MESH" and len(obj.data.vertices) > 0
    ]
    skinned_meshes = [
        obj
        for obj in imported_meshes
        if (obj.parent and obj.parent.type == "ARMATURE")
        or any(modifier.type == "ARMATURE" for modifier in obj.modifiers)
    ]
    target_meshes = skinned_meshes or [
        obj for obj in imported_meshes if not obj.hide_render
    ]
    if not target_meshes:
        raise RuntimeError("输入人物中没有网格")
    make_target_static(target_meshes, target_import)
    target_min, target_max = world_bounds(target_meshes)

    baseline_import = import_glb(baseline_path)
    armatures = [obj for obj in baseline_import if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("系统基准文件中没有骨架")
    armature = max(armatures, key=lambda item: len(item.data.bones))
    for obj in list(baseline_import):
        if obj.type == "MESH" or (obj.type == "ARMATURE" and obj is not armature):
            bpy.data.objects.remove(obj, do_unlink=True)

    if source_pose == "t":
        apply_t_pose(armature)
    alignment = align_armature(armature, target_min, target_max)
    armature["animotionhub_profile_id"] = profile_id
    armature["animotionhub_source_pose"] = source_pose
    for mesh in target_meshes:
        parent_with_auto_weights(mesh, armature)
    weights = validate_weights(target_meshes, armature)
    deformation = validate_deformation(target_meshes, armature)
    write_validation(
        output_path,
        profile_id=profile_id,
        source_pose=source_pose,
        alignment=alignment,
        weights=weights,
        deformation=deformation,
    )
    if not weights["ok"]:
        raise RuntimeError(
            "自动权重检查失败："
            f"未加权 {weights['unweighted_vertices']}，"
            f"权重和异常 {weights['invalid_weight_sum_vertices']}，"
            f"超过四骨骼 {weights['over_four_influence_vertices']}"
        )
    if not deformation["ok"]:
        raise RuntimeError(f"蒙皮变形检查失败：{deformation['error']}")

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for mesh in target_meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_skins=True,
        export_animations=False,
        export_yup=True,
    )
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise RuntimeError("Blender 未生成有效 GLB")


if __name__ == "__main__":
    main()
