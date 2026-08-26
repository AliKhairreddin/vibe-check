import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientDashboardSource = readFileSync(
  new URL('../frontend/src/components/client-dashboard.tsx', import.meta.url),
  'utf8',
);

test('keeps internal review-processing language out of the customer portal', () => {
  const internalPhrases = [
    'Admin view · all clients',
    'Calibrates future reviews',
    'Client override',
    'Learning signal',
    'guarded precedent',
    'Reusable policy feedback',
  ];

  for (const phrase of internalPhrases) {
    assert.equal(clientDashboardSource.includes(phrase), false, `${phrase} should not be customer-facing`);
  }
});

test('uses direct customer-facing sign-in and decision copy', () => {
  assert.match(clientDashboardSource, /Sign in to review your creatives and share your decisions\./);
  assert.match(clientDashboardSource, /Why are you choosing a different decision\?/);
  assert.match(clientDashboardSource, /Different from recommendation/);
});
