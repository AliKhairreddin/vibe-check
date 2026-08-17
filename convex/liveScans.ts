import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

type ResultStatus = "green" | "yellow" | "red";
type ReviewKind = "creative" | "copy";

const CLAIM_LEASE_MS = 15 * 60 * 1000;
const MAX_AD_IDS = 500;
const MAX_NAMES = 100;

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function normalizeResultStatus(status: unknown): ResultStatus | null {
  if (status === "green" || status === "yellow" || status === "red") {
    return status;
  }
  if (status === "amber" || status === "orange") return "yellow";
  if (status === "pass") return "green";
  if (status === "needs_review") return "yellow";
  if (status === "likely_violation") return "red";
  return null;
}

function overallStatus(report: unknown): ResultStatus | null {
  if (!report || typeof report !== "object") return null;
  return normalizeResultStatus((report as { overall_status?: unknown }).overall_status);
}

function mergeStrings(current: string[], incoming: string[], limit: number) {
  return [...new Set([...current, ...incoming].filter(Boolean))].slice(0, limit);
}

async function findReview(ctx: QueryCtx | MutationCtx, jobId: string) {
  const review = await ctx.db
    .query("reviews")
    .withIndex("by_job_id", (builder) => builder.eq("jobId", jobId))
    .unique();
  return review?.deletedAt === undefined ? review : null;
}

async function findHistoricalCreativeReview(ctx: MutationCtx, key: string) {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_file_name", (builder) => builder.eq("fileName", key))
    .collect();
  return reviews
    .sort((left, right) => right.createdAt - left.createdAt)
    .find((review) =>
      review.deletedAt === undefined
      && review.status === "complete"
      && review.reportReady
      && (review.hasCreative ?? true)
    ) ?? null;
}

async function getClaim(ctx: QueryCtx | MutationCtx, kind: ReviewKind, key: string) {
  return ctx.db
    .query("liveScanReviewClaims")
    .withIndex("by_kind_key", (builder) => builder.eq("kind", kind).eq("key", key))
    .unique();
}

export const claimReview = mutation({
  args: {
    displayName: v.string(),
    jobId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("creative"), v.literal("copy")),
    secret: v.string(),
    startReview: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    let claim = await getClaim(ctx, args.kind, args.key);

    if (!claim && args.kind === "creative") {
      const historical = await findHistoricalCreativeReview(ctx, args.key);
      if (historical) {
        const claimId = await ctx.db.insert("liveScanReviewClaims", {
          createdAt: now,
          displayName: args.displayName,
          jobId: historical.jobId,
          key: args.key,
          kind: args.kind,
          result: overallStatus(historical.report) ?? undefined,
          status: "complete",
          updatedAt: now,
        });
        claim = await ctx.db.get(claimId);
      }
    }

    if (!claim) {
      const status = args.startReview ? "claiming" : "waiting_media";
      const claimId = await ctx.db.insert("liveScanReviewClaims", {
        createdAt: now,
        displayName: args.displayName,
        jobId: args.jobId,
        key: args.key,
        kind: args.kind,
        leaseExpiresAt: args.startReview ? now + CLAIM_LEASE_MS : undefined,
        status,
        updatedAt: now,
      });
      claim = await ctx.db.get(claimId);
      return {
        job_id: args.jobId,
        needs_media: status === "waiting_media",
        result: null,
        should_submit: args.startReview,
        status,
      };
    }

    const review = await findReview(ctx, claim.jobId);
    const status = review?.status ?? claim.status;
    const result = overallStatus(review?.report) ?? claim.result ?? null;
    const leaseExpired = (claim.leaseExpiresAt ?? 0) <= now;
    const canRetry = status === "failed"
      || (status === "claiming" && leaseExpired)
      || (status === "complete" && !review);
    const canStartWaitingMedia = args.startReview && status === "waiting_media";

    if (canRetry && !args.startReview) {
      await ctx.db.patch(claim._id, {
        displayName: args.displayName,
        jobId: args.jobId,
        leaseExpiresAt: undefined,
        result: undefined,
        status: "waiting_media",
        updatedAt: now,
      });
      return {
        job_id: args.jobId,
        needs_media: true,
        result: null,
        should_submit: false,
        status: "waiting_media",
      };
    }

    if (canRetry || canStartWaitingMedia) {
      await ctx.db.patch(claim._id, {
        displayName: args.displayName,
        jobId: args.jobId,
        leaseExpiresAt: now + CLAIM_LEASE_MS,
        result: undefined,
        status: "claiming",
        updatedAt: now,
      });
      return {
        job_id: args.jobId,
        needs_media: false,
        result: null,
        should_submit: true,
        status: "claiming",
      };
    }

    if (claim.displayName !== args.displayName) {
      await ctx.db.patch(claim._id, { displayName: args.displayName, updatedAt: now });
    }
    return {
      job_id: claim.jobId,
      needs_media: status === "waiting_media",
      result,
      should_submit: false,
      status,
    };
  },
});

export const markReviewQueued = mutation({
  args: {
    jobId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("creative"), v.literal("copy")),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const claim = await getClaim(ctx, args.kind, args.key);
    if (!claim || claim.jobId !== args.jobId) throw new Error("Live review claim not found");
    await ctx.db.patch(claim._id, {
      leaseExpiresAt: undefined,
      status: "queued",
      updatedAt: Date.now(),
    });
  },
});

export const finishReview = mutation({
  args: {
    jobId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("creative"), v.literal("copy")),
    result: v.optional(v.union(
      v.literal("green"),
      v.literal("amber"),
      v.literal("yellow"),
      v.literal("red")
    )),
    secret: v.string(),
    status: v.union(v.literal("complete"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const claim = await getClaim(ctx, args.kind, args.key);
    if (!claim || claim.jobId !== args.jobId) return null;
    const result = normalizeResultStatus(args.result);
    await ctx.db.patch(claim._id, {
      leaseExpiresAt: undefined,
      result: result ?? undefined,
      status: args.status,
      updatedAt: Date.now(),
    });
    return {
      display_name: claim.displayName,
      job_id: claim.jobId,
      key: claim.key,
      kind: claim.kind,
      result,
      status: args.status,
    };
  },
});

export const releaseReview = mutation({
  args: {
    jobId: v.string(),
    key: v.string(),
    kind: v.union(v.literal("creative"), v.literal("copy")),
    message: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const claim = await getClaim(ctx, args.kind, args.key);
    if (!claim || claim.jobId !== args.jobId) return;
    await ctx.db.patch(claim._id, {
      leaseExpiresAt: undefined,
      status: "failed",
      updatedAt: Date.now(),
    });
  },
});

const creativeObservation = v.object({
  adCount: v.number(),
  adIds: v.array(v.string()),
  adSetNames: v.array(v.string()),
  campaignNames: v.array(v.string()),
  creativeKey: v.string(),
  creativeName: v.string(),
  deliveryStatuses: v.array(v.string()),
});

const copyObservation = v.object({
  adCount: v.number(),
  adIds: v.array(v.string()),
  copyKey: v.string(),
  creativeKey: v.string(),
  creativeName: v.string(),
  primaryText: v.string(),
});

export const observe = mutation({
  args: {
    accountId: v.string(),
    accountName: v.string(),
    copies: v.array(copyObservation),
    creatives: v.array(creativeObservation),
    observationDate: v.string(),
    observedAdIds: v.array(v.string()),
    observedAt: v.number(),
    secret: v.string(),
    sourceUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const account = await ctx.db
      .query("liveScanAccounts")
      .withIndex("by_date_account", (builder) =>
        builder.eq("observationDate", args.observationDate).eq("accountId", args.accountId)
      )
      .unique();
    if (account) {
      await ctx.db.patch(account._id, {
        accountName: args.accountName || account.accountName,
        lastObservedAt: Math.max(account.lastObservedAt, args.observedAt),
        scanCount: account.scanCount + 1,
        sourceUrl: args.sourceUrl ?? account.sourceUrl,
      });
    } else {
      await ctx.db.insert("liveScanAccounts", {
        accountId: args.accountId,
        accountName: args.accountName,
        firstObservedAt: args.observedAt,
        lastObservedAt: args.observedAt,
        observationDate: args.observationDate,
        scanCount: 1,
        sourceUrl: args.sourceUrl,
      });
    }

    const observedAdIds = new Set(args.observedAdIds);
    const liveCreativeByAd = new Map<string, string>();
    for (const creative of args.creatives) {
      for (const adId of creative.adIds) liveCreativeByAd.set(adId, creative.creativeKey);
    }
    const liveCopyKeysByAd = new Map<string, Set<string>>();
    for (const copy of args.copies) {
      for (const adId of copy.adIds) {
        const keys = liveCopyKeysByAd.get(adId) ?? new Set<string>();
        keys.add(copy.copyKey);
        liveCopyKeysByAd.set(adId, keys);
      }
    }
    const [storedCreatives, storedCopies] = await Promise.all([
      ctx.db
        .query("liveScanCreatives")
        .withIndex("by_date_account", (builder) =>
          builder.eq("observationDate", args.observationDate).eq("accountId", args.accountId)
        )
        .collect(),
      ctx.db
        .query("liveScanCopies")
        .withIndex("by_date_account", (builder) =>
          builder.eq("observationDate", args.observationDate).eq("accountId", args.accountId)
        )
        .collect(),
    ]);
    for (const existing of storedCreatives) {
      const adIds = existing.adIds.filter((adId) =>
        !observedAdIds.has(adId)
        || liveCreativeByAd.get(adId) === existing.creativeKey
      );
      if (adIds.length !== existing.adIds.length) {
        await ctx.db.patch(existing._id, { adCount: adIds.length, adIds });
      }
    }
    for (const existing of storedCopies) {
      const adIds = existing.adIds.filter((adId) => {
        if (!observedAdIds.has(adId)) return true;
        if (liveCreativeByAd.get(adId) !== existing.creativeKey) return false;
        const capturedCopyKeys = liveCopyKeysByAd.get(adId);
        return capturedCopyKeys === undefined || capturedCopyKeys.has(existing.copyKey);
      });
      if (adIds.length !== existing.adIds.length) {
        await ctx.db.patch(existing._id, { adCount: adIds.length, adIds });
      }
    }

    for (const value of args.creatives) {
      const existing = await ctx.db
        .query("liveScanCreatives")
        .withIndex("by_date_account_creative", (builder) =>
          builder
            .eq("observationDate", args.observationDate)
            .eq("accountId", args.accountId)
            .eq("creativeKey", value.creativeKey)
        )
        .unique();
      if (existing) {
        const adIds = mergeStrings(existing.adIds, value.adIds, MAX_AD_IDS);
        await ctx.db.patch(existing._id, {
          adCount: adIds.length,
          adIds,
          adSetNames: mergeStrings(existing.adSetNames, value.adSetNames, MAX_NAMES),
          campaignNames: mergeStrings(existing.campaignNames, value.campaignNames, MAX_NAMES),
          creativeName: value.creativeName,
          deliveryStatuses: mergeStrings(
            existing.deliveryStatuses,
            value.deliveryStatuses,
            MAX_NAMES
          ),
          lastObservedAt: Math.max(existing.lastObservedAt, args.observedAt),
        });
      } else {
        await ctx.db.insert("liveScanCreatives", {
          accountId: args.accountId,
          adCount: mergeStrings([], value.adIds, MAX_AD_IDS).length,
          adIds: mergeStrings([], value.adIds, MAX_AD_IDS),
          adSetNames: mergeStrings([], value.adSetNames, MAX_NAMES),
          campaignNames: mergeStrings([], value.campaignNames, MAX_NAMES),
          creativeKey: value.creativeKey,
          creativeName: value.creativeName,
          deliveryStatuses: mergeStrings([], value.deliveryStatuses, MAX_NAMES),
          firstObservedAt: args.observedAt,
          lastObservedAt: args.observedAt,
          observationDate: args.observationDate,
        });
      }
    }

    for (const value of args.copies) {
      const existing = await ctx.db
        .query("liveScanCopies")
        .withIndex("by_date_account_creative_copy", (builder) =>
          builder
            .eq("observationDate", args.observationDate)
            .eq("accountId", args.accountId)
            .eq("creativeKey", value.creativeKey)
            .eq("copyKey", value.copyKey)
        )
        .unique();
      if (existing) {
        const adIds = mergeStrings(existing.adIds, value.adIds, MAX_AD_IDS);
        await ctx.db.patch(existing._id, {
          adCount: adIds.length,
          adIds,
          creativeName: value.creativeName,
          lastObservedAt: Math.max(existing.lastObservedAt, args.observedAt),
          primaryText: value.primaryText,
        });
      } else {
        await ctx.db.insert("liveScanCopies", {
          accountId: args.accountId,
          adCount: mergeStrings([], value.adIds, MAX_AD_IDS).length,
          adIds: mergeStrings([], value.adIds, MAX_AD_IDS),
          copyKey: value.copyKey,
          creativeKey: value.creativeKey,
          creativeName: value.creativeName,
          firstObservedAt: args.observedAt,
          lastObservedAt: args.observedAt,
          observationDate: args.observationDate,
          primaryText: value.primaryText,
        });
      }
    }

    return {
      account_id: args.accountId,
      observation_date: args.observationDate,
      observed_at: args.observedAt,
    };
  },
});

async function reviewState(ctx: QueryCtx, kind: ReviewKind, key: string) {
  const claim = await getClaim(ctx, kind, key);
  if (!claim) {
    return {
      job_id: null,
      message: "",
      progress: 0,
      result: null,
      status: kind === "creative" ? "waiting_media" : "not_submitted",
    };
  }
  const review = await findReview(ctx, claim.jobId);
  return {
    job_id: claim.jobId,
    message: review?.message ?? "",
    progress: review?.progress ?? (claim.status === "complete" ? 100 : 0),
    result: overallStatus(review?.report) ?? normalizeResultStatus(claim.result) ?? null,
    status: review?.status ?? claim.status,
  };
}

export const getDay = query({
  args: {
    observationDate: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const [accounts, creatives, copies] = await Promise.all([
      ctx.db
        .query("liveScanAccounts")
        .withIndex("by_date", (builder) => builder.eq("observationDate", args.observationDate))
        .collect(),
      ctx.db
        .query("liveScanCreatives")
        .withIndex("by_date", (builder) => builder.eq("observationDate", args.observationDate))
        .collect(),
      ctx.db
        .query("liveScanCopies")
        .withIndex("by_date", (builder) => builder.eq("observationDate", args.observationDate))
        .collect(),
    ]);
    const activeCreatives = creatives.filter((creative) => creative.adCount > 0);
    const activeCopies = copies.filter((copy) => copy.adCount > 0);

    const creativeStates = new Map<string, Awaited<ReturnType<typeof reviewState>>>();
    for (const key of new Set(activeCreatives.map((creative) => creative.creativeKey))) {
      creativeStates.set(key, await reviewState(ctx, "creative", key));
    }
    const copyStates = new Map<string, Awaited<ReturnType<typeof reviewState>>>();
    for (const key of new Set(activeCopies.map((copy) => copy.copyKey))) {
      copyStates.set(key, await reviewState(ctx, "copy", key));
    }

    const publicAccounts = accounts
      .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
      .map((account) => {
        const accountCreatives = activeCreatives
          .filter((creative) => creative.accountId === account.accountId)
          .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
          .map((creative) => ({
            ad_count: creative.adCount,
            ad_ids: creative.adIds,
            ad_set_names: creative.adSetNames,
            campaign_names: creative.campaignNames,
            copies: activeCopies
              .filter((copy) =>
                copy.accountId === account.accountId
                && copy.creativeKey === creative.creativeKey
              )
              .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
              .map((copy) => ({
                ad_count: copy.adCount,
                ad_ids: copy.adIds,
                copy_key: copy.copyKey,
                first_observed_at: copy.firstObservedAt,
                last_observed_at: copy.lastObservedAt,
                primary_text: copy.primaryText,
                review: copyStates.get(copy.copyKey),
              })),
            creative_key: creative.creativeKey,
            creative_name: creative.creativeName,
            delivery_statuses: creative.deliveryStatuses,
            first_observed_at: creative.firstObservedAt,
            last_observed_at: creative.lastObservedAt,
            review: creativeStates.get(creative.creativeKey),
          }));
        const accountAdIds = new Set(accountCreatives.flatMap((creative) => creative.ad_ids));
        return {
          account_id: account.accountId,
          account_name: account.accountName,
          creatives: accountCreatives,
          first_observed_at: account.firstObservedAt,
          last_observed_at: account.lastObservedAt,
          live_ad_count: accountAdIds.size || accountCreatives.reduce(
            (total, creative) => total + creative.ad_count,
            0
          ),
          scan_count: account.scanCount,
          source_url: account.sourceUrl ?? null,
        };
      });

    const uniqueCreativeKeys = new Set(activeCreatives.map((creative) => creative.creativeKey));
    const uniqueCopyKeys = new Set(activeCopies.map((copy) => copy.copyKey));
    const liveAdKeys = new Set(activeCreatives.flatMap((creative) =>
      creative.adIds.map((adId) => `${creative.accountId}:${adId}`)
    ));
    const uniqueStates = [
      ...[...uniqueCreativeKeys].map((key) => creativeStates.get(key)),
      ...[...uniqueCopyKeys].map((key) => copyStates.get(key)),
    ].filter((state): state is NonNullable<typeof state> => Boolean(state));
    const outcomes = { green: 0, yellow: 0, red: 0 };
    let pending = 0;
    for (const state of uniqueStates) {
      const result = normalizeResultStatus(state.result);
      if (result) outcomes[result] += 1;
      else if (state.status !== "failed") pending += 1;
    }

    return {
      accounts: publicAccounts,
      observation_date: args.observationDate,
      totals: {
        accounts_observed: accounts.length,
        copy_variants: uniqueCopyKeys.size,
        live_ads: liveAdKeys.size || publicAccounts.reduce(
          (total, account) => total + account.live_ad_count,
          0
        ),
        outcomes,
        pending,
        unique_creatives: uniqueCreativeKeys.size,
      },
    };
  },
});
