import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  maintenanceState: defineTable({
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    key: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  reviewPayloads: defineTable({
    createdAt: v.number(),
    jobId: v.string(),
    manifestStorageId: v.id("_storage"),
    mediaStorageId: v.optional(v.id("_storage")),
    updatedAt: v.number(),
  }).index("by_job_id", ["jobId"]),
  reviewEvidenceFrames: defineTable({
    createdAt: v.number(),
    frames: v.array(v.object({
      filename: v.string(),
      storageId: v.id("_storage"),
      timestamp: v.optional(v.number()),
    })),
    jobId: v.string(),
    updatedAt: v.number(),
  }).index("by_job_id", ["jobId"]),
  reviewProcessingMetrics: defineTable({
    completed: v.boolean(),
    createdAt: v.number(),
    errorType: v.optional(v.string()),
    finishedAt: v.number(),
    jobId: v.string(),
    mediaKind: v.string(),
    queueWaitMs: v.optional(v.number()),
    stages: v.array(v.object({
      durationMs: v.number(),
      name: v.string(),
      startedOffsetMs: v.number(),
    })),
    startedAt: v.number(),
    totalMs: v.number(),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_started_at", ["startedAt"]),
  clientReviewDecisions: defineTable({
    aiFindings: v.optional(v.array(v.string())),
    aiStatus: v.optional(v.union(
      v.literal("green"),
      v.literal("yellow"),
      v.literal("red")
    )),
    aiSummary: v.optional(v.string()),
    clientId: v.string(),
    createdAt: v.number(),
    decidedAt: v.number(),
    decision: v.union(v.literal("approved"), v.literal("disapproved")),
    feedbackNote: v.optional(v.string()),
    feedbackReason: v.optional(v.union(
      v.literal("false_positive"),
      v.literal("missed_policy_issue"),
      v.literal("partner_preference"),
      v.literal("one_off_exception"),
      v.literal("business_decision")
    )),
    jobId: v.string(),
    offerId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_client_id_and_offer_id_and_job_id", ["clientId", "offerId", "jobId"])
    .index("by_client_id_and_decided_at", ["clientId", "decidedAt"])
    .index("by_job_id", ["jobId"])
    .index("by_offer_id_and_decided_at", ["offerId", "decidedAt"]),
  reportArtifacts: defineTable({
    contentType: v.string(),
    createdAt: v.number(),
    filename: v.string(),
    ownerId: v.string(),
    ownerType: v.union(v.literal("review"), v.literal("batch")),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  }).index("by_owner_type_and_owner_id", ["ownerType", "ownerId"]),
  reviewAutomations: defineTable({
    automationId: v.string(),
    createdAt: v.number(),
    daysOfWeek: v.array(v.number()),
    driveFolderId: v.string(),
    enabled: v.boolean(),
    fileNamePattern: v.string(),
    includeSubfolders: v.boolean(),
    lastBatchId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    lastRunMessage: v.optional(v.string()),
    lastRunStatus: v.optional(v.string()),
    lastScheduledFor: v.optional(v.string()),
    localTime: v.string(),
    name: v.string(),
    timeZone: v.string(),
    updatedAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"])
    .index("by_last_batch_id", ["lastBatchId"]),
  automationRuns: defineTable({
    attempts: v.optional(v.number()),
    automationId: v.string(),
    batchId: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    jobIds: v.array(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    matchedCount: v.number(),
    message: v.string(),
    queuedCount: v.number(),
    retryRequired: v.optional(v.boolean()),
    runId: v.string(),
    scheduledFor: v.string(),
    status: v.string(),
    updatedAt: v.number(),
  })
    .index("by_run_id", ["runId"])
    .index("by_automation_scheduled", ["automationId", "scheduledFor"])
    .index("by_automation_status", ["automationId", "status"])
    .index("by_batch_id", ["batchId"])
    .index("by_status", ["status"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),
  automationFileClaims: defineTable({
    automationId: v.string(),
    claimedAt: v.number(),
    fileId: v.string(),
    fileName: v.string(),
    jobId: v.optional(v.string()),
    modifiedTime: v.string(),
    runId: v.string(),
  })
    .index("by_automation_file_modified", ["automationId", "fileId", "modifiedTime"])
    .index("by_run_id", ["runId"]),
  automationJobStates: defineTable({
    batchId: v.optional(v.string()),
    batchItemId: v.optional(v.string()),
    jobId: v.string(),
    reviewId: v.optional(v.id("reviews")),
    runId: v.string(),
    status: v.string(),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_run_id", ["runId"]),
  reviews: defineTable({
    automationRunId: v.optional(v.string()),
    batchId: v.optional(v.string()),
    batchItemId: v.optional(v.string()),
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
    fileName: v.string(),
    fileSize: v.optional(v.number()),
    hasAdCopy: v.optional(v.boolean()),
    hasCreative: v.optional(v.boolean()),
    jobId: v.string(),
    message: v.string(),
    offerIds: v.optional(v.array(v.string())),
    primaryOfferId: v.optional(v.string()),
    progress: v.number(),
    report: v.optional(v.any()),
    reportReady: v.boolean(),
    status: v.string(),
    sourceCheckedAt: v.optional(v.number()),
    sourceFileId: v.optional(v.string()),
    sourceKind: v.optional(v.string()),
    sourceMessage: v.optional(v.string()),
    sourceStatus: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    updatedAt: v.number(),
    vertical: v.optional(v.union(
      v.literal("auto-insurance"),
      v.literal("home-insurance")
    )),
  })
    .index("by_job_id", ["jobId"])
    .index("by_batch_id", ["batchId"])
    .index("by_file_name", ["fileName"])
    .index("by_created_at", ["createdAt"])
    .index("by_status_deleted_automation_updated", [
      "status",
      "deletedAt",
      "automationRunId",
      "updatedAt",
    ])
    .index("by_deleted_at_created_at", ["deletedAt", "createdAt"]),
  reviewOfferStats: defineTable({
    batchId: v.optional(v.string()),
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
    fileName: v.optional(v.string()),
    hasCreative: v.boolean(),
    internalDisposition: v.optional(v.string()),
    jobId: v.string(),
    offerId: v.string(),
    previewFindingCount: v.optional(v.number()),
    previewFindings: v.optional(v.array(v.string())),
    previewReady: v.optional(v.boolean()),
    previewSummary: v.optional(v.string()),
    resultStatus: v.optional(v.union(
      v.literal("green"),
      v.literal("amber"),
      v.literal("yellow"),
      v.literal("orange"),
      v.literal("red")
    )),
    sourceKind: v.optional(v.string()),
    sourceStatus: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    status: v.string(),
    updatedAt: v.number(),
    vertical: v.optional(v.union(
      v.literal("auto-insurance"),
      v.literal("home-insurance")
    )),
  })
    .index("by_offer_id_deleted_at", ["offerId", "deletedAt"])
    .index("by_offer_id_and_vertical_and_deleted_at", [
      "offerId",
      "vertical",
      "deletedAt",
    ])
    .index("by_offer_id_and_deleted_at_and_status_and_created_at", [
      "offerId",
      "deletedAt",
      "status",
      "createdAt",
    ])
    .index("by_job_id", ["jobId"])
    .index("by_job_id_and_offer_id", ["jobId", "offerId"]),
  reviewOfferReports: defineTable({
    createdAt: v.number(),
    jobId: v.string(),
    offerId: v.string(),
    position: v.number(),
    report: v.any(),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_job_id_offer_id", ["jobId", "offerId"]),
  reviewBatches: defineTable({
    batchId: v.string(),
    createdAt: v.number(),
    expectedCount: v.number(),
    sourceLabel: v.optional(v.string()),
    items: v.array(v.object({
      offerOutcomes: v.optional(v.array(v.object({
        adCopyResult: v.optional(v.string()),
        creativeResult: v.optional(v.string()),
        evaluationState: v.string(),
        message: v.string(),
        offerId: v.string(),
        offerName: v.string(),
        overallStatus: v.optional(v.string()),
        withOverride: v.optional(v.boolean()),
      }))),
      driveFileId: v.optional(v.string()),
      driveId: v.optional(v.string()),
      fileName: v.string(),
      itemId: v.string(),
      jobId: v.optional(v.string()),
      mediaKind: v.string(),
      message: v.string(),
      result: v.optional(v.string()),
      status: v.string(),
      vertical: v.optional(v.union(
        v.literal("auto-insurance"),
        v.literal("home-insurance")
      )),
    })),
    reviewContext: v.optional(v.object({
      adCopy: v.string(),
      driveId: v.optional(v.string()),
      frameIntervalSeconds: v.number(),
      manualTranscript: v.string(),
      model: v.optional(v.string()),
      notes: v.string(),
      offerIds: v.array(v.string()),
      policyText: v.string(),
      sceneDetection: v.boolean(),
    })),
    notificationStatus: v.string(),
    notificationAttempts: v.optional(v.number()),
    notificationClaimId: v.optional(v.string()),
    notificationLeaseExpiresAt: v.optional(v.number()),
    notificationReady: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_batch_id", ["batchId"])
    .index("by_created_at", ["createdAt"])
    .index("by_notification_status", ["notificationStatus"])
    .index("by_notification_ready_status_lease", ["notificationReady", "notificationStatus", "notificationLeaseExpiresAt"]),
  liveScanAccounts: defineTable({
    accountId: v.string(),
    accountName: v.string(),
    firstObservedAt: v.number(),
    lastObservedAt: v.number(),
    observationDate: v.string(),
    scanCount: v.number(),
    sourceUrl: v.optional(v.string()),
  })
    .index("by_date", ["observationDate"])
    .index("by_date_account", ["observationDate", "accountId"]),
  liveScanCreatives: defineTable({
    accountId: v.string(),
    adCount: v.number(),
    adIds: v.array(v.string()),
    adSetNames: v.array(v.string()),
    campaignNames: v.array(v.string()),
    creativeKey: v.string(),
    creativeName: v.string(),
    deliveryStatuses: v.array(v.string()),
    firstObservedAt: v.number(),
    lastObservedAt: v.number(),
    observationDate: v.string(),
  })
    .index("by_date", ["observationDate"])
    .index("by_date_account", ["observationDate", "accountId"])
    .index("by_date_account_creative", ["observationDate", "accountId", "creativeKey"]),
  liveScanCopies: defineTable({
    accountId: v.string(),
    adCount: v.number(),
    adIds: v.array(v.string()),
    copyKey: v.string(),
    creativeKey: v.string(),
    creativeName: v.string(),
    firstObservedAt: v.number(),
    lastObservedAt: v.number(),
    observationDate: v.string(),
    primaryText: v.string(),
  })
    .index("by_date", ["observationDate"])
    .index("by_date_account", ["observationDate", "accountId"])
    .index("by_date_account_creative_copy", [
      "observationDate",
      "accountId",
      "creativeKey",
      "copyKey",
    ]),
  liveScanReviewClaims: defineTable({
    createdAt: v.number(),
    displayName: v.string(),
    jobId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("creative"), v.literal("copy")),
    leaseExpiresAt: v.optional(v.number()),
    result: v.optional(v.union(
      v.literal("green"),
      v.literal("amber"),
      v.literal("yellow"),
      v.literal("orange"),
      v.literal("red")
    )),
    status: v.string(),
    updatedAt: v.number(),
  })
    .index("by_kind_key", ["kind", "key"])
    .index("by_job_id", ["jobId"]),
  apiPartners: defineTable({
    allowedOfferIds: v.array(v.string()),
    allowCustomPolicy: v.boolean(),
    concurrentReviewLimit: v.number(),
    createdAt: v.number(),
    description: v.string(),
    maxUploadMb: v.number(),
    monthlyReviewLimit: v.number(),
    name: v.string(),
    partnerId: v.string(),
    retentionDays: v.number(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    unlimitedConcurrency: v.boolean(),
    unlimitedReviews: v.boolean(),
    updatedAt: v.number(),
    webhookSigningSecret: v.optional(v.string()),
    webhookUrl: v.optional(v.string()),
  })
    .index("by_partner_id", ["partnerId"])
    .index("by_status", ["status"]),
  apiKeys: defineTable({
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
    keyId: v.string(),
    lastUsedAt: v.optional(v.number()),
    name: v.string(),
    partnerId: v.string(),
    prefix: v.string(),
    revokedAt: v.optional(v.number()),
    scopes: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    tokenHash: v.string(),
    updatedAt: v.number(),
  })
    .index("by_key_id", ["keyId"])
    .index("by_partner_id", ["partnerId"])
    .index("by_token_hash", ["tokenHash"]),
  apiReviewLinks: defineTable({
    apiKeyId: v.string(),
    createdAt: v.number(),
    creativeName: v.optional(v.string()),
    externalId: v.optional(v.string()),
    fileName: v.string(),
    fileSize: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    jobId: v.string(),
    mediaKind: v.string(),
    partnerId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("deleted")
    ),
    terminalAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_partner_id_and_created_at", ["partnerId", "createdAt"])
    .index("by_partner_id_and_idempotency_key", ["partnerId", "idempotencyKey"])
    .index("by_partner_id_and_status_and_created_at", ["partnerId", "status", "createdAt"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),
  apiScanAds: defineTable({
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    apiKeyId: v.string(),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    contentFingerprint: v.string(),
    creativeName: v.optional(v.string()),
    currentReviewId: v.string(),
    externalAdId: v.string(),
    fieldsSha256: v.string(),
    firstObservedAt: v.number(),
    lastChangedAt: v.number(),
    lastObservedAt: v.number(),
    mediaSha256: v.string(),
    partnerId: v.string(),
    scanCount: v.number(),
  })
    .index("by_partner_id_and_external_ad_id", ["partnerId", "externalAdId"])
    .index("by_partner_id_and_last_observed_at", ["partnerId", "lastObservedAt"]),
  apiScanObservations: defineTable({
    apiKeyId: v.string(),
    changeStatus: v.union(
      v.literal("new"),
      v.literal("unchanged"),
      v.literal("media_changed"),
      v.literal("fields_changed"),
      v.literal("media_and_fields_changed"),
      v.literal("retry")
    ),
    contentFingerprint: v.string(),
    externalAdId: v.string(),
    fieldsSha256: v.string(),
    mediaSha256: v.string(),
    observationId: v.string(),
    observedAt: v.number(),
    expiresAt: v.number(),
    partnerId: v.string(),
    previousContentFingerprint: v.optional(v.string()),
    reviewCreated: v.boolean(),
    reviewId: v.string(),
  })
    .index("by_observation_id", ["observationId"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_partner_id_and_observed_at", ["partnerId", "observedAt"])
    .index("by_partner_id_and_external_ad_id_and_observed_at", [
      "partnerId",
      "externalAdId",
      "observedAt",
    ]),
  apiMonthlyUsage: defineTable({
    createdAt: v.number(),
    monthKey: v.string(),
    partnerId: v.string(),
    reviewsCreated: v.number(),
    updatedAt: v.number(),
  }).index("by_partner_id_and_month_key", ["partnerId", "monthKey"]),
  apiEvidenceBundles: defineTable({
    bundle: v.any(),
    createdAt: v.number(),
    expiresAt: v.number(),
    jobId: v.string(),
    partnerId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_expires_at", ["expiresAt"]),
  apiWebhookDeliveries: defineTable({
    attempts: v.number(),
    claimId: v.optional(v.string()),
    createdAt: v.number(),
    deliveryId: v.string(),
    eventType: v.string(),
    jobId: v.string(),
    lastError: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.number(),
    partnerId: v.string(),
    payload: v.any(),
    responseStatus: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("delivered"),
      v.literal("failed")
    ),
    updatedAt: v.number(),
  })
    .index("by_delivery_id", ["deliveryId"])
    .index("by_job_id", ["jobId"])
    .index("by_partner_id_and_created_at", ["partnerId", "createdAt"])
    .index("by_status_and_next_attempt_at", ["status", "nextAttemptAt"])
    .index("by_status_and_lease_expires_at", ["status", "leaseExpiresAt"]),
  offerProfiles: defineTable({
    createdAt: v.number(),
    displayName: v.string(),
    enabled: v.boolean(),
    internalOverrides: v.array(v.object({
      enabled: v.boolean(),
      guidance: v.string(),
      overrideId: v.string(),
      rationale: v.string(),
      title: v.string(),
    })),
    isDefault: v.boolean(),
    offerId: v.string(),
    officialGuidelines: v.string(),
    updatedAt: v.number(),
    version: v.number(),
  })
    .index("by_offer_id", ["offerId"])
    .index("by_enabled", ["enabled"])
    .index("by_default", ["isDefault"]),
  offerProfileRevisions: defineTable({
    createdAt: v.number(),
    displayName: v.string(),
    enabled: v.boolean(),
    internalOverrides: v.array(v.object({
      enabled: v.boolean(),
      guidance: v.string(),
      overrideId: v.string(),
      rationale: v.string(),
      title: v.string(),
    })),
    isDefault: v.boolean(),
    offerId: v.string(),
    officialGuidelines: v.string(),
    updatedAt: v.number(),
    version: v.number(),
  })
    .index("by_offer_id_version", ["offerId", "version"]),
});
