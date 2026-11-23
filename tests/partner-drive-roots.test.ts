import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('dedicated partner Drive roots retain their names and folders', () => {
  const source = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
  assert.equal(error, undefined);
  const roots = JSON.parse(config.vars.GOOGLE_DRIVE_ADDITIONAL_FOLDERS_JSON);
  const expected = {
    kissterra: { name: 'Kissterra Auto', folder_id: '1F3rYM_tVmbNXuYkn00HoaopB0UsUVcn5' },
    'kissterra-home': { name: 'Kissterra Home', folder_id: '14JPGzMvru97KOqRIatOscY1lyCKNISIR' },
    'smart-financial': { name: 'Smart Financial', folder_id: '1LozyVky9H1rMjJA4p0em7V8Bm8QnZMM8' },
    'lead-economy': { name: 'Lead Economy', folder_id: '1_aFP9qE59-PmTz9BwM6QyItzWAqEYTSY' },
  };
  for (const [id, root] of Object.entries(expected)) assert.deepEqual(roots[id], root);
});
