import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const RECOVERY_GRACE_MS = 3 * 60_000;
// Older containers did not record ownership. Allow their maximum job deadline
// to pass before treating an unchanged review as abandoned during rollout.
const LEGACY_RECOVERY_GRACE_MS = 2 * 60 * 60_000;
const INTERRUPTIBLE_STATUSES = [
  "queued",
  "downloading_from_drive",
  "processing_video",
  "processing_image",
  "extracting_audio",
  "extracting_frames",
  "running_ocr",
  "analyzing_visuals",
  "preparing_transcript",
  "reviewing_with_llm",
];

export async function isInterrupted(
  ctx: QueryCtx,
  review: Doc<"reviews">,
  now: number,
  idleInstanceId?: string,
  liveOwners?: Map<string, boolean>,
): Promise<boolean> {
  if (review.deletedAt !== undefined || review.automationRunId !== undefined
    || review.apiBatchId !== undefined || !INTERRUPTIBLE_STATUSES.includes(review.status)
    || review.updatedAt > now - RECOVERY_GRACE_MS) return false;
  if (!review.processingInstanceId) {
    return review.updatedAt <= now - LEGACY_RECOVERY_GRACE_MS;
  }
  // The caller may recover its own abandoned jobs only after its queue is idle.
  if (review.processingInstanceId === idleInstanceId) return true;
  const knownLive = liveOwners?.get(review.processingInstanceId);
  if (knownLive !== undefined) return !knownLive;
  const owner = await ctx.db.query("platformInstances")
    .withIndex("by_instance_id", q => q.eq("instanceId", review.processingInstanceId!))
    .unique();
  const live = Boolean(owner && owner.updatedAt > now - RECOVERY_GRACE_MS);
  liveOwners?.set(review.processingInstanceId, live);
  return !live;
}

export async function interruptedReviews(ctx: QueryCtx, limit: number, now: number, idleInstanceId?: string) {
  const reviews = [];
  const liveOwners = new Map<string, boolean>();
  for (const status of INTERRUPTIBLE_STATUSES) {
    const remaining = limit - reviews.length;
    if (remaining <= 0) break;
    const matches = await ctx.db
      .query("reviews")
      .withIndex("by_status_deleted_automation_api_batch_updated", (query) =>
        query
          .eq("status", status)
          .eq("deletedAt", undefined)
          .eq("automationRunId", undefined)
          .eq("apiBatchId", undefined)
          .lte("updatedAt", now - RECOVERY_GRACE_MS)
      )
      .order("asc")
      .take(500);
    for (const review of matches) {
      if (await isInterrupted(ctx, review, now, idleInstanceId, liveOwners)) reviews.push(review);
      if (reviews.length >= limit) break;
    }
  }
  return reviews;
}
