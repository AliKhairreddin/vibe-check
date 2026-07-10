from __future__ import annotations
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field, field_validator

ResultStatus = Literal['green','yellow','orange','red']
ReviewSourceKind = Literal['google_drive_file','google_sheet']
ReviewSourceStatus = Literal['linked','not_found','ambiguous','unavailable']
LEGACY_RESULT_STATUSES = {
    'pass': 'green',
    'needs_review': 'orange',
    'likely_violation': 'red',
}

def normalize_result_status(value):
    return LEGACY_RESULT_STATUSES.get(value, value)

class JobStatus(str, Enum):
    queued='queued'; downloading_from_drive='downloading_from_drive'; processing_video='processing_video'; processing_image='processing_image'; extracting_audio='extracting_audio'; extracting_frames='extracting_frames'; running_ocr='running_ocr'; analyzing_visuals='analyzing_visuals'; preparing_transcript='preparing_transcript'; reviewing_with_llm='reviewing_with_llm'; complete='complete'; failed='failed'

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

    @field_validator('status', mode='before')
    @classmethod
    def normalize_legacy_status(cls, value):
        return normalize_result_status(value)

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

    @field_validator('overall_status', mode='before')
    @classmethod
    def normalize_legacy_status(cls, value):
        return normalize_result_status(value)

class JobRecord(BaseModel):
    job_id: str
    file_name: str = ''
    file_size: int | None = None
    status: JobStatus = JobStatus.queued
    progress: int = 0
    message: str = ''
    report_ready: bool = False
    has_creative: bool = True
    has_ad_copy: bool = True
    batch_id: str | None = None
    batch_item_id: str | None = None
    source_kind: ReviewSourceKind | None = None
    source_status: ReviewSourceStatus | None = None
    source_url: str | None = None
    source_file_id: str | None = None
    source_message: str = ''
    source_checked_at: int | None = None
    created_at: int | None = None
    updated_at: int | None = None

class ReviewSource(BaseModel):
    kind: ReviewSourceKind | None = None
    status: ReviewSourceStatus
    url: str | None = None
    file_id: str | None = None
    label: str
    message: str
    checked_at: int

class ReviewSources(BaseModel):
    sources: list[ReviewSource] = Field(default_factory=list)

class ReviewHistoryItem(JobRecord):
    overall_status: ResultStatus | None = None
    creative_result: ResultStatus | None = None
    ad_copy_result: ResultStatus | None = None

class ReviewHistoryPage(BaseModel):
    reviews: list[ReviewHistoryItem] = Field(default_factory=list)
    next_cursor: str | None = None
    has_more: bool = False

class ReviewRequestMeta(BaseModel):
    ad_copy: str = ''
    policy_text: str = ''
    notes: str = ''
    manual_transcript: str = ''
    model: str | None = None
    frame_interval_seconds: float = 1.0
    scene_detection: bool = False
    batch_id: str | None = None
    batch_item_id: str | None = None

    @property
    def has_ad_copy(self) -> bool:
        return bool(self.ad_copy.strip())

    @property
    def has_batch(self) -> bool:
        return bool(self.batch_id and self.batch_item_id)

class DriveCreativeFile(BaseModel):
    file_id: str
    name: str
    mime_type: str
    size: int | None = None
    modified_time: str | None = None
    web_view_link: str

class DriveCreativeList(BaseModel):
    files: list[DriveCreativeFile] = Field(default_factory=list)

class CreateDriveReview(BaseModel):
    file_id: str = Field(min_length=1, max_length=512)
    ad_copy: str = ''
    policy_text: str = ''
    notes: str = ''
    manual_transcript: str = ''
    model: str | None = None
    frame_interval_seconds: float = Field(default=1.0, ge=0.5, le=60)
    scene_detection: bool = False
    batch_id: str | None = None
    batch_item_id: str | None = None

class CreateBatchItem(BaseModel):
    item_id: str
    file_name: str
    media_kind: Literal['video','image','copy_only']

class CreateReviewBatch(BaseModel):
    batch_id: str
    items: list[CreateBatchItem]

class BatchFailure(BaseModel):
    message: str = 'Upload failed before the review could start.'

class ReviewBatchItem(CreateBatchItem):
    status: str = 'pending'
    job_id: str | None = None
    result: ResultStatus | None = None
    message: str = ''

class ReviewBatch(BaseModel):
    batch_id: str
    created_at: int
    updated_at: int
    expected_count: int
    items: list[ReviewBatchItem]
    notification_status: str = 'pending'
