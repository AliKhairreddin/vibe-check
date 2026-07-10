import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const statusArgs = {
  batchId: v.optional(v.string()),
  batchItemId: v.optional(v.string()),
  secret: v.string(),
  fileName: v.optional(v.string()),
  fileSize: v.optional(v.number()),
  hasAdCopy: v.optional(v.boolean()),
  hasCreative: v.optional(v.boolean()),
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
  return normalizeResultStatus(status);
}

function normalizeResultStatus(status: unknown) {
  if (status === "green" || status === "yellow" || status === "orange" || status === "red") {
    return status;
  }
  if (status === "pass") return "green";
  if (status === "needs_review") return "orange";
  if (status === "likely_violation") return "red";
  return null;
}

function findingSource(finding: unknown) {
  if (!finding || typeof finding !== "object") return "";
  const source = (finding as { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}

function sourceResultStatus(report: unknown, key: "creative" | "ad_copy") {
  if (!report || typeof report !== "object") return null;
  const sourceResults = (report as { source_results?: unknown }).source_results;
  if (!sourceResults || typeof sourceResults !== "object") return null;
  const result = (sourceResults as Record<string, unknown>)[key];
  if (!result || typeof result !== "object") return null;
  const status = (result as { status?: unknown }).status;
  return normalizeResultStatus(status);
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
  if (!relevant.length) return status ? "green" : null;
  if (relevant.some(
    (finding) =>
      finding &&
      typeof finding === "object" &&
      (finding as { severity?: unknown }).severity === "high"
  )) return "red";
  return relevant.some(
    (finding) =>
      finding &&
      typeof finding === "object" &&
      (finding as { severity?: unknown }).severity === "medium"
  ) ? "orange" : "yellow";
}

function creativeResult(report: unknown, hasCreative: boolean) {
  if (!hasCreative) return null;
  return sourceResultStatus(report, "creative") ?? splitResult(report, (source) => source !== "ad_copy");
}

function adCopyResult(report: unknown, hasAdCopy: boolean) {
  if (!hasAdCopy) return null;
  return sourceResultStatus(report, "ad_copy") ?? splitResult(report, (source) => source === "ad_copy");
}

function publicReview(review: {
  batchId?: string;
  batchItemId?: string;
  createdAt: number;
  fileName: string;
  fileSize?: number;
  hasAdCopy?: boolean;
  hasCreative?: boolean;
  jobId: string;
  message: string;
  progress: number;
  report?: unknown;
  reportReady: boolean;
  status: string;
  sourceCheckedAt?: number;
  sourceFileId?: string;
  sourceKind?: string;
  sourceMessage?: string;
  sourceStatus?: string;
  sourceUrl?: string;
  updatedAt: number;
}) {
  const hasAdCopy = review.hasAdCopy ?? true;
  const hasCreative = review.hasCreative ?? true;
  return {
    ad_copy_result: adCopyResult(review.report, hasAdCopy),
    batch_id: review.batchId ?? null,
    batch_item_id: review.batchItemId ?? null,
    created_at: review.createdAt,
    creative_result: creativeResult(review.report, hasCreative),
    file_name: review.fileName,
    file_size: review.fileSize ?? null,
    has_ad_copy: hasAdCopy,
    has_creative: hasCreative,
    job_id: review.jobId,
    message: review.message,
    overall_status: overallStatus(review.report),
    progress: review.progress,
    report_ready: review.reportReady,
    status: review.status,
    source_checked_at: review.sourceCheckedAt ?? null,
    source_file_id: review.sourceFileId ?? null,
    source_kind: review.sourceKind ?? null,
    source_message: review.sourceMessage ?? "",
    source_status: review.sourceStatus ?? null,
    source_url: review.sourceUrl ?? null,
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
      batchId: args.batchId ?? existing?.batchId,
      batchItemId: args.batchItemId ?? existing?.batchItemId,
      fileName: args.fileName ?? existing?.fileName ?? "",
      fileSize: args.fileSize ?? existing?.fileSize,
      hasAdCopy: args.hasAdCopy ?? existing?.hasAdCopy ?? true,
      hasCreative: args.hasCreative ?? existing?.hasCreative ?? true,
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

export const setSource = mutationGeneric({
  args: {
    secret: v.string(),
    jobId: v.string(),
    checkedAt: v.number(),
    fileId: v.optional(v.string()),
    kind: v.optional(v.string()),
    message: v.string(),
    status: v.string(),
    url: v.optional(v.string()),
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
      sourceCheckedAt: args.checkedAt,
      sourceFileId: args.fileId,
      sourceKind: args.kind,
      sourceMessage: args.message,
      sourceStatus: args.status,
      sourceUrl: args.url,
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
