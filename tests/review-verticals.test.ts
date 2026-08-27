import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyReviewVertical } from '../convex/reviewVerticals.ts';

test('routes explicit HOME filename tokens to Home Insurance', () => {
  assert.equal(classifyReviewVertical('CT_VD_EN_HOME_27.08_AR_101.mp4'), 'home-insurance');
  assert.equal(classifyReviewVertical('home-offer-static.png'), 'home-insurance');
});

test('routes AUTO and legacy filenames to Auto Insurance', () => {
  assert.equal(classifyReviewVertical('CT_VD_EN_AUTO_FDR_27.08_AR_102.mp4'), 'auto-insurance');
  assert.equal(classifyReviewVertical('CT_VD_EN_SWF_27.08_AR_103.mp4'), 'auto-insurance');
});

test('does not classify partial words as vertical tokens', () => {
  assert.equal(classifyReviewVertical('HOMER_offer.mp4'), 'auto-insurance');
});
