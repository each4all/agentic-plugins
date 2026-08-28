import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import {
  parseCodexPermissionConfigToml,
  unescapeTomlBasic,
} from '../../plugins/runtime/scripts/lib/codex-config.mjs';

// ADR-0057 §Decision 4 split `lib/permission-config.mjs` BY CONSUMER rather than by
// file name. The two union readers (`readClaudePermissionConfig`,
// `readCodexPermissionConfig`) existed only to gather input for the permission
// planner and were deleted with it; their tests went too. What survives is the
// generic Codex-config TOML parser, whose production consumer is
// `lib/profile-readers.mjs` — nothing to do with the advisor.
//
// The function keeps its name: it reads Codex's PERMISSION configuration (approval
// policy, sandbox mode, per-project trust), which is what it is called after.

describe('codex-config parseCodexPermissionConfigToml', () => {
  it('extracts trusted projects and top-level posture', () => {
    const parsed = parseCodexPermissionConfigToml('approval_policy = "never"\n[projects."/a"]\ntrust_level = "trusted"\n');
    strictEqual(parsed.approvalPolicy, 'never');
    strictEqual(parsed.sandboxMode, null);
    ok(parsed.trustedProjects.has('/a'));
  });

  it('reads both postures and leaves an untrusted project out of the set', () => {
    const parsed = parseCodexPermissionConfigToml(
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[projects."/trusted"]\ntrust_level = "trusted"\n\n[projects."/other"]\ntrust_level = "untrusted"\n',
    );
    strictEqual(parsed.approvalPolicy, 'on-request');
    strictEqual(parsed.sandboxMode, 'workspace-write');
    ok(parsed.trustedProjects.has('/trusted'));
    ok(!parsed.trustedProjects.has('/other'), 'only trust_level="trusted" counts');
  });

  it('unescapes a basic-string project key so it can be compared against a real path', () => {
    strictEqual(unescapeTomlBasic('a\\"b'), 'a"b');
    strictEqual(unescapeTomlBasic('a\\\\b'), 'a\\b');
    const parsed = parseCodexPermissionConfigToml('[projects."/we\\"ird"]\ntrust_level = "trusted"\n');
    ok(parsed.trustedProjects.has('/we"ird'), 'the stored key is compared unescaped');
  });
});
