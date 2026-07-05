import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const statusArgs = {
  secret: v.string(),
  fileName: v.optional(v.string()),
  hasAdCopy: v.optional(v.boolean()),
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

function overallStatus(report: unknown) {
  if (!report || typeof report !== "object") return null;
  const status = (report as { overall_status?: unknown }).overall_status;
  return status === "pass" ||
    status === "needs_review" ||
    status === "likely_violation"
    ? status
    : null;
}

function findingSource(finding: unknown) {
  if (!finding || typeof finding !== "object") return "";
  const source = (finding as { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}

function splitResult(
  report: unknown,
  sourceMatches: (source: string) => boolean
) {
  const status = overallStatus(report);
  if (!report || typeof report !== "object") return null;
  const findings = (report as { findings?: unknown }).findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    return status;
  }

  const relevant = findings.filter((finding) => sourceMatches(findingSource(finding)));
  if (!relevant.length) return status ? "pass" : null;
  return relevant.some(
    (finding) =>
      finding &&
      typeof finding === "object" &&
      (finding as { severity?: unknown }).severity === "high"
  )
    ? "likely_violation"
    : "needs_review";
}

function creativeResult(report: unknown) {
  return splitResult(report, (source) => source !== "ad_copy");
}

function adCopyResult(report: unknown, hasAdCopy: boolean) {
  if (!hasAdCopy) return null;
  return splitResult(report, (source) => source === "ad_copy");
}

function publicReview(review: {
  createdAt: number;
  fileName: string;
  hasAdCopy?: boolean;
  jobId: string;
  message: string;
  progress: number;
  report?: unknown;
  reportReady: boolean;
  status: string;
  updatedAt: number;
}) {
  const hasAdCopy = review.hasAdCopy ?? true;
  return {
    ad_copy_result: adCopyResult(review.report, hasAdCopy),
    created_at: review.createdAt,
    creative_result: creativeResult(review.report),
    file_name: review.fileName,
    has_ad_copy: hasAdCopy,
    job_id: review.jobId,
    message: review.message,
    overall_status: overallStatus(review.report),
    progress: review.progress,
    report_ready: review.reportReady,
    status: review.status,
    updated_at: review.updatedAt,
  };
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
      hasAdCopy: args.hasAdCopy ?? existing?.hasAdCopy ?? true,
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
    return publicReview(review);
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

export const listRecent = queryGeneric({
  args: {
    secret: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(args.limit, 100));
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_created_at")
      .order("desc")
      .take(limit);
    return reviews.map(publicReview);
  },
});
