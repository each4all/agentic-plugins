// Tests for lib/operator-text.mjs, moved with safeOperatorText and
// isDisplayHazard out of test-legacy-egress-discovery.mjs (ADR-0064 Decision 2,
// item 3). The discovery scanner and the WAL's own record-name policy,
// safeRecordName, went with ADR-0064 Decision 1.

import { describe, it } from 'node:test';
import { match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { isDisplayHazard, safeOperatorText } from '../../plugins/runtime/scripts/lib/operator-text.mjs';

describe('operator-facing text is defused', () => {
  it('CONTROL — an ordinary path renders EXACTLY, including non-ASCII', () => {
    strictEqual(safeOperatorText('/Users/op/작업/repo'), '/Users/op/작업/repo');
    strictEqual(safeOperatorText('/plain/path'), '/plain/path');
  });

  it('truncation carries a stable hash so two long paths do not render alike', () => {
    const a = `/x/${'a'.repeat(600)}1`;
    const b = `/x/${'a'.repeat(600)}2`;
    notStrictEqual(safeOperatorText(a), safeOperatorText(b));
    match(safeOperatorText(a), /truncated; sha256:[0-9a-f]{12}/);
    strictEqual(safeOperatorText(a), safeOperatorText(a), 'stable across calls');
  });

  it('bidi, zero-width AND Unicode line separators are hazards, not just C0 controls', () => {
    // U+2028/U+2029 are LINE and PARAGRAPH SEPARATOR: not C0, but terminals and
    // log viewers break lines on them, which is the forged-instruction hazard
    // the C0 newline entry exists to stop. They were missing (cross-host review).
    // U+061C, U+2060, U+180E and the interlinear-annotation set render as
    // nothing without being bidi controls or zero-width joiners, so two distinct
    // names look identical to the operator being asked to act on one of them.
    for (const cp of [0x202e, 0x200b, 0x2066, 0xfeff, 0x0a, 0x1b, 0x7f, 0x9b, 0x2028, 0x2029,
      0x061c, 0x2060, 0x180e, 0xfff9, 0xfffa, 0xfffb]) {
      ok(isDisplayHazard(cp), `U+${cp.toString(16).toUpperCase()} must be treated as a display hazard`);
    }
    ok(!isDisplayHazard('a'.codePointAt(0)));
    ok(!isDisplayHazard('작'.codePointAt(0)));
    match(safeOperatorText('a‮b'), /a\?b/);
    for (const sep of [' ', ' ']) {
      strictEqual(safeOperatorText(`a${sep}b`).includes(sep), false, `U+${sep.codePointAt(0).toString(16)} survived safeOperatorText`);
    }
  });

  it('defusing NEVER collapses two distinct paths, truncated or not', () => {
    // Reproduced: two paths differing only in a control byte both rendered
    // `/x/a?b`. Neither was truncated, so a hash attached only on truncation did
    // not help — and the guidance asks the operator to act on ONE named record.
    const shortPaths = ['/x/ab', '/x/ab'];
    const [pa, pb] = shortPaths.map((p) => safeOperatorText(p));
    notStrictEqual(pa, pb, 'two short paths differing only in a control byte must not render identically');
    match(pa, /sha256:[0-9a-f]{12}/);

    // CONTROL — nothing altered means nothing appended.
    strictEqual(safeOperatorText('/plain/path'), '/plain/path');
  });
});
