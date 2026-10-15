// C120 — the review-scope suite (_review-scope-suite.mjs) for designer. The suite
// is split per persona so node --test runs the three in parallel; the
// designer file also checks that every persona the unit reaches has a file.

import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import { personasFor } from './_personas.mjs';
import { reviewScopeSuite } from './_review-scope-suite.mjs';

if (!personasFor('scripts/lib/review-scope.mjs').includes('designer')) throw new Error('review-scope.mjs is not generated into designer');
await reviewScopeSuite('designer');

describe('the review-scope suite runs per persona (C120)', () => {
  it('every persona review-scope.mjs is generated into has its own test file', () => {
    deepStrictEqual(personasFor('scripts/lib/review-scope.mjs'), ['designer', 'engineer', 'founder']);
  });
});
