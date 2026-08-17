from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class StageTiming:
    name: str
    started_offset_ms: int
    duration_ms: int

    def as_wire_value(self) -> dict[str, int | str]:
        return {
            'name': self.name,
            'startedOffsetMs': self.started_offset_ms,
            'durationMs': self.duration_ms,
        }


class ProcessingTimer:
    """Collect overlapping job-stage timings without adding writes per stage."""

    def __init__(
        self,
        job_id: str,
        media_kind: str,
        queued_at_ms: int | None = None,
    ):
        self.job_id = job_id
        self.media_kind = media_kind
        self.started_at_ms = int(time.time() * 1000)
        self._started_ns = time.perf_counter_ns()
        self._stages: list[StageTiming] = []
        self.queue_wait_ms = (
            max(0, self.started_at_ms - queued_at_ms)
            if queued_at_ms is not None
            else None
        )

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        started_ns = time.perf_counter_ns()
        try:
            yield
        finally:
            finished_ns = time.perf_counter_ns()
            self._stages.append(StageTiming(
                name=name,
                started_offset_ms=max(0, (started_ns - self._started_ns) // 1_000_000),
                duration_ms=max(0, (finished_ns - started_ns) // 1_000_000),
            ))

    def finish(self, *, completed: bool, error_type: str = '') -> dict:
        finished_ns = time.perf_counter_ns()
        finished_at_ms = int(time.time() * 1000)
        value = {
            'jobId': self.job_id,
            'mediaKind': self.media_kind,
            'completed': completed,
            'startedAt': self.started_at_ms,
            'finishedAt': finished_at_ms,
            'totalMs': max(0, (finished_ns - self._started_ns) // 1_000_000),
            'stages': [
                stage.as_wire_value()
                for stage in sorted(
                    self._stages,
                    key=lambda item: (item.started_offset_ms, item.name),
                )
            ],
        }
        if error_type:
            value['errorType'] = error_type
        if self.queue_wait_ms is not None:
            value['queueWaitMs'] = self.queue_wait_ms
        return value
