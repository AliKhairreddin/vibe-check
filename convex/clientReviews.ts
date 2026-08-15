import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type ResultStatus = "green" | "amber" | "red";

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function normalizeResultStatus(value: unknown): ResultStatus | null {
  if (value === "green" || value === "amber" || value === "red") return value;
  if (value === "pass") return "green";
  if (value === "yellow" || value === "orange" || value === "needs_review") return "amber";
  if (value === "likely_violation") return "red";
  return null;
}

const decisionValueValidator = v.union(v.literal("approved"), v.literal("disapproved"));
const decisionValidator = v.object({
  decidedAt: v.number(),
  decision: decisionValueValidator,
});
const reviewValidator = v.object({
  aiStatus: v.union(v.literal("green"), v.literal("amber"), v.literal("red")),
  batchId: v.union(v.string(), v.null()),
  batchSourceLabel: v.union(v.string(), v.null()),
  createdAt: v.number(),
  decision: v.union(decisionValidator, v.null()),
  fileName: v.string(),
  jobId: v.string(),
  mediaKind: v.union(v.literal("video"), v.literal("image"), v.literal("copy_only")),
});

function mediaKind(fileName: string, hasCreative: boolean | undefined) {
  if (hasCreative === false) return "copy_only" as const;
  const normalized = fileName.toLowerCase();
  return (
    normalized.endsWith(".jpg")
    || normalized.endsWith(".jpeg")
    || normalized.endsWith(".png")
    || normalized.endsWith(".webp")
  ) ? "image" as const : "video" as const;
}

export const list = query({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    limit: v.number(),
  },
  returns: v.array(reviewValidator),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(args.limit, 100));
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_offer_id_and_deleted_at_and_status_and_created_at", (q) =>
        q
          .eq("offerId", args.offerId)
          .eq("deletedAt", undefined)
          .eq("status", "complete")
      )
      .order("desc")
      .take(limit);
    const reviews = await Promise.all(stats.map((stat) =>
      ctx.db
        .query("reviews")
        .withIndex("by_job_id", (q) => q.eq("jobId", stat.jobId))
        .unique()
    ));
    const batchIds = [...new Set(reviews.flatMap((review) =>
      review?.batchId ? [review.batchId] : []
    ))];
    const batches = await Promise.all(batchIds.map((batchId) =>
      ctx.db
        .query("reviewBatches")
        .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
        .unique()
    ));
    const batchById = new Map(batches.flatMap((batch) =>
      batch ? [[batch.batchId, batch] as const] : []
    ));
    const decisions = await Promise.all(stats.map((stat) =>
      ctx.db
        .query("clientReviewDecisions")
        .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
          q
            .eq("clientId", args.clientId)
            .eq("offerId", args.offerId)
            .eq("jobId", stat.jobId)
        )
        .unique()
    ));

    return stats.flatMap((stat, index) => {
      const review = reviews[index];
      const aiStatus = normalizeResultStatus(stat.resultStatus);
      if (!review || review.deletedAt !== undefined || !aiStatus) return [];
      const decision = decisions[index];
      return [{
        aiStatus,
        batchId: review.batchId ?? null,
        batchSourceLabel: review.batchId
          ? batchById.get(review.batchId)?.sourceLabel ?? null
          : null,
        createdAt: review.createdAt,
        decision: decision ? {
          decidedAt: decision.decidedAt,
          decision: decision.decision,
        } : null,
        fileName: review.fileName,
        jobId: review.jobId,
        mediaKind: mediaKind(review.fileName, review.hasCreative),
      }];
    });
  },
});

export const getReport = query({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .collect();
    if (!stats.some((stat) => stat.offerId === args.offerId && stat.deletedAt === undefined)) {
      return null;
    }
    const stored = await ctx.db
      .query("reviewOfferReports")
      .withIndex("by_job_id_offer_id", (q) =>
        q.eq("jobId", args.jobId).eq("offerId", args.offerId)
      )
      .unique();
    if (stored) return stored.report;
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!review || review.deletedAt !== undefined) return null;
    const report = review.report;
    if (!report || typeof report !== "object" || Array.isArray(report)) return null;
    const primaryOfferId = (report as { primary_offer_id?: unknown; offer_id?: unknown }).primary_offer_id
      ?? (report as { offer_id?: unknown }).offer_id
      ?? "acp";
    return primaryOfferId === args.offerId ? report : null;
  },
});

export const decide = mutation({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
    decision: decisionValueValidator,
  },
  returns: decisionValidator,
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .collect();
    if (!stats.some((stat) =>
      stat.offerId === args.offerId
      && stat.deletedAt === undefined
      && stat.status === "complete"
    )) {
      throw new Error("Client review is unavailable");
    }
    const existing = await ctx.db
      .query("clientReviewDecisions")
      .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
        q
          .eq("clientId", args.clientId)
          .eq("offerId", args.offerId)
          .eq("jobId", args.jobId)
      )
      .unique();
    const now = Date.now();
    const value = {
      clientId: args.clientId,
      decidedAt: now,
      decision: args.decision,
      jobId: args.jobId,
      offerId: args.offerId,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("clientReviewDecisions", { ...value, createdAt: now });
    }
    return { decidedAt: now, decision: args.decision };
  },
});
