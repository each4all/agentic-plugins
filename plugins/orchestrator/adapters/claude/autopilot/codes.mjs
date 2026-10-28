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
]);
export const MACRO_OWNER_GATES = Object.freeze([...VALID_MACRO_OWNER_GATES]);
// `duplicate-workflow` is never stored (no single file owns it); it reaches
// the driver as an entry-brief owner-choice-required and halts owner-choice.
export const OWNER_GATES = Object.freeze([...MACRO_OWNER_GATES, ...ENGINEER_OWNER_GATES]);

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
