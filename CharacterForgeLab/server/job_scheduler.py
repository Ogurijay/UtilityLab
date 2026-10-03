# -*- coding: utf-8 -*-
"""AnimotionHub 本机后台任务调度器。

任务事实保存在 PlatformStore 的 jobs.json 中；内存队列只负责本次服务进程的执行顺序。
因此服务重启后可以由调用方根据持久记录重新提交，而不会依赖遗留线程。
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass
from typing import Any, Callable


TERMINAL_STATES = {"completed", "failed", "blocked", "cancelled"}


@dataclass(frozen=True)
class ScheduledJob:
    job_id: str
    runner: Callable[..., None]
    args: tuple[Any, ...]


class PersistentJobScheduler:
    """限制并发并为任务提供取消信号的本机调度器。"""

    def __init__(self, store: Any, max_workers: int = 1):
        self.store = store
        self.max_workers = max(1, int(max_workers))
        self.pending: queue.Queue[ScheduledJob] = queue.Queue()
        self.lock = threading.RLock()
        self.known: set[str] = set()
        self.cancel_events: dict[str, threading.Event] = {}
        self.workers: list[threading.Thread] = []
        for index in range(self.max_workers):
            worker = threading.Thread(
                target=self._work,
                name=f"animotion-job-worker-{index + 1}",
                daemon=True,
            )
            worker.start()
            self.workers.append(worker)

    def _job(self, job_id: str) -> dict[str, Any] | None:
        return next(
            (
                item
                for item in self.store.list_jobs().get("items", [])
                if item.get("id") == job_id
            ),
            None,
        )

    def submit(
        self,
        job_id: str,
        runner: Callable[..., None],
        *args: Any,
        recovered: bool = False,
    ) -> bool:
        with self.lock:
            if job_id in self.known:
                return False
            job = self._job(job_id)
            if not job or job.get("status") in TERMINAL_STATES:
                return False
            cancel_event = self.cancel_events.setdefault(job_id, threading.Event())
            cancel_event.clear()
            self.known.add(job_id)
            self.store.update_job(
                job_id,
                status="queued",
                progress=min(int(job.get("progress") or 0), 5) if recovered else 0,
                error=None,
                recovered=bool(recovered),
            )
            self.pending.put(ScheduledJob(job_id, runner, tuple(args)))
            return True

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self._job(job_id)
            if not job:
                raise ValueError("后台任务不存在")
            if job.get("status") in TERMINAL_STATES:
                return job
            event = self.cancel_events.setdefault(job_id, threading.Event())
            event.set()
            return self.store.update_job(
                job_id,
                status="cancel_requested",
                error="用户请求取消任务",
            )

    def _work(self) -> None:
        while True:
            scheduled = self.pending.get()
            event = self.cancel_events.setdefault(scheduled.job_id, threading.Event())
            try:
                if event.is_set():
                    self.store.update_job(
                        scheduled.job_id,
                        status="cancelled",
                        progress=100,
                        error="任务在开始前已取消",
                    )
                    continue
                scheduled.runner(
                    scheduled.job_id,
                    *scheduled.args,
                    cancel_event=event,
                )
                job = self._job(scheduled.job_id)
                if event.is_set() and job and job.get("status") not in TERMINAL_STATES:
                    self.store.update_job(
                        scheduled.job_id,
                        status="cancelled",
                        progress=100,
                        error="任务已取消",
                    )
            except Exception as exc:  # noqa: BLE001 - worker 必须把未知异常写回任务。
                self.store.update_job(
                    scheduled.job_id,
                    status="failed",
                    progress=100,
                    error=f"后台任务异常：{exc}",
                )
            finally:
                with self.lock:
                    self.known.discard(scheduled.job_id)
                    self.cancel_events.pop(scheduled.job_id, None)
                self.pending.task_done()
