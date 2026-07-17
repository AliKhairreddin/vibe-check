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

class OfferOverride(BaseModel):
    override_id: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=160)
    guidance: str = Field(min_length=1, max_length=10_000)
    rationale: str = Field(default='', max_length=5_000)
    enabled: bool = True

class AppliedOverride(BaseModel):
    override_id: str
    title: str = ''
    disposition: Literal['accepted','partial','uncertain'] = 'uncertain'
    rationale: str = ''

class OverrideAnnotation(BaseModel):
    finding_index: int = Field(ge=0)
    internal_override: AppliedOverride

class OverrideAnnotationSet(BaseModel):
    annotations: list[OverrideAnnotation] = Field(default_factory=list)

class OfferProfile(BaseModel):
    offer_id: str = Field(min_length=1, max_length=80)
    display_name: str = Field(min_length=1, max_length=160)
    official_guidelines: str = Field(min_length=1, max_length=200_000)
    internal_overrides: list[OfferOverride] = Field(default_factory=list)
    enabled: bool = True
    is_default: bool = False
    version: int = Field(default=1, ge=1)
    created_at: int | None = None
    updated_at: int | None = None

class OfferProfileInput(BaseModel):
    display_name: str = Field(min_length=1, max_length=160)
    official_guidelines: str = Field(min_length=1, max_length=200_000)
    internal_overrides: list[OfferOverride] = Field(default_factory=list)
    enabled: bool = True
    is_default: bool = False

class OfferProfileList(BaseModel):
    offers: list[OfferProfile] = Field(default_factory=list)

class Finding(BaseModel):
    severity: Literal['low','medium','high']
    source: Literal['audio','onscreen_text','visual','ad_copy','policy']
    timestamp_start: str | None = None
    timestamp_end: str | None = None
    evidence: str
    policy_reason: str
    suggested_fix: str
    confidence: Literal['low','medium','high']
    internal_override: AppliedOverride | None = None

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

class OfferComplianceResult(BaseModel):
    offer_id: str = 'acp'
    offer_name: str = 'ACP'
    guideline_version: int | None = None
    overall_status: ResultStatus
    summary: str
    source_results: SourceResults = Field(default_factory=SourceResults)
    findings: list[Finding] = Field(default_factory=list)
    safe_rewrite: SafeRewrite = Field(default_factory=SafeRewrite)
    limitations: list[str] = Field(default_factory=list)
    policy_sources: list[str] = Field(default_factory=list)
    internal_disposition: Literal[
        'clear',
        'accepted_with_override',
        'action_required',
        'human_review',
    ] = 'clear'

    @field_validator('overall_status', mode='before')
    @classmethod
    def normalize_legacy_status(cls, value):
        return normalize_result_status(value)

class ComplianceReport(OfferComplianceResult):
    schema_version: int = 1
    primary_offer_id: str | None = None
    offer_results: list[OfferComplianceResult] = Field(default_factory=list)

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
    offer_ids: list[str] = Field(default_factory=lambda: ['acp'])
    primary_offer_id: str = 'acp'
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
    offer_profiles: list[OfferProfile] = Field(default_factory=list)

    @property
    def has_ad_copy(self) -> bool:
        return bool(self.ad_copy.strip())

    @property
    def has_batch(self) -> bool:
        return bool(self.batch_id and self.batch_item_id)

    @property
    def offer_ids(self) -> list[str]:
        return [profile.offer_id for profile in self.offer_profiles] or ['acp']

    @property
    def primary_offer_id(self) -> str:
        return self.offer_ids[0]

class DriveCreativeFile(BaseModel):
    file_id: str
    name: str
    mime_type: str
    size: int | None = None
    modified_time: str | None = None
    web_view_link: str

class DriveBrowserItem(DriveCreativeFile):
    kind: Literal['folder','creative']
    selectable: bool = True
    disabled_reason: str | None = None

class DriveFolder(BaseModel):
    folder_id: str
    name: str
    web_view_link: str

class DriveBrowserList(BaseModel):
    current_folder: DriveFolder
    items: list[DriveBrowserItem] = Field(default_factory=list)
    max_selection: int = 100

class ResolveDriveSelection(BaseModel):
    folder_ids: list[str] = Field(default_factory=list, max_length=100)
    file_ids: list[str] = Field(default_factory=list, max_length=100)

class DriveSelectionResult(BaseModel):
    files: list[DriveCreativeFile] = Field(default_factory=list)
    max_selection: int = 100

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
    offer_ids: list[str] = Field(default_factory=lambda: ['acp'], min_length=1, max_length=10)

class ReviewOutcomeCounts(BaseModel):
    green: int = 0
    yellow: int = 0
    orange: int = 0
    red: int = 0

class ReviewStats(BaseModel):
    offer_id: str = 'acp'
    total_reviews: int = 0
    completed_reviews: int = 0
    creative_reviews: int = 0
    copy_only_reviews: int = 0
    in_progress_reviews: int = 0
    failed_reviews: int = 0
    accepted_overrides: int = 0
    outcomes: ReviewOutcomeCounts = Field(default_factory=ReviewOutcomeCounts)

class DeletedReview(BaseModel):
    job_id: str
    deleted_at: int

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
