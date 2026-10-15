// C120 — the review-scope suite (_review-scope-suite.mjs) for engineer. The suite
// is split per persona so node --test runs the three in parallel; the
// designer file also checks that every persona the unit reaches has a file.

import { personasFor } from './_personas.mjs';
import { reviewScopeSuite } from './_review-scope-suite.mjs';

if (!personasFor('scripts/lib/review-scope.mjs').includes('engineer')) throw new Error('review-scope.mjs is not generated into engineer');
await reviewScopeSuite('engineer');
