import { paginationOptsValidator } from "convex/server";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { getConvexSize, v, type Value } from "convex/values";

type ResultStatus = "green" | "yellow" | "orange" | "red";
const MAX_OFFER_RESULT_BYTES = 800_000;
const TERMINAL_BATCH_STATUSES = new Set(["complete", "failed", "upload_failed"]);

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
  automationRunId: v.optional(v.string()),
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

const KNOWN_OFFERS = [
  { offer_id: "acp", offer_name: "ACP" },
  { offer_id: "kissterra", offer_name: "Kissterra" },
  { offer_id: "lead-economy", offer_name: "Lead Economy" },
  { offer_id: "smart-financial", offer_name: "Smart Financial" },
];

function publicOfferOutcomes(report: unknown, hasCreative: boolean, hasAdCopy: boolean) {
  // No report means no verdict snapshot. Returning an empty list lets the UI
  // use the immutable offerIds metadata to render active offers as Not ready,
  // while failed jobs remain N/A instead of looking evaluated.
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  if (report && typeof report === "object" && !Array.isArray(report)) {
    const values = (report as { offer_outcomes?: unknown }).offer_outcomes;
    if (Array.isArray(values)) {
      const outcomes = values.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const source = value as Record<string, unknown>;
        const offerId = normalizeOfferId(source.offer_id ?? source.offerId);
        if (!offerId) return [];
        const state = source.evaluation_state ?? source.evaluationState;
        if (state !== "evaluated" && state !== "disabled" && state !== "missing_guidelines") {
          return [];
        }
        return [{
          ad_copy_result: normalizeResultStatus(source.ad_copy_result ?? source.adCopyResult),
          creative_result: normalizeResultStatus(source.creative_result ?? source.creativeResult),
          evaluation_state: state,
          message: typeof source.message === "string" ? source.message : "",
          offer_id: offerId,
          offer_name: typeof (source.offer_name ?? source.offerName) === "string"
            ? String(source.offer_name ?? source.offerName)
            : offerId,
          overall_status: normalizeResultStatus(source.overall_status ?? source.overallStatus),
        }];
      });
      if (outcomes.length) return outcomes;
    }
  }

  const primaryOfferId = reportPrimaryOfferId(report) ?? "acp";
  return KNOWN_OFFERS.map((offer) => {
    const evaluated = offer.offer_id === primaryOfferId;
    return {
      ad_copy_result: evaluated ? adCopyResult(report, hasAdCopy) : null,
      creative_result: evaluated ? creativeResult(report, hasCreative) : null,
      evaluation_state: evaluated ? "evaluated" : "disabled",
      message: evaluated ? "" : "Not evaluated for this review.",
      offer_id: offer.offer_id,
      offer_name: offer.offer_name,
      overall_status: evaluated ? overallStatus(report) : null,
    };
  });
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
    offer_outcomes: publicOfferOutcomes(review.report, hasCreative, hasAdCopy),
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
    const jobState = await ctx.db
      .query("automationJobStates")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (args.automationRunId && jobState?.runId !== args.automationRunId) {
      throw new Error("Automation review generation is no longer active");
    }
    const automationRun = jobState
      ? await ctx.db
          .query("automationRuns")
          .withIndex("by_run_id", (q) => q.eq("runId", jobState.runId))
          .unique()
      : null;
    if (
      jobState
      && (
        !automationRun
        || !["running", "queued"].includes(automationRun.status)
        || (automationRun.leaseExpiresAt ?? 0) <= now
      )
    ) {
      throw new Error("Automation review generation is no longer active");
    }
    if (args.automationRunId && !jobState) {
      throw new Error("Automation review claim was not found");
    }
    if (existing?.automationRunId && !jobState) {
      throw new Error("Automation review generation is no longer active");
    }

    const value = {
      automationRunId: jobState?.runId ?? existing?.automationRunId,
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
    const reviewId = existing?._id ?? await ctx.db.insert("reviews", review);
    if (existing) await ctx.db.patch(existing._id, value);
    await syncReviewOfferStats(ctx, review, now);

    if (value.batchId && value.batchItemId) {
      const batch = await ctx.db
        .query("reviewBatches")
        .withIndex("by_batch_id", (q) => q.eq("batchId", value.batchId!))
        .unique();
      if (batch) {
        const items = batch.items.map((item) => item.itemId === value.batchItemId ? {
          ...item,
          jobId: args.jobId,
          message: args.message,
          status: args.status,
        } : item);
        await ctx.db.patch(batch._id, {
          items,
          notificationReady: items.every((item) =>
            TERMINAL_BATCH_STATUSES.has(item.status)
          ),
          updatedAt: now,
        });
      }
    }

    if (jobState && automationRun) {
      await ctx.db.patch(jobState._id, {
        batchId: value.batchId,
        batchItemId: value.batchItemId,
        reviewId,
        status: args.status,
        updatedAt: now,
      });
      if (!["complete", "failed"].includes(args.status)) {
        await ctx.db.patch(automationRun._id, {
          leaseExpiresAt: now + 30 * 60 * 1000,
          updatedAt: now,
        });
        const automation = await ctx.db
          .query("reviewAutomations")
          .withIndex("by_automation_id", (q) => q.eq("automationId", automationRun.automationId))
          .unique();
        if (automation && automation.lastScheduledFor === automationRun.scheduledFor) {
          await ctx.db.patch(automation._id, { lastRunAt: now, updatedAt: now });
        }
      }
    }

    return value;
  },
});

export const setReport = mutation({
  args: {
    automationRunId: v.optional(v.string()),
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
    if (existing.automationRunId) {
      if (args.automationRunId !== existing.automationRunId) {
        throw new Error("Automation review generation is no longer active");
      }
      const jobState = await ctx.db
        .query("automationJobStates")
        .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
        .unique();
      const run = jobState
        ? await ctx.db
            .query("automationRuns")
            .withIndex("by_run_id", (q) => q.eq("runId", jobState.runId))
            .unique()
        : null;
      if (
        !jobState
        || jobState.runId !== existing.automationRunId
        || !run
        || !["running", "queued"].includes(run.status)
        || (run.leaseExpiresAt ?? 0) <= now
      ) {
        throw new Error("Automation review generation is no longer active");
      }
    }
    const { offerReports, parentReport } = splitReportForStorage(args.report);
    const schemaVersion = parentReport && typeof parentReport === "object"
      ? (parentReport as { schema_version?: unknown }).schema_version
      : null;
    if (schemaVersion === 2 && existing.offerIds?.length) {
      const expected = [...new Set(existing.offerIds.map(normalizeOfferId).filter(
        (offerId): offerId is string => Boolean(offerId)
      ))].sort();
      const actual = [...new Set(offerReports.map((offerReport) => offerReport.offerId))].sort();
      if (expected.length !== actual.length || expected.some((offerId, index) => offerId !== actual[index])) {
        throw new Error("Report offer results do not match the review's eligible offer snapshot");
      }
      const primaryOfferId = reportPrimaryOfferId(parentReport);
      if (!primaryOfferId || !expected.includes(primaryOfferId)) {
        throw new Error("Report primary offer is not part of the review's eligible offer snapshot");
      }
    }
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

// Telegram batch notifications only need compact offer verdicts. Reading the
// full report for every item can exceed both Convex read limits and the batch
// notification lease, so hydrate up to 100 summaries from the small projection.
export const getBatchOfferSummaries = query({
  args: {
    secret: v.string(),
    jobIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const jobIds = [...new Set(args.jobIds)].slice(0, 100);
    const summaries = [];
    for (const jobId of jobIds) {
      const rows = await ctx.db
        .query("reviewOfferStats")
        .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
        .collect();
      const offerResults = rows.flatMap((row) => row.resultStatus ? [{
        evaluation_state: "evaluated",
        offer_id: row.offerId,
        overall_status: row.resultStatus,
      }] : []);
      if (offerResults.length) {
        summaries.push({ job_id: jobId, offer_results: offerResults });
      }
    }
    return summaries;
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

// Seed the compact projection for reviews written before multi-offer support.
// The durable cursor makes startup/tick calls cheap and safely resumable.
export const backfillOfferStats = mutation({
  args: {
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const migrationKey = "reviewOfferStatsV1";
    const state = await ctx.db
      .query("maintenanceState")
      .withIndex("by_key", (query) => query.eq("key", migrationKey))
      .unique();
    if (state?.complete) {
      return {
        continueCursor: state.cursor ?? "",
        isDone: true,
        processed: 0,
      };
    }
    const result = await ctx.db
      .query("reviews")
      .withIndex("by_created_at")
      .paginate({
        cursor: state?.cursor ?? null,
        numItems: 25,
        maximumBytesRead: 8_000_000,
        maximumRowsRead: 50,
      });
    const updatedAt = Date.now();
    for (const review of result.page) {
      await syncReviewOfferStats(ctx, review, updatedAt);
    }
    const statePatch = {
      complete: result.isDone,
      cursor: result.continueCursor,
      key: migrationKey,
      updatedAt,
    };
    if (state) {
      await ctx.db.patch(state._id, statePatch);
    } else {
      await ctx.db.insert("maintenanceState", statePatch);
    }
    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      processed: result.page.length,
    };
  },
});

export const getStats = query({
  args: {
    secret: v.string(),
    offerId: v.optional(v.string()),
    offerIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const requestedOfferIds = [...new Set(
      (args.offerIds?.length ? args.offerIds : [args.offerId])
        .flatMap((offerId) => {
          const normalized = normalizeOfferId(offerId);
          return normalized ? [normalized] : [];
        })
    )].slice(0, 10);
    if (!requestedOfferIds.length) requestedOfferIds.push("acp");
    const reviewRows = await Promise.all(requestedOfferIds.map((offerId) =>
      ctx.db
        .query("reviewOfferStats")
        .withIndex("by_offer_id_deleted_at", (query) =>
          query.eq("offerId", offerId).eq("deletedAt", undefined)
        )
        .collect()
    ));
    const reviews = reviewRows.flat();

    const outcomes: Record<ResultStatus, number> = {
      green: 0,
      yellow: 0,
      orange: 0,
      red: 0,
    };
    let acceptedOverrides = 0;
    for (const review of reviews) {
      if (review.status !== "complete") continue;
      if (review.resultStatus) outcomes[review.resultStatus] += 1;
      if (review.internalDisposition === "accepted_with_override") {
        acceptedOverrides += 1;
      }
    }

    const reviewsByJobId = new Map<string, typeof reviews[number]>();
    for (const review of reviews) {
      if (!reviewsByJobId.has(review.jobId)) reviewsByJobId.set(review.jobId, review);
    }
    const uniqueReviews = [...reviewsByJobId.values()];
    const completedReviews = uniqueReviews.filter((review) => review.status === "complete").length;
    const failedReviews = uniqueReviews.filter((review) => review.status === "failed").length;
    const creativeReviews = uniqueReviews.filter((review) => review.hasCreative ?? true).length;
    const copyOnlyReviews = uniqueReviews.length - creativeReviews;

    return {
      accepted_overrides: acceptedOverrides,
      completed_reviews: completedReviews,
      copy_only_reviews: copyOnlyReviews,
      creative_reviews: creativeReviews,
      failed_reviews: failedReviews,
      in_progress_reviews: uniqueReviews.length - completedReviews - failedReviews,
      offer_id: requestedOfferIds.length === 1 ? requestedOfferIds[0] : "all",
      offer_ids: requestedOfferIds,
      outcomes,
      total_reviews: uniqueReviews.length,
    };
  },
});
