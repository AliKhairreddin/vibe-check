import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReviewSource, backfill, list as listSources } from '../convex/reviewSources.ts';
import { listPage, upsertStatus } from '../convex/reviews.ts';
import { upsert, allowsOrigin } from '../convex/apiPartners.ts';
import { normalizeAllowedOrigins } from '../convex/apiOrigins.ts';

process.env.CONVEX_HTTP_SECRET = 'source-test';
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, { secret: 'source-test', ...args });

function fixture() {
  const tables: Record<string, any[]> = {};
  const indexes: string[] = [];
  let serial = 0;
  const db = {
    query(table: string) {
      const predicates: Array<(row: any) => boolean> = [];
      let direction = 1;
      const index = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; } };
      const matches = () => [...(tables[table] ?? [])].filter(row => predicates.every(p => p(row)))
        .sort((a, b) => ((a.createdAt ?? a._creationTime) - (b.createdAt ?? b._creationTime)) * direction);
      const query = {
        withIndex(name: string, configure?: (index: any) => unknown) { indexes.push(`${table}:${name}`); configure?.(index); return query; },
        order(value: string) { direction = value === 'desc' ? -1 : 1; return query; },
        unique: async () => { const rows = matches(); assert.ok(rows.length <= 1); return rows[0] ?? null; },
        first: async () => matches()[0] ?? null,
        take: async (n: number) => matches().slice(0, n),
        collect: async () => matches(),
        paginate: async ({ cursor, numItems }: any) => {
          const rows = matches(), offset = Number(cursor ?? 0);
          return { page: rows.slice(offset, offset + numItems), isDone: offset + numItems >= rows.length, continueCursor: String(offset + numItems) };
        },
      };
      return query;
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial };
      (tables[table] ??= []).push(row); return row._id;
    },
    async patch(id: string, value: any) {
      const row = Object.values(tables).flat().find(r => r._id === id);
      assert.ok(row); Object.assign(row, value);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex(row => row._id === id);
        if (index !== -1) rows.splice(index, 1);
      }
    },
  };
  const addReview = (jobId: string, extra: any = {}) => db.insert('reviews', {
    jobId, fileName: `${jobId}.mp4`, status: 'complete', progress: 100, message: '', reportReady: true,
    createdAt: serial, updatedAt: serial, offerIds: ['acp'], primaryOfferId: 'acp', ...extra,
  });
  return { ctx: { db }, tables, indexes, addReview };
}

test('sources follow submitters, independently of evaluated offers and shared access', async () => {
  const { ctx } = fixture();
  assert.equal((await resolveReviewSource(ctx as any, 'internal')).historySource, 'digital-nudge');
  await ctx.db.insert('publisherSubmissions', { jobId: 'dn', publisherId: 'digital-nudge-acp' });
  assert.equal((await resolveReviewSource(ctx as any, 'dn')).historySource, 'digital-nudge');
  await ctx.db.insert('publisherSubmissions', { jobId: 'publisher', publisherId: 'publisher-acp' });
  assert.equal((await resolveReviewSource(ctx as any, 'publisher')).historySource, 'publisher:publisher-acp');
  await ctx.db.insert('apiReviewLinks', { jobId: 'api', partnerId: 'lemon' });
  await ctx.db.insert('publisherSubmissions', { jobId: 'api', publisherId: 'digital-nudge-acp' });
  assert.equal((await resolveReviewSource(ctx as any, 'api')).historySource, 'api:lemon');
  await ctx.db.insert('apiPartners', { name: 'ACP', sharedReviewOfferIds: ['acp'] });
  assert.equal((await resolveReviewSource(ctx as any, 'internal')).historySource, 'digital-nudge');
});

test('source backfill resumes in bounded pages and filtered pagination never mixes tenants or deleted rows', async () => {
  const { ctx, tables, indexes, addReview } = fixture();
  for (let i = 0; i < 65; i++) {
    await addReview(`review-${i}`, i === 0 ? { deletedAt: 1 } : {});
    if (i % 2) await ctx.db.insert('apiReviewLinks', { jobId: `review-${i}`, partnerId: 'lemon' });
  }
  assert.deepEqual(await invoke(backfill, ctx), { processed: 50, done: false });
  assert.deepEqual(await invoke(backfill, ctx), { processed: 15, done: true });
  assert.deepEqual(await invoke(backfill, ctx), { processed: 0, done: true });
  assert.equal(tables.reviews[1].historySource, 'api:lemon');
  const read = async (source: string) => {
    let cursor: string | null = null;
    const jobs: string[] = [];
    while (true) {
      const page = await invoke(listPage, ctx, { source, paginationOpts: { cursor, numItems: 7 } });
      jobs.push(...page.page.map((r: any) => r.job_id));
      assert.ok(page.page.every((r: any) => r.history_source === source));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return jobs;
  };
  const digitalNudge = await read('digital-nudge'), lemon = await read('api:lemon');
  assert.equal(digitalNudge.length, 32);
  assert.equal(lemon.length, 32);
  assert.equal(new Set([...digitalNudge, ...lemon]).size, 64);
  assert.ok(indexes.includes('reviews:by_history_source_and_deleted_at_and_created_at'));
  assert.equal((await read('api:another')).length, 0);
  await assert.rejects(invoke(listPage, ctx, { secret: 'invalid', paginationOpts: { cursor: null, numItems: 5 } }), /Unauthorized/);
});

test('new reviews receive ownership before they appear in source history', async () => {
  const { ctx, tables } = fixture();
  await ctx.db.insert('apiReviewLinks', { jobId: 'api', partnerId: 'lemon' });
  await ctx.db.insert('publisherSubmissions', { jobId: 'publisher', publisherId: 'publisher-one' });
  for (const jobId of ['internal', 'api', 'publisher']) {
    await invoke(upsertStatus, ctx, { jobId, status: 'queued', progress: 0, reportReady: false, message: 'Queued' });
  }
  assert.deepEqual(tables.reviews.map(r => r.historySource), ['digital-nudge', 'api:lemon', 'publisher:publisher-one']);
});

test('source options identify API accounts and external publisher workspaces', async () => {
  const { ctx } = fixture();
  await ctx.db.insert('apiPartners', { partnerId: 'lemon', name: 'LemonMax' });
  await ctx.db.insert('publishers', { publisherId: 'digital-nudge-acp', organizationId: 'digital-nudge', name: 'Digital Nudge', clientId: 'acp' });
  await ctx.db.insert('publishers', { publisherId: 'external', name: 'External', clientId: 'acp' });
  const sources = await invoke(listSources, ctx);
  assert.deepEqual(sources.map((s: any) => s.value), ['digital-nudge', 'api:lemon', 'publisher:external']);
  assert.equal(sources[1].label, 'LemonMax API');
});

test('origin settings normalize, preserve omitted values, clear explicitly, and revoke on suspension', async () => {
  const { ctx } = fixture();
  const settings = { partnerId: 'lemon', name: 'LemonMax', allowedOfferIds: [], allowCustomPolicy: false,
    concurrentReviewLimit: 5, description: '', maxUploadMb: 400, monthlyReviewLimit: 500,
    retentionDays: 30, status: 'active', unlimitedConcurrency: false, unlimitedReviews: false };
  const origin = 'https://lemonmaxx.com';
  const saved = await invoke(upsert, ctx, { ...settings, allowedOrigins: [`${origin}/`, 'http://localhost:9002'] });
  assert.deepEqual(saved.allowed_origins, ['http://localhost:9002', origin]);
  assert.equal(await invoke(allowsOrigin, ctx, { origin }), true);
  await invoke(upsert, ctx, settings);
  assert.equal(await invoke(allowsOrigin, ctx, { origin }), true);
  await invoke(upsert, ctx, { ...settings, status: 'suspended' });
  assert.equal(await invoke(allowsOrigin, ctx, { origin }), false);
  await invoke(upsert, ctx, settings);
  assert.equal(await invoke(allowsOrigin, ctx, { origin }), true);
  await invoke(upsert, ctx, { ...settings, allowedOrigins: [] });
  assert.equal(await invoke(allowsOrigin, ctx, { origin }), false);
});

test('origin validation rejects paths, wildcards, credentials and non-loopback HTTP', () => {
  assert.deepEqual(normalizeAllowedOrigins(['https://EXAMPLE.com:443/', 'https://example.com', 'http://[::1]:9002']), ['http://[::1]:9002', 'https://example.com']);
  for (const origin of ['*', 'null', 'https://*.example.com', 'https://example.com/path', 'https://example.com/../',
    'https://@example.com', 'https://example.com?', 'http://example.com', 'http://localhost.example.com:9002', 'https://example.com:0']) {
    assert.throws(() => normalizeAllowedOrigins([origin]), undefined, origin);
  }
});
