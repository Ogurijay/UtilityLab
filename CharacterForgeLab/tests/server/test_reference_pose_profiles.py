# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import math
import struct
import unittest
from pathlib import Path


STUDIO = Path(__file__).resolve().parents[2] / "runtime"


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise AssertionError(f"不是 GLB 文件：{path}")
    offset = 12
    while offset + 8 <= len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + length]
        if chunk_type == 0x4E4F534A:
            return json.loads(chunk.rstrip(b"\x00 ").decode("utf-8"))
        offset += 8 + length
    raise AssertionError(f"GLB 缺少 JSON 块：{path}")


def normalize(values: list[float]) -> list[float]:
    length = math.sqrt(sum(value * value for value in values))
    return [value / length for value in values]


def quaternion_multiply(left: list[float], right: list[float]) -> list[float]:
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return [
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ]


class ReferencePoseProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profiles = json.loads(
            (STUDIO / "data" / "reference_pose_profiles_v2.json").read_text(
                encoding="utf-8"
            )
        )
        cls.assets = json.loads(
            (STUDIO / "data" / "managed_assets_v3.json").read_text(encoding="utf-8")
        )

    def test_profiles_are_versioned_and_complete(self) -> None:
        self.assertEqual(self.profiles["schema_version"], 2)
        self.assertEqual(self.profiles["three_revision"], "r185")
        for profile_id, expected_bones in (
            ("ue5-mannequin-simple", 89),
            ("uefn-mannequin", 88),
        ):
            profile = self.profiles["profiles"][profile_id]
            self.assertEqual(profile["bone_count"], expected_bones)
            self.assertTrue(profile["hierarchy_signature"].startswith("fnv1a32:"))
            self.assertTrue(profile["rest_pose_signature"].startswith("fnv1a32:"))
            self.assertEqual(
                set(profile["poses"]),
                {"source", "a", "t"},
            )
            self.assertEqual(
                set(profile["poses"]["t"]["bones"]),
                {
                    "upperarm_l",
                    "lowerarm_l",
                    "hand_l",
                    "upperarm_r",
                    "lowerarm_r",
                    "hand_r",
                },
            )

    def test_t_pose_flips_each_palm_around_its_longitudinal_axis(self) -> None:
        assets = {item["id"]: item for item in self.assets["items"]}
        for profile in self.profiles["profiles"].values():
            asset = assets[profile["baseline_asset_id"]]
            glb = read_glb_json(Path(asset["source"]["managed_path"]))
            nodes = {node.get("name"): node for node in glb["nodes"]}
            t_bones = profile["poses"]["t"]["bones"]
            for side in ("l", "r"):
                hand = nodes[f"hand_{side}"]
                middle = nodes[f"middle_metacarpal_{side}"]
                bind = normalize(hand.get("rotation", [0, 0, 0, 1]))
                target = normalize(t_bones[f"hand_{side}"]["quaternion"])
                inverse_bind = [-bind[0], -bind[1], -bind[2], bind[3]]
                delta = normalize(quaternion_multiply(inverse_bind, target))
                palm_axis = normalize(middle["translation"])

                # T Pose 只沿手掌纵轴翻转 180 度，避免手腕改变伸展方向。
                self.assertAlmostEqual(abs(delta[3]), 0.0, places=6)
                axis_alignment = abs(sum(delta[i] * palm_axis[i] for i in range(3)))
                self.assertGreater(axis_alignment, 0.999999)

    def test_baseline_asset_hashes_and_rest_signatures_match(self) -> None:
        assets = {item["id"]: item for item in self.assets["items"]}
        for profile in self.profiles["profiles"].values():
            asset = assets[profile["baseline_asset_id"]]
            self.assertEqual(asset["source"]["sha256"], profile["baseline_sha256"])
            self.assertEqual(
                asset["skeleton"]["rest_pose_signature"],
                profile["rest_pose_signature"],
            )
            self.assertEqual(asset["skeleton"]["bone_count"], profile["bone_count"])


if __name__ == "__main__":
    unittest.main()
