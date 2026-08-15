import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

const storedFrameValidator = v.object({
  filename: v.string(),
  storageId: v.id("_storage"),
  timestamp: v.optional(v.number()),
});

const publicFrameValidator = v.object({
  filename: v.string(),
  timestamp: v.union(v.number(), v.null()),
  url: v.string(),
});

export const generateUploadUrl = mutation({
  args: { secret: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return ctx.storage.generateUploadUrl();
  },
});

export const save = mutation({
  args: {
    secret: v.string(),
    jobId: v.string(),
    frames: v.array(storedFrameValidator),
  },
  returns: v.object({ jobId: v.string(), frameCount: v.number() }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (args.frames.length > 30) {
      throw new Error("At most 30 evidence frames can be saved per review");
    }
    const filenames = new Set<string>();
    for (const frame of args.frames) {
      if (!frame.filename || filenames.has(frame.filename)) {
        throw new Error("Evidence frame filenames must be unique");
      }
      filenames.add(frame.filename);
    }
    const existing = await ctx.db
      .query("reviewEvidenceFrames")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    const now = Date.now();
    if (existing) {
      const retainedStorageIds = new Set(args.frames.map((frame) => frame.storageId));
      for (const frame of existing.frames) {
        if (!retainedStorageIds.has(frame.storageId)) {
          await ctx.storage.delete(frame.storageId);
        }
      }
      await ctx.db.patch(existing._id, { frames: args.frames, updatedAt: now });
    } else {
      await ctx.db.insert("reviewEvidenceFrames", {
        createdAt: now,
        frames: args.frames,
        jobId: args.jobId,
        updatedAt: now,
      });
    }
    return { jobId: args.jobId, frameCount: args.frames.length };
  },
});

export const list = query({
  args: { secret: v.string(), jobId: v.string() },
  returns: v.array(publicFrameValidator),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const evidence = await ctx.db
      .query("reviewEvidenceFrames")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!evidence) return [];
    const frames = await Promise.all(evidence.frames.map(async (frame) => {
      const url = await ctx.storage.getUrl(frame.storageId);
      return url ? [{
        filename: frame.filename,
        timestamp: frame.timestamp ?? null,
        url,
      }] : [];
    }));
    return frames.flat();
  },
});

export const remove = mutation({
  args: { secret: v.string(), jobId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const evidence = await ctx.db
      .query("reviewEvidenceFrames")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!evidence) return { removed: false };
    for (const frame of evidence.frames) {
      await ctx.storage.delete(frame.storageId);
    }
    await ctx.db.delete(evidence._id);
    return { removed: true };
  },
});

export const removeFiles = mutation({
  args: {
    secret: v.string(),
    storageIds: v.array(v.id("_storage")),
  },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const storageIds = [...new Set(args.storageIds)].slice(0, 30);
    for (const storageId of storageIds) {
      await ctx.storage.delete(storageId);
    }
    return { removed: storageIds.length };
  },
});
