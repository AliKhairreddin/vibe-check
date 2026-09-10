import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server.js';
import type { Doc } from './_generated/dataModel';
import { getConvexSize, v } from 'convex/values';
import { candidateValidator, lessonValidator, learningMetricsValidator } from './learningTypes.ts';

const zeroMetrics = { discovery: 0, validation: 0, improved: 0, regressions: 0,
  severeRegressions: 0, baselineErrors: 0, candidateErrors: 0, shadow: 0, shadowImproved: 0, shadowRegressions: 0 };
const MAX_LESSONS = 20;
function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
const stateFor = (ctx: QueryCtx | MutationCtx, offerId: string) => ctx.db.query('learningStates')
  .withIndex('by_offer_id', q => q.eq('offerId', offerId)).unique();
const profileFor = (ctx: QueryCtx | MutationCtx, offerId: string) => ctx.db.query('offerProfiles')
  .withIndex('by_offer_id', q => q.eq('offerId', offerId)).unique();
const versionFor = (ctx: QueryCtx | MutationCtx, offerId: string, version: number) => ctx.db.query('learningVersions')
  .withIndex('by_offer_id_and_version', q => q.eq('offerId', offerId).eq('version', version)).unique();
export function policyText(profile: Doc<'offerProfiles'>) {
  return `# Official guidelines — ${profile.displayName}\n\n${profile.officialGuidelines}\n\n# Current internal rules\n\n`
    + profile.internalOverrides.filter(x => x.enabled).map(x => `## ${x.title} [${x.overrideId}]\n${x.guidance}\n${x.rationale}`).join('\n\n');
}
function effectiveText(base: string, lessons: Doc<'learningVersions'>['lessons']) {
  return base + (lessons.length ? '\n\n# Learned clarifications (subordinate to official guidelines and internal rules)\n\n'
    + lessons.map(x => `## ${x.title} [${x.key}]\nApplies when: ${x.appliesWhen}\n${x.guidance}\nDoes not apply: ${x.excludes}`).join('\n\n') : '');
}
async function clearActive(ctx: MutationCtx, state: Doc<'learningStates'>, reason: string, actor: string) {
  const previous = await versionFor(ctx, state.offerId, state.version);
  if (!previous?.lessons.length) return state.version;
  const version = state.version + 1;
  await ctx.db.insert('learningVersions', {
    offerId: state.offerId, version, guidelineVersion: previous.guidelineVersion, generation: state.generation + 1,
    lessons: [], baseText: previous.baseText, reason, actor,
    createdAt: Date.now(), metrics: zeroMetrics, decisions: [],
  });
  return version;
}

// Called in the same transaction as a decision/policy change: feedback cannot be
// saved without its durable processing request. No model/network work happens here.
export async function enqueueLearning(ctx: MutationCtx, offerId: string, invalidate = false) {
  const state = await stateFor(ctx, offerId);
  const now = Date.now();
  if (!state) {
    await ctx.db.insert('learningStates', { offerId, enabled: true, generation: 1, version: 0,
      status: 'pending', nextAttemptAt: now + 60_000, attempts: 0, message: 'Waiting to analyze advertiser feedback.',
      updatedAt: now, suppressedKeys: [] });
    return;
  }
  if (!invalidate && state.status === 'processing') {
    await ctx.db.patch(state._id, { rerunRequested: true, updatedAt: now });
    return;
  }
  const version = invalidate ? await clearActive(ctx, state, 'Feedback or base guidelines changed; prior learning suspended for revalidation.', 'system') : state.version;
  await ctx.db.patch(state._id, { generation: state.generation + 1, version, attempts: 0,
    ...(invalidate ? { minimumRunGeneration: state.generation + 1 } : {}), rerunRequested: false,
    status: state.enabled ? 'pending' : 'paused', nextAttemptAt: now + 60_000, leaseToken: undefined,
    message: invalidate ? 'Prior learning suspended. Rechecking changed evidence.' : 'New feedback queued.', updatedAt: now });
}

export const saveEvidence = mutation({
  args: { secret: v.string(), jobId: v.string(), offerId: v.string(), guidelineVersion: v.number(),
    learningVersion: v.number(), fingerprint: v.string(), evidence: v.any(), complete: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { secret, ...args }) => {
    authorize(secret);
    if (getConvexSize(args) > 70_000) throw new Error('Learning evidence exceeds the bounded snapshot size.');
    const existing = await ctx.db.query('learningEvidence').withIndex('by_job_id_and_offer_id', q =>
      q.eq('jobId', args.jobId).eq('offerId', args.offerId)).unique();
    // A completed review's evidence is immutable, including across retries.
    if (!existing) await ctx.db.insert('learningEvidence', { ...args, createdAt: Date.now() });
    return null;
  },
});

export const claim = mutation({
  args: { secret: v.string(), token: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const now = Date.now();
    for (const status of ['pending', 'processing'] as const) {
      const states = await ctx.db.query('learningStates').withIndex('by_status_and_next_attempt_at', q =>
        q.eq('status', status).lte('nextAttemptAt', now)).take(10);
      for (const state of states) {
        if (!state.enabled) continue;
        if (state.attempts >= 5) {
          await ctx.db.patch(state._id, { status: 'failed', message: 'Processing failed after five attempts. Retry from Learning.', updatedAt: now });
          continue;
        }
        await ctx.db.patch(state._id, { status: 'processing', leaseToken: args.token,
          nextAttemptAt: now + 20 * 60_000, attempts: state.attempts + 1, updatedAt: now, message: 'Analyzing and testing feedback.' });
        return { offerId: state.offerId, generation: state.generation, token: args.token };
      }
    }
    return null;
  },
});

export const dataset = query({
  args: { secret: v.string(), offerId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const [state, profile, decisions, lastRun] = await Promise.all([
      stateFor(ctx, args.offerId), profileFor(ctx, args.offerId),
      ctx.db.query('clientReviewDecisions').withIndex('by_offer_id_and_decided_at', q => q.eq('offerId', args.offerId)).order('desc').take(250),
      ctx.db.query('learningRuns').withIndex('by_offer_id_and_created_at', q => q.eq('offerId', args.offerId)).order('desc').first(),
    ]);
    const current = state ? await versionFor(ctx, args.offerId, state.version) : null;
    const rows = [];
    // Bounded materialization, newest current-policy examples. No raw media is copied.
    for (const decision of decisions) {
      if (rows.length >= 80) break;
      const [evidence, review] = await Promise.all([
        ctx.db.query('learningEvidence').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', decision.jobId).eq('offerId', args.offerId)).unique(),
        ctx.db.query('reviews').withIndex('by_job_id', q => q.eq('jobId', decision.jobId)).unique(),
      ]);
      if (!evidence || !review || review.deletedAt !== undefined || evidence.guidelineVersion !== profile?.version) continue;
      rows.push({ ...decision, id: `${decision._id}@${decision.decidedAt}`, evidence: evidence.evidence,
        fingerprint: evidence.fingerprint, evidenceComplete: evidence.complete, createdAt: evidence.createdAt });
    }
    const shadows = lastRun ? await ctx.db.query('learningShadows').withIndex('by_offer_id_and_run_id', q =>
      q.eq('offerId', args.offerId).eq('runId', lastRun._id)).take(100) : [];
    return { state, profile, current, rows, lastRun: lastRun && lastRun.generation >= (state?.minimumRunGeneration ?? 0) ? lastRun : null, shadows, scanned: decisions.length };
  },
});

export const finish = mutation({
  args: { secret: v.string(), offerId: v.string(), token: v.string(), generation: v.number(), guidelineVersion: v.number(),
    candidates: v.array(candidateValidator), lessons: v.array(lessonValidator), metrics: learningMetricsValidator,
    decisionIds: v.array(v.string()), message: v.string() }, returns: v.boolean(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const state = await stateFor(ctx, args.offerId);
    const profile = await profileFor(ctx, args.offerId);
    if (!state?.enabled || state.status !== 'processing' || state.leaseToken !== args.token
      || state.generation !== args.generation || state.nextAttemptAt <= Date.now() || profile?.version !== args.guidelineVersion) return false;
    if (args.lessons.length > MAX_LESSONS || args.candidates.length > 3 || args.decisionIds.length > 80
      || getConvexSize(args) > 100_000) throw new Error('Learning result exceeds processing limits.');
    const current = await versionFor(ctx, args.offerId, state.version);
    const currentKeys = new Set(current?.guidelineVersion === profile.version ? current.lessons.map(x => x.key) : []);
    if (state.rerunRequested && args.lessons.some(x => !currentKeys.has(x.key))) {
      args.lessons = current?.guidelineVersion === profile.version ? current.lessons : [];
      args.candidates = args.candidates.map(x => x.status === 'published' ? { ...x, status: 'shadow' } : x);
      args.message = 'New feedback arrived during testing. Rechecking before automatic publication.';
    }
    for (const lesson of args.lessons) {
      if (state.suppressedKeys.includes(lesson.key)) throw new Error('A disabled lesson cannot be republished.');
      if (currentKeys.has(lesson.key)) {
        if (JSON.stringify(lesson) !== JSON.stringify(current!.lessons.find(x => x.key === lesson.key))) throw new Error('An active clarification cannot change without fresh validation.');
        continue;
      }
      const candidate = args.candidates.find(x => x.lesson.key === lesson.key && x.status === 'published');
      if (!candidate || lesson.support < 8 || lesson.contradictions !== 0 || lesson.lowerBound < 0.65
        || candidate.metrics.validation < 6 || candidate.metrics.improved < 2 || candidate.metrics.regressions !== 0
        || candidate.metrics.severeRegressions !== 0 || candidate.metrics.shadow < 3
        || candidate.metrics.shadowImproved < 1 || candidate.metrics.shadowRegressions !== 0) {
        throw new Error('Automatic publication requirements were not met.');
      }
    }
    const decisions = await ctx.db.query('clientReviewDecisions').withIndex('by_offer_id_and_decided_at', q => q.eq('offerId', args.offerId)).order('desc').take(250);
    const byId = new Map(decisions.map(x => [`${x._id}@${x.decidedAt}`, x]));
    const allIds = new Set([...args.decisionIds, ...args.lessons.flatMap(x => [...x.supportingDecisionIds, ...x.contradictingDecisionIds])]);
    if ([...allIds].some(id => !byId.has(id))) return false;
    for (const lesson of args.lessons.filter(x => !currentKeys.has(x.key))) {
      const sourceIds = new Set(lesson.supportingDecisionIds);
      if (sourceIds.size !== lesson.support || lesson.contradictingDecisionIds.length !== 0) throw new Error('Supporting decision counts do not match the evidence.');
      const fingerprints = new Set<string>();
      for (const id of sourceIds) {
        const d = byId.get(id)!;
        if (d.feedbackScope !== 'similar_creatives' || !d.feedbackNote || !['false_positive', 'confirmed_issue', 'missed_policy_issue', 'partner_preference'].includes(d.feedbackReason ?? '')) throw new Error('Only reusable policy feedback can support publication.');
        const evidence = await ctx.db.query('learningEvidence').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', d.jobId).eq('offerId', args.offerId)).unique();
        if (!evidence?.complete || evidence.guidelineVersion !== profile.version) throw new Error('Complete current-policy evidence is required.');
        fingerprints.add(evidence.fingerprint);
      }
      if (fingerprints.size < 8) throw new Error('Independent creatives are required for publication.');
    }
    const snapshots = [...allIds].map(id => {
      const d = byId.get(id)!;
      return { id, jobId: d.jobId, decidedAt: d.decidedAt, decision: d.decision,
        note: d.feedbackNote ?? '', reason: d.feedbackReason ?? '' };
    });
    const now = Date.now();
    // Keep the shadow run ID stable until it is resolved; new observations refer to it.
    const lastRun = await ctx.db.query('learningRuns').withIndex('by_offer_id_and_created_at', q => q.eq('offerId', args.offerId)).order('desc').first();
    const stillShadowing = args.candidates.some(x => x.status === 'shadow');
    const sameShadow = stillShadowing && lastRun?.guidelineVersion === profile.version
      && JSON.stringify(lastRun.candidates.map(x => x.lesson.key)) === JSON.stringify(args.candidates.map(x => x.lesson.key));
    if (sameShadow && lastRun) await ctx.db.patch(lastRun._id, { candidates: args.candidates, message: args.message });
    if (!sameShadow) await ctx.db.insert('learningRuns', { offerId: args.offerId, generation: args.generation,
      guidelineVersion: profile.version, createdAt: now, candidates: args.candidates, message: args.message });
    const baseText = policyText(profile);
    const nextText = effectiveText(baseText, args.lessons);
    let version = state.version;
    if (!current || effectiveText(current.baseText, current.lessons) !== nextText || current.guidelineVersion !== profile.version) {
      version += 1;
      await ctx.db.insert('learningVersions', { offerId: args.offerId, version, guidelineVersion: profile.version,
        generation: args.generation, lessons: args.lessons, baseText,
        createdAt: now, actor: 'automatic', reason: args.message, metrics: args.metrics, decisions: snapshots });
    }
    await ctx.db.patch(state._id, { version, status: state.rerunRequested ? 'pending' : 'idle',
      generation: state.generation + (state.rerunRequested ? 1 : 0), rerunRequested: false, nextAttemptAt: now + 60_000,
      attempts: 0, leaseToken: undefined, updatedAt: now, message: args.message });
    return true;
  },
});

export const fail = mutation({
  args: { secret: v.string(), offerId: v.string(), token: v.string(), generation: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const state = await stateFor(ctx, args.offerId);
    if (state?.leaseToken === args.token && state.generation === args.generation) await ctx.db.patch(state._id, {
      status: state.attempts >= 5 ? 'failed' : 'pending', leaseToken: undefined,
      nextAttemptAt: Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** state.attempts),
      message: 'Learning analysis could not complete. Reviews continue with the current guidelines.', updatedAt: Date.now(),
    });
    return null;
  },
});

export const context = query({
  args: { secret: v.string(), offerId: v.string(), guidelineVersion: v.number() }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const state = await stateFor(ctx, args.offerId);
    if (!state?.enabled) return { version: state?.version ?? 0, lessons: [], shadow: null };
    const current = await versionFor(ctx, args.offerId, state.version);
    const run = await ctx.db.query('learningRuns').withIndex('by_offer_id_and_created_at', q => q.eq('offerId', args.offerId)).order('desc').first();
    const shadow = run && run.generation >= (state.minimumRunGeneration ?? 0) && run.guidelineVersion === args.guidelineVersion && run.candidates.some(x => x.status === 'shadow')
      ? { runId: run._id, lessons: run.candidates.filter(x => x.status === 'shadow').map(x => x.lesson) } : null;
    return { version: current?.guidelineVersion === args.guidelineVersion ? state.version : 0,
      lessons: current?.guidelineVersion === args.guidelineVersion ? current.lessons : [], shadow };
  },
});

export const saveShadow = mutation({
  args: { secret: v.string(), offerId: v.string(), jobId: v.string(), runId: v.id('learningRuns'),
    fingerprint: v.string(), baseline: v.string(), candidate: v.string() }, returns: v.null(),
  handler: async (ctx, { secret, ...args }) => {
    authorize(secret);
    const run = await ctx.db.get(args.runId);
    if (!run || run.offerId !== args.offerId) throw new Error('Wrong advertiser shadow run.');
    const existing = await ctx.db.query('learningShadows').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', args.jobId).eq('offerId', args.offerId)).unique();
    if (!existing) await ctx.db.insert('learningShadows', { ...args, createdAt: Date.now() });
    return null;
  },
});

export const dashboard = query({
  args: { secret: v.string(), offerId: v.string(), beforeVersion: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const state = await stateFor(ctx, args.offerId);
    const [profile, versions, runs, decisions] = await Promise.all([
      profileFor(ctx, args.offerId),
      ctx.db.query('learningVersions').withIndex('by_offer_id_and_version', q => q.eq('offerId', args.offerId).lt('version', args.beforeVersion ?? Number.MAX_SAFE_INTEGER)).order('desc').take(3),
      ctx.db.query('learningRuns').withIndex('by_offer_id_and_created_at', q => q.eq('offerId', args.offerId)).order('desc').take(10),
      ctx.db.query('clientReviewDecisions').withIndex('by_offer_id_and_decided_at', q => q.eq('offerId', args.offerId)).order('desc').take(30),
    ]);
    const current = state ? await versionFor(ctx, args.offerId, state.version) : null;
    return { state, current: current ? { ...current, effectiveText: effectiveText(current.baseText, current.lessons) } : null, profile: profile ? { offerId: profile.offerId, version: profile.version, baseText: policyText(profile) } : null,
      versions: versions.slice(0, 2).map(x => ({ ...x, effectiveText: effectiveText(x.baseText, x.lessons) })), nextBeforeVersion: versions.length > 2 ? versions[1].version : null,
      runs, decisions: decisions.map(d => ({ id: `${d._id}@${d.decidedAt}`, jobId: d.jobId,
        decision: d.decision, aiStatus: d.aiStatus, decidedAt: d.decidedAt, note: d.feedbackNote ?? '', reason: d.feedbackReason ?? '', scope: d.feedbackScope ?? null })) };
  },
});

export const control = mutation({
  args: { secret: v.string(), offerId: v.string(), action: v.union(v.literal('pause'), v.literal('resume'), v.literal('retry'), v.literal('restore'), v.literal('disable')),
    expectedVersion: v.number(), restoreVersion: v.optional(v.number()), lessonKey: v.optional(v.string()), actor: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    let state = await stateFor(ctx, args.offerId);
    if (!state) { await enqueueLearning(ctx, args.offerId); state = await stateFor(ctx, args.offerId); }
    if (!state || state.version !== args.expectedVersion) throw new Error('Guidelines changed. Refresh before retrying.');
    let version = state.version;
    let suppressedKeys = state.suppressedKeys;
    if (args.action === 'pause') version = await clearActive(ctx, state, 'Learning disabled by owner.', args.actor);
    if (args.action === 'disable') {
      const current = await versionFor(ctx, args.offerId, state.version);
      if (!current?.lessons.some(x => x.key === args.lessonKey)) throw new Error('Clarification is no longer active. Refresh and retry.');
      const { _id, _creationTime, ...copy } = current;
      version += 1;
      suppressedKeys = [...new Set([...suppressedKeys, args.lessonKey!])].slice(-100);
      await ctx.db.insert('learningVersions', { ...copy, version, generation: state.generation + 1,
        lessons: current.lessons.filter(x => x.key !== args.lessonKey),
        createdAt: Date.now(), actor: args.actor, reason: 'Owner disabled one clarification.' });
    }
    if (args.action === 'restore') {
      const profile = await profileFor(ctx, args.offerId);
      const previous = await versionFor(ctx, args.offerId, args.restoreVersion ?? -1);
      if (!previous || previous.guidelineVersion !== profile?.version) throw new Error('Restore requires the same base guideline version.');
      const decisions = await ctx.db.query('clientReviewDecisions').withIndex('by_offer_id_and_decided_at', q => q.eq('offerId', args.offerId)).order('desc').take(250);
      const ids = new Set(decisions.map(d => `${d._id}@${d.decidedAt}`));
      if (previous.decisions.some(d => !ids.has(d.id))) throw new Error('Supporting feedback changed; this version needs revalidation.');
      const current = await versionFor(ctx, args.offerId, state.version);
      suppressedKeys = [...new Set([...suppressedKeys, ...(current?.lessons ?? []).filter(x => !previous.lessons.some(p => p.key === x.key)).map(x => x.key)])].slice(-100);
      version += 1;
      const { _id, _creationTime, ...copy } = previous;
      await ctx.db.insert('learningVersions', { ...copy, version, generation: state.generation + 1,
        createdAt: Date.now(), actor: args.actor, reason: `Restored learning version ${previous.version}.` });
    }
    await ctx.db.patch(state._id, { version, suppressedKeys, generation: state.generation + 1, minimumRunGeneration: state.generation + 1,
      enabled: args.action !== 'pause', status: args.action === 'pause' ? 'paused' : ['restore', 'disable'].includes(args.action) ? 'idle' : 'pending',
      attempts: 0, leaseToken: undefined, nextAttemptAt: Date.now(), updatedAt: Date.now(),
      message: args.action === 'pause' ? 'Learning is off. Base guidelines remain active.' : args.action === 'restore' ? 'Previous version restored.' : 'Feedback analysis queued.' });
    return null;
  },
});
