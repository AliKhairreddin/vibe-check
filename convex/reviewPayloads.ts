import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

export const generateUploadUrl = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return ctx.storage.generateUploadUrl();
  },
});

export const save = mutation({
  args: {
    secret: v.string(),
    jobId: v.string(),
    manifestStorageId: v.id("_storage"),
    mediaStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("reviewPayloads")
      .withIndex("by_job_id", (query) => query.eq("jobId", args.jobId))
      .unique();
    const now = Date.now();
    const value = {
      jobId: args.jobId,
      manifestStorageId: args.manifestStorageId,
      mediaStorageId: args.mediaStorageId,
      updatedAt: now,
    };
    if (existing) {
      if (existing.manifestStorageId !== args.manifestStorageId) {
        await ctx.storage.delete(existing.manifestStorageId);
      }
      if (
        existing.mediaStorageId
        && existing.mediaStorageId !== args.mediaStorageId
      ) {
        await ctx.storage.delete(existing.mediaStorageId);
      }
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("reviewPayloads", { ...value, createdAt: now });
    }
    return { jobId: args.jobId };
  },
});

export const listForJobs = query({
  args: {
    secret: v.string(),
    jobIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const jobIds = [...new Set(args.jobIds)].slice(0, 100);
    const payloads = await Promise.all(jobIds.map(async (jobId) => {
      const payload = await ctx.db
        .query("reviewPayloads")
        .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
        .unique();
      if (!payload) return null;
      const [manifestUrl, mediaUrl] = await Promise.all([
        ctx.storage.getUrl(payload.manifestStorageId),
        payload.mediaStorageId ? ctx.storage.getUrl(payload.mediaStorageId) : null,
      ]);
      if (!manifestUrl) return null;
      return {
        jobId,
        manifestUrl,
        mediaUrl,
      };
    }));
    return payloads.filter((payload) => payload !== null);
  },
});

export const remove = mutation({
  args: {
    secret: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const payload = await ctx.db
      .query("reviewPayloads")
      .withIndex("by_job_id", (query) => query.eq("jobId", args.jobId))
      .unique();
    if (!payload) return { removed: false };
    await ctx.storage.delete(payload.manifestStorageId);
    if (payload.mediaStorageId) await ctx.storage.delete(payload.mediaStorageId);
    await ctx.db.delete(payload._id);
    return { removed: true };
  },
});

export const removeFiles = mutation({
  args: {
    secret: v.string(),
    storageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    for (const storageId of [...new Set(args.storageIds)].slice(0, 10)) {
      await ctx.storage.delete(storageId);
    }
  },
});
