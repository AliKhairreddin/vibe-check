import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminSource = readFileSync(
  new URL('../frontend/src/admin-app.tsx', import.meta.url),
  'utf8',
);
const offerOutcomesSource = readFileSync(
  new URL('../frontend/src/components/offer-outcomes.tsx', import.meta.url),
  'utf8',
);
const dashboardSource = readFileSync(
  new URL('../frontend/src/components/dashboard.tsx', import.meta.url),
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

test('exposes dedicated partner Drive roots', () => {
  assert.match(workerConfig, /Kissterra Auto/);
  assert.match(workerConfig, /Kissterra Home/);
  assert.match(workerConfig, /14JPGzMvru97KOqRIatOscY1lyCKNISIR/);
  assert.match(workerConfig, /Smart Financial/);
  assert.match(workerConfig, /1LozyVky9H1rMjJA4p0em7V8Bm8QnZMM8/);
  assert.match(workerConfig, /Lead Economy/);
  assert.match(workerConfig, /1_aFP9qE59-PmTz9BwM6QyItzWAqEYTSY/);
});

test('keeps the review form full width and renders batch progress as a table below', () => {
  assert.doesNotMatch(adminSource, /lg:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(320px,0\.95fr\)\]/);
  assert.match(adminSource, /<CardTitle className="text-xl">Batch progress<\/CardTitle>/);
  assert.match(adminSource, /<CardDescription className="max-sm:col-span-2">/);
  assert.match(adminSource, /<CardAction className="max-sm:row-span-1 max-sm:row-start-1">/);
  assert.doesNotMatch(adminSource, /<Separator orientation="vertical" className="h-4" \/>/);
  assert.match(adminSource, /<MenuIcon \/>/);
  assert.match(adminSource, /aria-expanded=\{openMobile\}/);
  assert.match(adminSource, /<Table className="min-w-\[58rem\] table-fixed max-md:min-w-\[74rem\]">/);
  assert.match(adminSource, /<col className="max-md:w-56" \/>/);
  assert.match(adminSource, /<Table className="table-fixed max-md:min-w-\[58rem\]">/);
  assert.match(adminSource, /<CardDescription className="max-sm:col-span-2">\s*Uploaded \{formatDate\(query\.data\.created_at\)\}/);
  assert.match(adminSource, /<CardAction className="max-sm:col-span-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch">/);
  assert.match(offerOutcomesSource, /compact && 'min-w-0 max-w-full overflow-hidden'/);
  assert.match(offerOutcomesSource, /compact && 'min-w-0 max-w-full justify-start truncate'/);
  assert.match(dashboardSource, /max-sm:flex-col max-sm:items-stretch max-sm:gap-0\.5 max-sm:\[&_\[data-slot=badge\]\]:ml-auto/);
  assert.match(adminSource, /<TableHead>Creative<\/TableHead>/);
  assert.match(adminSource, /<TableHead className="w-36">Vertical<\/TableHead>/);
  assert.match(adminSource, /<TableHead className="min-w-72">Progress<\/TableHead>/);
});
