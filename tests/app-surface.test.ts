import assert from 'node:assert/strict';
import test from 'node:test';

import { appSurfaceForHostname } from '../frontend/src/lib/app-surface.ts';

test('maps each production hostname to its isolated browser surface', () => {
  assert.equal(appSurfaceForHostname('adchecked.com'), 'marketing');
  assert.equal(appSurfaceForHostname('www.adchecked.com'), 'marketing');
  assert.equal(appSurfaceForHostname('app.adchecked.com'), 'client');
  assert.equal(appSurfaceForHostname('admin.adchecked.com'), 'admin');
});

test('allows local admin development but fails closed for unknown hosts', () => {
  assert.equal(appSurfaceForHostname('localhost'), 'admin');
  assert.equal(appSurfaceForHostname('127.0.0.1'), 'admin');
  assert.equal(appSurfaceForHostname('vibe-check.example.workers.dev'), 'unsupported');
  assert.equal(appSurfaceForHostname('attacker.example'), 'unsupported');
});
