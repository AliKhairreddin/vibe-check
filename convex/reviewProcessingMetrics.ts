import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const stageValidator = v.object({
  durationMs: v.number(),
  name: v.string(),
  startedOffsetMs: v.number(),
});

const metricFields = {
  completed: v.boolean(),
  errorType: v.optional(v.string()),
  finishedAt: v.number(),
  jobId: v.string(),
  mediaKind: v.string(),
  queueWaitMs: v.optional(v.number()),
  stages: v.array(stageValidator),
  startedAt: v.number(),
  totalMs: v.number(),
};
const metricValidator = v.object(metricFields);

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

export const save = mutation({
  args: {
    ...metricFields,
    secret: v.string(),
  },
  returns: v.object({ jobId: v.string() }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (args.stages.length > 40) {
      throw new Error("At most 40 processing stages can be saved per review");
    }
    const { secret: _secret, ...metric } = args;
    const existing = await ctx.db
      .query("reviewProcessingMetrics")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...metric, updatedAt: now });
    } else {
      await ctx.db.insert("reviewProcessingMetrics", {
        ...metric,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { jobId: args.jobId };
  },
});

export const recent = query({
  args: {
    limit: v.optional(v.number()),
    secret: v.string(),
  },
  returns: v.array(metricValidator),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), 200));
    const metrics = await ctx.db
      .query("reviewProcessingMetrics")
      .withIndex("by_started_at")
      .order("desc")
      .take(limit);
    return metrics.map(({
      _id: _id,
      _creationTime: _creationTime,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...metric
    }) => metric);
  },
});
