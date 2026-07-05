import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const statusArgs = {
  secret: v.string(),
  fileName: v.optional(v.string()),
  jobId: v.string(),
  message: v.string(),
  progress: v.number(),
  reportReady: v.boolean(),
  status: v.string(),
};

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized");
  }
}

export const upsertStatus = mutationGeneric({
  args: statusArgs,
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();

    const value = {
      fileName: args.fileName ?? existing?.fileName ?? "",
      jobId: args.jobId,
      message: args.message,
      progress: args.progress,
      reportReady: args.reportReady,
      status: args.status,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("reviews", { ...value, createdAt: now });
    }

    return value;
  },
});

export const setReport = mutationGeneric({
  args: {
    secret: v.string(),
    jobId: v.string(),
    report: v.any(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!existing) {
      throw new Error("Review job not found");
    }
    await ctx.db.patch(existing._id, {
      report: args.report,
      reportReady: true,
      updatedAt: Date.now(),
    });
  },
});

export const getStatus = queryGeneric({
  args: {
    secret: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!review) return null;
    return {
      file_name: review.fileName,
      job_id: review.jobId,
      message: review.message,
      progress: review.progress,
      report_ready: review.reportReady,
      status: review.status,
    };
  },
});

export const getReport = queryGeneric({
  args: {
    secret: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    return review?.report ?? null;
  },
});
