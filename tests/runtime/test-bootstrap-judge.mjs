// tests/runtime/test-bootstrap-judge.mjs — the per-OS canonical Codex notify argv.
//
// This file used to cover the judgeSteps observations of egress.configured and
// notify.codex.configured. ADR-0064 (R4n1) removed those steps and their judges
// from bootstrap, so the cases that pinned them are gone; the value-step and
// statusline judges are covered in test-bootstrap-value-grammar.mjs and the
// statusline suites. What remains is the pure argv builder
// (lib/notification-plan.mjs), which still ships until its own removal.

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { expectedCodexNotifyArgv } from '../../plugins/runtime/scripts/lib/notification-plan.mjs';

const SHUTTLE = '/home/op/.agentic-plugins/bin/codex-notify-shuttle.mjs';

describe('expectedCodexNotifyArgv — the per-OS canonical argv single source', () => {
  it('POSIX keeps /usr/bin/env node <receiver> — the form already merged on live machines', () => {
    for (const platform of ['linux', 'darwin']) {
      const argv = expectedCodexNotifyArgv({ receiverPath: SHUTTLE, platform, execPath: '/ignored/node' });
      strictEqual(argv[0], '/usr/bin/env');
      strictEqual(argv[1], 'node');
      strictEqual(argv[2], SHUTTLE);
    }
  });

  it('win32 interpolates the render machine\'s own node executable — /usr/bin/env does not exist there', () => {
    const argv = expectedCodexNotifyArgv({ receiverPath: 'C:\\Users\\op\\.agentic-plugins\\bin\\codex-notify-shuttle.mjs', platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' });
    strictEqual(argv.length, 2);
    strictEqual(argv[0], 'C:\\Program Files\\nodejs\\node.exe');
    strictEqual(argv[1], 'C:\\Users\\op\\.agentic-plugins\\bin\\codex-notify-shuttle.mjs');
  });
});
