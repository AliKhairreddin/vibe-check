import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type BatchItem = {
  offerOutcomes?: Array<{
    adCopyResult?: string;
    creativeResult?: string;
    evaluationState: string;
    message: string;
    offerId: string;
    offerName: string;
    overallStatus?: string;
  }>;
  fileName: string;
  itemId: string;
  jobId?: string;
  mediaKind: string;
  message: string;
  result?: string;
  status: string;
};

const TERMINAL_BATCH_STATUSES = new Set(["complete", "failed", "upload_failed"]);
const NOTIFICATION_LEASE_MS = 15 * 60 * 1000;
const MAX_NOTIFICATION_ATTEMPTS = 3;

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function publicBatch(batch: {
  batchId: string;
  createdAt: number;
  expectedCount: number;
  items: BatchItem[];
  notificationStatus: string;
  updatedAt: number;
}) {
  return {
    batch_id: batch.batchId,
    created_at: batch.createdAt,
    expected_count: batch.expectedCount,
    items: batch.items.map((item) => ({
      file_name: item.fileName,
      item_id: item.itemId,
      job_id: item.jobId ?? null,
      media_kind: item.mediaKind,
      message: item.message,
      offer_outcomes: (item.offerOutcomes ?? []).map((outcome) => ({
        ad_copy_result: outcome.adCopyResult ?? null,
        creative_result: outcome.creativeResult ?? null,
        evaluation_state: outcome.evaluationState,
        message: outcome.message,
        offer_id: outcome.offerId,
        offer_name: outcome.offerName,
        overall_status: outcome.overallStatus ?? null,
      })),
      result: item.result ?? null,
      status: item.status,
    })),
    notification_status: batch.notificationStatus,
    updated_at: batch.updatedAt,
  };
}

async function findBatch(ctx: MutationCtx | QueryCtx, batchId: string) {
  return ctx.db
    .query("reviewBatches")
    .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
    .unique();
}

export const createBatch = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    items: v.array(v.object({
      fileName: v.string(),
      itemId: v.string(),
      mediaKind: v.string(),
      offerOutcomes: v.optional(v.array(v.object({
        adCopyResult: v.optional(v.string()),
        creativeResult: v.optional(v.string()),
        evaluationState: v.string(),
        message: v.string(),
        offerId: v.string(),
        offerName: v.string(),
        overallStatus: v.optional(v.string()),
      }))),
    })),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await findBatch(ctx, args.batchId);
    if (existing) return publicBatch(existing);
    const now = Date.now();
    const batch = {
      batchId: args.batchId,
      createdAt: now,
      expectedCount: args.items.length,
      items: args.items.map((item) => ({ ...item, message: "", status: "pending" })),
      notificationStatus: "pending",
      notificationAttempts: 0,
      notificationReady: false,
      updatedAt: now,
    };
    await ctx.db.insert("reviewBatches", batch);
    return publicBatch(batch);
  },
});

export const getBatch = query({
  args: { secret: v.string(), batchId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    return batch ? publicBatch(batch) : null;
  },
});

export const updateItemStatus = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    itemId: v.string(),
    jobId: v.optional(v.string()),
    message: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    const items = batch.items.map((item) => item.itemId === args.itemId ? {
      ...item,
      jobId: args.jobId ?? item.jobId,
      message: args.message,
      status: args.status,
    } : item);
    if (!items.some((item) => item.itemId === args.itemId)) throw new Error("Batch item not found");
    const updatedAt = Date.now();
    const notificationReady = items.every((item) =>
      TERMINAL_BATCH_STATUSES.has(item.status)
    );
    await ctx.db.patch(batch._id, { items, notificationReady, updatedAt });
    return publicBatch({ ...batch, items, updatedAt });
  },
});

export const finishItem = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    itemId: v.string(),
    jobId: v.optional(v.string()),
    message: v.string(),
    offerOutcomes: v.optional(v.array(v.object({
      adCopyResult: v.optional(v.string()),
      creativeResult: v.optional(v.string()),
      evaluationState: v.string(),
      message: v.string(),
      offerId: v.string(),
      offerName: v.string(),
      overallStatus: v.optional(v.string()),
    }))),
    result: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    const items = batch.items.map((item) => item.itemId === args.itemId ? {
      ...item,
      jobId: args.jobId ?? item.jobId,
      message: args.message,
      offerOutcomes: args.offerOutcomes ?? item.offerOutcomes,
      result: args.result ?? item.result,
      status: args.status,
    } : item);
    if (!items.some((item) => item.itemId === args.itemId)) throw new Error("Batch item not found");
    const notificationReady = items.every((item) =>
      TERMINAL_BATCH_STATUSES.has(item.status)
    );
    const shouldNotify = batch.notificationStatus === "pending" && notificationReady;
    const notificationStatus = shouldNotify ? "claimed" : batch.notificationStatus;
    const updatedAt = Date.now();
    const notificationAttempts = shouldNotify
      ? (batch.notificationAttempts ?? 0) + 1
      : batch.notificationAttempts;
    const notificationLeaseExpiresAt = shouldNotify
      ? updatedAt + NOTIFICATION_LEASE_MS
      : batch.notificationLeaseExpiresAt;
    await ctx.db.patch(batch._id, {
      items,
      notificationAttempts,
      notificationLeaseExpiresAt,
      notificationReady,
      notificationStatus,
      updatedAt,
    });
    return {
      batch: publicBatch({ ...batch, items, notificationStatus, updatedAt }),
      shouldNotify,
    };
  },
});

export const markNotification = mutation({
  args: { secret: v.string(), batchId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    const now = Date.now();
    const status = (
      args.status === "failed"
      && (batch.notificationAttempts ?? 0) >= MAX_NOTIFICATION_ATTEMPTS
    ) ? "failed_exhausted" : args.status;
    await ctx.db.patch(batch._id, {
      notificationLeaseExpiresAt: status === "failed"
        ? now + NOTIFICATION_LEASE_MS
        : batch.notificationLeaseExpiresAt,
      notificationStatus: status,
      updatedAt: now,
    });
  },
});

export const claimNotification = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    for (const status of ["pending", "failed", "claimed"]) {
      const candidates = status === "pending"
        ? await ctx.db
            .query("reviewBatches")
            .withIndex("by_notification_ready_status_lease", (q) =>
              q.eq("notificationReady", true).eq("notificationStatus", status)
            )
            .take(1)
        : await ctx.db
        .query("reviewBatches")
        .withIndex("by_notification_ready_status_lease", (q) =>
          q
            .eq("notificationReady", true)
            .eq("notificationStatus", status)
            .lte("notificationLeaseExpiresAt", now)
        )
        .take(1);
      for (const batch of candidates) {
        const attempts = batch.notificationAttempts ?? 0;
        if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
          await ctx.db.patch(batch._id, {
            notificationStatus: "failed_exhausted",
            updatedAt: now,
          });
          continue;
        }
        const notificationAttempts = attempts + 1;
        const notificationLeaseExpiresAt = now + NOTIFICATION_LEASE_MS;
        await ctx.db.patch(batch._id, {
          notificationAttempts,
          notificationLeaseExpiresAt,
          notificationStatus: "claimed",
          updatedAt: now,
        });
        return publicBatch({
          ...batch,
          notificationStatus: "claimed",
          updatedAt: now,
        });
      }
    }
    return null;
  },
});
