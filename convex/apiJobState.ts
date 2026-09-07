import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export function executionStatus(status: string): "queued" | "processing" | "completed" | "failed" {
  if (status === "queued") return "queued";
  if (status === "complete" || status === "completed") return "completed";
  if (status === "failed" || status === "deleted") return "failed";
  return "processing";
}

export async function assertApiLease(ctx: QueryCtx, jobId: string, leaseId?: string) {
  const link = await ctx.db.query("apiReviewLinks")
    .withIndex("by_job_id", q => q.eq("jobId", jobId)).unique();
  if (link?.queueManaged && (
    !leaseId || link.leaseId !== leaseId || link.status !== "active"
    || (link.availableAt ?? 0) <= Date.now()
  )) throw new Error("API job lease is no longer active");
  return link;
}

// Kept on the ownership row so card polling never reads transcripts or reports.
export async function syncApiJobState(
  ctx: MutationCtx,
  link: Doc<"apiReviewLinks"> | null,
  review: { status: string; progress?: number; message?: string; reportReady?: boolean; fileName?: string; fileSize?: number },
  report?: unknown,
) {
  if (!link) return;
  const status = executionStatus(review.status);
  let resultColor = link.resultColor;
  let findingCount = link.findingCount;
  if (report && typeof report === "object") {
    const parent = report as Record<string, unknown>;
    const results = Array.isArray(parent.offer_results) ? parent.offer_results as Record<string, unknown>[] : [];
    const selected = results.find(r => r.offer_id === link.requestedOfferId) ?? parent;
    const color = selected.overall_status;
    resultColor = color === "amber" || color === "orange" ? "yellow"
      : color === "green" || color === "yellow" || color === "red" ? color : undefined;
    findingCount = Array.isArray(selected.findings) ? selected.findings.length : undefined;
  }
  await ctx.db.patch(link._id, {
    executionStatus: status,
    progress: review.progress ?? link.progress ?? 0,
    message: review.message ?? link.message ?? "",
    reportReady: review.reportReady ?? link.reportReady ?? false,
    fileName: review.fileName ?? link.fileName,
    fileSize: review.fileSize ?? link.fileSize,
    resultColor,
    findingCount,
    updatedAt: Date.now(),
  });
}

export function assetCard(link: Doc<"apiReviewLinks">) {
  const status = link.status === "deleted" ? "failed" : link.executionStatus ?? (link.status === "active" ? "queued" : executionStatus(link.status));
  const ready = status === "completed" && Boolean(link.reportReady);
  return {
    asset_id: link.externalId ?? null,
    job_id: link.batchId ?? link.jobId,
    review_id: link.jobId,
    creative_name: link.creativeName ?? null,
    offer_id: link.requestedOfferId ?? null,
    offer_name: link.offerName ?? null,
    status,
    color: ready ? link.resultColor ?? null : null,
    clean: ready && link.resultColor ? link.resultColor === "green" && link.findingCount === 0 : null,
    finding_count: ready ? link.findingCount ?? null : null,
    report_ready: ready,
    progress: link.progress ?? 0,
    message: link.message ?? "Queued for processing",
    status_url: `/api/v1/jobs/${link.batchId ?? link.jobId}`,
    result_url: `/api/v1/assets/${encodeURIComponent(link.externalId ?? "")}/result?review_id=${link.jobId}`,
    updated_at: link.updatedAt,
  };
}
