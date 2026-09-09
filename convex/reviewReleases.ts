import { v } from "convex/values";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel";
import { syncReviewOfferStats } from "./reviews.ts";

const scopeArgs = {
  secret: v.string(),
  clientId: v.optional(v.string()),
  publisherId: v.optional(v.string()),
};
const targetArgs = { jobIds: v.optional(v.array(v.string())), batchId: v.optional(v.string()) };
type Scope = { secret: string; clientId?: string; publisherId?: string };
type Target = { jobIds?: string[]; batchId?: string };

function authorize(args: Scope) {
  if (!process.env.CONVEX_HTTP_SECRET || args.secret !== process.env.CONVEX_HTTP_SECRET) throw new Error("Unauthorized");
  if (Boolean(args.publisherId) !== Boolean(args.clientId)) throw new Error("Invalid publisher scope");
}

async function selection(ctx: QueryCtx, args: Scope & Target) {
  authorize(args);
  if (Boolean(args.batchId) === Boolean(args.jobIds?.length)) throw new Error("Select creatives or a batch");
  const ids = [...new Set(args.jobIds ?? [])];
  if (ids.length > 100) throw new Error("Select up to 100 creatives");
  let reviews: Doc<"reviews">[];
  if (args.batchId) {
    const batch = await ctx.db.query("reviewBatches").withIndex("by_batch_id", q => q.eq("batchId", args.batchId!)).unique();
    if (!batch) throw new Error("Batch unavailable");
    if (batch.items.length < batch.expectedCount || batch.items.some(item => !["complete", "failed", "upload_failed"].includes(item.status))) {
      throw new Error("Wait for the batch to finish processing before release");
    }
    reviews = (await ctx.db.query("reviews").withIndex("by_batch_id", q => q.eq("batchId", args.batchId!)).take(101))
      .filter(review => review.deletedAt === undefined && review.status !== "failed");
  } else {
    const rows = await Promise.all(ids.map(jobId => ctx.db.query("reviews").withIndex("by_job_id", q => q.eq("jobId", jobId)).unique()));
    if (rows.some(row => !row || row.deletedAt !== undefined)) throw new Error("Creative unavailable");
    reviews = rows as Doc<"reviews">[];
  }
  if (!reviews.length || reviews.length > 100) throw new Error("Select between 1 and 100 completed creatives");
  for (const review of reviews) {
    if (review.status !== "complete" || !review.reportReady) throw new Error("Only completed creatives can be released");
    if (args.publisherId) {
      const owner = await ctx.db.query("publisherSubmissions")
        .withIndex("by_client_id_and_job_id", q => q.eq("clientId", args.clientId!).eq("jobId", review.jobId)).unique();
      if (owner?.publisherId !== args.publisherId) throw new Error("Creative unavailable");
    }
  }
  const stats = await Promise.all(reviews.map(review => ctx.db.query("reviewOfferStats")
    .withIndex("by_job_id", q => q.eq("jobId", review.jobId)).take(20)));
  const eligible = stats.map(rows => rows.filter(row => row.deletedAt === undefined && row.status === "complete" && row.resultStatus && (!args.clientId || row.offerId === args.clientId)));
  return { reviews, eligible };
}

export const getSelection = query({
  args: { ...scopeArgs, ...targetArgs },
  returns: v.object({
    job_ids: v.array(v.string()),
    offers: v.array(v.object({ offer_id: v.string(), offer_name: v.string(), total: v.number(), pending: v.number() })),
  }),
  handler: async (ctx, args) => {
    const { reviews, eligible } = await selection(ctx, args);
    const offers = [];
    for (const offerId of [...new Set(eligible.flatMap(rows => rows.map(row => row.offerId)))].sort()) {
      const profile = await ctx.db.query("offerProfiles").withIndex("by_offer_id", q => q.eq("offerId", offerId)).unique();
      const matching = eligible.flatMap(rows => rows.filter(row => row.offerId === offerId));
      offers.push({ offer_id: offerId, offer_name: profile?.displayName ?? offerId, total: matching.length, pending: matching.filter(row => row.withheld).length });
    }
    return { job_ids: reviews.map(review => review.jobId), offers };
  },
});

export const release = mutation({
  args: { ...scopeArgs, jobIds: v.array(v.string()), offerIds: v.array(v.string()), confirmed: v.boolean(), releasedBy: v.string() },
  returns: v.object({ released: v.number(), offer_ids: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const { reviews, eligible } = await selection(ctx, args);
    if (!args.confirmed) throw new Error("Confirm the release before continuing");
    const offerIds = [...new Set(args.offerIds)];
    if (!offerIds.length || offerIds.some(id => !eligible.some(rows => rows.some(row => row.offerId === id)))) {
      throw new Error("Choose offers that were evaluated for these creatives");
    }
    let released = 0;
    const now = Date.now();
    for (const [index, review] of reviews.entries()) {
      const additions = eligible[index].filter(row => row.withheld && offerIds.includes(row.offerId)).map(row => row.offerId);
      if (!additions.length) continue;
      const releasedOfferIds = [...new Set([...(review.releasedOfferIds ?? review.offerIds ?? []), ...additions])];
      const patch = { releasedOfferIds, releasedAt: review.releasedAt ?? now, updatedAt: now };
      await ctx.db.patch(review._id, patch);
      for (const stat of eligible[index]) {
        if (additions.includes(stat.offerId)) await ctx.db.patch(stat._id, { withheld: undefined, updatedAt: now });
      }
      await ctx.db.insert("reviewReleaseEvents", { jobId: review.jobId, offerIds: additions, releasedBy: args.publisherId ? `publisher:${args.publisherId}` : args.releasedBy, createdAt: now });
      released += additions.length;
    }
    return { released, offer_ids: offerIds };
  },
});

// One-time operator repair requested for the September 8 SmartFinancial auto upload.
// Internal only: the publisher release API is additive and cannot recall a release.
export const restrictSmartFinancialAutoBatch = internalMutation({
  args: {},
  returns: v.object({ batch_id: v.string(), job_ids: v.array(v.string()), visible_offer_ids: v.array(v.string()) }),
  handler: async ctx => {
    const batchId = "676aee6dedc94bf0be11f0eeff8e297b";
    const rows = await ctx.db.query("reviews").withIndex("by_batch_id", q => q.eq("batchId", batchId)).take(4);
    const expected = new Set(["SFI_IM_EN_AUTO_0001.jpeg", "SFI_VD_EN_AUTO_0004.mp4", "SFI_VD_EN_AUTO_0005.mp4"]);
    if (rows.length !== 3 || rows.some(row => !expected.delete(row.fileName) || row.deletedAt !== undefined || row.status !== "complete" || !row.offerIds?.includes("smart-financial"))) {
      throw new Error("SmartFinancial batch did not match the verified repair target");
    }
    const now = Date.now();
    for (const row of rows) {
      if (row.releasedOfferIds?.length === 1 && row.releasedOfferIds[0] === "smart-financial") continue;
      const patch = { releasedOfferIds: ["smart-financial"], releasedAt: row.releasedAt ?? now, updatedAt: now };
      await ctx.db.patch(row._id, patch);
      await syncReviewOfferStats(ctx, { ...row, ...patch }, now);
      await ctx.db.insert("reviewReleaseEvents", { jobId: row.jobId, offerIds: ["smart-financial"], releasedBy: "admin:smart-financial-visibility-repair", createdAt: now });
    }
    return { batch_id: batchId, job_ids: rows.map(row => row.jobId), visible_offer_ids: ["smart-financial"] };
  },
});
