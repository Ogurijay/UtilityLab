# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import unittest
import urllib.request


BASE_URL = os.environ.get("ANIMOTION_TEST_URL", "http://127.0.0.1:8788")


def get_json(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


class LiveCharacterApiTests(unittest.TestCase):
    def test_health_and_three_runtime(self) -> None:
        health = get_json("/api/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["three"], "0.185.1")
        self.assertEqual(health["api_version"], 4)

    def test_reference_pose_data_is_served(self) -> None:
        payload = get_json("/CharacterStudio/data/reference_pose_profiles_v2.json")
        self.assertEqual(payload["schema_version"], 2)
        self.assertIn("ue5-mannequin-simple", payload["profiles"])
        self.assertIn("uefn-mannequin", payload["profiles"])

    def test_job_registry_is_readable(self) -> None:
        jobs = get_json("/api/jobs")
        self.assertIsInstance(jobs.get("items"), list)


if __name__ == "__main__":
    unittest.main()
