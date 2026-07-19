import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCALIZABLE_PLUGIN_NAMES,
  LOCALIZATION_HOSTS,
  isLocalizationHost,
  localizeCommandFields,
  localizeCommandList,
  localizePluginCommands,
} from '../../plugins/runtime/scripts/lib/host-localization.mjs';

// ADR-0045 §10 / macro S6-loc-leaf — the localization core moved out of
// footer.mjs into a shared leaf so context.mjs (entry-brief, S7b) can import
// it without the footer→context cycle. These are the leaf-level unit tests;
// the footer render-path integration tests stay in test-footer.mjs.

describe('runtime host-localization leaf — prefix rewriting', () => {
  const SHAPES = ['engineer:resume', '/engineer:resume', '$engineer:resume'];

  it('rewrites every input shape to / for a claude render', () => {
    for (const shape of SHAPES) {
      strictEqual(localizePluginCommands(shape, 'claude'), '/engineer:resume');
    }
  });

  it('rewrites every input shape to $ for a codex render', () => {
    for (const shape of SHAPES) {
      strictEqual(localizePluginCommands(shape, 'codex'), '$engineer:resume');
    }
  });

  it('keeps a neutral render untouched for every input shape', () => {
    for (const shape of SHAPES) {
      strictEqual(localizePluginCommands(shape, 'neutral'), shape);
    }
  });

  it('rewrites mixed-shape prose in one pass', () => {
    strictEqual(
      localizePluginCommands(
        'Run /engineer:refine then runtime:doctor, $designer:critique and image:compose',
        'codex',
      ),
      'Run $engineer:refine then $runtime:doctor, $designer:critique and $image:compose',
    );
  });
});

describe('runtime host-localization leaf — idempotency on both host prefixes', () => {
  const MIXED = 'Start /engineer:resume, then $orchestrator:next and founder:frame';

  it('is idempotent for a claude render', () => {
    const once = localizePluginCommands(MIXED, 'claude');
    strictEqual(localizePluginCommands(once, 'claude'), once);
  });

  it('is idempotent for a codex render', () => {
    const once = localizePluginCommands(MIXED, 'codex');
    strictEqual(localizePluginCommands(once, 'codex'), once);
  });

  it('is idempotent for a neutral render', () => {
    strictEqual(
      localizePluginCommands(localizePluginCommands(MIXED, 'neutral'), 'neutral'),
      MIXED,
    );
  });
});

describe('runtime host-localization leaf — cross-host symmetry', () => {
  const MIXED = 'Start /engineer:resume, then $orchestrator:next and founder:frame';

  it('converges regardless of the prior render host (claude→codex ≡ codex)', () => {
    strictEqual(
      localizePluginCommands(localizePluginCommands(MIXED, 'claude'), 'codex'),
      localizePluginCommands(MIXED, 'codex'),
    );
  });

  it('converges regardless of the prior render host (codex→claude ≡ claude)', () => {
    strictEqual(
      localizePluginCommands(localizePluginCommands(MIXED, 'codex'), 'claude'),
      localizePluginCommands(MIXED, 'claude'),
    );
  });

  it('round-trips claude→codex→claude back to the claude form', () => {
    const claudeOnce = localizePluginCommands(MIXED, 'claude');
    const roundTrip = localizePluginCommands(
      localizePluginCommands(claudeOnce, 'codex'),
      'claude',
    );
    strictEqual(roundTrip, claudeOnce);
  });
});

describe('runtime host-localization leaf — explicit trusted-host threading', () => {
  it('exposes exactly the three localization hosts', () => {
    deepStrictEqual([...LOCALIZATION_HOSTS].sort(), ['claude', 'codex', 'neutral']);
  });

  it('exports a deeply immutable host vocabulary (frozen array, not a mutable Set)', () => {
    // Object.freeze(new Set(...)) would not freeze the Set's entries — an
    // importer could add('shell') and poison --host validation process-wide
    // (codex review MAJOR). The exported vocabulary must be a frozen array.
    strictEqual(Array.isArray(LOCALIZATION_HOSTS), true);
    strictEqual(Object.isFrozen(LOCALIZATION_HOSTS), true);
    throws(() => {
      LOCALIZATION_HOSTS.push('shell');
    }, TypeError);
    strictEqual(isLocalizationHost('shell'), false);
  });

  it('isLocalizationHost mirrors the vocabulary for membership checks', () => {
    for (const host of LOCALIZATION_HOSTS) strictEqual(isLocalizationHost(host), true);
    for (const bad of ['shell', 'CLAUDE', '', undefined, null]) {
      strictEqual(isLocalizationHost(bad), false);
    }
  });

  it('throws on a missing or untrusted host instead of silently defaulting to $', () => {
    for (const badHost of [undefined, null, '', 'CLAUDE', 'Codex', 'bash', 1, {}]) {
      throws(
        () => localizePluginCommands('/engineer:resume', badHost),
        TypeError,
        `expected TypeError for host=${String(badHost)}`,
      );
    }
  });

  it('throws on an untrusted host even when the value is empty or absent', () => {
    // A caller that wired no host is a bug regardless of payload — the
    // falsy-value fast path must not mask the missing-host defect.
    throws(() => localizePluginCommands('', undefined), TypeError);
    throws(() => localizePluginCommands(null, 'shell'), TypeError);
  });

  it('threads the host assertion through the list and field helpers', () => {
    throws(() => localizeCommandList(['/engineer:resume'], undefined), TypeError);
    throws(() => localizeCommandFields({ next_action: '/engineer:resume' }, undefined, ['next_action']), TypeError);
    throws(() => localizeCommandFields(null, 'shell', ['next_action']), TypeError);
  });
});

describe('runtime host-localization leaf — leading-boundary guard', () => {
  it('does not rewrite path-like or infix text', () => {
    for (const value of [
      'See plugins/runtime/scripts for details',
      'a/engineer:x is not a command',
      'https://example.test/engineer:resume',
    ]) {
      strictEqual(localizePluginCommands(value, 'codex'), value);
    }
  });

  it('rewrites after every recognized leading boundary', () => {
    for (const [input, expected] of [
      ['/engineer:resume', '$engineer:resume'],
      [' (/engineer:resume)', ' ($engineer:resume)'],
      ['`/engineer:resume`', '`$engineer:resume`'],
      ['"/engineer:resume"', '"$engineer:resume"'],
      ["'/engineer:resume'", "'$engineer:resume'"],
      ['[/engineer:resume]', '[$engineer:resume]'],
    ]) {
      strictEqual(localizePluginCommands(input, 'codex'), expected);
    }
  });
});

describe('runtime host-localization leaf — plugin-name table', () => {
  it('pins the localizable plugin-name set (companions script-only, attention hook-only — both deliberately absent)', () => {
    deepStrictEqual(
      [...LOCALIZABLE_PLUGIN_NAMES],
      ['runtime', 'engineer', 'orchestrator', 'founder', 'designer', 'image'],
    );
  });

  it('localizes every member on both host prefixes (leaf-level omission guard)', () => {
    for (const name of LOCALIZABLE_PLUGIN_NAMES) {
      strictEqual(localizePluginCommands(`$${name}:x`, 'claude'), `/${name}:x`);
      strictEqual(localizePluginCommands(`/${name}:x`, 'codex'), `$${name}:x`);
    }
  });

  it('matches the repo plugin inventory derived from command surfaces (independent-authority omission guard)', () => {
    // Self-referential pinning alone would stay green when a new
    // command-bearing plugin lands without joining the localization set —
    // the historical designer omission (ADR-0043 §1; codex review MINOR).
    // Derive the expected membership from the repo itself: every plugin
    // directory shipping a commands/ surface must localize, and nothing
    // else may (companions is script-only, attention hook-only — both have
    // no commands/ directory, so the exclusion is structural, not a list).
    const pluginsRoot = fileURLToPath(new URL('../../plugins', import.meta.url));
    const commandBearing = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(pluginsRoot, name, 'commands')))
      .sort();
    deepStrictEqual([...LOCALIZABLE_PLUGIN_NAMES].sort(), commandBearing);
  });
});

describe('runtime host-localization leaf — list and field helpers', () => {
  it('localizeCommandList maps values and normalizes an absent list to []', () => {
    deepStrictEqual(localizeCommandList(undefined, 'codex'), []);
    deepStrictEqual(localizeCommandList(null, 'claude'), []);
    deepStrictEqual(
      localizeCommandList(['/engineer:resume', 'runtime:doctor'], 'codex'),
      ['$engineer:resume', '$runtime:doctor'],
    );
  });

  it('localizeCommandFields rewrites only the named string fields', () => {
    const out = localizeCommandFields(
      { next_action: '/engineer:refine', routing_recommendation: 42, untouched: '/engineer:resume' },
      'codex',
      ['next_action', 'routing_recommendation', 'absent_field'],
    );
    strictEqual(out.next_action, '$engineer:refine');
    strictEqual(out.routing_recommendation, 42);
    strictEqual(out.untouched, '/engineer:resume');
    strictEqual('absent_field' in out, false);
  });

  it('localizeCommandFields passes a nullish target through under a trusted host', () => {
    strictEqual(localizeCommandFields(null, 'codex', ['next_action']), null);
    strictEqual(localizeCommandFields(undefined, 'claude', ['next_action']), undefined);
  });
});
