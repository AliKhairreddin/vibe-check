import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel";
import { assetCard, assertApiLease, executionStatus } from "./apiJobState.ts";
import { finalizeReviewRecord } from "./apiPartners.ts";

const LEASE_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function requireSecret(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error("Unauthorized");
}

async function batchResponse(ctx: QueryCtx, batch: Doc<"apiJobBatches">) {
  const links = await ctx.db.query("apiReviewLinks")
    .withIndex("by_batch_id_and_batch_position", q => q.eq("batchId", batch.batchId)).take(101);
  const assets = links.map(assetCard);
  const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const asset of assets) counts[asset.status] += 1;
  const terminal = counts.completed + counts.failed === batch.total;
  const status = terminal ? (counts.failed ? "failed" : "completed")
    : counts.queued === batch.total ? "queued" : "processing";
  return {
    job_id: batch.batchId, status, total: batch.total, counts, assets,
    offer_id: batch.offerId, offer_name: batch.offerName,
    progress: Math.floor(assets.reduce((sum, asset) => sum + asset.progress, 0) / batch.total),
    status_url: `/api/v1/jobs/${batch.batchId}`, created_at: batch.createdAt,
  };
}

export const submit = mutation({
  args: {
    secret: v.string(), partnerId: v.string(), apiKeyId: v.string(), batchId: v.string(),
    idempotencyKey: v.optional(v.string()), requestHash: v.string(),
    offerId: v.string(), offerName: v.string(), requestMeta: v.string(), maxBytes: v.number(),
    creatives: v.array(v.object({ jobId: v.string(), assetId: v.string(), creativeName: v.string(), mediaUrl: v.string() })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (!args.creatives.length || args.creatives.length > 100
      || new Set(args.creatives.map(c => c.assetId)).size !== args.creatives.length
      || new TextEncoder().encode(args.requestMeta).length > 650_000
      || !/^batch_[0-9a-f]{32}$/.test(args.batchId)) throw new Error("Invalid batch submission");
    const partner = await ctx.db.query("apiPartners")
      .withIndex("by_partner_id", q => q.eq("partnerId", args.partnerId)).unique();
    const key = await ctx.db.query("apiKeys")
      .withIndex("by_key_id", q => q.eq("keyId", args.apiKeyId)).unique();
    const now = Date.now();
    if (!partner || partner.status !== "active" || !key || key.status !== "active"
      || (key.expiresAt !== undefined && key.expiresAt <= now)) throw new Error("API credentials are no longer active");
    if (key.partnerId !== args.partnerId || !key.scopes.includes("reviews:create")) throw new Error("API key is not permitted to create reviews");
    // Also protects transport retries when the caller omitted Idempotency-Key.
    const existingBatch = await ctx.db.query("apiJobBatches")
      .withIndex("by_batch_id", q => q.eq("batchId", args.batchId)).unique();
    if (existingBatch) {
      if (existingBatch.partnerId !== args.partnerId || existingBatch.requestHash !== args.requestHash) throw new Error("Batch ID was already used with a different batch payload");
      return batchResponse(ctx, existingBatch);
    }
    // Deduplicate before quotas and any external media download.
    if (args.idempotencyKey) {
      const duplicate = await ctx.db.query("apiJobBatches")
        .withIndex("by_partner_id_and_idempotency_key", q => q.eq("partnerId", args.partnerId).eq("idempotencyKey", args.idempotencyKey)).unique();
      if (duplicate) {
        if (duplicate.requestHash !== args.requestHash) throw new Error("Idempotency-Key was already used with a different batch payload");
        return batchResponse(ctx, duplicate);
      }
    }
    if (partner.allowedOfferIds.length && !partner.allowedOfferIds.includes(args.offerId)) throw new Error("Offer is not permitted for this API partner");
    if (args.maxBytes > partner.maxUploadMb * 1024 * 1024 || args.maxBytes <= 0) throw new Error("Invalid media size limit");
    if (!partner.unlimitedConcurrency) {
      const active = await ctx.db.query("apiReviewLinks")
        .withIndex("by_partner_id_and_status_and_created_at", q => q.eq("partnerId", args.partnerId).eq("status", "active"))
        .take(partner.concurrentReviewLimit);
      if (active.length + args.creatives.length > partner.concurrentReviewLimit) throw new Error("Concurrent review limit reached for this batch");
    }
    const monthKey = new Date(now).toISOString().slice(0, 7);
    const usage = await ctx.db.query("apiMonthlyUsage")
      .withIndex("by_partner_id_and_month_key", q => q.eq("partnerId", args.partnerId).eq("monthKey", monthKey)).unique();
    const reviewsCreated = (usage?.reviewsCreated ?? 0) + args.creatives.length;
    if (!partner.unlimitedReviews && reviewsCreated > partner.monthlyReviewLimit) throw new Error("Monthly review limit reached for this batch");
    const batch = {
      batchId: args.batchId, partnerId: args.partnerId, idempotencyKey: args.idempotencyKey,
      requestHash: args.requestHash, offerId: args.offerId, offerName: args.offerName,
      requestMeta: args.requestMeta, maxBytes: args.maxBytes, total: args.creatives.length, createdAt: now,
    };
    const batchDocId = await ctx.db.insert("apiJobBatches", batch);
    for (const [position, creative] of args.creatives.entries()) {
      await ctx.db.insert("apiReviewLinks", {
        apiKeyId: key.keyId, partnerId: args.partnerId, batchId: args.batchId, batchPosition: position,
        jobId: creative.jobId, externalId: creative.assetId, creativeName: creative.creativeName,
        fileName: creative.creativeName, mediaKind: "remote", mediaUrl: creative.mediaUrl,
        requestedOfferId: args.offerId, offerName: args.offerName, status: "active", executionStatus: "queued",
        queueManaged: true, availableAt: now, attempts: 0, progress: 0, reportReady: false,
        message: "Queued for processing", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("reviews", {
        historySource: `api:${args.partnerId}`, historySourceKind: "api",
        releasedOfferIds: [],
        jobId: creative.jobId, apiBatchId: args.batchId, fileName: creative.creativeName,
        offerIds: [args.offerId], primaryOfferId: args.offerId, hasCreative: true, hasAdCopy: false,
        status: "queued", progress: 0, message: "Queued for processing", reportReady: false, createdAt: now, updatedAt: now,
      });
    }
    if (usage) await ctx.db.patch(usage._id, { reviewsCreated, updatedAt: now });
    else await ctx.db.insert("apiMonthlyUsage", { partnerId: args.partnerId, monthKey, reviewsCreated, createdAt: now, updatedAt: now });
    return batchResponse(ctx, { ...batch, _id: batchDocId, _creationTime: now });
  },
});

export const getBatch = query({
  args: { secret: v.string(), partnerId: v.string(), batchId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await ctx.db.query("apiJobBatches").withIndex("by_batch_id", q => q.eq("batchId", args.batchId)).unique();
    return batch?.partnerId === args.partnerId ? batchResponse(ctx, batch) : null;
  },
});

async function findAsset(ctx: QueryCtx, partnerId: string, assetId: string, offerId?: string, reviewId?: string) {
  if (reviewId) {
    const link = await ctx.db.query("apiReviewLinks").withIndex("by_job_id", q => q.eq("jobId", reviewId)).unique();
    return link?.partnerId === partnerId && link.externalId === assetId && (!offerId || link.requestedOfferId === offerId) ? link : null;
  }
  const links = offerId ? await ctx.db.query("apiReviewLinks")
    .withIndex("by_partner_id_and_external_id_and_requested_offer_id", q => q.eq("partnerId", partnerId).eq("externalId", assetId).eq("requestedOfferId", offerId)).order("desc").take(1)
    : await ctx.db.query("apiReviewLinks")
      .withIndex("by_partner_id_and_external_id", q => q.eq("partnerId", partnerId).eq("externalId", assetId)).order("desc").take(1);
  return links[0] ?? null;
}

async function cardWithLegacyPreview(ctx: QueryCtx, link: Doc<"apiReviewLinks">) {
  if (link.executionStatus || link.status === "deleted") return assetCard(link);
  // Older ownership rows predate the compact projection. Read only small stats.
  const stats = await ctx.db.query("reviewOfferStats").withIndex("by_job_id", q => q.eq("jobId", link.jobId)).take(10);
  const stat = stats.find(s => s.offerId === link.requestedOfferId) ?? stats[0];
  const status = executionStatus(stat?.status ?? (link.status === "active" ? "queued" : link.status));
  const color = stat?.resultStatus;
  return assetCard({ ...link, executionStatus: status, reportReady: status === "completed",
    resultColor: color === "amber" || color === "orange" ? "yellow" : color,
    findingCount: stat?.previewFindingCount,
  });
}

export const getAsset = query({
  args: { secret: v.string(), partnerId: v.string(), assetId: v.string(), offerId: v.optional(v.string()), reviewId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await findAsset(ctx, args.partnerId, args.assetId, args.offerId, args.reviewId);
    return link && link.status !== "deleted" ? cardWithLegacyPreview(ctx, link) : null;
  },
});

export const statusColors = query({
  args: { secret: v.string(), partnerId: v.string(), assetIds: v.array(v.string()), offerId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (!args.assetIds.length || args.assetIds.length > 100) throw new Error("Provide between 1 and 100 asset IDs");
    return Promise.all(args.assetIds.map(async assetId => {
      const link = await findAsset(ctx, args.partnerId, assetId, args.offerId);
      if (!link || link.status === "deleted") return { asset_id: assetId, status: "not_found", color: null, review_id: null, job_id: null };
      const card = await cardWithLegacyPreview(ctx, link);
      return { asset_id: assetId, status: card.status, color: card.color, review_id: card.review_id, job_id: card.job_id,
        offer_id: card.offer_id, clean: card.clean, finding_count: card.finding_count };
    }));
  },
});

export const pending = query({
  args: { secret: v.string(), now: v.number() }, returns: v.boolean(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return Boolean(await ctx.db.query("apiReviewLinks")
      .withIndex("by_queue_managed_and_status_and_available_at", q => q.eq("queueManaged", true).eq("status", "active").lte("availableAt", args.now)).first());
  },
});

export const claim = mutation({
  args: { secret: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    const candidates = await ctx.db.query("apiReviewLinks")
      .withIndex("by_queue_managed_and_status_and_available_at", q => q.eq("queueManaged", true).eq("status", "active").lte("availableAt", now)).take(10);
    for (const link of candidates) {
      const review = await ctx.db.query("reviews").withIndex("by_job_id", q => q.eq("jobId", link.jobId)).unique();
      if (review?.status === "complete") {
        await ctx.db.patch(link._id, { mediaUrl: undefined, leaseId: undefined, availableAt: undefined });
        await finalizeReviewRecord(ctx, link, "complete");
        continue;
      }
      const attempts = (link.attempts ?? 0) + 1;
      const partner = await ctx.db.query("apiPartners").withIndex("by_partner_id", q => q.eq("partnerId", link.partnerId)).unique();
      if (attempts > MAX_ATTEMPTS || partner?.status !== "active") {
        const message = partner?.status !== "active" ? "API partner is no longer active" : "Processing was interrupted repeatedly; submit a new job to retry";
        await ctx.db.patch(link._id, { executionStatus: "failed", reportReady: false, progress: 100, message, mediaUrl: undefined });
        if (review) await ctx.db.patch(review._id, { status: "failed", reportReady: false, progress: 100, message, updatedAt: now });
        await finalizeReviewRecord(ctx, link, "failed");
        continue;
      }
      const batch = await ctx.db.query("apiJobBatches").withIndex("by_batch_id", q => q.eq("batchId", link.batchId!)).unique();
      if (!batch || !link.mediaUrl) throw new Error("Durable API job payload is missing");
      const leaseId = crypto.randomUUID();
      await ctx.db.patch(link._id, { leaseId, attempts, availableAt: now + LEASE_MS, executionStatus: "processing", reportReady: false,
        resultColor: undefined, findingCount: undefined, progress: 0, message: "Downloading creative", updatedAt: now });
      return { job_id: link.jobId, asset_id: link.externalId, creative_name: link.creativeName, media_url: link.mediaUrl,
        request_meta: batch.requestMeta, max_bytes: batch.maxBytes, lease_id: leaseId, attempts };
    }
    return null;
  },
});

export const heartbeat = mutation({
  args: { secret: v.string(), jobId: v.string(), leaseId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await assertApiLease(ctx, args.jobId, args.leaseId);
    if (!link?.queueManaged) throw new Error("API job not found");
    await ctx.db.patch(link._id, { availableAt: Date.now() + LEASE_MS });
    return null;
  },
});

export const finish = mutation({
  args: { secret: v.string(), jobId: v.string(), leaseId: v.string(), success: v.boolean(), retryable: v.boolean(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await assertApiLease(ctx, args.jobId, args.leaseId);
    if (!link?.queueManaged) throw new Error("API job not found");
    const review = await ctx.db.query("reviews").withIndex("by_job_id", q => q.eq("jobId", args.jobId)).unique();
    if (args.success && (review?.status !== "complete" || !review.reportReady)) throw new Error("API job report is not complete");
    const retry = !args.success && args.retryable && (link.attempts ?? 0) < MAX_ATTEMPTS;
    const status = retry ? "queued" : args.success ? "completed" : "failed";
    const message = retry ? "Processing interrupted; queued for automatic retry" : args.message.slice(0, 500);
    await ctx.db.patch(link._id, { executionStatus: status, message, progress: retry ? 0 : 100,
      reportReady: args.success, leaseId: undefined, availableAt: retry ? Date.now() + 30_000 : undefined,
      mediaUrl: retry ? link.mediaUrl : undefined, updatedAt: Date.now() });
    if (review && !args.success) await ctx.db.patch(review._id, { status: retry ? "queued" : "failed", message,
      progress: retry ? 0 : 100, reportReady: false, updatedAt: Date.now() });
    if (!retry) await finalizeReviewRecord(ctx, link, args.success ? "complete" : "failed");
    return null;
  },
});
