import { expect, test, type Locator, type Page } from '@playwright/test';

const offer = { offer_id: 'acp', display_name: 'Fixture Insurance', enabled: true, configured: true, version: 1 };
const review = {
  job_id: 'mobile-review', file_name: 'Spring insurance campaign', status: 'complete',
  progress: 100, message: 'Reviewed', report_ready: true, has_creative: false,
  created_at: Date.UTC(2026, 8, 1), updated_at: Date.UTC(2026, 8, 1), vertical: 'home-insurance',
};

async function openAdmin(page: Page, path: string, role: 'owner' | 'employee' = 'owner') {
  await page.route('**/api/admin/session', route => route.fulfill({ json: { authorized: true, role, username: 'fixture', can_manage_settings: role === 'owner' } }));
  await page.route('**/api/offers/catalog', route => route.fulfill({ json: { offers: [offer] } }));
  await page.route('**/api/drive/options', route => route.fulfill({ json: { default_drive_id: 'default', options: [] } }));
  await page.route('**/api/drive/browse?*', route => route.fulfill({ json: { current_folder: { folder_id: 'root', name: 'Fixture' }, items: [], max_selection: 100 } }));
  await page.route('**/api/reviews/history?*', route => route.fulfill({ json: { reviews: [review], next_cursor: null, has_more: false } }));
  await page.route('**/api/reviews/sources', route => route.fulfill({ json: [] }));
  await page.goto(`${path}?surface=admin`);
}

for (const source of ['ad copy', 'uploaded files']) {
  test(`the selected vertical reaches every batch item and review request for ${source}`, async ({ page }) => {
    const items = source === 'ad copy'
      ? ['First spring campaign', 'Second spring campaign'] : ['first.png', 'second.png'];
    let batchItems: Array<{ vertical: string }> = [];
    const submissions = new Map<string, string>();
    await page.route('**/api/reviews/job-*', route => route.fulfill({ json: { ...review, status: 'queued' } }));
    await page.route('**/api/batches', async route => {
      batchItems = route.request().postDataJSON().items;
      await route.fulfill({ json: {} });
    });
    await page.route('**/api/reviews', async route => {
      const request = route.request();
      const body = new Response(request.postDataBuffer(), {
        headers: { 'content-type': request.headers()['content-type'] },
      });
      const form = await body.formData();
      const file = form.get('creative');
      const item = file instanceof File ? file.name : String(form.get('ad_copy'));
      submissions.set(item, String(form.get('vertical')));
      await route.fulfill({ json: { ...review, job_id: `job-${items.indexOf(item)}`, status: 'queued' } });
    });
    await openAdmin(page, '/reviews/new');
    const vertical = page.getByRole('group', { name: 'Creative vertical' });
    await expect(vertical.getByRole('button', { name: 'Auto Insurance' })).toHaveAttribute('aria-pressed', 'true');
    await vertical.getByRole('button', { name: 'Home Insurance' }).click();
    await expect(vertical.getByRole('button', { name: 'Home Insurance' })).toHaveAttribute('aria-pressed', 'true');
    if (source === 'ad copy') {
      await page.getByLabel('Ad copy / platform captions').fill(items.join('\n'));
    } else {
      await page.getByRole('button', { name: 'This computer' }).click();
      await page.locator('input[type=file]').setInputFiles(items.map(name => ({
        name, mimeType: 'image/png', buffer: Buffer.from('synthetic upload'),
      })));
    }
    await page.getByRole('button', { name: 'Create 2 reviews' }).click();
    await expect.poll(() => Object.fromEntries(submissions)).toEqual(Object.fromEntries(items.map(item => [item, 'home-insurance'])));
    expect(batchItems.map(item => item.vertical)).toEqual(['home-insurance', 'home-insurance']);
    const progress = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Progress' }) });
    for (const item of items) await expect(progress.getByRole('row').filter({ hasText: item })).toContainText('Home Insurance');
  });
}

async function expectContainedPage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function expectScrollableTable(table: Locator) {
  await expect(table).toBeVisible();
  const distance = await table.evaluate(node => {
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.scrollWidth > parent.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) {
        parent.scrollLeft = 100;
        return parent.scrollLeft;
      }
    }
    return 0;
  });
  expect(distance).toBeGreaterThan(0);
}

test('phone navigation opens and the batch progress description fits below its actions', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openAdmin(page, '/reviews/new');
  const description = page.getByText(/Jobs are submitted in groups/);
  const actions = page.getByText(/parallel submissions$/);
  await expect(description).toBeVisible();
  const textBox = (await description.boundingBox())!;
  const actionBox = (await actions.boundingBox())!;
  expect(textBox.y).toBeGreaterThanOrEqual(actionBox.y + actionBox.height - 1);
  expect(textBox.x + textBox.width).toBeGreaterThanOrEqual(actionBox.x + actionBox.width - 1);
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expectContainedPage(page);
});

test('review history and batch results scroll inside the phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openAdmin(page, '/history');
  const file = page.getByText(review.file_name, { exact: true });
  await expect(file).toBeVisible();
  await expectScrollableTable(page.getByRole('table').filter({ has: file }));
  await expectContainedPage(page);
  await page.route('**/api/batches/mobile-batch', route => route.fulfill({ json: {
    batch_id: 'mobile-batch', created_at: review.created_at, expected_count: 1,
    items: [{ item_id: 'first', file_name: review.file_name, media_kind: 'copy_only', status: 'queued', message: '' }],
  } }));
  await page.goto('/batches/mobile-batch?surface=admin');
  await expect(page.getByRole('heading', { name: 'Batch report' })).toBeVisible();
  await expectScrollableTable(page.getByRole('table').filter({ has: file }));
  await expectContainedPage(page);
});

test('desktop batch progress stays below the review form with navigation expanded or collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openAdmin(page, '/reviews/new');
  for (const name of ['Collapse navigation', 'Expand navigation']) {
    const submit = page.getByRole('button', { name: 'Create review', exact: true });
    const progress = page.getByRole('heading', { name: 'Batch progress' });
    await expect(progress).toBeVisible();
    const buttonBox = (await submit.boundingBox())!;
    expect((await progress.boundingBox())!.y).toBeGreaterThan(buttonBox.y + buttonBox.height);
    await expectContainedPage(page);
    await page.getByRole('button', { name }).click();
  }
});

test('exception badges fit in the mobile dashboard and report', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const outcome = {
    offer_id: offer.offer_id, offer_name: offer.display_name, evaluation_state: 'evaluated',
    overall_status: 'green', with_override: true, ad_copy_result: 'green', creative_result: null,
  };
  await page.route('**/api/reviews?*', route => route.fulfill({ json: [{ ...review, released_offer_ids: ['acp'], offer_outcomes: [outcome] }] }));
  await page.route('**/api/reviews/stats?*', route => route.fulfill({ json: {
    offer_id: 'acp', offer_ids: ['acp'], vertical: 'all', total_reviews: 1, completed_reviews: 1,
    creative_reviews: 0, copy_only_reviews: 1, in_progress_reviews: 0, failed_reviews: 0,
    accepted_overrides: 1, client_overrides: 0, outcomes: { green: 1, yellow: 0, red: 0 },
  } }));
  await page.route('**/api/reviews/mobile-review', route => route.fulfill({ json: review }));
  await page.route('**/api/reviews/mobile-review/report', route => route.fulfill({ json: {
    ...outcome, internal_disposition: 'accepted_with_override', summary: 'Reviewed', findings: [],
    limitations: [], safe_rewrite: { ad_copy: '', onscreen_text: [] },
  } }));
  await page.route('**/api/reviews/mobile-review/source', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/reviews/mobile-review/thumbnail', route => route.fulfill({ status: 404 }));
  await page.route('**/api/reviews/mobile-review/evidence', route => route.fulfill({ json: { frames: [] } }));
  await openAdmin(page, '/', 'employee');
  const link = page.getByRole('link').filter({ hasText: review.file_name });
  const badge = link.getByText('Green · Exception', { exact: true });
  await expect(badge).toBeVisible();
  const badgeBox = (await badge.boundingBox())!;
  const label = (await link.getByText(offer.display_name, { exact: true }).boundingBox())!;
  expect(badgeBox.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
  expect(badgeBox.x).toBeGreaterThanOrEqual(label.x - 1);
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(label.x + label.width + 1);
  expect(await badge.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Manage releases' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expectContainedPage(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const name of ['Collapse navigation', 'Expand navigation']) {
    await expect(badge).toBeVisible();
    expect(await badge.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expectContainedPage(page);
    await page.getByRole('button', { name }).click();
  }
  await page.setViewportSize({ width: 393, height: 852 });
  await link.click();
  const disposition = page.getByText('Accepted internally', { exact: true });
  await expect(disposition).toBeVisible();
  const statusBox = (await disposition.boundingBox())!;
  const summary = (await page.getByText(/Review job mobile-review/).boundingBox())!;
  expect(statusBox.y).toBeGreaterThanOrEqual(summary.y + summary.height - 1);
  await expectContainedPage(page);
});
