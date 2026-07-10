from __future__ import annotations
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field

ResultStatus = Literal['green','yellow','orange','red']

class JobStatus(str, Enum):
    queued='queued'; processing_video='processing_video'; processing_image='processing_image'; extracting_audio='extracting_audio'; extracting_frames='extracting_frames'; running_ocr='running_ocr'; analyzing_visuals='analyzing_visuals'; preparing_transcript='preparing_transcript'; reviewing_with_llm='reviewing_with_llm'; complete='complete'; failed='failed'

class Finding(BaseModel):
    severity: Literal['low','medium','high']
    source: Literal['audio','onscreen_text','visual','ad_copy','policy']
    timestamp_start: str | None = None
    timestamp_end: str | None = None
    evidence: str
    policy_reason: str
    suggested_fix: str
    confidence: Literal['low','medium','high']

class SafeRewrite(BaseModel):
    ad_copy: str = ''
    onscreen_text: list[str] = Field(default_factory=list)

class SourceResult(BaseModel):
    status: ResultStatus
    summary: str = ''

class SourceResults(BaseModel):
    creative: SourceResult | None = None
    ad_copy: SourceResult | None = None

class ComplianceReport(BaseModel):
    overall_status: ResultStatus
    summary: str
    source_results: SourceResults = Field(default_factory=SourceResults)
    findings: list[Finding] = Field(default_factory=list)
    safe_rewrite: SafeRewrite = Field(default_factory=SafeRewrite)
    limitations: list[str] = Field(default_factory=list)

class JobRecord(BaseModel):
    job_id: str
    file_name: str = ''
    status: JobStatus = JobStatus.queued
    progress: int = 0
    message: str = ''
    report_ready: bool = False
    has_creative: bool = True
    has_ad_copy: bool = True
    created_at: int | None = None
    updated_at: int | None = None

class ReviewHistoryItem(JobRecord):
    overall_status: ResultStatus | None = None
    creative_result: ResultStatus | None = None
    ad_copy_result: ResultStatus | None = None

class ReviewRequestMeta(BaseModel):
    ad_copy: str = ''
    policy_text: str = ''
    notes: str = ''
    manual_transcript: str = ''
    model: str | None = None
    frame_interval_seconds: float = 1.0
    scene_detection: bool = False

    @property
    def has_ad_copy(self) -> bool:
        return bool(self.ad_copy.strip())
