// plugins/orchestrator/adapters/claude/autopilot/codes.mjs
//
// The closed sets and identifier alphabets the gate policy (policy.mjs, which
// re-exports them) and the event file's writer (events.mjs, ADR-0068
// Decision 4) both check against. A leaf: it reads no policy, so the event
// file depends on these codes alone.
//
// Engineer's owner gates are copied here, not imported (ADR-0010 §5);
// tests/plugin-shape/test-autopilot-enum-parity.mjs holds the copies equal.

import { VALID_MACRO_OWNER_GATES } from '../../../scripts/state.mjs';

export const ENGINEER_OWNER_GATES = Object.freeze([
  'scope-routing', 'decide-conflict', 'peer-conflict', 'recurring-finding', 'staging-set', 'pr-handling',
  // C176 (ADR-0063, amendment of 2026-11-09) — a critique at its subtask's
  // critique cap with findings still open: the serial driver halts
  // awaiting-owner:critique-cap, the lane scheduler parks that lane only.
  'critique-cap',
]);
export const MACRO_OWNER_GATES = Object.freeze([...VALID_MACRO_OWNER_GATES]);
// `duplicate-workflow` is never stored (no single file owns it); it reaches
// the driver as an entry-brief owner-choice-required and halts owner-choice.
// The gates a worker's step report may name: the stored ones.
export const STORED_OWNER_GATES = Object.freeze([...MACRO_OWNER_GATES, ...ENGINEER_OWNER_GATES]);
// C163 A1b (ADR-0063, implementation note of 2026-11-07) — gates the policy
// derives from state and never stores: `review-outcome`, a lane whose latest
// review outcome holds its commit back (lib/review-attempts.mjs
// REVIEW_OUTCOME_GATE, held equal by tests/orchestrator/test-autopilot-review-gate.mjs).
// The owner's acceptance or a new review clears it, never a worker.
export const DERIVED_OWNER_GATES = Object.freeze(['review-outcome']);
export const OWNER_GATES = Object.freeze([...STORED_OWNER_GATES, ...DERIVED_OWNER_GATES]);

// DESIGN §6.2 / ADR-0063 D4. `awaiting-owner` is reported as
// `awaiting-owner:<gate>`.
export const HALT_REASONS = Object.freeze([
  'owner-choice', 'awaiting-owner', 'low-confidence', 'owner-decision', 'plan-unapproved',
  'awaiting-landing', 'dirty-tree', 'no-progress', 'worker-failed', 'permission-denied',
  'compaction-imminent', 'budget', 'version-drift', 'interrupted',
]);

// Identifiers that may enter a worker prompt or a printed command.
const SUBTASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export const isSafeSubtaskId = (id) => typeof id === 'string' && SUBTASK_ID_RE.test(id);
export const isSafeMacroId = (id) => typeof id === 'string' && MACRO_ID_RE.test(id);
