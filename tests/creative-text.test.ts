import assert from 'node:assert/strict';
import test from 'node:test';
import { creativeText } from '../convex/creativeText.ts';

test('original creative text excludes internal and provider data and keeps speech in order', () => {
  const projected = creativeText({
    audio_transcript: { chunks: [{ text: 'First sentence.' }, { text: 'Second sentence.' }], model: 'private-model', usage: { cost: 4 } },
    onscreen_text_ocr: [{ text: 'From $25' }, { text: 'From $25' }, { text: 'Terms apply' }],
    submitted_ad_copy: { text: 'Compare quotes' },
    ocr_coverage: { status: 'partial' }, notes: 'secret notes', policy_text: 'secret policy',
  });
  assert.deepEqual(projected, {
    transcript: 'First sentence.\n\nSecond sentence.', onscreen_text: 'From $25\n\nTerms apply',
    ad_copy: 'Compare quotes', onscreen_text_partial: true,
  });
});

test('missing or truncated evidence does not invent a transcript from summaries or findings', () => {
  for (const value of [null, { summary: 'A partial learning snapshot' }, { audio_transcript: { chunks: [{ text: null }] } }]) {
    assert.deepEqual(creativeText(value), { transcript: null, onscreen_text: null, ad_copy: null, onscreen_text_partial: false });
  }
});
