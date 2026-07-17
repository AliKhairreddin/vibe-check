import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const AUTOMATION_RUN_LEASE_MS = 30 * 60 * 1000;
const MAX_AUTOMATION_RUN_ATTEMPTS = 3;
const TERMINAL_BATCH_STATUSES = new Set(["complete", "failed", "upload_failed"]);

const automationFields = {
  automationId: v.string(),
  daysOfWeek: v.array(v.number()),
  driveFolderId: v.string(),
  enabled: v.boolean(),
  fileNamePattern: v.string(),
  includeSubfolders: v.boolean(),
  localTime: v.string(),
  name: v.string(),
  timeZone: v.string(),
};

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

function publicAutomation(automation: {
  automationId: string;
  createdAt: number;
  daysOfWeek: number[];
  driveFolderId: string;
  enabled: boolean;
  fileNamePattern: string;
  includeSubfolders: boolean;
  lastBatchId?: string;
  lastRunAt?: number;
  lastRunMessage?: string;
  lastRunStatus?: string;
  lastScheduledFor?: string;
  localTime: string;
  name: string;
  timeZone: string;
  updatedAt: number;
}) {
  return {
    automation_id: automation.automationId,
    created_at: automation.createdAt,
    days_of_week: automation.daysOfWeek,
    enabled: automation.enabled,
    file_name_pattern: automation.fileNamePattern,
    folder_id: automation.driveFolderId,
    include_subfolders: automation.includeSubfolders,
    last_batch_id: automation.lastBatchId ?? null,
    last_run_at: automation.lastRunAt ?? null,
    last_run_message: automation.lastRunMessage ?? "",
    last_run_status: automation.lastRunStatus ?? null,
    last_scheduled_for: automation.lastScheduledFor ?? null,
    name: automation.name,
    time_of_day: automation.localTime,
    timezone: automation.timeZone,
    updated_at: automation.updatedAt,
  };
}

export const list = query({
  args: { secret: v.string(), includeDisabled: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const rows = args.includeDisabled === false
      ? await ctx.db
          .query("reviewAutomations")
          .withIndex("by_enabled", (q) => q.eq("enabled", true))
          .collect()
      : await ctx.db.query("reviewAutomations").collect();
    return rows
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(publicAutomation);
  },
});

export const tickState = query({
  args: { secret: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const maintenance = await ctx.db
      .query("maintenanceState")
      .withIndex("by_key", (q) => q.eq("key", "reviewOfferStatsV1"))
      .unique();
    const running = await ctx.db
      .query("automationRuns")
      .withIndex("by_status_lease", (q) =>
        q.eq("status", "running").lte("leaseExpiresAt", args.now)
      )
      .take(1);
    const queued = running.length
      ? []
      : await ctx.db
          .query("automationRuns")
          .withIndex("by_status_lease", (q) =>
            q.eq("status", "queued").lte("leaseExpiresAt", args.now)
          )
          .take(1);

    let needsNotification = false;
    for (const status of ["pending", "failed", "claimed"]) {
      const batches = status === "pending"
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
                .lte("notificationLeaseExpiresAt", args.now)
            )
            .take(1);
      if (batches.length) {
        needsNotification = true;
        break;
      }
    }

    const automations = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return {
      automations: automations
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(publicAutomation),
      needs_recovery: Boolean(running.length || queued.length),
      needs_notification: needsNotification,
      needs_maintenance: !maintenance?.complete,
    };
  },
});

export const upsert = mutation({
  args: { secret: v.string(), ...automationFields },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    const now = Date.now();
    const value = {
      automationId: args.automationId,
      daysOfWeek: [...new Set(args.daysOfWeek)].sort(),
      driveFolderId: args.driveFolderId,
      enabled: args.enabled,
      fileNamePattern: args.fileNamePattern,
      includeSubfolders: args.includeSubfolders,
      localTime: args.localTime,
      name: args.name,
      timeZone: args.timeZone,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("reviewAutomations", { ...value, createdAt: now });
    return publicAutomation({ ...existing, ...value, createdAt: existing?.createdAt ?? now });
  },
});

export const remove = mutation({
  args: { secret: v.string(), automationId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!existing) throw new Error("Review automation not found");
    const activeRuns = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation_status", (q) =>
        q.eq("automationId", args.automationId).eq("status", "running")
      )
      .take(1);
    const queuedRuns = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation_status", (q) =>
        q.eq("automationId", args.automationId).eq("status", "queued")
      )
      .take(1);
    const failedRuns = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation_status", (q) =>
        q.eq("automationId", args.automationId).eq("status", "failed")
      )
      .take(1);
    if (activeRuns.length || queuedRuns.length || failedRuns.length) {
      throw new Error("Finish or exhaust the pending automation retry before deleting it");
    }
    await ctx.db.delete(existing._id);
    return { automation_id: args.automationId };
  },
});

export const claimRun = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
    scheduledFor: v.string(),
    allowDisabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const automation = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (!automation) throw new Error("Review automation not found");
    if (!automation.enabled && !args.allowDisabled) return { claimed: false, reason: "disabled" };
    const existing = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation_scheduled", (q) =>
        q.eq("automationId", args.automationId).eq("scheduledFor", args.scheduledFor)
      )
      .unique();
    const now = Date.now();
    if (!existing) {
      for (const status of ["running", "queued", "failed"]) {
        const blockers = await ctx.db
          .query("automationRuns")
          .withIndex("by_automation_status", (q) =>
            q.eq("automationId", args.automationId).eq("status", status)
          )
          .take(1);
        if (blockers.length) {
          return {
            claimed: false,
            reason: "another_run_requires_attention",
            run_id: blockers[0].runId,
          };
        }
      }
    }
    if (existing) {
      const attempts = Math.max(1, existing.attempts ?? 1);
      const reclaimable = existing.status === "failed"
        || (existing.status === "running" && (existing.leaseExpiresAt ?? 0) <= now);
      if (!reclaimable) {
        return { claimed: false, reason: "already_claimed", run_id: existing.runId };
      }
      const oldClaims = await ctx.db
        .query("automationFileClaims")
        .withIndex("by_run_id", (q) => q.eq("runId", existing.runId))
        .collect();
      for (const claim of oldClaims) {
        const jobState = claim.jobId
          ? await ctx.db
              .query("automationJobStates")
              .withIndex("by_job_id", (q) => q.eq("jobId", claim.jobId!))
              .unique()
          : null;
        if (!jobState || jobState.status !== "complete") {
          await ctx.db.delete(claim._id);
        }
      }
      const oldJobStates = await ctx.db
        .query("automationJobStates")
        .withIndex("by_run_id", (q) => q.eq("runId", existing.runId))
        .collect();
      for (const state of oldJobStates) await ctx.db.delete(state._id);
      if (attempts >= MAX_AUTOMATION_RUN_ATTEMPTS) {
        await ctx.db.patch(existing._id, {
          message: "Automation retry limit reached for this schedule.",
          status: "failed_exhausted",
          updatedAt: now,
        });
        await ctx.db.patch(automation._id, {
          lastRunAt: now,
          lastRunMessage: "Automation retry limit reached for this schedule.",
          lastRunStatus: "failed_exhausted",
          lastScheduledFor: args.scheduledFor,
          updatedAt: now,
        });
        return { claimed: false, reason: "retry_limit", run_id: existing.runId };
      }
      await ctx.db.patch(existing._id, {
        attempts: attempts + 1,
        jobIds: [],
        leaseExpiresAt: now + AUTOMATION_RUN_LEASE_MS,
        matchedCount: 0,
        message: "Retrying Google Drive scan for matching creatives.",
        queuedCount: 0,
        retryRequired: false,
        runId: args.runId,
        status: "running",
        updatedAt: now,
      });
      await ctx.db.patch(automation._id, {
        lastRunAt: now,
        lastRunMessage: "Retrying Google Drive scan for matching creatives.",
        lastRunStatus: "running",
        lastScheduledFor: args.scheduledFor,
        updatedAt: now,
      });
      return { claimed: true, run_id: args.runId, attempt: attempts + 1 };
    }
    await ctx.db.insert("automationRuns", {
      attempts: 1,
      automationId: args.automationId,
      createdAt: now,
      jobIds: [],
      leaseExpiresAt: now + AUTOMATION_RUN_LEASE_MS,
      matchedCount: 0,
      message: "Scanning Google Drive for matching creatives.",
      queuedCount: 0,
      retryRequired: false,
      runId: args.runId,
      scheduledFor: args.scheduledFor,
      status: "running",
      updatedAt: now,
    });
    await ctx.db.patch(automation._id, {
      lastRunAt: now,
      lastRunMessage: "Scanning Google Drive for matching creatives.",
      lastRunStatus: "running",
      lastScheduledFor: args.scheduledFor,
      updatedAt: now,
    });
    return { claimed: true, run_id: args.runId };
  },
});

export const claimFiles = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
    files: v.array(v.object({
      fileId: v.string(),
      fileName: v.string(),
      modifiedTime: v.string(),
      jobId: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (
      !run
      || run.automationId !== args.automationId
      || run.status !== "running"
      || (run.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      throw new Error("Automation run lease is no longer active");
    }
    const claimed = [];
    for (const file of args.files.slice(0, 100)) {
      const existing = await ctx.db
        .query("automationFileClaims")
        .withIndex("by_automation_file_modified", (q) =>
          q
            .eq("automationId", args.automationId)
            .eq("fileId", file.fileId)
            .eq("modifiedTime", file.modifiedTime)
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("automationFileClaims", {
        automationId: args.automationId,
        claimedAt: Date.now(),
        fileId: file.fileId,
        fileName: file.fileName,
        jobId: file.jobId,
        modifiedTime: file.modifiedTime,
        runId: args.runId,
      });
      if (file.jobId) {
        await ctx.db.insert("automationJobStates", {
          jobId: file.jobId,
          runId: args.runId,
          status: "claimed",
          updatedAt: Date.now(),
        });
      }
      claimed.push(file);
    }
    return claimed;
  },
});

export const attachBatchItems = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
    items: v.array(v.object({
      batchId: v.string(),
      batchItemId: v.string(),
      jobId: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (
      !run
      || run.automationId !== args.automationId
      || run.status !== "running"
      || (run.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      throw new Error("Automation run lease is no longer active");
    }
    for (const item of args.items.slice(0, 100)) {
      const state = await ctx.db
        .query("automationJobStates")
        .withIndex("by_job_id", (q) => q.eq("jobId", item.jobId))
        .unique();
      if (!state || state.runId !== args.runId) {
        throw new Error("Automation job claim was not found");
      }
      await ctx.db.patch(state._id, {
        batchId: item.batchId,
        batchItemId: item.batchItemId,
        updatedAt: Date.now(),
      });
    }
    return { attached: args.items.length };
  },
});

export const heartbeatRun = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    const now = Date.now();
    if (
      !run
      || run.automationId !== args.automationId
      || !["running", "queued"].includes(run.status)
      || (run.leaseExpiresAt ?? 0) <= now
    ) {
      throw new Error("Automation run lease is no longer active");
    }
    await ctx.db.patch(run._id, {
      leaseExpiresAt: now + AUTOMATION_RUN_LEASE_MS,
      updatedAt: now,
    });
    const automation = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", args.automationId))
      .unique();
    if (automation && automation.lastScheduledFor === run.scheduledFor) {
      await ctx.db.patch(automation._id, { lastRunAt: now, updatedAt: now });
    }
    return { lease_expires_at: now + AUTOMATION_RUN_LEASE_MS };
  },
});

export const markRetryRequired = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    const now = Date.now();
    if (
      !run
      || run.automationId !== args.automationId
      || run.status !== "running"
      || (run.leaseExpiresAt ?? 0) <= now
    ) {
      throw new Error("Automation run lease is no longer active");
    }
    await ctx.db.patch(run._id, {
      leaseExpiresAt: now + AUTOMATION_RUN_LEASE_MS,
      message: "One or more matched creatives must be retried after queued reviews finish.",
      retryRequired: true,
      updatedAt: now,
    });
    return { retry_required: true };
  },
});

export const releaseFiles = mutation({
  args: {
    secret: v.string(),
    automationId: v.string(),
    runId: v.string(),
    files: v.array(v.object({
      fileId: v.string(),
      modifiedTime: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    let released = 0;
    for (const file of args.files.slice(0, 100)) {
      const claim = await ctx.db
        .query("automationFileClaims")
        .withIndex("by_automation_file_modified", (q) =>
          q
            .eq("automationId", args.automationId)
            .eq("fileId", file.fileId)
            .eq("modifiedTime", file.modifiedTime)
        )
        .unique();
      if (!claim || claim.runId !== args.runId) continue;
      await ctx.db.delete(claim._id);
      if (claim.jobId) {
        const state = await ctx.db
          .query("automationJobStates")
          .withIndex("by_job_id", (q) => q.eq("jobId", claim.jobId!))
          .unique();
        if (
          state
          && state.runId === args.runId
          && state.status === "claimed"
          && !state.reviewId
        ) {
          await ctx.db.delete(state._id);
        }
      }
      released += 1;
    }
    return { released };
  },
});

export const recoverInterrupted = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    const running = await ctx.db
      .query("automationRuns")
      .withIndex("by_status_lease", (q) =>
        q.eq("status", "running").lte("leaseExpiresAt", now)
      )
      .take(1);
    const queued = running.length < 1
      ? await ctx.db
          .query("automationRuns")
          .withIndex("by_status_lease", (q) =>
            q.eq("status", "queued").lte("leaseExpiresAt", now)
          )
          .take(1 - running.length)
      : [];
    const candidates = [...running, ...queued];

    for (const run of candidates) {
      const claims = await ctx.db
        .query("automationFileClaims")
        .withIndex("by_run_id", (q) => q.eq("runId", run.runId))
        .collect();
      const jobStates = await ctx.db
        .query("automationJobStates")
        .withIndex("by_run_id", (q) => q.eq("runId", run.runId))
        .collect();
      const statesByJobId = new Map(jobStates.map((state) => [state.jobId, state]));
      const trackedJobIds = [...new Set([
        ...run.jobIds,
        ...jobStates.map((state) => state.jobId),
        ...claims.flatMap((claim) => claim.jobId ? [claim.jobId] : []),
      ])];
      const failedBatchItems = new Map<string, Map<string, string>>();
      for (const state of jobStates) {
        if (["complete", "failed"].includes(state.status)) continue;
        const message = "Automation review was interrupted by a container restart and will be retried.";
        if (state.reviewId) {
          await ctx.db.patch(state.reviewId, {
            message,
            progress: 100,
            reportReady: false,
            status: "failed",
            updatedAt: now,
          });
        }
        await ctx.db.patch(state._id, { status: "failed", updatedAt: now });
        const stats = await ctx.db
          .query("reviewOfferStats")
          .withIndex("by_job_id", (q) => q.eq("jobId", state.jobId))
          .collect();
        for (const stat of stats) {
          await ctx.db.patch(stat._id, { status: "failed", updatedAt: now });
        }
        if (state.batchId && state.batchItemId) {
          const items = failedBatchItems.get(state.batchId) ?? new Map<string, string>();
          items.set(state.batchItemId, state.jobId);
          failedBatchItems.set(state.batchId, items);
        }
      }
      for (const [batchId, failedItems] of failedBatchItems) {
        const batch = await ctx.db
          .query("reviewBatches")
          .withIndex("by_batch_id", (q) => q.eq("batchId", batchId))
          .unique();
        if (batch) {
          const message = "Automation review was interrupted by a container restart and will be retried.";
          const items = batch.items.map((item) => {
            const jobId = failedItems.get(item.itemId);
            return jobId ? { ...item, jobId, message, status: "failed" } : item;
          });
          await ctx.db.patch(batch._id, {
            items,
            notificationReady: items.every((item) =>
              TERMINAL_BATCH_STATUSES.has(item.status)
            ),
            updatedAt: now,
          });
        }
      }

      for (const claim of claims) {
        const state = claim.jobId ? statesByJobId.get(claim.jobId) : null;
        if (!state || state.status !== "complete") await ctx.db.delete(claim._id);
      }

      const completed = !run.retryRequired
        && trackedJobIds.length > 0
        && trackedJobIds.every((jobId) => statesByJobId.get(jobId)?.status === "complete");
      const status = completed ? "complete" : "failed";
      const message = completed
        ? "All automated reviews completed."
        : "Interrupted automation work was released and can be retried.";
      await ctx.db.patch(run._id, {
        finishedAt: now,
        jobIds: trackedJobIds,
        message,
        status,
        updatedAt: now,
      });
      const automation = await ctx.db
        .query("reviewAutomations")
        .withIndex("by_automation_id", (q) => q.eq("automationId", run.automationId))
        .unique();
      if (automation && automation.lastScheduledFor === run.scheduledFor) {
        await ctx.db.patch(automation._id, {
          lastRunAt: now,
          lastRunMessage: message,
          lastRunStatus: status,
          updatedAt: now,
        });
      }
    }
    return { processed: candidates.length };
  },
});

export const finishRun = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    status: v.string(),
    message: v.string(),
    matchedCount: v.number(),
    queuedCount: v.number(),
    retryRequired: v.optional(v.boolean()),
    batchId: v.optional(v.string()),
    jobIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run || run.status !== "running") {
      throw new Error("Automation run lease is no longer active");
    }
    const automation = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", run.automationId))
      .unique();
    const now = Date.now();
    let finalStatus = args.status;
    let finalMessage = args.message;
    if (args.status === "queued" && args.jobIds.length) {
      const jobStates = await ctx.db
        .query("automationJobStates")
        .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
        .collect();
      const statesByJobId = new Map(jobStates.map((state) => [state.jobId, state]));
      if (args.jobIds.every((jobId) => {
        const state = statesByJobId.get(jobId);
        return state && ["complete", "failed"].includes(state.status);
      })) {
        finalStatus = args.retryRequired || args.jobIds.some((jobId) =>
          statesByJobId.get(jobId)?.status === "failed"
        )
          ? "failed"
          : "complete";
        finalMessage = finalStatus === "complete"
          ? "All automated reviews completed."
          : "One or more automated reviews failed or could not be queued and will be retried.";
      }
    }
    await ctx.db.patch(run._id, {
      batchId: args.batchId,
      finishedAt: now,
      jobIds: args.jobIds,
      leaseExpiresAt: finalStatus === "queued"
        ? now + AUTOMATION_RUN_LEASE_MS
        : run.leaseExpiresAt,
      matchedCount: args.matchedCount,
      message: finalMessage,
      queuedCount: args.queuedCount,
      retryRequired: args.retryRequired ?? false,
      status: finalStatus,
      updatedAt: now,
    });
    if (automation && automation.lastScheduledFor === run.scheduledFor) {
      await ctx.db.patch(automation._id, {
        lastBatchId: args.batchId,
        lastRunAt: now,
        lastRunMessage: finalMessage,
        lastRunStatus: finalStatus,
        updatedAt: now,
      });
      return publicAutomation({
        ...automation,
        lastBatchId: args.batchId,
        lastRunAt: now,
        lastRunMessage: finalMessage,
        lastRunStatus: finalStatus,
        updatedAt: now,
      });
    }
    return automation ? publicAutomation(automation) : null;
  },
});

export const finishJob = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const run = await ctx.db
      .query("automationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique();
    if (
      !run
      || !["running", "queued"].includes(run.status)
      || !run.jobIds.includes(args.jobId)
    ) {
      return { status: "not_tracked" };
    }
    const jobStates = await ctx.db
      .query("automationJobStates")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .collect();
    const statesByJobId = new Map(jobStates.map((state) => [state.jobId, state]));
    if (!run.jobIds.every((jobId) => {
      const state = statesByJobId.get(jobId);
      return state && ["complete", "failed"].includes(state.status);
    })) {
      return { status: run.status };
    }

    const failed = Boolean(run.retryRequired)
      || run.jobIds.some((jobId) => statesByJobId.get(jobId)?.status === "failed");
    const status = failed ? "failed" : "complete";
    const message = failed
      ? "One or more automated reviews failed or could not be queued and will be retried."
      : "All automated reviews completed.";
    const now = Date.now();
    await ctx.db.patch(run._id, {
      finishedAt: now,
      message,
      status,
      updatedAt: now,
    });
    const automation = await ctx.db
      .query("reviewAutomations")
      .withIndex("by_automation_id", (q) => q.eq("automationId", run.automationId))
      .unique();
    if (automation && automation.lastScheduledFor === run.scheduledFor) {
      await ctx.db.patch(automation._id, {
        lastRunAt: now,
        lastRunMessage: message,
        lastRunStatus: status,
        updatedAt: now,
      });
    }
    return { status };
  },
});
