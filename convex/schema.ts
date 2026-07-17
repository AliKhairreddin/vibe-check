import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  reviews: defineTable({
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
  })
    .index("by_job_id", ["jobId"])
    .index("by_created_at", ["createdAt"])
    .index("by_deleted_at_created_at", ["deletedAt", "createdAt"]),
  reviewOfferStats: defineTable({
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
    hasCreative: v.boolean(),
    internalDisposition: v.optional(v.string()),
    jobId: v.string(),
    offerId: v.string(),
    resultStatus: v.optional(v.union(
      v.literal("green"),
      v.literal("yellow"),
      v.literal("orange"),
      v.literal("red")
    )),
    status: v.string(),
    updatedAt: v.number(),
  })
    .index("by_offer_id_deleted_at", ["offerId", "deletedAt"])
    .index("by_job_id", ["jobId"]),
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
    items: v.array(v.object({
      fileName: v.string(),
      itemId: v.string(),
      jobId: v.optional(v.string()),
      mediaKind: v.string(),
      message: v.string(),
      result: v.optional(v.string()),
      status: v.string(),
    })),
    notificationStatus: v.string(),
    updatedAt: v.number(),
  })
    .index("by_batch_id", ["batchId"])
    .index("by_created_at", ["createdAt"]),
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
