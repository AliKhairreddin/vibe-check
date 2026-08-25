import { paginationOptsValidator } from "convex/server";
import { type MutationCtx, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

const API_SCOPES = new Set([
  "evidence:read",
  "history:read",
  "reports:download",
  "reviews:create",
  "reviews:delete",
  "reviews:read",
  "scans:read",
  "scans:write",
]);
const WEBHOOK_LEASE_MS = 2 * 60 * 1000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const MONTH_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function normalizeScopes(scopes: string[]) {
  const values = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (!values.length || values.some((scope) => !API_SCOPES.has(scope))) {
    throw new Error("One or more API key scopes are invalid");
  }
  return values;
}

function publicKey(key: {
  createdAt: number;
  expiresAt?: number;
  keyId: string;
  lastUsedAt?: number;
  name: string;
  prefix: string;
  revokedAt?: number;
  scopes: string[];
  status: "active" | "revoked";
}) {
  return {
    created_at: key.createdAt,
    expires_at: key.expiresAt ?? null,
    key_id: key.keyId,
    last_used_at: key.lastUsedAt ?? null,
    name: key.name,
    prefix: key.prefix,
    revoked_at: key.revokedAt ?? null,
    scopes: key.scopes,
    status: key.status,
  };
}

function publicPartner(partner: {
  allowedOfferIds: string[];
  allowCustomPolicy: boolean;
  concurrentReviewLimit: number;
  createdAt: number;
  description: string;
  maxUploadMb: number;
  monthlyReviewLimit: number;
  name: string;
  partnerId: string;
  retentionDays: number;
  status: "active" | "suspended";
  unlimitedConcurrency: boolean;
  unlimitedReviews: boolean;
  updatedAt: number;
  webhookSigningSecret?: string;
  webhookUrl?: string;
}) {
  return {
    allowed_offer_ids: partner.allowedOfferIds,
    allow_custom_policy: partner.allowCustomPolicy,
    concurrent_review_limit: partner.concurrentReviewLimit,
    created_at: partner.createdAt,
    description: partner.description,
    max_upload_mb: partner.maxUploadMb,
    monthly_review_limit: partner.monthlyReviewLimit,
    name: partner.name,
    partner_id: partner.partnerId,
    retention_days: partner.retentionDays,
    status: partner.status,
    unlimited_concurrency: partner.unlimitedConcurrency,
    unlimited_reviews: partner.unlimitedReviews,
    updated_at: partner.updatedAt,
    webhook_configured: Boolean(partner.webhookUrl && partner.webhookSigningSecret),
    webhook_url: partner.webhookUrl ?? null,
  };
}

function publicReview(
  link: {
    createdAt: number;
    creativeName?: string;
    externalId?: string;
    fileName: string;
    fileSize?: number;
    jobId: string;
    mediaKind: string;
    status: "active" | "complete" | "failed" | "deleted";
    terminalAt?: number;
    updatedAt: number;
  },
  review: {
    message: string;
    offerIds?: string[];
    primaryOfferId?: string;
    progress: number;
    reportReady: boolean;
    status: string;
    updatedAt: number;
  } | null,
) {
  const deleted = link.status === "deleted";
  return {
    created_at: link.createdAt,
    creative_name: link.creativeName ?? null,
    external_id: link.externalId ?? null,
    file_name: link.fileName,
    file_size: link.fileSize ?? null,
    job_id: link.jobId,
    media_kind: link.mediaKind,
    message: deleted ? "Deleted" : review?.message ?? "Review unavailable",
    offer_ids: review?.offerIds ?? [],
    primary_offer_id: review?.primaryOfferId ?? null,
    progress: deleted ? 100 : review?.progress ?? (link.status === "active" ? 0 : 100),
    report_ready: deleted ? false : review?.reportReady ?? false,
    review_id: link.jobId,
    status: deleted ? "deleted" : review?.status ?? link.status,
    terminal_at: link.terminalAt ?? null,
    updated_at: Math.max(link.updatedAt, review?.updatedAt ?? 0),
  };
}

function publicScanAd(scan: Doc<"apiScanAds">) {
  return {
    account_id: scan.accountId ?? null,
    account_name: scan.accountName ?? null,
    ad_id: scan.externalAdId,
    ad_set_id: scan.adSetId ?? null,
    ad_set_name: scan.adSetName ?? null,
    campaign_id: scan.campaignId ?? null,
    campaign_name: scan.campaignName ?? null,
    content_fingerprint: scan.contentFingerprint,
    creative_name: scan.creativeName ?? null,
    current_review_id: scan.currentReviewId,
    fields_sha256: scan.fieldsSha256,
    first_observed_at: scan.firstObservedAt,
    last_changed_at: scan.lastChangedAt,
    last_observed_at: scan.lastObservedAt,
    media_sha256: scan.mediaSha256,
    scan_count: scan.scanCount,
  };
}

function publicScanObservation(observation: Doc<"apiScanObservations">) {
  return {
    ad_id: observation.externalAdId,
    change_status: observation.changeStatus,
    content_fingerprint: observation.contentFingerprint,
    fields_sha256: observation.fieldsSha256,
    media_sha256: observation.mediaSha256,
    observation_id: observation.observationId,
    observed_at: observation.observedAt,
    expires_at: observation.expiresAt,
    previous_content_fingerprint: observation.previousContentFingerprint ?? null,
    review_created: observation.reviewCreated,
    review_id: observation.reviewId,
  };
}

async function finalizeReviewRecord(
  ctx: MutationCtx,
  link: Doc<"apiReviewLinks">,
  status: "complete" | "failed",
) {
  if (link.status !== "active") return { finalized: false, reason: "already_terminal" };
  const now = Date.now();
  await ctx.db.patch(link._id, { status, terminalAt: now, updatedAt: now });
  const partner = await ctx.db
    .query("apiPartners")
    .withIndex("by_partner_id", (q) => q.eq("partnerId", link.partnerId))
    .unique();
  let deliveryId: string | null = null;
  if (partner?.webhookUrl && partner.webhookSigningSecret) {
    deliveryId = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
    const eventType = status === "complete" ? "review.completed" : "review.failed";
    const payload = {
      created_at: new Date(now).toISOString(),
      data: {
        creative_name: link.creativeName ?? null,
        external_id: link.externalId ?? null,
        job_id: link.jobId,
        result_url: `/api/v1/reviews/${link.jobId}/result`,
        review_id: link.jobId,
        status,
      },
      event_id: deliveryId,
      type: eventType,
    };
    await ctx.db.insert("apiWebhookDeliveries", {
      attempts: 0,
      createdAt: now,
      deliveryId,
      eventType,
      jobId: link.jobId,
      nextAttemptAt: now,
      partnerId: link.partnerId,
      payload,
      status: "pending",
      updatedAt: now,
    });
  }
  return { delivery_id: deliveryId, finalized: true };
}

export const list = query({
  args: { monthKey: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (!MONTH_KEY_PATTERN.test(args.monthKey)) {
      throw new Error("Month key must use YYYY-MM format");
    }
    const partners = await ctx.db.query("apiPartners").order("desc").take(100);
    return await Promise.all(partners.map(async (partner) => {
      const keys = await ctx.db
        .query("apiKeys")
        .withIndex("by_partner_id", (q) => q.eq("partnerId", partner.partnerId))
        .order("desc")
        .take(100);
      const usage = await ctx.db
        .query("apiMonthlyUsage")
        .withIndex("by_partner_id_and_month_key", (q) =>
          q.eq("partnerId", partner.partnerId).eq("monthKey", args.monthKey)
        )
        .unique();
      const active = await ctx.db
        .query("apiReviewLinks")
        .withIndex("by_partner_id_and_status_and_created_at", (q) =>
          q.eq("partnerId", partner.partnerId).eq("status", "active")
        )
        .take(partner.unlimitedConcurrency ? 1_000 : partner.concurrentReviewLimit + 1);
      return {
        ...publicPartner(partner),
        active_reviews: active.length,
        keys: keys.map(publicKey),
        month_key: args.monthKey,
        monthly_reviews_created: usage?.reviewsCreated ?? 0,
      };
    }));
  },
});

export const upsert = mutation({
  args: {
    allowedOfferIds: v.array(v.string()),
    allowCustomPolicy: v.boolean(),
    concurrentReviewLimit: v.number(),
    description: v.string(),
    maxUploadMb: v.number(),
    monthlyReviewLimit: v.number(),
    name: v.string(),
    partnerId: v.string(),
    retentionDays: v.number(),
    secret: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    unlimitedConcurrency: v.boolean(),
    unlimitedReviews: v.boolean(),
    webhookUrl: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    const now = Date.now();
    const value = {
      allowedOfferIds: [...new Set(args.allowedOfferIds)].sort(),
      allowCustomPolicy: args.allowCustomPolicy,
      concurrentReviewLimit: args.concurrentReviewLimit,
      description: args.description,
      maxUploadMb: args.maxUploadMb,
      monthlyReviewLimit: args.monthlyReviewLimit,
      name: args.name,
      partnerId: args.partnerId,
      retentionDays: args.retentionDays,
      status: args.status,
      unlimitedConcurrency: args.unlimitedConcurrency,
      unlimitedReviews: args.unlimitedReviews,
      updatedAt: now,
      webhookSigningSecret: args.webhookUrl && args.webhookUrl === existing?.webhookUrl
        ? existing.webhookSigningSecret
        : undefined,
      webhookUrl: args.webhookUrl,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("apiPartners", { ...value, createdAt: now });
    return publicPartner({ ...existing, ...value, createdAt: existing?.createdAt ?? now });
  },
});

export const rotateWebhookSecret = mutation({
  args: {
    partnerId: v.string(),
    secret: v.string(),
    webhookSigningSecret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    if (!partner) throw new Error("API partner not found");
    if (!partner.webhookUrl) throw new Error("Save a webhook URL before creating its secret");
    await ctx.db.patch(partner._id, {
      webhookSigningSecret: args.webhookSigningSecret,
      updatedAt: Date.now(),
    });
    return { partner_id: partner.partnerId, webhook_configured: true };
  },
});

export const issueKey = mutation({
  args: {
    expiresAt: v.optional(v.number()),
    keyId: v.string(),
    name: v.string(),
    partnerId: v.string(),
    prefix: v.string(),
    scopes: v.array(v.string()),
    secret: v.string(),
    tokenHash: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    if (!partner) throw new Error("API partner not found");
    const duplicate = await ctx.db
      .query("apiKeys")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (duplicate) throw new Error("API key token already exists");
    const now = Date.now();
    const value = {
      createdAt: now,
      expiresAt: args.expiresAt,
      keyId: args.keyId,
      name: args.name,
      partnerId: args.partnerId,
      prefix: args.prefix,
      scopes: normalizeScopes(args.scopes),
      status: "active" as const,
      tokenHash: args.tokenHash,
      updatedAt: now,
    };
    await ctx.db.insert("apiKeys", value);
    return publicKey(value);
  },
});

export const revokeKey = mutation({
  args: { keyId: v.string(), partnerId: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_id", (q) => q.eq("keyId", args.keyId))
      .unique();
    if (!key || key.partnerId !== args.partnerId) throw new Error("API key not found");
    const now = Date.now();
    if (key.status !== "revoked") {
      await ctx.db.patch(key._id, { revokedAt: now, status: "revoked", updatedAt: now });
    }
    return { key_id: key.keyId, revoked_at: key.revokedAt ?? now, status: "revoked" };
  },
});

export const authenticate = mutation({
  args: { now: v.number(), secret: v.string(), tokenHash: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!key || key.status !== "active" || (key.expiresAt ?? Number.MAX_SAFE_INTEGER) <= args.now) {
      return null;
    }
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", key.partnerId))
      .unique();
    if (!partner || partner.status !== "active") return null;
    if (!key.lastUsedAt || key.lastUsedAt < args.now - 5 * 60 * 1000) {
      await ctx.db.patch(key._id, { lastUsedAt: args.now, updatedAt: args.now });
    }
    const monthKey = new Date(args.now).toISOString().slice(0, 7);
    const usage = await ctx.db
      .query("apiMonthlyUsage")
      .withIndex("by_partner_id_and_month_key", (q) =>
        q.eq("partnerId", partner.partnerId).eq("monthKey", monthKey)
      )
      .unique();
    return {
      ...publicPartner(partner),
      api_key_id: key.keyId,
      api_key_name: key.name,
      api_key_prefix: key.prefix,
      month_key: monthKey,
      monthly_reviews_created: usage?.reviewsCreated ?? 0,
      scopes: key.scopes,
    };
  },
});

export const claimReview = mutation({
  args: {
    apiKeyId: v.string(),
    creativeName: v.optional(v.string()),
    externalId: v.optional(v.string()),
    fileName: v.string(),
    fileSize: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    jobId: v.string(),
    mediaKind: v.string(),
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_id", (q) => q.eq("keyId", args.apiKeyId))
      .unique();
    if (!partner || partner.status !== "active" || !key || key.status !== "active") {
      throw new Error("API credentials are no longer active");
    }
    if (key.partnerId !== partner.partnerId || !key.scopes.includes("reviews:create")) {
      throw new Error("API key is not permitted to create reviews");
    }
    if (args.idempotencyKey) {
      const duplicate = await ctx.db
        .query("apiReviewLinks")
        .withIndex("by_partner_id_and_idempotency_key", (q) =>
          q.eq("partnerId", partner.partnerId).eq("idempotencyKey", args.idempotencyKey)
        )
        .unique();
      if (duplicate) return { created: false, review_id: duplicate.jobId };
    }
    if (!partner.unlimitedConcurrency) {
      const active = await ctx.db
        .query("apiReviewLinks")
        .withIndex("by_partner_id_and_status_and_created_at", (q) =>
          q.eq("partnerId", partner.partnerId).eq("status", "active")
        )
        .take(partner.concurrentReviewLimit);
      if (active.length >= partner.concurrentReviewLimit) {
        throw new Error("Concurrent review limit reached");
      }
    }
    const now = Date.now();
    const monthKey = new Date(now).toISOString().slice(0, 7);
    const usage = await ctx.db
      .query("apiMonthlyUsage")
      .withIndex("by_partner_id_and_month_key", (q) =>
        q.eq("partnerId", partner.partnerId).eq("monthKey", monthKey)
      )
      .unique();
    const reviewsCreated = usage?.reviewsCreated ?? 0;
    if (!partner.unlimitedReviews && reviewsCreated >= partner.monthlyReviewLimit) {
      throw new Error("Monthly review limit reached");
    }
    const existingJob = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (existingJob) throw new Error("Review ID already exists");
    await ctx.db.insert("apiReviewLinks", {
      apiKeyId: key.keyId,
      createdAt: now,
      creativeName: args.creativeName,
      externalId: args.externalId,
      fileName: args.fileName,
      fileSize: args.fileSize,
      idempotencyKey: args.idempotencyKey,
      jobId: args.jobId,
      mediaKind: args.mediaKind,
      partnerId: partner.partnerId,
      status: "active",
      updatedAt: now,
    });
    if (usage) {
      await ctx.db.patch(usage._id, { reviewsCreated: reviewsCreated + 1, updatedAt: now });
    } else {
      await ctx.db.insert("apiMonthlyUsage", {
        createdAt: now,
        monthKey,
        partnerId: partner.partnerId,
        reviewsCreated: 1,
        updatedAt: now,
      });
    }
    return {
      created: true,
      month_key: monthKey,
      monthly_limit: partner.monthlyReviewLimit,
      monthly_reviews_created: reviewsCreated + 1,
      review_id: args.jobId,
    };
  },
});

export const claimScanReview = mutation({
  args: {
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    apiKeyId: v.string(),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    contentFingerprint: v.string(),
    creativeName: v.optional(v.string()),
    externalAdId: v.string(),
    fieldsSha256: v.string(),
    fileName: v.string(),
    fileSize: v.number(),
    jobId: v.string(),
    mediaKind: v.string(),
    mediaSha256: v.string(),
    observationId: v.string(),
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_id", (q) => q.eq("keyId", args.apiKeyId))
      .unique();
    if (!partner || partner.status !== "active" || !key || key.status !== "active") {
      throw new Error("API credentials are no longer active");
    }
    if (key.partnerId !== partner.partnerId || !key.scopes.includes("scans:write")) {
      throw new Error("API key is not permitted to submit creative scans");
    }

    const current = await ctx.db
      .query("apiScanAds")
      .withIndex("by_partner_id_and_external_ad_id", (q) =>
        q.eq("partnerId", partner.partnerId).eq("externalAdId", args.externalAdId)
      )
      .unique();
    const now = Date.now();
    const previousContentFingerprint = current?.contentFingerprint;
    let reusable = false;
    if (current?.contentFingerprint === args.contentFingerprint) {
      const [link, review] = await Promise.all([
        ctx.db
          .query("apiReviewLinks")
          .withIndex("by_job_id", (q) => q.eq("jobId", current.currentReviewId))
          .unique(),
        ctx.db
          .query("reviews")
          .withIndex("by_job_id", (q) => q.eq("jobId", current.currentReviewId))
          .unique(),
      ]);
      reusable = Boolean(
        link
        && link.partnerId === partner.partnerId
        && (link.status === "active" || link.status === "complete")
        && review?.deletedAt === undefined
        && review?.status !== "failed"
      );
    }

    if (current && reusable) {
      await ctx.db.insert("apiScanObservations", {
        apiKeyId: key.keyId,
        changeStatus: "unchanged",
        contentFingerprint: args.contentFingerprint,
        externalAdId: args.externalAdId,
        expiresAt: now + partner.retentionDays * 24 * 60 * 60 * 1000,
        fieldsSha256: args.fieldsSha256,
        mediaSha256: args.mediaSha256,
        observationId: args.observationId,
        observedAt: now,
        partnerId: partner.partnerId,
        previousContentFingerprint,
        reviewCreated: false,
        reviewId: current.currentReviewId,
      });
      await ctx.db.patch(current._id, {
        accountId: args.accountId,
        accountName: args.accountName,
        adSetId: args.adSetId,
        adSetName: args.adSetName,
        apiKeyId: key.keyId,
        campaignId: args.campaignId,
        campaignName: args.campaignName,
        creativeName: args.creativeName,
        lastObservedAt: now,
        scanCount: current.scanCount + 1,
      });
      return {
        change_status: "unchanged",
        content_fingerprint: args.contentFingerprint,
        created: false,
        fields_sha256: args.fieldsSha256,
        media_sha256: args.mediaSha256,
        observation_id: args.observationId,
        observed_at: now,
        previous_content_fingerprint: previousContentFingerprint ?? null,
        review_id: current.currentReviewId,
      };
    }

    if (!partner.unlimitedConcurrency) {
      const active = await ctx.db
        .query("apiReviewLinks")
        .withIndex("by_partner_id_and_status_and_created_at", (q) =>
          q.eq("partnerId", partner.partnerId).eq("status", "active")
        )
        .take(partner.concurrentReviewLimit);
      if (active.length >= partner.concurrentReviewLimit) {
        throw new Error("Concurrent review limit reached");
      }
    }
    const monthKey = new Date(now).toISOString().slice(0, 7);
    const usage = await ctx.db
      .query("apiMonthlyUsage")
      .withIndex("by_partner_id_and_month_key", (q) =>
        q.eq("partnerId", partner.partnerId).eq("monthKey", monthKey)
      )
      .unique();
    const reviewsCreated = usage?.reviewsCreated ?? 0;
    if (!partner.unlimitedReviews && reviewsCreated >= partner.monthlyReviewLimit) {
      throw new Error("Monthly review limit reached");
    }
    const existingJob = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (existingJob) throw new Error("Review ID already exists");

    let changeStatus:
      | "new"
      | "media_changed"
      | "fields_changed"
      | "media_and_fields_changed"
      | "retry";
    if (!current) changeStatus = "new";
    else if (current.contentFingerprint === args.contentFingerprint) changeStatus = "retry";
    else if (current.mediaSha256 !== args.mediaSha256 && current.fieldsSha256 !== args.fieldsSha256) {
      changeStatus = "media_and_fields_changed";
    } else if (current.mediaSha256 !== args.mediaSha256) changeStatus = "media_changed";
    else changeStatus = "fields_changed";

    await ctx.db.insert("apiReviewLinks", {
      apiKeyId: key.keyId,
      createdAt: now,
      creativeName: args.creativeName,
      externalId: args.externalAdId,
      fileName: args.fileName,
      fileSize: args.fileSize,
      jobId: args.jobId,
      mediaKind: args.mediaKind,
      partnerId: partner.partnerId,
      status: "active",
      updatedAt: now,
    });
    if (usage) {
      await ctx.db.patch(usage._id, { reviewsCreated: reviewsCreated + 1, updatedAt: now });
    } else {
      await ctx.db.insert("apiMonthlyUsage", {
        createdAt: now,
        monthKey,
        partnerId: partner.partnerId,
        reviewsCreated: 1,
        updatedAt: now,
      });
    }
    const scanValue = {
      accountId: args.accountId,
      accountName: args.accountName,
      adSetId: args.adSetId,
      adSetName: args.adSetName,
      apiKeyId: key.keyId,
      campaignId: args.campaignId,
      campaignName: args.campaignName,
      contentFingerprint: args.contentFingerprint,
      creativeName: args.creativeName,
      currentReviewId: args.jobId,
      externalAdId: args.externalAdId,
      fieldsSha256: args.fieldsSha256,
      lastObservedAt: now,
      mediaSha256: args.mediaSha256,
      partnerId: partner.partnerId,
    };
    if (current) {
      await ctx.db.patch(current._id, {
        ...scanValue,
        lastChangedAt: changeStatus === "retry" ? current.lastChangedAt : now,
        scanCount: current.scanCount + 1,
      });
    } else {
      await ctx.db.insert("apiScanAds", {
        ...scanValue,
        firstObservedAt: now,
        lastChangedAt: now,
        scanCount: 1,
      });
    }
    await ctx.db.insert("apiScanObservations", {
      apiKeyId: key.keyId,
      changeStatus,
      contentFingerprint: args.contentFingerprint,
      externalAdId: args.externalAdId,
      expiresAt: now + partner.retentionDays * 24 * 60 * 60 * 1000,
      fieldsSha256: args.fieldsSha256,
      mediaSha256: args.mediaSha256,
      observationId: args.observationId,
      observedAt: now,
      partnerId: partner.partnerId,
      previousContentFingerprint,
      reviewCreated: true,
      reviewId: args.jobId,
    });
    return {
      change_status: changeStatus,
      content_fingerprint: args.contentFingerprint,
      created: true,
      fields_sha256: args.fieldsSha256,
      media_sha256: args.mediaSha256,
      month_key: monthKey,
      monthly_limit: partner.monthlyReviewLimit,
      monthly_reviews_created: reviewsCreated + 1,
      observation_id: args.observationId,
      observed_at: now,
      previous_content_fingerprint: previousContentFingerprint ?? null,
      review_id: args.jobId,
    };
  },
});

export const getScanAd = query({
  args: { externalAdId: v.string(), partnerId: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const scan = await ctx.db
      .query("apiScanAds")
      .withIndex("by_partner_id_and_external_ad_id", (q) =>
        q.eq("partnerId", args.partnerId).eq("externalAdId", args.externalAdId)
      )
      .unique();
    return scan ? publicScanAd(scan) : null;
  },
});

export const listScanAds = query({
  args: {
    paginationOpts: paginationOptsValidator,
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const result = await ctx.db
      .query("apiScanAds")
      .withIndex("by_partner_id_and_last_observed_at", (q) => q.eq("partnerId", args.partnerId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(publicScanAd) };
  },
});

export const listScanObservations = query({
  args: {
    externalAdId: v.string(),
    paginationOpts: paginationOptsValidator,
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const result = await ctx.db
      .query("apiScanObservations")
      .withIndex("by_partner_id_and_external_ad_id_and_observed_at", (q) =>
        q.eq("partnerId", args.partnerId).eq("externalAdId", args.externalAdId)
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(publicScanObservation) };
  },
});

export const getReview = query({
  args: { jobId: v.string(), partnerId: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!link || link.partnerId !== args.partnerId) return null;
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    return publicReview(link, review);
  },
});

export const listReviews = query({
  args: {
    paginationOpts: paginationOptsValidator,
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const result = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_partner_id_and_created_at", (q) => q.eq("partnerId", args.partnerId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await Promise.all(result.page.map(async (link) => {
      const review = await ctx.db
        .query("reviews")
        .withIndex("by_job_id", (q) => q.eq("jobId", link.jobId))
        .unique();
      return publicReview(link, review);
    }));
    return { ...result, page };
  },
});

export const saveEvidence = mutation({
  args: {
    bundle: v.any(),
    jobId: v.string(),
    partnerId: v.string(),
    secret: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!link || link.partnerId !== args.partnerId) throw new Error("API review not found");
    const partner = await ctx.db
      .query("apiPartners")
      .withIndex("by_partner_id", (q) => q.eq("partnerId", args.partnerId))
      .unique();
    if (!partner) throw new Error("API partner not found");
    const existing = await ctx.db
      .query("apiEvidenceBundles")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    const now = Date.now();
    const expiresAt = now + partner.retentionDays * 24 * 60 * 60 * 1000;
    const value = {
      bundle: args.bundle,
      expiresAt,
      jobId: args.jobId,
      partnerId: args.partnerId,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("apiEvidenceBundles", { ...value, createdAt: now });
    return { expires_at: expiresAt, review_id: args.jobId };
  },
});

export const getEvidence = query({
  args: { jobId: v.string(), now: v.number(), partnerId: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!link || link.partnerId !== args.partnerId) return null;
    const evidence = await ctx.db
      .query("apiEvidenceBundles")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!evidence) return { bundle: null, expired: false, expires_at: null };
    if (evidence.expiresAt <= args.now) {
      return { bundle: null, expired: true, expires_at: evidence.expiresAt };
    }
    return { bundle: evidence.bundle, expired: false, expires_at: evidence.expiresAt };
  },
});

export const finalizeReview = mutation({
  args: { jobId: v.string(), secret: v.string(), status: v.union(v.literal("complete"), v.literal("failed")) },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!link) return { finalized: false, reason: "not_api_review" };
    return await finalizeReviewRecord(ctx, link, args.status);
  },
});

export const reconcileTerminalReviews = mutation({
  args: { limit: v.number(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const active = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_status_and_updated_at", (q) => q.eq("status", "active"))
      .order("asc")
      .take(Math.max(1, Math.min(args.limit, 100)));
    let finalized = 0;
    for (const link of active) {
      const review = await ctx.db
        .query("reviews")
        .withIndex("by_job_id", (q) => q.eq("jobId", link.jobId))
        .unique();
      if (
        review?.deletedAt === undefined
        && (review?.status === "complete" || review?.status === "failed")
      ) {
        await finalizeReviewRecord(ctx, link, review.status);
        finalized += 1;
      }
    }
    return { finalized };
  },
});

export const markReviewDeleted = mutation({
  args: { jobId: v.string(), partnerId: v.string(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const link = await ctx.db
      .query("apiReviewLinks")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!link || link.partnerId !== args.partnerId) throw new Error("API review not found");
    const evidence = await ctx.db
      .query("apiEvidenceBundles")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (evidence) await ctx.db.delete(evidence._id);
    const webhookDeliveries = await ctx.db
      .query("apiWebhookDeliveries")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const delivery of webhookDeliveries) await ctx.db.delete(delivery._id);
    await ctx.db.delete(link._id);
    const now = Date.now();
    return { deleted_at: now, review_id: args.jobId };
  },
});

export const claimWebhookDeliveries = mutation({
  args: { limit: v.number(), now: v.number(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = Math.max(1, Math.min(args.limit, 20));
    const expiredClaims = await ctx.db
      .query("apiWebhookDeliveries")
      .withIndex("by_status_and_lease_expires_at", (q) =>
        q.eq("status", "claimed").lte("leaseExpiresAt", args.now)
      )
      .take(limit);
    for (const delivery of expiredClaims) {
      if (delivery.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await ctx.db.patch(delivery._id, {
          claimId: undefined,
          lastError: delivery.lastError ?? "Webhook delivery lease expired after the final attempt",
          leaseExpiresAt: undefined,
          status: "failed",
          updatedAt: args.now,
        });
        continue;
      }
      await ctx.db.patch(delivery._id, {
        claimId: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: args.now,
        status: "pending",
        updatedAt: args.now,
      });
    }
    const deliveries = await ctx.db
      .query("apiWebhookDeliveries")
      .withIndex("by_status_and_next_attempt_at", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", args.now)
      )
      .take(limit);
    const claimed = [];
    for (const delivery of deliveries) {
      if (delivery.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await ctx.db.patch(delivery._id, {
          claimId: undefined,
          lastError: delivery.lastError ?? "Webhook delivery retry limit reached",
          leaseExpiresAt: undefined,
          status: "failed",
          updatedAt: args.now,
        });
        continue;
      }
      const partner = await ctx.db
        .query("apiPartners")
        .withIndex("by_partner_id", (q) => q.eq("partnerId", delivery.partnerId))
        .unique();
      if (!partner?.webhookUrl || !partner.webhookSigningSecret) {
        await ctx.db.patch(delivery._id, {
          lastError: "Webhook configuration is unavailable",
          status: "failed",
          updatedAt: args.now,
        });
        continue;
      }
      const attempts = delivery.attempts + 1;
      const claimId = crypto.randomUUID();
      await ctx.db.patch(delivery._id, {
        attempts,
        claimId,
        leaseExpiresAt: args.now + WEBHOOK_LEASE_MS,
        status: "claimed",
        updatedAt: args.now,
      });
      claimed.push({
        attempts,
        claim_id: claimId,
        delivery_id: delivery.deliveryId,
        event_type: delivery.eventType,
        payload: delivery.payload,
        signing_secret: partner.webhookSigningSecret,
        webhook_url: partner.webhookUrl,
      });
    }
    return claimed;
  },
});

export const completeWebhookDelivery = mutation({
  args: {
    claimId: v.optional(v.string()),
    deliveryId: v.string(),
    error: v.optional(v.string()),
    now: v.number(),
    responseStatus: v.optional(v.number()),
    secret: v.string(),
    success: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const delivery = await ctx.db
      .query("apiWebhookDeliveries")
      .withIndex("by_delivery_id", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (!delivery) throw new Error("Webhook delivery not found");
    const claimMatches = delivery.claimId !== undefined
      ? args.claimId === delivery.claimId
      : args.claimId === undefined;
    if (delivery.status !== "claimed" || !claimMatches) {
      return { stale: true, status: delivery.status };
    }
    if (args.success) {
      await ctx.db.patch(delivery._id, {
        claimId: undefined,
        lastError: undefined,
        leaseExpiresAt: undefined,
        responseStatus: args.responseStatus,
        status: "delivered",
        updatedAt: args.now,
      });
      return { status: "delivered" };
    }
    if (delivery.attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await ctx.db.patch(delivery._id, {
        claimId: undefined,
        lastError: args.error,
        leaseExpiresAt: undefined,
        responseStatus: args.responseStatus,
        status: "failed",
        updatedAt: args.now,
      });
      return { status: "failed" };
    }
    const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
    const nextAttemptAt = args.now + delays[Math.min(delivery.attempts - 1, delays.length - 1)];
    await ctx.db.patch(delivery._id, {
      claimId: undefined,
      lastError: args.error,
      leaseExpiresAt: undefined,
      nextAttemptAt,
      responseStatus: args.responseStatus,
      status: "pending",
      updatedAt: args.now,
    });
    return { next_attempt_at: nextAttemptAt, status: "pending" };
  },
});

export const tickState = query({
  args: { now: v.number(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const [pending, claimed, expiredEvidence, expiredScanObservations] = await Promise.all([
      ctx.db
        .query("apiWebhookDeliveries")
        .withIndex("by_status_and_next_attempt_at", (q) =>
          q.eq("status", "pending").lte("nextAttemptAt", args.now)
        )
        .take(1),
      ctx.db
        .query("apiWebhookDeliveries")
        .withIndex("by_status_and_lease_expires_at", (q) =>
          q.eq("status", "claimed").lte("leaseExpiresAt", args.now)
        )
        .take(1),
      ctx.db
        .query("apiEvidenceBundles")
        .withIndex("by_expires_at", (q) => q.lte("expiresAt", args.now))
        .take(1),
      ctx.db
        .query("apiScanObservations")
        .withIndex("by_expires_at", (q) => q.lte("expiresAt", args.now))
        .take(1),
    ]);
    return {
      needs_evidence_cleanup: expiredEvidence.length > 0 || expiredScanObservations.length > 0,
      needs_webhook_delivery: pending.length > 0 || claimed.length > 0,
    };
  },
});

export const pruneExpiredEvidence = mutation({
  args: { limit: v.number(), now: v.number(), secret: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const expired = await ctx.db
      .query("apiEvidenceBundles")
      .withIndex("by_expires_at", (q) => q.lte("expiresAt", args.now))
      .take(Math.max(1, Math.min(args.limit, 100)));
    for (const evidence of expired) await ctx.db.delete(evidence._id);
    const remaining = Math.max(0, Math.min(args.limit, 100) - expired.length);
    const expiredScanObservations = remaining > 0
      ? await ctx.db
        .query("apiScanObservations")
        .withIndex("by_expires_at", (q) => q.lte("expiresAt", args.now))
        .take(remaining)
      : [];
    for (const observation of expiredScanObservations) await ctx.db.delete(observation._id);
    return { removed: expired.length + expiredScanObservations.length };
  },
});
