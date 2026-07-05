import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  reviews: defineTable({
    createdAt: v.number(),
    fileName: v.string(),
    hasAdCopy: v.optional(v.boolean()),
    jobId: v.string(),
    message: v.string(),
    progress: v.number(),
    report: v.optional(v.any()),
    reportReady: v.boolean(),
    status: v.string(),
    updatedAt: v.number(),
  })
    .index("by_job_id", ["jobId"])
    .index("by_created_at", ["createdAt"]),
});
