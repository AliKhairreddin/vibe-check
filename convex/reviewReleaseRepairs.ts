import { v } from 'convex/values';
import { internalMutation } from './_generated/server.js';

// Verified production incident: the 20 NAGT creatives in the 61-item Oct 23
// Kissterra batch. Earlier failed attempts were already deleted and unreleased.
export const kissterraOctober23BatchId = '32d214fe1e5c42df90ccec9fdc1bfd40';
export const kissterraOctober23AgtTargets = [
  ['5c9f18cdbd5349199265b4e2eca0ea2a', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9609.mp4'],
  ['1131e20f0e3a4a91b50bdecc974babfb', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9613.mp4'],
  ['4c6946db52e54506a36c4b587770b158', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9614.mp4'],
  ['583df3d1976a4108b60bc280c7165615', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9615.mp4'],
  ['ee46d84918bc44d6b8d25c1a7526e636', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9617.mp4'],
  ['56c226d55b0149c09c6f1ff4eef7d414', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9621.mp4'],
  ['3f999aba3ef9435ca18467df5ac975b8', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9624.mp4'],
  ['4a088c7cc5674abfa7c9340b33b91156', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9627.mp4'],
  ['1a03e2b6c88745568a039c62330dcfa6', 'NAGT-CEL_VD_EN_AUTO_23.10_IB 9628.mp4'],
  ['e4c1dd1b3e9f493c99cf8f2863051ecc', 'NAGT-CEL_VD_EN_AUTO_CSK_23.10_IB 9625.mp4'],
  ['3eb37429cba0407ebd4b4f33b00ad577', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9610.mp4'],
  ['3e7293c49c9a432bb79de711b7f296d9', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9611.mp4'],
  ['d845e370d4034741b2d6b0952c27c37a', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9612.mp4'],
  ['c29a4d6a3f304488a9bd382e46e54f0b', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9616.mp4'],
  ['572c66bbbbb14659881966376df9dca3', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9618.mp4'],
  ['bb8ea2fddb2645918664d95f93cb5285', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9619.mp4'],
  ['46cb90901dba433ba98447a0a6eb7813', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9620.mp4'],
  ['eee835c82fae4f69a838b0814623e0a5', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9622.mp4'],
  ['9d96e11d1696431096aa224cc7d775f5', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9623.mp4'],
  ['3c860a8c88704715b766cf0c9930e16f', 'NAGT-CEL_VD_EN_AUTO_K_23.10_IB 9626.mp4'],
] as const;

// Operator-only, atomic and repeatable. No deletion or outbound notifications.
export const retractKissterraOctober23Agt = internalMutation({
  args: { dryRun: v.boolean() },
  returns: v.object({ batchId: v.string(), dryRun: v.boolean(), matched: v.number(), changed: v.number(), jobIds: v.array(v.string()) }),
  handler: async (ctx, { dryRun }) => {
    const batchId = kissterraOctober23BatchId;
    const batch = await ctx.db.query('reviewBatches').withIndex('by_batch_id', q => q.eq('batchId', batchId)).unique();
    const expected = new Map<string, string>(kissterraOctober23AgtTargets);
    const batchTargets = batch?.items.filter(item => /agt/i.test(item.fileName)) ?? [];
    if (!batch || batch.sourceLabel !== '23 Oct 2026 Auto' || batch.expectedCount !== 61 || batch.items.length !== 61
      || batchTargets.length !== expected.size || batchTargets.some(item => !item.jobId || expected.get(item.jobId) !== item.fileName)) {
      throw new Error('Kissterra batch did not match the verified retraction target');
    }
    // Validate every target and its access projection before changing anything.
    const targets = [];
    for (const [jobId, fileName] of expected) {
      const review = await ctx.db.query('reviews').withIndex('by_job_id', q => q.eq('jobId', jobId)).unique();
      const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', jobId).eq('offerId', 'kissterra')).unique();
      if (!review || review.batchId !== batchId || review.fileName !== fileName || review.deletedAt !== undefined
        || review.status !== 'complete' || !review.reportReady || !review.offerIds?.includes('kissterra')
        || !stat || stat.batchId !== batchId || stat.deletedAt !== undefined || stat.status !== 'complete') {
        throw new Error('Creative did not match the verified retraction target');
      }
      targets.push({ review, stat });
    }
    const now = Date.now();
    let changed = 0;
    for (const { review, stat } of targets) {
      const previousReleasedOfferIds = review.releasedOfferIds ?? review.offerIds ?? [];
      if (!previousReleasedOfferIds.includes('kissterra') && review.blockedReleaseOfferIds?.includes('kissterra') && stat.withheld) continue;
      changed++;
      if (dryRun) continue;
      await ctx.db.patch(review._id, {
        releasedOfferIds: previousReleasedOfferIds.filter(id => id !== 'kissterra'),
        blockedReleaseOfferIds: [...new Set([...(review.blockedReleaseOfferIds ?? []), 'kissterra'])],
        updatedAt: now,
      });
      await ctx.db.patch(stat._id, { withheld: true, updatedAt: now });
      await ctx.db.insert('reviewReleaseEvents', {
        jobId: review.jobId, offerIds: ['kissterra'], action: 'retract', previousReleasedOfferIds,
        releasedBy: 'admin:kissterra-oct23-agt-retraction', createdAt: now,
        reason: 'Accidental release of AGT/NAGT creatives in the 23 Oct 2026 Auto batch; block repeat release to Kissterra.',
      });
    }
    return { batchId, dryRun, matched: targets.length, changed, jobIds: [...expected.keys()] };
  },
});
