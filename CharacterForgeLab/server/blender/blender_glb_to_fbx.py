# -*- coding: utf-8 -*-
"""Blender 后台脚本：把 CharacterStudio 导出的 GLB 转为 FBX。

调用方式：
blender --background --python blender_glb_to_fbx.py -- input.glb output.fbx
"""

from pathlib import Path
import sys

import bpy


def main() -> int:
    if "--" not in sys.argv:
        raise RuntimeError("缺少 -- input.glb output.fbx")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 2:
        raise RuntimeError("需要输入 GLB 与输出 FBX")
    source = Path(args[0]).resolve()
    target = Path(args[1]).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    bpy.ops.export_scene.fbx(
        filepath=str(target),
        use_selection=False,
        apply_unit_scale=True,
        bake_anim=True,
        add_leaf_bones=False,
        path_mode="COPY",
        embed_textures=True,
    )
    if not target.is_file():
        raise RuntimeError("Blender 未生成 FBX")
    print(f"AnimotionHub FBX ready: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

