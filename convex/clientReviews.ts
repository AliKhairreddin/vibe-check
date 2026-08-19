import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type ResultStatus = "green" | "yellow" | "red";

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function normalizeResultStatus(value: unknown): ResultStatus | null {
  if (value === "green" || value === "yellow" || value === "red") return value;
  if (value === "pass") return "green";
  if (value === "amber" || value === "orange" || value === "needs_review") return "yellow";
  if (value === "likely_violation") return "red";
  return null;
}

const decisionValueValidator = v.union(v.literal("approved"), v.literal("disapproved"));
const decisionValidator = v.object({
  decidedAt: v.number(),
  decision: decisionValueValidator,
});
const previewValidator = v.object({
  findingCount: v.number(),
  findings: v.array(v.string()),
  googleDriveUrl: v.union(v.string(), v.null()),
  summary: v.string(),
});
const reviewValidator = v.object({
  aiStatus: v.union(v.literal("green"), v.literal("yellow"), v.literal("red")),
  batchCreatedAt: v.number(),
  batchId: v.union(v.string(), v.null()),
  batchSourceLabel: v.union(v.string(), v.null()),
  createdAt: v.number(),
  decision: v.union(decisionValidator, v.null()),
  fileName: v.string(),
  issueSummary: v.union(v.string(), v.null()),
  jobId: v.string(),
  mediaKind: v.union(v.literal("video"), v.literal("image"), v.literal("copy_only")),
  preview: previewValidator,
});

function mediaKind(fileName: string, hasCreative: boolean | undefined) {
  if (hasCreative === false) return "copy_only" as const;
  const normalized = fileName.toLowerCase();
  return (
    normalized.endsWith(".jpg")
    || normalized.endsWith(".jpeg")
    || normalized.endsWith(".png")
    || normalized.endsWith(".webp")
  ) ? "image" as const : "video" as const;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function offerReport(value: unknown, offerId: string): Record<string, unknown> | null {
  const report = objectValue(value);
  if (!report) return null;
  const offerResults = Array.isArray(report.offer_results) ? report.offer_results : [];
  const matching = offerResults
    .map(objectValue)
    .find((candidate) => candidate?.offer_id === offerId);
  if (matching) return matching;
  if (report.offer_id === offerId) return report;
  const primaryOfferId = report.primary_offer_id ?? report.offer_id ?? "acp";
  return primaryOfferId === offerId ? report : null;
}

function issueSummary(value: unknown, status: ResultStatus): string | null {
  if (status === "green") return null;
  const report = objectValue(value);
  const summary = typeof report?.summary === "string" ? report.summary.trim() : "";
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const firstFinding = objectValue(findings[0]);
  const evidence = typeof firstFinding?.evidence === "string" ? firstFinding.evidence.trim() : "";
  const text = summary || evidence;
  if (!text) return status === "yellow" ? "Needs review" : "Critical issue";
  return text.length > 300 ? `${text.slice(0, 297).trimEnd()}...` : text;
}

function reportPreview(value: unknown, status: ResultStatus) {
  const report = objectValue(value);
  const rawFindings = Array.isArray(report?.findings) ? report.findings : [];
  const findings = rawFindings.flatMap((finding) => {
    const evidence = objectValue(finding)?.evidence;
    return typeof evidence === "string" && evidence.trim()
      ? [evidence.trim().slice(0, 400)]
      : [];
  }).slice(0, 3);
  const rawSummary = typeof report?.summary === "string" ? report.summary.trim() : "";
  return {
    findingCount: rawFindings.length,
    findings,
    summary: (rawSummary || (
      status === "green"
        ? "No policy issues were identified."
        : status === "red"
          ? "Critical issue"
          : "Needs review"
    )).slice(0, 600),
  };
}

function driveUrl(value: {
  sourceKind?: string;
  sourceStatus?: string;
  sourceUrl?: string;
}) {
  return value.sourceKind === "google_drive_file"
    && value.sourceStatus === "linked"
    && value.sourceUrl
    ? value.sourceUrl
    : null;
}

export const list = query({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    limit: v.number(),
  },
  returns: v.array(reviewValidator),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(args.limit, 1000));
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_offer_id_and_deleted_at_and_status_and_created_at", (q) =>
        q
          .eq("offerId", args.offerId)
          .eq("deletedAt", undefined)
          .eq("status", "complete")
      )
      .order("desc")
      .take(limit);
    const [legacyReviews, legacyReports, decisions] = await Promise.all([
      Promise.all(stats.map((stat) => stat.previewReady && stat.fileName !== undefined
        ? null
        : ctx.db
            .query("reviews")
            .withIndex("by_job_id", (q) => q.eq("jobId", stat.jobId))
            .unique())),
      Promise.all(stats.map((stat) => stat.previewReady
        ? null
        : ctx.db
            .query("reviewOfferReports")
            .withIndex("by_job_id_offer_id", (q) =>
              q.eq("jobId", stat.jobId).eq("offerId", args.offerId)
            )
            .unique())),
      ctx.db
        .query("clientReviewDecisions")
        .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
          q.eq("clientId", args.clientId).eq("offerId", args.offerId)
        )
        .take(1000),
    ]);
    const decisionByJobId = new Map(decisions.map((decision) => [decision.jobId, decision]));
    const batchIds = [...new Set(stats.flatMap((stat, index) => {
      const batchId = stat.batchId ?? legacyReviews[index]?.batchId;
      return batchId ? [batchId] : [];
    }))];
    const batches = await Promise.all(batchIds.map((batchId) =>
      ctx.db
        .query("reviewBatches")
        .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
        .unique()
    ));
    const batchById = new Map(batches.flatMap((batch) =>
      batch ? [[batch.batchId, batch] as const] : []
    ));
    return stats.flatMap((stat, index) => {
      const review = legacyReviews[index];
      const aiStatus = normalizeResultStatus(stat.resultStatus);
      const fileName = stat.fileName ?? review?.fileName;
      if (!fileName || review?.deletedAt !== undefined || !aiStatus) return [];
      const decision = decisionByJobId.get(stat.jobId);
      const batchId = stat.batchId ?? review?.batchId ?? null;
      const batch = batchId ? batchById.get(batchId) : null;
      const report = stat.previewReady
        ? null
        : offerReport(legacyReports[index]?.report ?? review?.report, args.offerId);
      const preview = stat.previewReady
        ? {
            findingCount: stat.previewFindingCount ?? 0,
            findings: stat.previewFindings ?? [],
            summary: stat.previewSummary ?? (aiStatus === "green" ? "No policy issues were identified." : "Needs review"),
          }
        : reportPreview(report, aiStatus);
      const googleDriveUrl = driveUrl({
        sourceKind: stat.sourceKind ?? review?.sourceKind,
        sourceStatus: stat.sourceStatus ?? review?.sourceStatus,
        sourceUrl: stat.sourceUrl ?? review?.sourceUrl,
      });
      return [{
        aiStatus,
        batchCreatedAt: batch?.createdAt ?? stat.createdAt,
        batchId,
        batchSourceLabel: batchId
          ? batch?.sourceLabel ?? null
          : null,
        createdAt: stat.createdAt,
        decision: decision ? {
          decidedAt: decision.decidedAt,
          decision: decision.decision,
        } : null,
        fileName,
        issueSummary: aiStatus === "green" ? null : preview.summary.slice(0, 300),
        jobId: stat.jobId,
        mediaKind: mediaKind(fileName, stat.hasCreative),
        preview: { ...preview, googleDriveUrl },
      }];
    });
  },
});

export const getDetail = query({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .take(100);
    const stat = stats.find((candidate) =>
      candidate.offerId === args.offerId
      && candidate.deletedAt === undefined
      && candidate.status === "complete"
    );
    if (!stat) return null;
    const [review, storedReport, decision, evidence] = await Promise.all([
      ctx.db
        .query("reviews")
        .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
        .unique(),
      ctx.db
        .query("reviewOfferReports")
        .withIndex("by_job_id_offer_id", (q) =>
          q.eq("jobId", args.jobId).eq("offerId", args.offerId)
        )
        .unique(),
      ctx.db
        .query("clientReviewDecisions")
        .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
          q
            .eq("clientId", args.clientId)
            .eq("offerId", args.offerId)
            .eq("jobId", args.jobId)
        )
        .unique(),
      ctx.db
        .query("reviewEvidenceFrames")
        .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
        .unique(),
    ]);
    if (!review || review.deletedAt !== undefined) return null;
    const report = objectValue(storedReport?.report) ?? offerReport(review.report, args.offerId);
    const aiStatus = normalizeResultStatus(stat.resultStatus);
    if (!report || !aiStatus) return null;
    const batch = review.batchId
      ? await ctx.db
          .query("reviewBatches")
          .withIndex("by_batch_id", (q) => q.eq("batchId", review.batchId!))
          .unique()
      : null;
    const preview = reportPreview(report, aiStatus);
    return {
      evidenceFrames: (evidence?.frames ?? []).map((frame) => ({
        filename: frame.filename,
        timestamp: frame.timestamp ?? null,
      })),
      googleDriveUrl: driveUrl(review),
      report,
      review: {
        aiStatus,
        batchCreatedAt: batch?.createdAt ?? review.createdAt,
        batchId: review.batchId ?? null,
        batchSourceLabel: review.batchId ? batch?.sourceLabel ?? null : null,
        createdAt: review.createdAt,
        decision: decision ? {
          decidedAt: decision.decidedAt,
          decision: decision.decision,
        } : null,
        fileName: review.fileName,
        issueSummary: issueSummary(report, aiStatus),
        jobId: review.jobId,
        mediaKind: mediaKind(review.fileName, review.hasCreative),
        preview: { ...preview, googleDriveUrl: driveUrl(review) },
      },
    };
  },
});

export const hasReview = query({
  args: {
    secret: v.string(),
    offerId: v.string(),
    jobId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .take(100);
    return stats.some((stat) =>
      stat.offerId === args.offerId
      && stat.deletedAt === undefined
      && stat.status === "complete"
    );
  },
});

export const getReport = query({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .take(100);
    if (!stats.some((stat) => stat.offerId === args.offerId && stat.deletedAt === undefined)) {
      return null;
    }
    const stored = await ctx.db
      .query("reviewOfferReports")
      .withIndex("by_job_id_offer_id", (q) =>
        q.eq("jobId", args.jobId).eq("offerId", args.offerId)
      )
      .unique();
    if (stored) return stored.report;
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!review || review.deletedAt !== undefined) return null;
    const report = review.report;
    if (!report || typeof report !== "object" || Array.isArray(report)) return null;
    const primaryOfferId = (report as { primary_offer_id?: unknown; offer_id?: unknown }).primary_offer_id
      ?? (report as { offer_id?: unknown }).offer_id
      ?? "acp";
    return primaryOfferId === args.offerId ? report : null;
  },
});

export const decide = mutation({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
    decision: decisionValueValidator,
  },
  returns: decisionValidator,
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .take(100);
    if (!stats.some((stat) =>
      stat.offerId === args.offerId
      && stat.deletedAt === undefined
      && stat.status === "complete"
    )) {
      throw new Error("Client review is unavailable");
    }
    const existing = await ctx.db
      .query("clientReviewDecisions")
      .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
        q
          .eq("clientId", args.clientId)
          .eq("offerId", args.offerId)
          .eq("jobId", args.jobId)
      )
      .unique();
    const now = Date.now();
    const value = {
      clientId: args.clientId,
      decidedAt: now,
      decision: args.decision,
      jobId: args.jobId,
      offerId: args.offerId,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("clientReviewDecisions", { ...value, createdAt: now });
    }
    return { decidedAt: now, decision: args.decision };
  },
});

export const clearDecision = mutation({
  args: {
    secret: v.string(),
    clientId: v.string(),
    offerId: v.string(),
    jobId: v.string(),
  },
  returns: v.object({ cleared: v.boolean() }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const stats = await ctx.db
      .query("reviewOfferStats")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .take(100);
    if (!stats.some((stat) =>
      stat.offerId === args.offerId
      && stat.deletedAt === undefined
      && stat.status === "complete"
    )) {
      throw new Error("Client review is unavailable");
    }
    const existing = await ctx.db
      .query("clientReviewDecisions")
      .withIndex("by_client_id_and_offer_id_and_job_id", (q) =>
        q
          .eq("clientId", args.clientId)
          .eq("offerId", args.offerId)
          .eq("jobId", args.jobId)
      )
      .unique();
    if (!existing) return { cleared: false };
    await ctx.db.delete(existing._id);
    return { cleared: true };
  },
});
