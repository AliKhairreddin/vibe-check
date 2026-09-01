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
const clientInsightsSource = readFileSync(
  new URL('../frontend/src/components/client-insights.tsx', import.meta.url),
  'utf8',
);
const clientSettingsSource = readFileSync(
  new URL('../frontend/src/components/client-settings.tsx', import.meta.url),
  'utf8',
);
const clientPreferencesSource = readFileSync(
  new URL('../frontend/src/lib/client-preferences.ts', import.meta.url),
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
  assert.match(clientDashboardSource, /label="hold" tone="danger" value=\{statusCounts\.red\}/);
  assert.match(clientDashboardSource, /label="needs decision" tone="warning" value=\{statusCounts\.yellow\}/);
  assert.match(clientDashboardSource, /label="ready" tone="success" value=\{statusCounts\.green\}/);
  assert.match(clientDashboardSource, /Original AdChecked assessment/);
  assert.match(clientDashboardSource, /Final client decisions/);
  assert.doesNotMatch(clientDashboardSource, /ai_status !== 'green'/);
  assert.doesNotMatch(clientDashboardSource, /label="flagged"/);
});

test('keeps decision actions state-aware and supports optional notes', () => {
  assert.match(clientDashboardSource, /review\.decision \? \(/);
  assert.match(clientDashboardSource, /Reset to pending/);
  assert.match(clientDashboardSource, /Decision note\{noteRequired \? '' : ' \(optional\)'\}/);
  assert.match(clientDashboardSource, /Previous decision note:/);
  assert.match(clientDashboardSource, /Open full review/);
});

test('uses neutral client workspace labels and exposes result filtering', () => {
  assert.match(clientDashboardSource, /<h1[^>]*>Review queue<\/h1>/);
  assert.match(clientDashboardSource, /label="Result"/);
  assert.match(clientDashboardSource, /label: 'Green', value: 'green'/);
  assert.match(clientDashboardSource, /label: 'Yellow', value: 'yellow'/);
  assert.match(clientDashboardSource, /label: 'Red', value: 'red'/);
  assert.doesNotMatch(clientDashboardSource, />Kissterra<\//);
  assert.doesNotMatch(clientDashboardSource, /Signed in as/);
});

test('labels the client footer with the signed-in company', () => {
  assert.match(clientDashboardSource, /workspaceName=\{selectedPortal\?\.display_name\}/);
  assert.match(clientDashboardSource, /<p className="font-medium">\{resolvedWorkspaceName\}<\/p>/);
  assert.doesNotMatch(clientDashboardSource, />Client view<\/p>/);
  assert.doesNotMatch(clientDashboardSource, />Client workspace<\/p>/);
});

test('organizes client navigation by workflow, performance, and utilities', () => {
  const workspace = clientDashboardSource.indexOf('>Workspace</SidebarGroupLabel>');
  const reviewQueue = clientDashboardSource.indexOf('<span>Review queue</span>');
  const performance = clientDashboardSource.indexOf('>Performance</SidebarGroupLabel>');
  const sidebarFooter = clientDashboardSource.indexOf('<SidebarFooter');
  const settings = clientDashboardSource.lastIndexOf('<span>Settings</span>');

  assert.ok(workspace >= 0);
  assert.ok(reviewQueue > workspace);
  assert.ok(performance > reviewQueue);
  assert.ok(sidebarFooter > performance);
  assert.ok(settings > sidebarFooter);
  assert.match(clientDashboardSource, /<span>Auto Insurance<\/span>/);
  assert.match(clientDashboardSource, /<CarFront\s*\/>\s*<span>Auto Insurance<\/span>/);
  assert.match(clientDashboardSource, /<span>Home Insurance<\/span>/);
  assert.doesNotMatch(clientDashboardSource, /<SidebarGroupLabel[^>]*>Verticals<\/SidebarGroupLabel>/);
});

test('provides dashboard, vertical, and batch insight routes', () => {
  assert.match(clientAppSource, /path: '\/client\/verticals\/\$verticalId'/);
  assert.match(clientAppSource, /path: '\/client\/\$clientId\/batches\/\$batchId'/);
  assert.match(clientInsightsSource, /Auto Insurance/);
  assert.match(clientInsightsSource, /icon: CarFront/);
  assert.match(clientInsightsSource, /Home Insurance/);
  assert.match(clientInsightsSource, /Batch performance/);
});

test('lets clients switch layouts and save review queue defaults', () => {
  assert.match(clientAppSource, /path: '\/client\/settings'/);
  assert.match(clientDashboardSource, /aria-label="Grid view"/);
  assert.match(clientDashboardSource, /aria-label="List view"/);
  assert.match(clientDashboardSource, /<span>Result<\/span>[\s\S]*<span>Findings<\/span>[\s\S]*<span>Decision<\/span>/);
  assert.match(clientSettingsSource, /Default review layout/);
  assert.match(clientSettingsSource, /Display density/);
  assert.match(clientSettingsSource, /Default result filter/);
  assert.match(clientSettingsSource, /Open newest batch automatically/);
  assert.match(clientPreferencesSource, /adchecked-client-preferences-v1/);
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
