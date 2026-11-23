import { expect, test, type Page } from '@playwright/test';

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
  });
}

async function openWorkspace(page: Page, role: 'client' | 'publisher' = 'client') {
  await page.route('**/api/client/session', route => route.fulfill({ json: {
    role, username: 'fixture-user', publisher_name: 'Fixture Publisher',
    portals: [{ client_id: 'fixture', display_name: 'Fixture Insurance' }],
  } }));
  await page.route('**/api/client/fixture/publishers', route => route.fulfill({ json: [] }));
  await page.route('**/api/client/fixture/verticals', route => route.fulfill({ json: [
    { verticalId: 'auto', name: 'Active vertical', enabled: true },
    { verticalId: 'home', name: 'Inactive vertical', enabled: false },
  ] }));
  await page.route('**/api/client/fixture/reviews?*', route => route.fulfill({ json: {
    client_id: 'fixture', display_name: 'Fixture Insurance', reviews: [],
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
