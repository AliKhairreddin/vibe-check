import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type BatchItem = {
  fileName: string;
  itemId: string;
  jobId?: string;
  mediaKind: string;
  message: string;
  result?: string;
  status: string;
};

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

export const createBatch = mutationGeneric({
  args: {
    secret: v.string(),
    batchId: v.string(),
    items: v.array(v.object({
      fileName: v.string(),
      itemId: v.string(),
      mediaKind: v.string(),
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
      updatedAt: now,
    };
    await ctx.db.insert("reviewBatches", batch);
    return publicBatch(batch);
  },
});

export const getBatch = queryGeneric({
  args: { secret: v.string(), batchId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    return batch ? publicBatch(batch) : null;
  },
});

export const updateItemStatus = mutationGeneric({
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
    await ctx.db.patch(batch._id, { items, updatedAt });
    return publicBatch({ ...batch, items, updatedAt });
  },
});

export const finishItem = mutationGeneric({
  args: {
    secret: v.string(),
    batchId: v.string(),
    itemId: v.string(),
    jobId: v.optional(v.string()),
    message: v.string(),
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
      result: args.result ?? item.result,
      status: args.status,
    } : item);
    if (!items.some((item) => item.itemId === args.itemId)) throw new Error("Batch item not found");
    const terminal = new Set(["complete", "failed", "upload_failed"]);
    const shouldNotify = batch.notificationStatus === "pending" && items.every((item) => terminal.has(item.status));
    const notificationStatus = shouldNotify ? "claimed" : batch.notificationStatus;
    const updatedAt = Date.now();
    await ctx.db.patch(batch._id, { items, notificationStatus, updatedAt });
    return {
      batch: publicBatch({ ...batch, items, notificationStatus, updatedAt }),
      shouldNotify,
    };
  },
});

export const markNotification = mutationGeneric({
  args: { secret: v.string(), batchId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    await ctx.db.patch(batch._id, {
      notificationStatus: args.status,
      updatedAt: Date.now(),
    });
  },
});
