import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

type BatchItem = {
  offerOutcomes?: Array<{
    adCopyResult?: string;
    creativeResult?: string;
    evaluationState: string;
    message: string;
    offerId: string;
    offerName: string;
    overallStatus?: string;
    withOverride?: boolean;
  }>;
  fileName: string;
  itemId: string;
  jobId?: string;
  mediaKind: string;
  message: string;
  result?: string;
  status: string;
};

type BatchReviewState = {
  batchItemId?: string;
  deletedAt?: number;
  jobId: string;
  message: string;
  status: string;
};

const publicOfferOutcomeValidator = v.object({
  ad_copy_result: v.union(v.string(), v.null()),
  creative_result: v.union(v.string(), v.null()),
  evaluation_state: v.string(),
  message: v.string(),
  offer_id: v.string(),
  offer_name: v.string(),
  overall_status: v.union(v.string(), v.null()),
  with_override: v.boolean(),
});

const publicBatchValidator = v.object({
  batch_id: v.string(),
  created_at: v.number(),
  expected_count: v.number(),
  source_label: v.union(v.string(), v.null()),
  items: v.array(v.object({
    file_name: v.string(),
    item_id: v.string(),
    job_id: v.union(v.string(), v.null()),
    media_kind: v.string(),
    message: v.string(),
    offer_outcomes: v.array(publicOfferOutcomeValidator),
    result: v.union(v.string(), v.null()),
    status: v.string(),
  })),
  notification_claim_id: v.union(v.string(), v.null()),
  notification_status: v.string(),
  updated_at: v.number(),
});

const TERMINAL_BATCH_STATUSES = new Set(["complete", "failed", "upload_failed"]);
const NOTIFICATION_LEASE_MS = 15 * 60 * 1000;
const MAX_NOTIFICATION_ATTEMPTS = 3;
const PURGE_CHUNK_SIZE = 10;

const purgeCountsValidator = v.object({
  apiEvidenceBundles: v.number(),
  apiReviewLinks: v.number(),
  apiWebhookDeliveries: v.number(),
  automationFileClaims: v.number(),
  automationJobStates: v.number(),
  automationRuns: v.number(),
  batchArtifacts: v.number(),
  batchItems: v.number(),
  batches: v.number(),
  clientDecisions: v.number(),
  evidenceFiles: v.number(),
  evidenceFrameSets: v.number(),
  files: v.number(),
  liveScanClaims: v.number(),
  offerReports: v.number(),
  offerStats: v.number(),
  payloads: v.number(),
  processingMetrics: v.number(),
  reportArtifacts: v.number(),
  reviews: v.number(),
});

type PurgeCounts = {
  apiEvidenceBundles: number;
  apiReviewLinks: number;
  apiWebhookDeliveries: number;
  automationFileClaims: number;
  automationJobStates: number;
  automationRuns: number;
  batchArtifacts: number;
  batchItems: number;
  batches: number;
  clientDecisions: number;
  evidenceFiles: number;
  evidenceFrameSets: number;
  files: number;
  liveScanClaims: number;
  offerReports: number;
  offerStats: number;
  payloads: number;
  processingMetrics: number;
  reportArtifacts: number;
  reviews: number;
};

function emptyPurgeCounts(): PurgeCounts {
  return {
    apiEvidenceBundles: 0,
    apiReviewLinks: 0,
    apiWebhookDeliveries: 0,
    automationFileClaims: 0,
    automationJobStates: 0,
    automationRuns: 0,
    batchArtifacts: 0,
    batchItems: 0,
    batches: 0,
    clientDecisions: 0,
    evidenceFiles: 0,
    evidenceFrameSets: 0,
    files: 0,
    liveScanClaims: 0,
    offerReports: 0,
    offerStats: 0,
    payloads: 0,
    processingMetrics: 0,
    reportArtifacts: 0,
    reviews: 0,
  };
}

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function publicBatch(batch: {
  batchId: string;
  createdAt: number;
  expectedCount: number;
  sourceLabel?: string;
  items: BatchItem[];
  notificationClaimId?: string;
  notificationStatus: string;
  updatedAt: number;
}) {
  return {
    batch_id: batch.batchId,
    created_at: batch.createdAt,
    expected_count: batch.expectedCount,
    source_label: batch.sourceLabel ?? null,
    items: batch.items.map((item) => ({
      file_name: item.fileName,
      item_id: item.itemId,
      job_id: item.jobId ?? null,
      media_kind: item.mediaKind,
      message: item.message,
      offer_outcomes: (item.offerOutcomes ?? []).map((outcome) => ({
        ad_copy_result: outcome.adCopyResult ?? null,
        creative_result: outcome.creativeResult ?? null,
        evaluation_state: outcome.evaluationState,
        message: outcome.message,
        offer_id: outcome.offerId,
        offer_name: outcome.offerName,
        overall_status: outcome.overallStatus ?? null,
        with_override: outcome.withOverride ?? false,
      })),
      result: item.result ?? null,
      status: item.status,
    })),
    notification_claim_id: batch.notificationClaimId ?? null,
    notification_status: batch.notificationStatus,
    updated_at: batch.updatedAt,
  };
}

async function findBatch(ctx: MutationCtx | QueryCtx, batchId: string) {
  return ctx.db
    .query("reviewBatches")
    .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
    .unique();
}

async function findArtifactsForOwner(
  ctx: MutationCtx,
  ownerType: "batch" | "review",
  ownerId: string,
) {
  const candidates = await ctx.db
    .query("reportArtifacts")
    .withIndex("by_owner_type_and_owner_id", (q) =>
      q
        .eq("ownerType", ownerType)
        .gte("ownerId", ownerId)
        .lt("ownerId", `${ownerId}\uffff`)
    )
    .take(100);
  return candidates.filter((artifact) =>
    artifact.ownerId === ownerId || artifact.ownerId.startsWith(`${ownerId}:`)
  );
}

async function purgeJob(
  ctx: MutationCtx,
  jobId: string,
  storageIds: Set<Id<"_storage">>,
  counts: PurgeCounts,
) {
  const [
    reviews,
    offerStats,
    offerReports,
    processingMetrics,
    payloads,
    evidenceFrameSets,
    clientDecisions,
    reportArtifacts,
    automationJobStates,
    liveScanClaims,
    apiReviewLinks,
    apiEvidenceBundles,
    apiWebhookDeliveries,
  ] = await Promise.all([
    ctx.db.query("reviews").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(2),
    ctx.db.query("reviewOfferStats").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(20),
    ctx.db.query("reviewOfferReports").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(20),
    ctx.db.query("reviewProcessingMetrics").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(2),
    ctx.db.query("reviewPayloads").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(2),
    ctx.db.query("reviewEvidenceFrames").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(2),
    ctx.db.query("clientReviewDecisions").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(100),
    findArtifactsForOwner(ctx, "review", jobId),
    ctx.db.query("automationJobStates").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(10),
    ctx.db.query("liveScanReviewClaims").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(10),
    ctx.db.query("apiReviewLinks").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(10),
    ctx.db.query("apiEvidenceBundles").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(10),
    ctx.db.query("apiWebhookDeliveries").withIndex("by_job_id", (q) => q.eq("jobId", jobId)).take(100),
  ]);

  for (const payload of payloads) {
    storageIds.add(payload.manifestStorageId);
    if (payload.mediaStorageId) storageIds.add(payload.mediaStorageId);
  }
  for (const evidence of evidenceFrameSets) {
    for (const frame of evidence.frames) storageIds.add(frame.storageId);
    counts.evidenceFiles += evidence.frames.length;
  }
  for (const artifact of reportArtifacts) storageIds.add(artifact.storageId);

  for (const document of reviews) await ctx.db.delete(document._id);
  for (const document of offerStats) await ctx.db.delete(document._id);
  for (const document of offerReports) await ctx.db.delete(document._id);
  for (const document of processingMetrics) await ctx.db.delete(document._id);
  for (const document of payloads) await ctx.db.delete(document._id);
  for (const document of evidenceFrameSets) await ctx.db.delete(document._id);
  for (const document of clientDecisions) await ctx.db.delete(document._id);
  for (const document of reportArtifacts) await ctx.db.delete(document._id);
  for (const document of automationJobStates) await ctx.db.delete(document._id);
  for (const document of liveScanClaims) await ctx.db.delete(document._id);
  for (const document of apiReviewLinks) await ctx.db.delete(document._id);
  for (const document of apiEvidenceBundles) await ctx.db.delete(document._id);
  for (const document of apiWebhookDeliveries) await ctx.db.delete(document._id);

  counts.apiEvidenceBundles += apiEvidenceBundles.length;
  counts.apiReviewLinks += apiReviewLinks.length;
  counts.apiWebhookDeliveries += apiWebhookDeliveries.length;
  counts.automationJobStates += automationJobStates.length;
  counts.clientDecisions += clientDecisions.length;
  counts.evidenceFrameSets += evidenceFrameSets.length;
  counts.liveScanClaims += liveScanClaims.length;
  counts.offerReports += offerReports.length;
  counts.offerStats += offerStats.length;
  counts.payloads += payloads.length;
  counts.processingMetrics += processingMetrics.length;
  counts.reportArtifacts += reportArtifacts.length;
  counts.reviews += reviews.length;
}

async function hydrateBatchItems(
  ctx: QueryCtx,
  batchId: string,
  items: BatchItem[],
) {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
    .collect() as BatchReviewState[];
  const reviewByItemId = new Map(
    reviews.flatMap((review) =>
      review.deletedAt === undefined && review.batchItemId
        ? [[review.batchItemId, review] as const]
        : []
    ),
  );
  return items.map((item) => {
    const review = reviewByItemId.get(item.itemId);
    if (!review) return item;
    if (
      TERMINAL_BATCH_STATUSES.has(item.status)
      && !TERMINAL_BATCH_STATUSES.has(review.status)
    ) {
      return item;
    }
    return {
      ...item,
      jobId: review.jobId,
      message: review.message,
      status: review.status,
    };
  });
}

export const createBatch = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    sourceLabel: v.optional(v.string()),
    items: v.array(v.object({
      fileName: v.string(),
      itemId: v.string(),
      mediaKind: v.string(),
      offerOutcomes: v.optional(v.array(v.object({
        adCopyResult: v.optional(v.string()),
        creativeResult: v.optional(v.string()),
        evaluationState: v.string(),
        message: v.string(),
        offerId: v.string(),
        offerName: v.string(),
        overallStatus: v.optional(v.string()),
        withOverride: v.optional(v.boolean()),
      }))),
    })),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await findBatch(ctx, args.batchId);
    if (existing) return publicBatch(existing);
    const now = Date.now();
    const batch = {
      batchId: args.batchId,
      createdAt: now,
      expectedCount: args.items.length,
      sourceLabel: args.sourceLabel,
      items: args.items.map((item) => ({ ...item, message: "", status: "pending" })),
      notificationStatus: "pending",
      notificationAttempts: 0,
      notificationReady: false,
      updatedAt: now,
    };
    await ctx.db.insert("reviewBatches", batch);
    return publicBatch(batch);
  },
});

export const getBatch = query({
  args: { secret: v.string(), batchId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) return null;
    const items = await hydrateBatchItems(ctx, batch.batchId, batch.items);
    return publicBatch({ ...batch, items });
  },
});

export const getBatches = query({
  args: {
    secret: v.string(),
    batchIds: v.array(v.string()),
  },
  returns: v.array(publicBatchValidator),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batchIds = [...new Set(args.batchIds)];
    if (batchIds.length > 100) {
      throw new Error("At most 100 review batches can be loaded at once");
    }
    const batches = await Promise.all(
      batchIds.map((batchId) => findBatch(ctx, batchId)),
    );
    const hydrated = await Promise.all(batches.map(async (batch) => {
      if (!batch) return null;
      const items = await hydrateBatchItems(ctx, batch.batchId, batch.items);
      return publicBatch({ ...batch, items });
    }));
    return hydrated.flatMap((batch) => batch ? [batch] : []);
  },
});

export const purgeBatch = mutation({
  args: {
    batchId: v.string(),
    confirmation: v.literal("DELETE_BATCH_AND_REVIEWS"),
    secret: v.string(),
  },
  returns: v.object({
    batchId: v.string(),
    counts: purgeCountsValidator,
    done: v.boolean(),
    remainingItems: v.number(),
    remainingReviews: v.number(),
  }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    const counts = emptyPurgeCounts();
    if (!batch) {
      return {
        batchId: args.batchId,
        counts,
        done: true,
        remainingItems: 0,
        remainingReviews: 0,
      };
    }
    if (batch.items.some((item) => !TERMINAL_BATCH_STATUSES.has(item.status))) {
      throw new Error("Only terminal review batches can be purged");
    }

    const batchReviews = await ctx.db
      .query("reviews")
      .withIndex("by_batch_id", (q) => q.eq("batchId", args.batchId))
      .take(501);
    if (batchReviews.length > 500) {
      throw new Error("Review batch is too large to purge safely");
    }
    if (batchReviews.some((review) =>
      review.deletedAt === undefined
      && review.status !== "complete"
      && review.status !== "failed"
    )) {
      throw new Error("Only terminal review batches can be purged");
    }

    const itemChunk = batch.items.slice(0, PURGE_CHUNK_SIZE);
    const selectedItemIds = new Set(itemChunk.map((item) => item.itemId));
    const jobIds = new Set(
      itemChunk.flatMap((item) => item.jobId ? [item.jobId] : []),
    );
    for (const review of batchReviews) {
      if (review.batchItemId && selectedItemIds.has(review.batchItemId)) {
        jobIds.add(review.jobId);
      }
    }
    if (!itemChunk.length) {
      for (const review of batchReviews.slice(0, PURGE_CHUNK_SIZE)) {
        jobIds.add(review.jobId);
      }
    }

    const storageIds = new Set<Id<"_storage">>();
    for (const jobId of jobIds) {
      await purgeJob(ctx, jobId, storageIds, counts);
    }
    counts.batchItems = itemChunk.length;

    const remainingItems = batch.items.slice(itemChunk.length);
    const remainingReviews = batchReviews.filter((review) => !jobIds.has(review.jobId));
    const done = remainingItems.length === 0 && remainingReviews.length === 0;
    if (done) {
      const [batchArtifacts, automations, automationRuns] = await Promise.all([
        findArtifactsForOwner(ctx, "batch", args.batchId),
        ctx.db
          .query("reviewAutomations")
          .withIndex("by_last_batch_id", (q) => q.eq("lastBatchId", args.batchId))
          .take(100),
        ctx.db
          .query("automationRuns")
          .withIndex("by_batch_id", (q) => q.eq("batchId", args.batchId))
          .take(100),
      ]);
      for (const artifact of batchArtifacts) {
        storageIds.add(artifact.storageId);
        await ctx.db.delete(artifact._id);
      }
      for (const automation of automations) {
        await ctx.db.patch(automation._id, { lastBatchId: undefined });
      }
      for (const run of automationRuns) {
        const [fileClaims, jobStates] = await Promise.all([
          ctx.db
            .query("automationFileClaims")
            .withIndex("by_run_id", (q) => q.eq("runId", run.runId))
            .take(500),
          ctx.db
            .query("automationJobStates")
            .withIndex("by_run_id", (q) => q.eq("runId", run.runId))
            .take(500),
        ]);
        for (const claim of fileClaims) await ctx.db.delete(claim._id);
        for (const state of jobStates) await ctx.db.delete(state._id);
        await ctx.db.delete(run._id);
        counts.automationFileClaims += fileClaims.length;
        counts.automationJobStates += jobStates.length;
      }
      counts.automationRuns += automationRuns.length;
      counts.batchArtifacts += batchArtifacts.length;
      counts.batches = 1;
      await ctx.db.delete(batch._id);
    } else {
      await ctx.db.patch(batch._id, {
        items: remainingItems,
        updatedAt: Date.now(),
      });
    }

    for (const storageId of storageIds) await ctx.storage.delete(storageId);
    counts.files = storageIds.size;
    return {
      batchId: args.batchId,
      counts,
      done,
      remainingItems: remainingItems.length,
      remainingReviews: remainingReviews.length,
    };
  },
});

export const updateItemStatus = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    itemId: v.string(),
    jobId: v.optional(v.string()),
    message: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    const items = batch.items.map((item) => item.itemId === args.itemId ? {
      ...item,
      jobId: args.jobId ?? item.jobId,
      message: args.message,
      status: args.status,
    } : item);
    if (!items.some((item) => item.itemId === args.itemId)) throw new Error("Batch item not found");
    const updatedAt = Date.now();
    const notificationReady = items.every((item) =>
      TERMINAL_BATCH_STATUSES.has(item.status)
    );
    await ctx.db.patch(batch._id, { items, notificationReady, updatedAt });
    return publicBatch({ ...batch, items, updatedAt });
  },
});

export const finishItem = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    itemId: v.string(),
    jobId: v.optional(v.string()),
    message: v.string(),
    offerOutcomes: v.optional(v.array(v.object({
      adCopyResult: v.optional(v.string()),
      creativeResult: v.optional(v.string()),
      evaluationState: v.string(),
      message: v.string(),
      offerId: v.string(),
      offerName: v.string(),
      overallStatus: v.optional(v.string()),
      withOverride: v.optional(v.boolean()),
    }))),
    result: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    const items = batch.items.map((item) => item.itemId === args.itemId ? {
      ...item,
      jobId: args.jobId ?? item.jobId,
      message: args.message,
      offerOutcomes: args.offerOutcomes ?? item.offerOutcomes,
      result: args.result ?? item.result,
      status: args.status,
    } : item);
    if (!items.some((item) => item.itemId === args.itemId)) throw new Error("Batch item not found");
    const notificationReady = items.every((item) =>
      TERMINAL_BATCH_STATUSES.has(item.status)
    );
    const currentNotificationAttempts = batch.notificationAttempts ?? 0;
    const notificationExhausted = (
      batch.notificationStatus === "pending"
      && notificationReady
      && currentNotificationAttempts >= MAX_NOTIFICATION_ATTEMPTS
    );
    const shouldNotify = (
      batch.notificationStatus === "pending"
      && notificationReady
      && !notificationExhausted
    );
    const notificationStatus = shouldNotify
      ? "claimed"
      : notificationExhausted
        ? "failed_exhausted"
        : batch.notificationStatus;
    const updatedAt = Date.now();
    const notificationClaimId = shouldNotify
      ? crypto.randomUUID()
      : notificationExhausted
        ? undefined
        : batch.notificationClaimId;
    const notificationAttempts = shouldNotify
      ? currentNotificationAttempts + 1
      : batch.notificationAttempts;
    const notificationLeaseExpiresAt = shouldNotify
      ? updatedAt + NOTIFICATION_LEASE_MS
      : notificationExhausted
        ? undefined
        : batch.notificationLeaseExpiresAt;
    await ctx.db.patch(batch._id, {
      items,
      notificationAttempts,
      notificationClaimId,
      notificationLeaseExpiresAt,
      notificationReady,
      notificationStatus,
      updatedAt,
    });
    return {
      batch: publicBatch({
        ...batch,
        items,
        notificationClaimId,
        notificationStatus,
        updatedAt,
      }),
      shouldNotify,
    };
  },
});

export const markNotification = mutation({
  args: {
    secret: v.string(),
    batchId: v.string(),
    claimId: v.optional(v.string()),
    status: v.string(),
  },
  returns: v.object({
    status: v.string(),
    updated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const batch = await findBatch(ctx, args.batchId);
    if (!batch) throw new Error("Review batch not found");
    if (batch.notificationStatus !== "claimed") {
      return { status: batch.notificationStatus, updated: false };
    }
    if (
      batch.notificationClaimId !== undefined
        ? args.claimId !== batch.notificationClaimId
        : args.claimId !== undefined
    ) {
      return { status: batch.notificationStatus, updated: false };
    }
    const now = Date.now();
    const status = (
      args.status === "failed"
      && (batch.notificationAttempts ?? 0) >= MAX_NOTIFICATION_ATTEMPTS
    ) ? "failed_exhausted" : args.status;
    await ctx.db.patch(batch._id, {
      notificationClaimId: undefined,
      notificationLeaseExpiresAt: status === "failed"
        ? now + NOTIFICATION_LEASE_MS
        : undefined,
      notificationStatus: status,
      updatedAt: now,
    });
    return { status, updated: true };
  },
});

export const claimNotification = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    for (const status of ["pending", "failed", "claimed"]) {
      const candidates = status === "pending"
        ? await ctx.db
            .query("reviewBatches")
            .withIndex("by_notification_ready_status_lease", (q) =>
              q.eq("notificationReady", true).eq("notificationStatus", status)
            )
            .take(1)
        : await ctx.db
        .query("reviewBatches")
        .withIndex("by_notification_ready_status_lease", (q) =>
          q
            .eq("notificationReady", true)
            .eq("notificationStatus", status)
            .lte("notificationLeaseExpiresAt", now)
        )
        .take(1);
      for (const batch of candidates) {
        const attempts = batch.notificationAttempts ?? 0;
        if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
          await ctx.db.patch(batch._id, {
            notificationClaimId: undefined,
            notificationLeaseExpiresAt: undefined,
            notificationStatus: "failed_exhausted",
            updatedAt: now,
          });
          continue;
        }
        const notificationAttempts = attempts + 1;
        const notificationClaimId = crypto.randomUUID();
        const notificationLeaseExpiresAt = now + NOTIFICATION_LEASE_MS;
        await ctx.db.patch(batch._id, {
          notificationAttempts,
          notificationClaimId,
          notificationLeaseExpiresAt,
          notificationStatus: "claimed",
          updatedAt: now,
        });
        return publicBatch({
          ...batch,
          notificationClaimId,
          notificationStatus: "claimed",
          updatedAt: now,
        });
      }
    }
    return null;
  },
});
