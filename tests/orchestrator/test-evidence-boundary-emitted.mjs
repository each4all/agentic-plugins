// C163 D2a — every prompt the orchestrator's dispatchers hand a peer opens
// with the evidence boundary: the Plan-verify prompt built from its template,
// sent as written, and a peer-now's caller prompt, which the runner bounds.
// The check is on the prompt the companion actually read (a fake companion
// keeps it). tests/cross-host/test-peer-prompt-evidence-boundary.mjs holds the
// template itself.

import { describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDispatcher, promptTemplates } from '../cross-host/_evidence-boundary-fixtures.mjs';

// An autopilot step's session would make the runs its own (tests/_hermetic-env.mjs
// clears it under npm test; a direct node --test does not).
for (const k of Object.keys(process.env)) if (k.startsWith('AGENTIC_')) delete process.env[k];

const ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'plugins', 'orchestrator');

describe('orchestrator: the peer reads the evidence boundary first (C163 D2a)', async () => {
  const [planVerify] = promptTemplates(join(ROOT, 'core/skills/_shared/references/ensemble-protocol.md'));
  await checkDispatcher({ label: 'orchestrator', scriptsDir: join(ROOT, 'scripts'), template: planVerify.body, it });
});
