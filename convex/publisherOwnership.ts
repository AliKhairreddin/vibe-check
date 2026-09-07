import type { MutationCtx } from './_generated/server';
export const DIGITAL_NUDGE_CLIENTS = ['kissterra', 'smart-financial', 'lead-economy', 'acp'];

// Legacy/internal reviews can contain several offers. Ownership is scoped by
// advertiser + job, so each advertiser sees its own Digital Nudge submission.
export async function attributeInternalReview(ctx: MutationCtx, clientId: string, jobId: string, createdAt: number) {
  if (!DIGITAL_NUDGE_CLIENTS.includes(clientId)) return;
  const existing = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', clientId).eq('jobId', jobId)).unique();
  if (existing) return;
  const apiOwner = await ctx.db.query('apiReviewLinks').withIndex('by_job_id', q => q.eq('jobId', jobId)).unique();
  if (apiOwner) return; // Partner API submissions retain their independent ownership.
  const publisherId = `digital-nudge-${clientId}`;
  const publisher = await ctx.db.query('publishers').withIndex('by_publisher_id', q => q.eq('publisherId', publisherId)).unique();
  if (!publisher) return;
  await ctx.db.insert('publisherSubmissions', { clientId, publisherId, jobId, createdAt, countsTowardUsage: false });
}
