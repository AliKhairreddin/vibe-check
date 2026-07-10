import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  reviews: defineTable({
    batchId: v.optional(v.string()),
    batchItemId: v.optional(v.string()),
    createdAt: v.number(),
    fileName: v.string(),
    fileSize: v.optional(v.number()),
    hasAdCopy: v.optional(v.boolean()),
    hasCreative: v.optional(v.boolean()),
    jobId: v.string(),
    message: v.string(),
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
    .index("by_created_at", ["createdAt"]),
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
});
