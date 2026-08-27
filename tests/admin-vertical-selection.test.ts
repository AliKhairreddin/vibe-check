import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminSource = readFileSync(
  new URL('../frontend/src/admin-app.tsx', import.meta.url),
  'utf8',
);
const workerConfig = readFileSync(
  new URL('../wrangler.jsonc', import.meta.url),
  'utf8',
);

test('lets an operator assign a vertical to the entire review selection', () => {
  assert.match(adminSource, /<Label>Creative vertical<\/Label>/);
  assert.match(adminSource, /aria-pressed=\{selectedVertical === 'auto-insurance'\}/);
  assert.match(adminSource, /aria-pressed=\{selectedVertical === 'home-insurance'\}/);
  assert.match(adminSource, /sharedFields\.set\('vertical', selectedVertical\)/);
  assert.match(adminSource, /vertical: selectedVertical/);
});

test('exposes dedicated Kissterra Auto and Home Drive roots', () => {
  assert.match(workerConfig, /Kissterra Auto/);
  assert.match(workerConfig, /Kissterra Home/);
  assert.match(workerConfig, /14JPGzMvru97KOqRIatOscY1lyCKNISIR/);
});

test('keeps the review form full width and renders batch progress as a table below', () => {
  assert.doesNotMatch(adminSource, /lg:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(320px,0\.95fr\)\]/);
  assert.match(adminSource, /<CardTitle className="text-xl">Batch progress<\/CardTitle>/);
  assert.match(adminSource, /<TableHead>Creative<\/TableHead>/);
  assert.match(adminSource, /<TableHead className="w-36">Vertical<\/TableHead>/);
  assert.match(adminSource, /<TableHead className="min-w-72">Progress<\/TableHead>/);
});
