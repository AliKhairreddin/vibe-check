import { paginationOptsValidator } from "convex/server";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { getConvexSize, v, type Value } from "convex/values";

type ResultStatus = "green" | "yellow" | "orange" | "red";
const MAX_OFFER_RESULT_BYTES = 800_000;

type OfferResultEntry = {
  internalDisposition: string | null;
  offerId: string;
  status: ResultStatus | null;
};

type ReviewForStats = {
  createdAt: number;
  deletedAt?: number;
  hasCreative?: boolean;
  jobId: string;
  offerIds?: string[];
  primaryOfferId?: string;
  report?: unknown;
  status: string;
};

type OfferReportForStorage = {
  offerId: string;
  position: number;
  report: Record<string, unknown>;
};

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
  offerIds: v.optional(v.array(v.string())),
  primaryOfferId: v.optional(v.string()),
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

function overallStatus(report: unknown): ResultStatus | null {
  if (!report || typeof report !== "object") return null;
  const status = (report as { overall_status?: unknown }).overall_status;
  return normalizeResultStatus(status);
}

function normalizeResultStatus(status: unknown): ResultStatus | null {
  if (status === "green" || status === "yellow" || status === "orange" || status === "red") {
    return status;
  }
  if (status === "pass") return "green";
  if (status === "needs_review") return "orange";
  if (status === "likely_violation") return "red";
  return null;
}

function normalizeOfferId(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLocaleLowerCase()
    : null;
}

function reportPrimaryOfferId(report: unknown) {
  if (!report || typeof report !== "object") return null;
  return normalizeOfferId((report as { primary_offer_id?: unknown }).primary_offer_id);
}

function assertOfferReportSize(value: unknown, label: string) {
  const size = getConvexSize(value as Value);
  if (size > MAX_OFFER_RESULT_BYTES) {
    throw new Error(
      `${label} is ${size.toLocaleString()} UTF-8 bytes; reduce report detail to ${MAX_OFFER_RESULT_BYTES.toLocaleString()} bytes or fewer.`
    );
  }
}

function splitReportForStorage(report: unknown) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    assertOfferReportSize(report, "Compliance report");
    return { offerReports: [] as OfferReportForStorage[], parentReport: report };
  }

  const source = report as Record<string, unknown>;
  if (!("offer_results" in source)) {
    // Reports written before multi-offer support remain byte-for-byte intact.
    assertOfferReportSize(report, "Compliance report");
    return { offerReports: [] as OfferReportForStorage[], parentReport: report };
  }

  const rawResults = source.offer_results;
  const candidates: Array<{ fallbackId?: string; report: unknown }> = Array.isArray(rawResults)
    ? rawResults.map((candidate) => ({ report: candidate }))
    : rawResults && typeof rawResults === "object"
      ? Object.entries(rawResults).map(([fallbackId, candidate]) => ({ fallbackId, report: candidate }))
      : [];
  if (candidates.length > 10) {
    throw new Error("A compliance report can contain at most 10 offer results.");
  }

  const primaryOfferId = reportPrimaryOfferId(report);
  const seen = new Set<string>();
  const offerReports = candidates.map((candidate, position) => {
    if (!candidate.report || typeof candidate.report !== "object" || Array.isArray(candidate.report)) {
      throw new Error(`Offer result ${position + 1} must be an object.`);
    }
    const result = candidate.report as Record<string, unknown>;
    const offerId = normalizeOfferId(
      result.offer_id
      ?? result.offerId
      ?? result.id
      ?? candidate.fallbackId
      ?? (candidates.length === 1 ? primaryOfferId : null)
    );
    if (!offerId) throw new Error(`Offer result ${position + 1} is missing an offer id.`);
    if (seen.has(offerId)) throw new Error(`Duplicate offer result: ${offerId}.`);
    seen.add(offerId);
    assertOfferReportSize(result, `Offer result ${offerId}`);
    return { offerId, position, report: result };
  });

  const { offer_results: _offerResults, ...parentReport } = source;
  assertOfferReportSize(parentReport, "Primary compliance report");
  return { offerReports, parentReport };
}

function offerResultEntries(report: unknown) {
  if (!report || typeof report !== "object") {
    return { entries: [] as OfferResultEntry[], hasContainer: false };
  }

  const offerResults = (report as { offer_results?: unknown }).offer_results;
  const entries: OfferResultEntry[] = [];
  if (Array.isArray(offerResults)) {
    for (const candidate of offerResults) {
      if (!candidate || typeof candidate !== "object") continue;
      const result = candidate as {
        id?: unknown;
        offer_id?: unknown;
        offerId?: unknown;
        internal_disposition?: unknown;
        overall_status?: unknown;
        status?: unknown;
      };
      const offerId = normalizeOfferId(result.offer_id ?? result.offerId ?? result.id);
      if (!offerId) continue;
      entries.push({
        internalDisposition: typeof result.internal_disposition === "string"
          ? result.internal_disposition
          : null,
        offerId,
        status: normalizeResultStatus(result.overall_status ?? result.status),
      });
    }
    return { entries, hasContainer: true };
  }

  if (offerResults && typeof offerResults === "object") {
    for (const [key, candidate] of Object.entries(offerResults)) {
      const result = candidate && typeof candidate === "object"
        ? candidate as {
            id?: unknown;
            offer_id?: unknown;
            offerId?: unknown;
            internal_disposition?: unknown;
            overall_status?: unknown;
            status?: unknown;
          }
        : null;
      const offerId = normalizeOfferId(
        result?.offer_id ?? result?.offerId ?? result?.id ?? key
      );
      if (!offerId) continue;
      entries.push({
        internalDisposition: typeof result?.internal_disposition === "string"
          ? result.internal_disposition
          : null,
        offerId,
        status: normalizeResultStatus(result?.overall_status ?? result?.status ?? candidate),
      });
    }
    return { entries, hasContainer: true };
  }

  return { entries, hasContainer: false };
}

function offerIdsForReview(review: ReviewForStats) {
  const storedOfferIds = [
    ...(review.offerIds ?? []),
    review.primaryOfferId,
  ].flatMap((value) => {
    const normalized = normalizeOfferId(value);
    return normalized ? [normalized] : [];
  });
  if (storedOfferIds.length) return [...new Set(storedOfferIds)];

  const offerResults = offerResultEntries(review.report);
  const reportedOfferIds = offerResults.entries.map((entry) => entry.offerId);
  if (reportedOfferIds.length) return [...new Set(reportedOfferIds)];

  // Reviews created before offer profiles existed used ACP's top-level report fields.
  return [reportPrimaryOfferId(review.report) ?? "acp"];
}

function resultStatusForReview(review: ReviewForStats, requestedOfferId: string | null) {
  const offerResults = offerResultEntries(review.report);
  const offerId = requestedOfferId
    ?? normalizeOfferId(review.primaryOfferId)
    ?? reportPrimaryOfferId(review.report);
  if (offerId) {
    const matched = offerResults.entries.find((entry) => entry.offerId === offerId);
    if (matched) return matched.status;
    if (requestedOfferId && offerResults.hasContainer) return null;
  }

  // Version 2 mirrors the primary result at the top level, while legacy reports are ACP-only.
  return overallStatus(review.report);
}

function internalDispositionForReview(review: ReviewForStats, requestedOfferId: string) {
  const offerResults = offerResultEntries(review.report);
  const matched = offerResults.entries.find((entry) => entry.offerId === requestedOfferId);
  if (matched) return matched.internalDisposition;
  if (offerResults.hasContainer || !review.report || typeof review.report !== "object") {
    return null;
  }
  const disposition = (review.report as { internal_disposition?: unknown }).internal_disposition;
  return typeof disposition === "string" ? disposition : null;
}

async function syncReviewOfferStats(
  ctx: MutationCtx,
  review: ReviewForStats,
  updatedAt: number
) {
  let projectedReview = review;
  if (!offerResultEntries(review.report).hasContainer) {
    const storedReports = await ctx.db
      .query("reviewOfferReports")
      .withIndex("by_job_id", (query) => query.eq("jobId", review.jobId))
      .collect();
    if (storedReports.length && review.report && typeof review.report === "object") {
      projectedReview = {
        ...review,
        report: {
          ...review.report,
          offer_results: storedReports
            .sort((left, right) => left.position - right.position)
            .map((row) => row.report),
        },
      };
    }
  }
  const existingRows = await ctx.db
    .query("reviewOfferStats")
    .withIndex("by_job_id", (query) => query.eq("jobId", review.jobId))
    .collect();
  const rowsByOfferId = new Map(existingRows.map((row) => [row.offerId, row]));
  const activeOfferIds = new Set(offerIdsForReview(projectedReview));

  for (const offerId of activeOfferIds) {
    const resultStatus = resultStatusForReview(projectedReview, offerId) ?? undefined;
    const internalDisposition = internalDispositionForReview(projectedReview, offerId) ?? undefined;
    const value = {
      createdAt: review.createdAt,
      deletedAt: review.deletedAt,
      hasCreative: review.hasCreative ?? true,
      internalDisposition,
      jobId: review.jobId,
      offerId,
      resultStatus,
      status: review.status,
      updatedAt,
    };
    const existing = rowsByOfferId.get(offerId);
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("reviewOfferStats", value);
  }

  // Offer selection is immutable in normal operation, but deleting stale rows
  // keeps the compact projection correct if an old caller repairs metadata.
  for (const row of existingRows) {
    if (!activeOfferIds.has(row.offerId)) await ctx.db.delete(row._id);
  }
}

async function replaceOfferReports(
  ctx: MutationCtx,
  jobId: string,
  offerReports: OfferReportForStorage[],
  updatedAt: number
) {
  const existingRows = await ctx.db
    .query("reviewOfferReports")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .collect();
  const rowsByOfferId = new Map(existingRows.map((row) => [row.offerId, row]));
  const retainedIds = new Set<string>();

  for (const offerReport of offerReports) {
    retainedIds.add(offerReport.offerId);
    const existing = rowsByOfferId.get(offerReport.offerId);
    const value = {
      jobId,
      offerId: offerReport.offerId,
      position: offerReport.position,
      report: offerReport.report,
      updatedAt,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("reviewOfferReports", { ...value, createdAt: updatedAt });
  }

  for (const row of existingRows) {
    if (!retainedIds.has(row.offerId)) await ctx.db.delete(row._id);
  }
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
  offerIds?: string[];
  primaryOfferId?: string;
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
    offer_ids: review.offerIds ?? ["acp"],
    overall_status: overallStatus(review.report),
    primary_offer_id: review.primaryOfferId ?? "acp",
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

export const upsertStatus = mutation({
  args: statusArgs,
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (existing?.deletedAt !== undefined) {
      throw new Error("Review job has been deleted");
    }

    const value = {
      batchId: args.batchId ?? existing?.batchId,
      batchItemId: args.batchItemId ?? existing?.batchItemId,
      fileName: args.fileName ?? existing?.fileName ?? "",
      fileSize: args.fileSize ?? existing?.fileSize,
      hasAdCopy: args.hasAdCopy ?? existing?.hasAdCopy ?? true,
      hasCreative: args.hasCreative ?? existing?.hasCreative ?? true,
      jobId: args.jobId,
      message: args.message,
      offerIds: args.offerIds ?? existing?.offerIds,
      primaryOfferId: args.primaryOfferId ?? existing?.primaryOfferId,
      progress: args.progress,
      reportReady: args.reportReady,
      status: args.status,
      updatedAt: now,
    };

    const review = {
      ...existing,
      ...value,
      createdAt: existing?.createdAt ?? now,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("reviews", review);
    await syncReviewOfferStats(ctx, review, now);

    return value;
  },
});

export const setReport = mutation({
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
    if (!existing || existing.deletedAt !== undefined) {
      throw new Error("Review job not found");
    }
    const now = Date.now();
    const { offerReports, parentReport } = splitReportForStorage(args.report);
    const value = {
      report: parentReport,
      reportReady: true,
      updatedAt: now,
    };
    await replaceOfferReports(ctx, args.jobId, offerReports, now);
    await ctx.db.patch(existing._id, value);
    await syncReviewOfferStats(
      ctx,
      { ...existing, ...value, report: args.report },
      now
    );
  },
});

export const setSource = mutation({
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
    if (!existing || existing.deletedAt !== undefined) {
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

export const getStatus = query({
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
    if (!review || review.deletedAt !== undefined) return null;
    return publicReview(review);
  },
});

export const getReport = query({
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
    if (!review || review.deletedAt !== undefined) return null;
    const report = review.report ?? null;
    if (!report || typeof report !== "object" || Array.isArray(report)) return report;
    const offerReports = await ctx.db
      .query("reviewOfferReports")
      .withIndex("by_job_id", (query) => query.eq("jobId", args.jobId))
      .collect();
    if (!offerReports.length) return report;
    return {
      ...report,
      offer_results: offerReports
        .sort((left, right) => left.position - right.position || left.offerId.localeCompare(right.offerId))
        .map((row) => row.report),
    };
  },
});

export const softDelete = mutation({
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
    if (!review) throw new Error("Review job not found");
    if (review.deletedAt !== undefined) {
      await syncReviewOfferStats(ctx, review, review.deletedAt);
      return { deleted_at: review.deletedAt, job_id: review.jobId };
    }
    if (review.status !== "complete" && review.status !== "failed") {
      throw new Error("Only complete or failed review jobs can be deleted");
    }

    const deletedAt = Date.now();
    await ctx.db.patch(review._id, { deletedAt, updatedAt: deletedAt });
    await syncReviewOfferStats(
      ctx,
      { ...review, deletedAt },
      deletedAt
    );
    return { deleted_at: deletedAt, job_id: review.jobId };
  },
});

export const listRecent = query({
  args: {
    secret: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(args.limit, 100));
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_deleted_at_created_at", (q) => q.eq("deletedAt", undefined))
      .order("desc")
      .take(limit);
    return reviews.map(publicReview);
  },
});

export const listPage = query({
  args: {
    secret: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const result = await ctx.db
      .query("reviews")
      .withIndex("by_deleted_at_created_at", (q) => q.eq("deletedAt", undefined))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicReview),
    };
  },
});

// Run this in bounded pages after deploying the compact projection to seed
// rows for reviews written by older versions of the application.
export const backfillOfferStats = mutation({
  args: {
    secret: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const result = await ctx.db
      .query("reviews")
      .withIndex("by_created_at")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(args.paginationOpts.numItems, 50)),
        maximumBytesRead: Math.min(args.paginationOpts.maximumBytesRead ?? 8_000_000, 8_000_000),
        maximumRowsRead: Math.min(args.paginationOpts.maximumRowsRead ?? 50, 50),
      });
    for (const review of result.page) {
      await syncReviewOfferStats(ctx, review, Date.now());
    }
    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      pageStatus: result.pageStatus ?? null,
      processed: result.page.length,
      splitCursor: result.splitCursor ?? null,
    };
  },
});

export const getStats = query({
  args: {
    secret: v.string(),
    offerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const requestedOfferId = normalizeOfferId(args.offerId) ?? "acp";
    const reviews = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_offer_id_deleted_at", (query) =>
        query.eq("offerId", requestedOfferId).eq("deletedAt", undefined)
      )
      .collect();

    const outcomes: Record<ResultStatus, number> = {
      green: 0,
      yellow: 0,
      orange: 0,
      red: 0,
    };
    let acceptedOverrides = 0;
    let completedReviews = 0;
    let failedReviews = 0;
    let creativeReviews = 0;
    let copyOnlyReviews = 0;

    for (const review of reviews) {
      if (review.hasCreative ?? true) creativeReviews += 1;
      else copyOnlyReviews += 1;
      if (review.status === "failed") {
        failedReviews += 1;
        continue;
      }
      if (review.status !== "complete") continue;

      completedReviews += 1;
      if (review.resultStatus) outcomes[review.resultStatus] += 1;
      if (review.internalDisposition === "accepted_with_override") {
        acceptedOverrides += 1;
      }
    }

    return {
      accepted_overrides: acceptedOverrides,
      completed_reviews: completedReviews,
      copy_only_reviews: copyOnlyReviews,
      creative_reviews: creativeReviews,
      failed_reviews: failedReviews,
      in_progress_reviews: reviews.length - completedReviews - failedReviews,
      offer_id: requestedOfferId,
      outcomes,
      total_reviews: reviews.length,
    };
  },
});
