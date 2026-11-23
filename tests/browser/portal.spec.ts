import { expect, test, type Page } from '@playwright/test';
import type { ClientReviewItem } from '../../frontend/src/lib/api';

for (const surface of ['client', 'admin']) {
  test(`${surface} waits for the session result before asking for a password`, async ({ page }) => {
    const path = surface === 'client' ? '/client' : '/';
    const session = `/api/${surface}/session`;
    const pending = Promise.withResolvers<void>();
    await page.route(`**${session}`, async route => {
      await pending.promise;
      await route.fulfill({ status: 401, json: { detail: 'Signed out' } });
    });
    const request = page.waitForRequest(req => new URL(req.url()).pathname === session);
    await page.goto(`${path}?surface=${surface}`);
    await request;
    try {
      const password = page.getByLabel('Password', { exact: true });
      const loading = page.getByRole('status').filter({ hasText: /checking your session/i });
      await expect(loading.or(password)).toBeVisible();
      await expect(password).toHaveCount(0);
    } finally {
      pending.resolve();
    }
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    if (surface === 'client') {
      await expect(page.getByText('Sign in to review your creatives and share your decisions.')).toBeVisible();
    }
  });
}

async function openWorkspace(page: Page, role: 'client' | 'publisher' = 'client', reviews: ClientReviewItem[] = []) {
  await page.route('**/api/client/session', route => route.fulfill({ json: {
    role, username: 'fixture-user', publisher_name: 'Fixture Publisher',
    portals: [{ client_id: 'fixture', display_name: 'Fixture Insurance' }],
  } }));
  await page.route('**/api/client/fixture/publishers', route => route.fulfill({ json: [] }));
  await page.route('**/api/client/fixture/verticals', route => route.fulfill({ json: [
    { verticalId: 'auto-insurance', name: 'Active vertical', enabled: true },
    { verticalId: 'home-insurance', name: 'Inactive vertical', enabled: false },
  ] }));
  await page.route('**/api/client/fixture/reviews?*', route => route.fulfill({ json: {
    client_id: 'fixture', display_name: 'Fixture Insurance', reviews,
  } }));
  await page.goto('/client/settings?surface=client');
}

test('a publisher sees its own company in the advertiser workspace', async ({ page }) => {
  await openWorkspace(page, 'publisher');
  await expect(page.getByRole('group', { name: 'Signed-in company' })).toContainText('Fixture Publisher');
});

test('an advertiser sees its company and saved queue preferences after reloading', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.getByRole('group', { name: 'Signed-in company' })).toContainText('Fixture Insurance');
  await expect(page.getByRole('button', { name: 'Active vertical' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inactive vertical' })).toHaveCount(0);
  const list = page.getByRole('button', { name: /List view/ });
  await expect(page.getByText('Display density', { exact: true })).toBeVisible();
  await expect(page.getByText('Default result filter', { exact: true })).toBeVisible();
  await list.click();
  const expand = page.getByRole('switch', { name: 'Open newest batch automatically' });
  await expand.click();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.reload();
  await expect(list).toHaveAttribute('aria-pressed', 'true');
  await expect(expand).not.toBeChecked();
  await page.getByRole('button', { name: 'Review queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/client/settings?surface=client');
  await page.getByRole('button', { name: 'Reset defaults' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: /Grid view/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(expand).toBeChecked();
});

function batchReviews(): ClientReviewItem[] {
  return (['red', 'yellow', 'green'] as const).map((color, index) => ({
    job_id: color, file_name: `${color}.txt`, ai_status: color, effective_status: color,
    batch_id: 'spring', batch_source_label: 'Spring campaign', batch_created_at: 1800000000000,
    created_at: 1800000000000 + index, decision: null, previous_decision: null,
    media_kind: 'copy_only', vertical: 'auto-insurance', issue_summary: null,
    preview: { finding_count: 0, findings: [], google_drive_url: null, summary: 'A synthetic ad.' },
  }));
}

async function openQueue(page: Page, role: 'client' | 'publisher', reviews: ClientReviewItem[]) {
  await page.route('**/api/client/fixture/reviews/*/thumbnail', route => route.fulfill({ status: 404 }));
  await page.route('**/api/client/fixture/reviews/release-selection', route => route.fulfill({
    json: { job_ids: reviews.map(review => review.job_id), offers: [
      { offer_id: 'fixture', offer_name: 'Fixture Insurance', total: reviews.length, pending: reviews.length },
    ] },
  }));
  await page.route('**/api/client/fixture/submissions', route => route.fulfill({ json: [] }));
  await openWorkspace(page, role, reviews);
  await page.route('**/api/client/fixture/reviews/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    const review = reviews.find(item => item.job_id === id);
    if (!review) return route.fallback();
    await route.fulfill({ json: {
      client_id: 'fixture', display_name: 'Fixture Insurance', review, evidence_frames: [],
      report: { summary: review.preview.summary, findings: [] }, google_drive_url: null,
    } });
  });
  await page.getByRole('button', { name: 'Review queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
}

test('the advertiser can filter effective results and open batch and vertical performance', async ({ page }) => {
  await openQueue(page, 'client', batchReviews());
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(navigation).toHaveText(/Performance.*Overview.*Active vertical.*Workspace.*Review queue.*Publishers/s);
  await expect(page.getByRole('navigation', { name: 'Account navigation' })).toHaveText(/Plan & usage.*Settings/s);
  for (const color of ['red', 'yellow', 'green']) {
    await expect(page.getByText(`1 ${color}`, { exact: true }).first()).toBeVisible();
  }
  const filter = page.getByRole('button', { name: /^Result:/ });
  for (const color of ['Red', 'Yellow', 'Green']) {
    await filter.click();
    await page.getByRole('menuitem', { name: new RegExp(`^${color}\\s*1$`) }).click();
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('article')).toContainText(`${color.toLowerCase()}.txt`);
  }
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('link', { name: 'View insights' }).click();
  await expect(page).toHaveURL(/\/client\/fixture\/batches\/spring/);
  await expect(page.getByRole('heading', { name: 'Spring campaign' })).toBeVisible();
  await expect(page.getByText('Creatives in this batch')).toBeVisible();
  await navigation.getByRole('button', { name: 'Active vertical' }).click();
  await expect(page).toHaveURL(/\/client\/verticals\/auto-insurance(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Auto Insurance', exact: true })).toBeVisible();
  await expect(page.getByText('Batch performance', { exact: true })).toBeVisible();
  await expect(page.getByText('Performance by insurance line')).toBeVisible();
});

test('a failed decision keeps its note and a saved decision changes the effective result', async ({ page }) => {
  const reviews = batchReviews();
  const red = reviews[0];
  const note = 'The updated creative includes the required disclosure.';
  let failNext = true;
  await page.route('**/api/client/fixture/reviews/red/decision', async route => {
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { detail: 'Fixture storage unavailable' } });
    }
    const body = route.request().postDataJSON();
    if (body.decision === 'pending') {
      red.previous_decision = red.decision;
      red.decision = null;
      red.effective_status = red.ai_status;
    } else {
      expect(body).toMatchObject({ decision: 'approved', feedback_reason: 'false_positive', feedback_note: note });
      red.decision = { decision: body.decision, decided_at: 1800000100000,
        feedback_note: body.feedback_note, feedback_reason: body.feedback_reason };
      red.effective_status = 'green';
    }
    await route.fulfill({ json: red.decision });
  });
  await openQueue(page, 'client', reviews);
  const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'red.txt' }) });
  await card.getByRole('button', { name: 'Add note' }).click();
  await expect(card.getByLabel('Decision note (optional)')).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('What informed your decision?')).toBeVisible();
  await page.getByLabel('Reason', { exact: true }).click();
  await page.getByRole('option', { name: 'AdChecked was too strict' }).click();
  const details = page.getByLabel('Additional details (required)');
  const save = page.getByRole('button', { name: 'Save decision' });
  await expect(save).toBeDisabled();
  await details.fill(note);
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture storage unavailable' }).first()).toContainText('Fixture storage unavailable');
  await expect(details).toHaveValue(note);
  await save.click();
  await expect(card.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
  await page.goto('/client/reviews?surface=client');
  await expect(page.getByRole('img', { name: 'Final client decisions: 1 Approved, 2 Pending, 0 Disapproved' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Original AdChecked assessment: 1 Green, 1 Yellow, 1 Red' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Results for Spring campaign: 3 creatives, 2 green, 1 yellow, 0 red/ })).toBeVisible();
  await card.getByRole('button', { name: 'red.txt' }).click();
  await card.getByRole('link', { name: 'Open full review for red.txt' }).click();
  await expect(page.getByText('Different from recommendation', { exact: true }).first()).toBeVisible();
  for (const phrase of ['Admin view · all clients', 'Calibrates future reviews', 'Client override',
    'Learning signal', 'guarded precedent', 'Reusable policy feedback']) {
    await expect(page.getByText(phrase)).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Reset to pending' }).click();
  await expect(page.getByText('Previous decision note:').locator('..')).toContainText(note);
  await page.getByRole('link', { name: 'Back to reviews' }).click();
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Results for Spring campaign: 3 creatives, 1 green, 1 yellow, 1 red/ })).toBeVisible();
});

test('the publisher can open uploads and sees advertiser decisions as read-only', async ({ page }) => {
  await openQueue(page, 'publisher', batchReviews());
  const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'red.txt' }) });
  await expect(card.getByText('Awaiting advertiser')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release batch' })).toBeEnabled();
  await expect(card.getByRole('button', { name: /^(Approve|Disapprove|Reset)$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publishers', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Uploads & progress' }).click();
  await expect(page.getByRole('heading', { name: 'Uploads & progress' })).toBeVisible();
});
