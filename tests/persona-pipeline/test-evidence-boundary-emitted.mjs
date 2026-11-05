// C163 D2a — every prompt a persona's dispatchers hand a peer opens with the
// evidence boundary, run once for every persona the manifest generates the
// peer runner into (ADR-0066 Decision 5).
//
// The check is on the prompt the companion actually read (a fake companion
// keeps it), not on the templates' text: a peer-now's caller prompt, which no
// template shapes, gets the boundary from the runner; a prompt built from the
// persona's ensemble-protocol template, which opens with it already, is sent
// as written. tests/cross-host/test-peer-prompt-evidence-boundary.mjs holds the
// templates themselves.

import './_drop-session.mjs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { personasFor, personaInfo } from './_personas.mjs';
import { checkDispatcher, promptTemplates } from '../cross-host/_evidence-boundary-fixtures.mjs';

for (const persona of personasFor('scripts/peer-runner.mjs')) {
  const P = personaInfo(persona);
  describe(`${persona}: the peer reads the evidence boundary first (C163 D2a)`, async () => {
    const [first] = promptTemplates(join(P.root, 'core/skills/_shared/references/ensemble-protocol.md'));
    await checkDispatcher({ label: persona, scriptsDir: join(P.root, 'scripts'), template: first.body, it });
  });
}
