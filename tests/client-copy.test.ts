import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientDashboardSource = readFileSync(
  new URL('../frontend/src/components/client-dashboard.tsx', import.meta.url),
  'utf8',
);
const clientAppSource = readFileSync(
  new URL('../frontend/src/client-app.tsx', import.meta.url),
  'utf8',
);
const adminAccessGateSource = readFileSync(
  new URL('../frontend/src/components/admin-access-gate.tsx', import.meta.url),
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

test('keeps red, yellow, and green review counts separate', () => {
  assert.match(clientDashboardSource, /label="red" tone="danger" value=\{statusCounts\.red\}/);
  assert.match(clientDashboardSource, /label="yellow" tone="warning" value=\{statusCounts\.yellow\}/);
  assert.match(clientDashboardSource, /label="green" tone="success" value=\{statusCounts\.green\}/);
  assert.doesNotMatch(clientDashboardSource, /ai_status !== 'green'/);
  assert.doesNotMatch(clientDashboardSource, /label="flagged"/);
});

test('never renders a sign-in screen while an existing session is being restored', () => {
  const clientLoadingState = clientDashboardSource.indexOf(
    'if (isCheckingSession) return <SessionLoadingScreen />;',
  );
  const clientSignedOutState = clientDashboardSource.indexOf('if (!session) {');
  assert.ok(clientLoadingState >= 0);
  assert.ok(clientSignedOutState > clientLoadingState);

  const adminLoadingState = adminAccessGateSource.indexOf(
    'if (access.isRestoringSession) return <SessionLoadingScreen />;',
  );
  const adminSignedInState = adminAccessGateSource.indexOf('if (access.isUnlocked) return children;');
  assert.ok(adminLoadingState >= 0);
  assert.ok(adminSignedInState > adminLoadingState);
});

test('keeps the client auth gate mounted across dashboard route changes', () => {
  assert.match(
    clientAppSource,
    /<ClientPortalGate>\s*<Outlet \/>\s*<\/ClientPortalGate>/,
  );
  assert.doesNotMatch(
    clientDashboardSource,
    /export function Client(?:Dashboard|ReviewDetail)Page\(\) \{[\s\S]{0,100}<ClientPortalGate>/,
  );
});
