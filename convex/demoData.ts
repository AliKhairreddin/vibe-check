import type { ClientReviewItem, OfferProfile, Report, ReviewBatch, ReviewHistoryItem } from '../frontend/src/lib/api';
import type { Publisher, SharedLink } from '../frontend/src/lib/workspace-api';
import type { DemoRole } from '../shared/demo.ts';
import { effectiveReviewStatus } from '../frontend/src/lib/client-review-status.ts';

export type DemoReview = { history: ReviewHistoryItem; client: ClientReviewItem; report: Report; decisions: NonNullable<ClientReviewItem['decision']>[] };
export type DemoEmail = { emailId: string; offerId: string; to: string[]; cc: string[]; replyTo: string; subject: string; message: string; signature: string; status: 'draft' | 'sent'; createdAt: number; expiresAt: number; sentAt?: number; links: { batchId: string; label: string; url: string; jobIds: string[] }[] };
export type DemoState = {
  offers: OfferProfile[]; reviews: DemoReview[]; batches: ReviewBatch[]; publishers: Publisher[];
  shares: (SharedLink & { jobIds: string[]; offerId: string })[];
  automations: Record<string, unknown>[];
  emails: DemoEmail[];
  activity: { at: number; message: string }[];
  plan: { plan: 'pilot' | 'starter' | 'growth' | 'enterprise'; publisherLimit: number; monthlyReviewLimit: number };
};
export const DEMO_OFFER = 'harbor-auto';
export const DEMO_PUBLISHER = 'demo-northstar';
export const DEMO_OFFER_NAMES: Record<string, string> = { 'harbor-auto': 'Harbor Auto (fictional)', 'maple-home': 'Maple Home (fictional)' };
export function demoClientSession(role: DemoRole) {
  return {
    role: role === 'publisher' ? 'publisher' : 'client', username: `${role}@demo.example`,
    ...(role === 'publisher' ? { publisher_id: DEMO_PUBLISHER, publisher_name: 'Northstar Studio (fictional)', publisher_ids: { [DEMO_OFFER]: DEMO_PUBLISHER } } : {}),
    portals: [{ client_id: DEMO_OFFER, display_name: DEMO_OFFER_NAMES[DEMO_OFFER], category: 'Auto insurance' }],
  };
}
export function makeDemoReview(id: string, now: number, input: { name: string; copy: string; offerIds: string[]; vertical?: 'auto-insurance' | 'home-insurance'; batchId?: string; itemId?: string; publisherId?: string; creative?: boolean; released?: boolean }, offers: OfferProfile[]): DemoReview {
  // Deterministic examples only. No model, media extraction, or provider call is made.
  const risky = /guarantee|everyone|government|official/i.test(input.copy);
  const qualify = /save|\d+%|cheapest/i.test(input.copy);
  const status: 'red' | 'yellow' | 'green' = risky ? 'red' : qualify ? 'yellow' : 'green';
  const summary = risky ? 'Unsupported guarantee needs to be removed.' : qualify ? 'Savings claim needs a nearby qualification.' : 'No issues in this illustrative review.';
  const findings: Report['findings'] = status === 'green' ? [] : [{ severity: risky ? 'high' : 'medium', source: 'ad_copy', evidence: input.copy.slice(0, 1000), policy_reason: risky ? 'The fictional offer policy prohibits guarantees of eligibility and government affiliation.' : 'The fictional offer policy requires savings claims to include eligibility and comparison context.', suggested_fix: 'Compare available options. Rates and eligibility vary by driver and provider.', confidence: 'high' }];
  const results = input.offerIds.map(offerId => ({ offer_id: offerId, offer_name: offers.find(o => o.offer_id === offerId)?.display_name ?? offerId,
    guideline_version: offers.find(o => o.offer_id === offerId)?.version ?? 1, overall_status: status, summary,
    source_results: { ad_copy: { status, summary }, ...(input.creative ? { creative: { status, summary: 'Fictional sample creative; uploaded media is not analyzed in the demo.' } } : {}) },
    findings, safe_rewrite: { ad_copy: 'Compare available insurance options. Rates and eligibility vary.', onscreen_text: ['Find coverage that fits your needs.'] },
    limitations: ['Fictional demo result. No AI or media processing was performed. Do not use this as a real compliance assessment.'],
    policy_sources: ['Fictional sample offer guidelines'], applied_overrides: [],
  } satisfies Report));
  const outcomes = results.map(r => ({ offer_id: r.offer_id, offer_name: r.offer_name, evaluation_state: 'evaluated' as const, overall_status: status, creative_result: input.creative ? status : null, ad_copy_result: status, message: summary }));
  const report: Report = { ...results[0], offer_results: results, offer_outcomes: outcomes, primary_offer_id: input.offerIds[0] };
  return {
    history: { job_id: id, file_name: input.name, status: 'complete', progress: 100, message: 'Simulated review complete', report_ready: true,
      created_at: now, updated_at: now, has_creative: Boolean(input.creative), has_ad_copy: true, batch_id: input.batchId ?? null, batch_item_id: input.itemId ?? null,
      history_source: 'digital-nudge', offer_ids: input.offerIds, primary_offer_id: input.offerIds[0], vertical: input.vertical ?? 'auto-insurance',
      overall_status: status, ad_copy_result: status, creative_result: input.creative ? status : null, offer_outcomes: outcomes,
      released_offer_ids: input.released ? input.offerIds : [], released_at: input.released ? now : null },
    client: { job_id: id, file_name: input.name, ai_status: status, effective_status: status, created_at: now, batch_created_at: now,
      batch_id: input.batchId ?? null, batch_source_label: input.batchId ? 'Autumn launch · fictional campaign' : null, batch_complete: true,
      publisher_id: input.publisherId ?? DEMO_PUBLISHER, released: Boolean(input.released), decision: null, previous_decision: null,
      media_kind: input.creative ? 'image' : 'copy_only', vertical: input.vertical ?? 'auto-insurance', issue_summary: findings.length ? summary : null,
      preview: { finding_count: findings.length, findings: findings.map(f => f.policy_reason), google_drive_url: null, summary } },
    report, decisions: [],
  };
}
export function seedDemo(now: number, nonce: string): DemoState {
  const offers: OfferProfile[] = Object.entries(DEMO_OFFER_NAMES).map(([id, name], index) => ({ offer_id: id, display_name: name,
    official_guidelines: 'FICTIONAL SAMPLE POLICY\nSavings claims must state eligibility and comparison context. Never guarantee approval, rates, or government affiliation. Use clear disclosures beside the claim.',
    internal_overrides: [{ override_id: 'demo-qualifier', title: 'Illustrative qualifier placement', guidance: 'Keep the rates-vary qualifier in the same frame as the savings claim.', rationale: 'Fictional internal review precedent.', enabled: true }],
    enabled: true, is_default: index === 0, version: 1, created_at: now - 7 * 86400000, updated_at: now - 86400000 }));
  const batches: ReviewBatch[] = [0, 1, 2].map(i => ({ batch_id: `demo-${nonce}-batch-${i}`, created_at: now - i * 86400000, updated_at: now, expected_count: 4, items: [], source_label: ['Autumn launch · fictional', 'Home protection · fictional', 'Evergreen refresh · fictional'][i], notification_status: 'Demo · no notifications sent' }));
  const names = ['Harbor savings carousel', 'Harbor comparison copy', 'Guaranteed approval concept', 'Rates vary revision', 'Maple home cover', 'Maple savings concept', 'Home quote copy', 'Family coverage revision', 'Weekend comparison', 'Save 40% concept', 'Government benefit concept', 'Coverage checklist'];
  const copies = ['Save up to 40% today.', 'Compare insurance options. Rates and eligibility vary.', 'Guaranteed approval for everyone.', 'Find coverage for your needs. Rates vary.'];
  const reviews = names.map((name, i) => {
    const batch = batches[Math.floor(i / 4)];
    const review = makeDemoReview(`demo-${nonce}-review-${i}`, now - Math.floor(i / 4) * 86400000 - i * 60000, {
      name: `${name} (fictional)${i % 3 === 0 ? '.png' : '.txt'}`, copy: copies[i % 4], offerIds: offers.map(o => o.offer_id),
      batchId: batch.batch_id, itemId: `item-${i}`, creative: i % 3 === 0, released: i !== 0 && i !== 1,
      vertical: i >= 4 && i < 8 ? 'home-insurance' : 'auto-insurance', publisherId: i % 4 === 3 ? 'demo-orbit' : DEMO_PUBLISHER,
    }, offers);
    review.client.batch_source_label = batch.source_label ?? null;
    review.client.batch_created_at = batch.created_at;
    if ([3, 7, 10].includes(i)) {
      review.client.decision = { decision: i === 10 ? 'disapproved' : 'approved', decided_at: now - i * 30000, feedback_note: i === 10 ? 'Remove the unsupported affiliation before resubmitting. Fictional feedback.' : 'Qualifier verified in the revised copy. Fictional feedback.', feedback_reason: i === 10 ? 'confirmed_issue' : 'business_decision' };
      review.client.effective_status = effectiveReviewStatus(review.client);
      review.decisions.push(review.client.decision);
    }
    batch.items.push({ item_id: `item-${i}`, file_name: review.history.file_name, media_kind: review.client.media_kind, job_id: review.history.job_id, result: review.client.ai_status, offer_outcomes: review.history.offer_outcomes, status: 'complete', message: 'Simulated review complete', vertical: review.client.vertical });
    return review;
  });
  return { offers, reviews, batches, publishers: [
    { publisherId: DEMO_PUBLISHER, name: 'Northstar Studio (fictional)', username: 'northstar@demo.example', status: 'active', createdAt: now - 6 * 86400000, inviteExpiresAt: null },
    { publisherId: 'demo-orbit', name: 'Orbit Creative (fictional)', username: 'orbit@demo.example', status: 'active', createdAt: now - 3 * 86400000, inviteExpiresAt: null },
  ], shares: [], emails: [], automations: [{ automation_id: 'demo-daily', name: 'Fictional campaign check', enabled: false, folder_id: 'demo-sample-folder', file_name_pattern: '*.png', time_of_day: '09:00', timezone: 'America/Toronto', days_of_week: [0, 1, 2, 3, 4], include_subfolders: false, created_at: now - 86400000, updated_at: now, last_run_at: now - 3600000, last_run_status: 'complete', last_run_message: 'Simulated check. No Drive access or notifications.', last_batch_id: batches[0].batch_id }], plan: { plan: 'growth', publisherLimit: 25, monthlyReviewLimit: 1000 },
  activity: [{ at: now - 60000, message: 'Harbor campaign reviewed; two creatives await release.' }, { at: now - 120000, message: 'Advertiser requested a correction to the government affiliation claim.' }] };
}
