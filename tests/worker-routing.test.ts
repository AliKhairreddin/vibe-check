import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiRequestAllowed,
  authRateLimitKey,
  hostSurface,
  isAdminPagePath,
  isAdminSessionPath,
  isContainerUnavailableMessage,
  isDriveReviewSubmission,
  legacyDestination,
  shouldRedirectAdminPathToClient,
} from '../worker/routing.ts';

test('maps only declared production hostnames to privileged surfaces', () => {
  assert.equal(hostSurface('adchecked.com'), 'public');
  assert.equal(hostSurface('app.adchecked.com'), 'client');
  assert.equal(hostSurface('admin.adchecked.com'), 'admin');
  assert.equal(hostSurface('api.adchecked.com'), 'api');
  assert.equal(hostSurface('vibe-check.example.workers.dev'), 'workers');
  assert.equal(hostSurface('admin.adchecked.com.attacker.example'), 'unknown');
});

test('keeps the admin login on the admin surface while redirecting client dashboards', () => {
  assert.equal(isAdminPagePath('/login'), true);
  assert.equal(shouldRedirectAdminPathToClient('/login'), false);
  assert.equal(shouldRedirectAdminPathToClient('/client'), true);
  assert.equal(shouldRedirectAdminPathToClient('/kissterra/reviews/job-1'), true);
});

test('recognizes the two rate-limited owner credential exchange endpoints', () => {
  assert.equal(isAdminSessionPath('/api/admin/session'), true);
  assert.equal(isAdminSessionPath('/api/scanner/session'), true);
  assert.equal(isAdminSessionPath('/api/admin/check'), false);
});

test('limits container-capacity fallback to retry-safe Drive review submissions', () => {
  assert.equal(
    isDriveReviewSubmission(new Request('https://admin.adchecked.com/api/drive/reviews', { method: 'POST' })),
    true,
  );
  assert.equal(
    isDriveReviewSubmission(new Request(
      `https://admin.adchecked.com/api/batches/${'a'.repeat(32)}/items/${'b'.repeat(32)}/retry-drive`,
      { method: 'POST' },
    )),
    true,
  );
  assert.equal(
    isDriveReviewSubmission(new Request('https://admin.adchecked.com/api/drive/reviews')),
    false,
  );
  assert.equal(
    isDriveReviewSubmission(new Request('https://admin.adchecked.com/api/reviews', { method: 'POST' })),
    false,
  );
});

test('recognizes Cloudflare container-capacity failures without retrying unrelated errors', () => {
  assert.equal(
    isContainerUnavailableMessage('There is no Container instance available at this time.'),
    true,
  );
  assert.equal(
    isContainerUnavailableMessage(new Error('Reached your max concurrent instance count')),
    true,
  );
  assert.equal(isContainerUnavailableMessage('Google Drive returned HTTP 403.'), false);
});

test('builds sign-in rate-limit keys without trusting caller-supplied hostnames', () => {
  const request = new Request('https://app.adchecked.com/api/client/check', {
    headers: { 'cf-connecting-ip': '192.0.2.10' },
  });
  assert.equal(authRateLimitKey(request, 'client'), 'client:192.0.2.10');
});

test('allows only the API family assigned to each hostname', () => {
  assert.equal(apiRequestAllowed('admin', '/api/reviews'), true);
  assert.equal(apiRequestAllowed('admin', '/api/client/check'), false);
  assert.equal(apiRequestAllowed('admin', '/api/v1/reviews'), false);
  assert.equal(apiRequestAllowed('client', '/api/client/check'), true);
  assert.equal(apiRequestAllowed('client', '/api/reviews'), false);
  assert.equal(apiRequestAllowed('api', '/api/v1/reviews'), true);
  assert.equal(apiRequestAllowed('api', '/api/reviews'), false);
  assert.equal(apiRequestAllowed('workers', '/api/v1/reviews'), true);
  assert.equal(apiRequestAllowed('workers', '/api/reviews'), false);
  assert.equal(apiRequestAllowed('legacy', '/api/v1/reviews'), true);
  assert.equal(apiRequestAllowed('legacy', '/api/client/kissterra/reviews'), true);
  assert.equal(apiRequestAllowed('legacy', '/api/live-scans/observe'), true);
  assert.equal(apiRequestAllowed('legacy', '/api/client/session'), false);
  assert.equal(apiRequestAllowed('legacy', '/api/reviews'), false);
  assert.equal(apiRequestAllowed('public', '/api/client/check'), false);
});

test('preserves legacy paths and queries while sending users to the correct surface', () => {
  assert.equal(
    legacyDestination(new URL('https://vibe-check.thatcanadian.dev/client?tab=pending')).toString(),
    'https://app.adchecked.com/client?tab=pending',
  );
  assert.equal(
    legacyDestination(new URL('https://vibe-check.thatcanadian.dev/kissterra/reviews/job-1')).toString(),
    'https://app.adchecked.com/client/kissterra/reviews/job-1',
  );
  assert.equal(
    legacyDestination(new URL('https://vibe-check.thatcanadian.dev/history')).toString(),
    'https://admin.adchecked.com/history',
  );
  assert.equal(
    legacyDestination(new URL('https://vibe-check.thatcanadian.dev/api/v1/me')).toString(),
    'https://api.adchecked.com/api/v1/me',
  );
});
