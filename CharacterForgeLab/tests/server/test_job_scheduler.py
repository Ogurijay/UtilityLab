# -*- coding: utf-8 -*-

from __future__ import annotations

import threading
import time
import unittest

from pathlib import Path
import sys


SERVER_DIR = Path(__file__).resolve().parents[2] / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from job_scheduler import PersistentJobScheduler  # noqa: E402


class MemoryStore:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.items: list[dict[str, object]] = []

    def create(self, job_id: str) -> None:
        self.items.append(
            {
                "id": job_id,
                "status": "queued",
                "progress": 0,
                "error": None,
            }
        )

    def list_jobs(self) -> dict[str, object]:
        with self.lock:
            return {"items": [dict(item) for item in self.items]}

    def update_job(self, job_id: str, **changes: object) -> dict[str, object]:
        with self.lock:
            job = next(item for item in self.items if item["id"] == job_id)
            job.update(changes)
            return dict(job)

    def job(self, job_id: str) -> dict[str, object]:
        return next(item for item in self.list_jobs()["items"] if item["id"] == job_id)


def wait_for(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("等待后台任务状态超时")


class PersistentJobSchedulerTests(unittest.TestCase):
    def test_single_worker_preserves_order_and_completion(self) -> None:
        store = MemoryStore()
        store.create("job-a")
        store.create("job-b")
        scheduler = PersistentJobScheduler(store, max_workers=1)
        order: list[str] = []

        def runner(job_id: str, label: str, *, cancel_event: threading.Event) -> None:
            self.assertFalse(cancel_event.is_set())
            store.update_job(job_id, status="running", progress=25)
            order.append(label)
            store.update_job(job_id, status="completed", progress=100)

        self.assertTrue(scheduler.submit("job-a", runner, "a"))
        self.assertTrue(scheduler.submit("job-b", runner, "b"))
        wait_for(lambda: store.job("job-b")["status"] == "completed")
        self.assertEqual(order, ["a", "b"])

    def test_queued_job_can_be_cancelled(self) -> None:
        store = MemoryStore()
        store.create("job-a")
        store.create("job-b")
        scheduler = PersistentJobScheduler(store, max_workers=1)
        release = threading.Event()

        def blocking_runner(
            job_id: str,
            *,
            cancel_event: threading.Event,
        ) -> None:
            store.update_job(job_id, status="running")
            release.wait(timeout=1.0)
            if cancel_event.is_set():
                store.update_job(job_id, status="cancelled", progress=100)
            else:
                store.update_job(job_id, status="completed", progress=100)

        scheduler.submit("job-a", blocking_runner)
        scheduler.submit("job-b", blocking_runner)
        wait_for(lambda: store.job("job-a")["status"] == "running")
        scheduler.cancel("job-b")
        release.set()
        wait_for(lambda: store.job("job-b")["status"] == "cancelled")
        self.assertEqual(store.job("job-b")["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
