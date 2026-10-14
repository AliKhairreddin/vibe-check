// This adapter implements the application's API contracts using only one bounded,
// visitor-owned snapshot. It deliberately has no database, fetch, or scheduler access.
import { effectiveReviewStatus } from '../frontend/src/lib/client-review-status.ts';
import { DEMO_BASE, type DemoRole } from '../shared/demo.ts';
import { DEMO_OFFER, DEMO_PUBLISHER, demoClientSession, makeDemoReview, type DemoReview, type DemoState } from './demoData.ts';
import type { ClientFeedbackReason, OfferProfileInput, ReviewBatch } from '../frontend/src/lib/api';

export class DemoError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new DemoError(status, message); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 2000) => typeof value === 'string' ? value.slice(0, max).trim() : '';
const strings = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === 'string') ? value as string[] : [];
const requireMethod = (method: string, allowed: string[]) => { if (!allowed.includes(method)) fail(405, 'Method not allowed in the demo.'); };
export function runDemoRequest(state: DemoState, role: DemoRole, path: string, method: string, value: unknown, now: number, nonce: string): unknown {
  const url = new URL(path, 'https://demo.invalid');
  const body = object(value);
  const owner = role === 'owner';
  const staff = owner || role === 'employee';
  const publisher = role === 'publisher';
  const note = (message: string) => { state.activity.unshift({ at: now, message }); state.activity = state.activity.slice(0, 60); };
  const ownerOnly = () => { if (!owner) fail(403, 'Only the administrator can manage this demo setting.'); };
  requireMethod(method, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);
  if (url.pathname === '/api/admin/session') {
    requireMethod(method, ['GET']);
    if (!staff) fail(403, 'This demo role does not have administrator access.');
    return { authorized: true, can_manage_settings: owner, role, username: `${role}@demo.example` };
  }
  if (url.pathname === '/api/client/session') {
    requireMethod(method, ['GET']);
    if (staff) fail(403, 'Switch to an advertiser or publisher experience.');
    return demoClientSession(role);
  }
  const clientMatch = url.pathname.match(/^\/api\/client\/([^/]+)(\/.*)$/);
  if (clientMatch && (staff || clientMatch[1] !== DEMO_OFFER)) fail(403, 'This advertiser is outside your demo role.');
  if (!staff && !clientMatch) fail(403, 'This operation is outside your demo role.');
  const route = clientMatch ? `/api${clientMatch[2]}` : url.pathname;
  const visible = () => state.reviews.filter(r => staff || (r.history.offer_ids?.includes(DEMO_OFFER) && (publisher ? r.client.publisher_id === DEMO_PUBLISHER : r.history.released_offer_ids?.includes(DEMO_OFFER))));
  const reviewById = (id: string) => visible().find(r => r.history.job_id === id) ?? fail(404, 'Review not found in this demo workspace.');
  const publisherFilter = (rows: DemoReview[]) => url.searchParams.has('publisher_id') ? rows.filter(r => r.client.publisher_id === url.searchParams.get('publisher_id')) : rows;
  const clientView = (r: DemoReview) => ({ ...r.client, effective_status: effectiveReviewStatus(r.client), released: r.history.released_offer_ids?.includes(DEMO_OFFER) ?? false });
  const selected = () => {
    if (body.batch_id) {
      if (!state.batches.some(b => b.batch_id === body.batch_id)) fail(404, 'Batch not found in this demo.');
      const rows = visible().filter(r => r.history.batch_id === body.batch_id);
      if (!rows.length) fail(404, 'No accessible reviews in this batch.');
      return rows;
    }
    const ids = strings(body.job_ids);
    if (!ids.length || ids.length > 80) fail(400, 'Choose between one and 80 reviews.');
    return [...new Set(ids)].map(reviewById);
  };
  const offerIds = () => {
    const ids = clientMatch ? [DEMO_OFFER] : strings(body.offer_ids);
    if (!ids.length || ids.some(id => !state.offers.some(o => o.offer_id === id && o.enabled && o.official_guidelines))) fail(400, 'Choose enabled demo offers with saved guidelines.');
    return [...new Set(ids)];
  };
  if (clientMatch && route === '/api/guidelines') {
    requireMethod(method, ['GET', 'PUT']);
    if (role !== 'advertiser') fail(403, 'Only the advertiser can manage guidelines.');
    const offer = state.offers.find(o => o.offer_id === DEMO_OFFER)!;
    if (method === 'GET') return offer;
    if (body.expected_version !== offer.version) fail(409, 'Guidelines changed since you opened them. Copy your edits before loading the saved version.');
    if (Object.keys(body).some(key => !['expected_version', 'official_guidelines', 'internal_overrides', 'enabled'].includes(key))) fail(400, 'Only your policy and internal rules can be changed.');
    if (typeof body.official_guidelines !== 'string' || body.official_guidelines.length > 12000 || typeof body.enabled !== 'boolean'
      || !Array.isArray(body.internal_overrides) || body.internal_overrides.length > 10) fail(400, 'The demo supports 12,000 guideline characters and ten rules.');
    const guidelines = body.official_guidelines.trim();
    if (body.enabled && !guidelines) fail(400, 'Add official guidelines before enabling reviews.');
    const ids = new Set<string>();
    const rules = body.internal_overrides.map(object).map(rule => {
      const id = text(rule.override_id, 80), title = text(rule.title, 160), guidance = text(rule.guidance, 2000);
      if (!/^[a-z0-9_-]{1,80}$/.test(id) || ids.has(id) || !title || !guidance) fail(400, 'Each rule needs a unique ID, title, and guidance.');
      ids.add(id);
      return { override_id: id, title, guidance, rationale: text(rule.rationale, 2000), enabled: rule.enabled === true };
    });
    Object.assign(offer, { official_guidelines: guidelines, internal_overrides: rules, enabled: body.enabled,
      is_default: offer.is_default && body.enabled, version: offer.version + 1, updated_at: now });
    note(`Saved ${offer.display_name} policy version ${offer.version}.`);
    return offer;
  }
  if (route === '/api/offers/catalog' || route === '/api/offers') {
    requireMethod(method, ['GET']);
    if (route === '/api/offers') ownerOnly();
    return { offers: state.offers.map(o => ({ ...o, configured: Boolean(o.official_guidelines), override_count: o.internal_overrides.filter(r => r.enabled).length })) };
  }
  const offerMatch = route.match(/^\/api\/offers\/([^/]+)$/);
  if (offerMatch) {
    ownerOnly(); requireMethod(method, ['PUT', 'DELETE']);
    let offer = state.offers.find(o => o.offer_id === offerMatch[1]);
    if (method === 'DELETE') { if (!offer) fail(404, 'Offer not found.'); offer.enabled = false; return offer; }
    if (!/^[a-z0-9-]{1,60}$/.test(offerMatch[1]) || !text(body.display_name, 100)) fail(400, 'A valid offer name is required.');
    const overrides = Array.isArray(body.internal_overrides) ? body.internal_overrides.slice(0, 10).map(object).map(o => ({ override_id: text(o.override_id, 80), title: text(o.title, 100), guidance: text(o.guidance), rationale: text(o.rationale), enabled: o.enabled === true })) : [];
    const input: OfferProfileInput = { display_name: text(body.display_name, 100), official_guidelines: text(body.official_guidelines, 12000), internal_overrides: overrides, enabled: body.enabled === true, is_default: body.is_default === true };
    if (!offer) { if (state.offers.length >= 8) fail(429, 'The demo supports up to eight offers.'); offer = { ...input, offer_id: offerMatch[1], version: 0 }; state.offers.push(offer); }
    Object.assign(offer, input, { version: offer.version + 1, updated_at: now });
    note(`Saved ${offer.display_name} policy version ${offer.version}.`);
    return offer;
  }
  if (route === '/api/reviews/stats') {
    requireMethod(method, ['GET']);
    const ids = (url.searchParams.get('offer_ids') ?? '').split(',').filter(Boolean);
    const vertical = url.searchParams.get('vertical') ?? 'all';
    const rows = visible().filter(r => vertical === 'all' || r.client.vertical === vertical);
    const outcomes = { green: 0, yellow: 0, red: 0 };
    rows.forEach(r => r.history.offer_outcomes?.filter(o => !ids.length || ids.includes(o.offer_id)).forEach(o => { const status = o.effective_status ?? o.overall_status; if (status) outcomes[status]++; }));
    return { offer_id: ids[0] ?? '', offer_ids: ids, vertical, total_reviews: rows.length, completed_reviews: rows.length, creative_reviews: rows.filter(r => r.history.has_creative).length, copy_only_reviews: rows.filter(r => !r.history.has_creative).length, in_progress_reviews: 0, failed_reviews: 0, accepted_overrides: 0, client_overrides: rows.filter(r => r.client.decision).length, outcomes };
  }
  if (route === '/api/reviews/sources') { requireMethod(method, ['GET']); return [{ value: 'digital-nudge', label: 'Northstar Studio (fictional)', kind: 'internal', account_type: null }]; }
  if (route === '/api/reviews' || route === '/api/reviews/history') {
    if (method === 'GET') {
      const rows = publisherFilter(visible()).sort((a, b) => b.client.created_at - a.client.created_at);
      if (clientMatch) return { client_id: DEMO_OFFER, display_name: state.offers[0].display_name, reviews: rows.map(clientView) };
      const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
      const limit = Math.max(1, Math.min(80, Number(url.searchParams.get('limit')) || 50));
      const reviews = rows.slice(offset, offset + limit).map(r => r.history);
      return route.endsWith('/history') ? { reviews, has_more: offset + limit < rows.length, next_cursor: offset + limit < rows.length ? String(offset + limit) : null } : reviews;
    }
    requireMethod(method, ['POST']);
    if (!staff && !publisher) fail(403, 'Only a publisher can submit in this experience.');
    if (state.reviews.length >= 80) fail(429, 'This demo has reached 80 reviews. Start a fresh demo to continue.');
    const copy = text(body.ad_copy, 5000);
    if (!copy && !text(body.file_name)) fail(400, 'Enter ad copy or choose a sample creative.');
    if (body.batch_id && !state.batches.some(b => b.batch_id === body.batch_id)) fail(404, 'Batch not found in this demo.');
    const review = makeDemoReview(`demo-${nonce}`, now, { name: text(body.file_name, 160) || 'New copy review (demo)', copy: copy || 'Compare options. Rates and eligibility vary.',
      offerIds: offerIds(), vertical: body.vertical === 'home-insurance' ? 'home-insurance' : 'auto-insurance', batchId: text(body.batch_id) || undefined, itemId: text(body.batch_item_id) || undefined, creative: body.has_creative === true }, state.offers);
    state.reviews.unshift(review);
    const batch = state.batches.find(b => b.batch_id === body.batch_id);
    if (batch) {
      const item = batch.items.find(i => i.item_id === body.batch_item_id);
      if (!item) fail(404, 'Batch item not found in this demo.');
      Object.assign(item, { job_id: review.history.job_id, status: 'complete', result: review.client.ai_status, message: review.history.message, offer_outcomes: review.history.offer_outcomes });
      batch.updated_at = now;
    }
    note('Simulated a creative review. No upload or AI processing was performed.');
    return review.history;
  }
  if (route === '/api/reviews/release-selection' || route === '/api/reviews/release') {
    requireMethod(method, ['POST']);
    if (!staff && !publisher) fail(403, 'Publishers release creatives; advertisers make decisions.');
    const rows = selected();
    if (route.endsWith('release-selection')) return { job_ids: rows.map(r => r.history.job_id), offers: state.offers.filter(o => !clientMatch || o.offer_id === DEMO_OFFER).map(o => ({ offer_id: o.offer_id, offer_name: o.display_name, total: rows.filter(r => r.history.offer_ids?.includes(o.offer_id)).length, pending: rows.filter(r => r.history.offer_ids?.includes(o.offer_id) && !r.history.released_offer_ids?.includes(o.offer_id)).length })) };
    if (body.confirmed !== true) fail(400, 'Confirm the release first.');
    const ids = offerIds();
    for (const r of rows) { r.history.released_offer_ids = [...new Set([...(r.history.released_offer_ids ?? []), ...ids.filter(id => r.history.offer_ids?.includes(id))])]; r.history.released_at = now; r.client.released = r.history.released_offer_ids.includes(DEMO_OFFER); }
    note(`Released ${rows.length} sample creatives inside this demo. Notifications were simulated.`);
    return { released: rows.length, simulated: true };
  }
  const reviewMatch = route.match(/^\/api\/reviews\/([^/]+)(?:\/(report(?:\.json|\.pdf)?|source|evidence|thumbnail|media|decision|frames\/[^/]+))?$/);
  if (reviewMatch) {
    const review = reviewById(reviewMatch[1]);
    const operation = reviewMatch[2];
    if (operation === 'decision') {
      requireMethod(method, ['PUT']);
      if (role !== 'advertiser') fail(403, 'Only the advertiser can decide on a released creative.');
      if (!['pending', 'approved', 'disapproved'].includes(String(body.decision))) fail(400, 'Invalid review decision.');
      const reasons: ClientFeedbackReason[] = ['false_positive', 'confirmed_issue', 'missed_policy_issue', 'partner_preference', 'one_off_exception', 'business_decision'];
      if (body.feedback_reason && !reasons.includes(body.feedback_reason as ClientFeedbackReason)) fail(400, 'Invalid feedback reason.');
      const decision = body.decision === 'pending' ? null : { decision: body.decision as 'approved' | 'disapproved', decided_at: now, feedback_note: text(body.feedback_note, 2000), feedback_reason: body.feedback_reason as ClientFeedbackReason ?? null, feedback_scope: body.feedback_scope === 'similar_creatives' ? 'similar_creatives' as const : 'this_creative' as const };
      review.client.previous_decision = review.client.decision;
      review.client.decision = decision;
      review.client.effective_status = effectiveReviewStatus(review.client);
      const outcome = review.history.offer_outcomes?.find(o => o.offer_id === DEMO_OFFER);
      if (outcome) Object.assign(outcome, { automated_status: review.client.ai_status, effective_status: review.client.effective_status, client_decision: decision?.decision ?? null, client_decided_at: decision?.decided_at ?? null, client_feedback_note: decision?.feedback_note ?? null, client_feedback_reason: decision?.feedback_reason ?? null });
      review.report.client_decisions = decision ? [{ ai_status: review.client.ai_status, client_id: DEMO_OFFER, offer_id: DEMO_OFFER, decided_at: decision.decided_at, decision: decision.decision, feedback_note: decision.feedback_note, feedback_reason: decision.feedback_reason }] : [];
      if (decision) review.decisions = [...review.decisions, decision].slice(-20);
      note(`Advertiser marked ${review.history.file_name}: ${body.decision}.`);
      return decision;
    }
    if (method === 'DELETE' && !operation) {
      if (!owner) fail(403, 'Only the administrator can remove review history.');
      state.reviews = state.reviews.filter(r => r !== review); return { job_id: review.history.job_id, deleted_at: now };
    }
    requireMethod(method, ['GET', 'HEAD']);
    const frames = review.history.has_creative ? [{ filename: 'sample.svg', timestamp: 14, url: `/api/reviews/${review.history.job_id}/frames/sample.svg` }] : [];
    if (operation === 'source') return { sources: [{ status: 'unavailable', kind: null, label: 'Fictional demo creative', message: 'This sample has no external source.', checked_at: now }] };
    if (operation === 'evidence') return { frames };
    if (operation === 'thumbnail' || operation === 'media' || operation?.startsWith('frames/')) return { demo_asset: true, title: review.history.file_name, claim: review.report.findings[0]?.evidence ?? 'Compare options. Rates vary.' };
    if (operation?.startsWith('report')) return clientMatch ? review.report.offer_results?.find(r => r.offer_id === DEMO_OFFER) ?? review.report : review.report;
    if (clientMatch) return { client_id: DEMO_OFFER, display_name: state.offers[0].display_name, review: clientView(review), report: review.report.offer_results?.find(r => r.offer_id === DEMO_OFFER) ?? review.report, evidence_frames: frames, google_drive_url: null, report_pdf_url: `${url.pathname}/report.pdf` };
    return review.history;
  }
  if (route === '/api/batches') {
    if (method === 'GET') { const ids = (url.searchParams.get('ids') ?? '').split(','); return state.batches.filter(b => ids.includes(b.batch_id)); }
    requireMethod(method, ['POST']);
    if (!staff) fail(403, 'Only staff can create admin batches.');
    const id = text(body.batch_id, 100);
    if (!id || !Array.isArray(body.items) || !body.items.length || body.items.length > 20) fail(400, 'Demo batches support one to 20 items.');
    const existing = state.batches.find(b => b.batch_id === id);
    if (existing) return existing;
    if (state.batches.length >= 20) fail(429, 'The demo supports 20 batches.');
    const batch: ReviewBatch = { batch_id: id, created_at: now, updated_at: now, expected_count: body.items.length, source_label: text(body.source_label, 200) || 'Demo submission', notification_status: 'Simulated', items: body.items.map(object).map(i => ({ item_id: text(i.item_id, 100), file_name: text(i.file_name, 160), media_kind: i.media_kind === 'image' ? 'image' : i.media_kind === 'video' ? 'video' : 'copy_only', status: 'pending', message: 'Waiting for demo submission' })) };
    state.batches.push(batch); return batch;
  }
  const batchMatch = route.match(/^\/api\/batches\/([^/]+)(\/report\.pdf)?$/);
  if (batchMatch) {
    requireMethod(method, ['GET']);
    const batch = state.batches.find(b => b.batch_id === batchMatch[1]) ?? fail(404, 'Batch not found.');
    const rows = visible().filter(r => r.history.batch_id === batch.batch_id);
    if (!rows.length) fail(404, 'No accessible reviews in this batch.');
    if (batchMatch[2]) return { demo_reports: rows.map(r => ({ ...(clientMatch ? r.report.offer_results?.find(o => o.offer_id === DEMO_OFFER) ?? r.report : r.report), file_name: r.history.file_name })) };
    return { ...batch, items: batch.items.filter(i => rows.some(r => r.history.job_id === i.job_id)) };
  }
  if (route === '/api/submissions') { requireMethod(method, ['GET']); return publisherFilter(visible()).map(r => ({ jobId: r.history.job_id, publisherId: r.client.publisher_id, fileName: r.history.file_name, status: r.history.status, progress: 100, message: r.history.message, createdAt: r.history.created_at, released: r.client.released })); }
  const deleteSubmission = route.match(/^\/api\/submissions\/([^/]+)$/);
  if (deleteSubmission) { requireMethod(method, ['DELETE']); if (!publisher) fail(403, 'Publisher access required.'); const r = reviewById(deleteSubmission[1]); if (r.client.released) fail(409, 'Released creatives stay in the review history.'); state.reviews = state.reviews.filter(x => x !== r); return { removed: true }; }
  if (route === '/api/plan') { requireMethod(method, ['GET']); return { ...state.plan, clientId: DEMO_OFFER, monthlyReviews: state.reviews.length, publishers: state.publishers.length }; }
  if (route === '/api/publishers') {
    if (publisher) fail(403, 'Publisher management requires advertiser access.');
    if (method === 'GET') return state.publishers;
    requireMethod(method, ['POST']);
    if (state.publishers.length >= 10) fail(429, 'The demo supports ten publishers.');
    if (text(body.name, 100).length < 2) fail(400, 'Enter a publisher name.');
    const id = `demo-${nonce}`;
    const username = `${id}@demo.example`;
    state.publishers.push({ publisherId: id, name: text(body.name, 100), username, status: 'invited', createdAt: now, inviteExpiresAt: now + 86400000 });
    note('Created a fictional publisher invitation. No invitation was sent.');
    return { publisher_id: id, username, invite_url: 'https://demo.example/invitation-simulated' };
  }
  const pubMatch = route.match(/^\/api\/publishers\/([^/]+)(\/invite)?$/);
  if (pubMatch) {
    if (publisher) fail(403, 'Advertiser access required.');
    const p = state.publishers.find(p => p.publisherId === pubMatch[1]) ?? fail(404, 'Publisher not found.');
    requireMethod(method, pubMatch[2] ? ['POST'] : ['DELETE']);
    p.status = pubMatch[2] ? 'invited' : 'suspended';
    return pubMatch[2] ? { publisher_id: p.publisherId, username: p.username, invite_url: 'https://demo.example/invitation-simulated' } : { suspended: true };
  }
  if (route === '/api/shares') {
    if (method === 'GET') return state.shares;
    requireMethod(method, ['POST']);
    if (state.shares.length >= 20) fail(429, 'The demo supports 20 private links.');
    const rows = selected();
    const shareId = `demo-${nonce}`;
    state.shares.push({ shareId, title: text(body.title, 100) || 'Demo review', createdAt: now, expiresAt: now + 86400000, revokedAt: null, count: rows.length, jobIds: rows.map(r => r.history.job_id), offerId: DEMO_OFFER });
    note('Simulated sharing. The link only opens inside this private demo session.');
    return { share_id: shareId, url: `${DEMO_BASE}${staff ? `/reviews/${rows[0].history.job_id}/report` : `/client/${DEMO_OFFER}/reviews/${rows[0].history.job_id}`}`, simulated: true };
  }
  const shareMatch = route.match(/^\/api\/shares\/([^/]+)$/);
  if (shareMatch) { requireMethod(method, ['DELETE']); const s = state.shares.find(s => s.shareId === shareMatch[1]) ?? fail(404, 'Link not found.'); s.revokedAt = now; return { revoked: true }; }
  if (route === '/api/release-emails/options') {
    requireMethod(method, ['GET']);
    return { advertisers: state.offers.filter(o => staff || o.offer_id === DEMO_OFFER).map(o => ({ id: o.offer_id, name: o.display_name })), sender: 'simulation@demo.example', sending_enabled: true, simulated: true };
  }
  if (route === '/api/release-emails/recent') { requireMethod(method, ['GET']); return state.emails; }
  if (route === '/api/release-emails/batches') {
    requireMethod(method, ['GET']);
    return { batches: state.batches.flatMap(b => { const rows = visible().filter(r => r.history.batch_id === b.batch_id && r.history.released_offer_ids?.includes(DEMO_OFFER)); return rows.length ? [{ batchId: b.batch_id, title: b.source_label, label: b.source_label, count: rows.length, createdAt: b.created_at }] : []; }), cursor: '', isDone: true };
  }
  if (route === '/api/release-emails/preview') {
    requireMethod(method, ['POST']);
    if (role === 'advertiser') fail(403, 'This simulation is for publishers and staff.');
    if (state.emails.length >= 15) fail(429, 'This demo supports 15 email previews.');
    const emailId = text(body.email_id, 100);
    const existing = state.emails.find(e => e.emailId === emailId);
    if (existing) return existing;
    if (!emailId || !Array.isArray(body.batches) || !body.batches.length || body.batches.length > 20 || !strings(body.to).length) fail(400, 'Choose a released batch and enter a recipient.');
    if (body.offer_id !== DEMO_OFFER) fail(400, 'Choose Harbor Auto for this simulation.');
    const links = body.batches.map(object).map(b => {
      const rows = visible().filter(r => r.history.batch_id === b.batch_id && r.history.released_offer_ids?.includes(DEMO_OFFER));
      if (!rows.length) fail(404, 'Released batch not found in this demo.');
      return { batchId: text(b.batch_id, 100), label: text(b.label, 200), url: 'https://demo.example/private-simulated-link', jobIds: rows.map(r => r.history.job_id) };
    });
    const email = { emailId, offerId: DEMO_OFFER, to: strings(body.to).slice(0, 10).map(x => x.slice(0, 200)), cc: strings(body.cc).slice(0, 10).map(x => x.slice(0, 200)), replyTo: text(body.reply_to, 200), subject: text(body.subject, 200), message: text(body.message, 2000), signature: text(body.signature, 500), status: 'draft' as const, createdAt: now, expiresAt: now + 86400000, links };
    state.emails.push(email); return email;
  }
  const emailSend = route.match(/^\/api\/release-emails\/([^/]+)\/send$/);
  if (emailSend) {
    requireMethod(method, ['POST']);
    if (role === 'advertiser') fail(403, 'Publisher or staff access required.');
    const email = state.emails.find(e => e.emailId === emailSend[1]) ?? fail(404, 'Demo email not found.');
    if (body.confirmed !== true) fail(400, 'Confirm the simulated send first.');
    email.status = 'sent'; email.sentAt = now;
    note('Simulated sending a review email. No message left this demo workspace.');
    return { status: 'sent', simulated: true };
  }
  if (route === '/api/admin/workspaces') { ownerOnly(); requireMethod(method, ['GET']); return state.offers.map(o => ({ ...state.plan, clientId: o.offer_id, name: o.display_name, monthlyReviews: state.reviews.length, publishers: state.publishers.length })); }
  const planMatch = route.match(/^\/api\/admin\/workspaces\/([^/]+)\/plan$/);
  if (planMatch) { ownerOnly(); requireMethod(method, ['PUT']); if (!state.offers.some(o => o.offer_id === planMatch[1])) fail(404, 'Workspace not found.'); if (!['pilot', 'starter', 'growth', 'enterprise'].includes(String(body.plan))) fail(400, 'Invalid plan.'); state.plan = { plan: body.plan as DemoState['plan']['plan'], publisherLimit: Math.min(100, Math.max(1, Number(body.publisher_limit) || 25)), monthlyReviewLimit: Math.min(10000, Math.max(1, Number(body.monthly_review_limit) || 1000)) }; note('Simulated a plan change. No payment was taken.'); return state.plan; }
  if (route === '/api/admin/api/partners') { ownerOnly(); requireMethod(method, ['GET']); return { partners: [], available_scopes: ['reviews:create', 'reviews:read'], base_url: 'https://demo.example/api/v1' }; }
  if (route === '/api/drive/options') { requireMethod(method, ['GET']); return { default_drive_id: 'demo', options: [{ drive_id: 'demo', name: 'Fictional sample library' }] }; }
  if (route === '/api/drive/browse') { requireMethod(method, ['GET']); return { current_folder: { folder_id: 'demo', name: 'Fictional sample library', web_view_link: '' }, items: [], max_selection: 20 }; }
  if (route === '/api/live-scans') { requireMethod(method, ['GET']); return { observation_date: url.searchParams.get('date'), accounts: [], totals: { accounts_observed: 0, copy_variants: 0, live_ads: 0, pending: 0, unique_creatives: 0, outcomes: { green: 0, yellow: 0, red: 0 } } }; }
  if (route === '/api/automations') { ownerOnly(); requireMethod(method, ['GET']); return { automations: state.automations }; }
  const automationMatch = route.match(/^\/api\/automations\/([^/]+)(\/run)?$/);
  if (automationMatch) {
    ownerOnly(); requireMethod(method, automationMatch[2] ? ['POST'] : ['PUT', 'DELETE']);
    let automation = state.automations.find(a => a.automation_id === automationMatch[1]);
    if (method === 'DELETE') { if (!automation) fail(404, 'Demo automation not found.'); state.automations = state.automations.filter(a => a !== automation); return { deleted: true }; }
    if (automationMatch[2]) {
      if (!automation) fail(404, 'Demo automation not found.');
      Object.assign(automation, { last_run_at: now, last_run_status: 'complete', last_run_message: 'Simulated check completed. No Drive access, paid processing, or notifications.', updated_at: now });
      return { automation, status: 'complete', message: automation.last_run_message, matched_count: 4, queued_count: 0, batch_id: state.batches[0]?.batch_id ?? null, job_ids: [], simulated: true };
    }
    if (!text(body.name, 100)) fail(400, 'Enter an automation name.');
    if (!automation) { if (state.automations.length >= 10) fail(429, 'The demo supports ten automations.'); automation = { automation_id: automationMatch[1].slice(0, 100), created_at: now }; state.automations.push(automation); }
    Object.assign(automation, { name: text(body.name, 100), enabled: body.enabled === true, folder_id: text(body.folder_id, 200), file_name_pattern: text(body.file_name_pattern, 100), time_of_day: text(body.time_of_day, 5), timezone: text(body.timezone, 100), days_of_week: Array.isArray(body.days_of_week) ? body.days_of_week.filter(d => Number.isInteger(d) && Number(d) >= 0 && Number(d) < 7) : [], include_subfolders: body.include_subfolders === true, updated_at: now, last_run_message: 'Demo only. Scheduled background execution is disabled.' });
    return automation;
  }
  if (route.startsWith('/api/learning/')) { ownerOnly(); requireMethod(method, ['GET']); return { available: true, canManage: false, profile: { version: 1, baseText: state.offers[0].official_guidelines }, state: { enabled: false, status: 'paused', message: 'Learning is paused in the demo. Feedback remains in this workspace.', version: 0, updatedAt: now }, current: null, versions: [], nextBeforeVersion: null, runs: [], decisions: state.reviews.flatMap(r => r.decisions.map(d => ({ id: r.history.job_id, jobId: r.history.job_id, decidedAt: d.decided_at, decision: d.decision, note: d.feedback_note ?? '', reason: d.feedback_reason ?? '' }))) }; }
  if (route === '/api/admin/platform') {
    ownerOnly(); requireMethod(method, ['GET']);
    return { observed_at: now, convex: { status: 'Demo simulation', latency_ms: 0 }, backend: { status: 'Demo simulation', instance_id: 'demo', queue: { active: 0, pending: 0, workers: 0 } }, overview: { observedAt: now, sampleLimit: 80, sampledOfferResults: state.reviews.length * 2, publishers: state.publishers.length, instances: [], traffic: [], reviews: { sampled: state.reviews.length, complete: state.reviews.length, failed: 0, pending: 0 }, processing: { sampleSize: 0, medianMs: null, p95Ms: null, p95QueueWaitMs: null, failed: 0 }, advertisers: state.offers.map(o => ({ clientId: o.display_name, reviews: state.reviews.length, completed: state.reviews.length, pending: 0, failed: 0, flagged: state.reviews.filter(r => r.client.ai_status !== 'green').length, publishers: state.publishers.map(p => ({ ...p, reviews: state.reviews.filter(r => r.client.publisher_id === p.publisherId).length, completed: 0, pending: 0, failed: 0, flagged: 0 })) })) } };
  }
  // A closed allowlist: new production endpoints cannot silently become available.
  return fail(403, 'This external or administrative action is unavailable in the demo. No real action was taken.');
}
