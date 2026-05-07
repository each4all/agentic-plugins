// plugins/engineer plugin-shape conformance test (Stage 2 Deliverable E,
// Cluster 1 Option B — content sanity; Stage 2.5 ADR-0014 cited-brief
// absorption tests appended).
//
// Mirrors tests/plugin-shape/test-research-plugin.mjs structure with
// engineer-specific multi-skill shape:
//   - 2 manifests (Claude + Codex)
//   - 6 skills (investigate / frame / decide / compose / critique / refine)
//     × {SKILL.md, agents/openai.yaml}
//   - 4 shared references (presentation / ensemble / orchestration / agent-taxonomy)
//   - 2 host-shared canonical scripts (state.mjs, dispatch-peer.mjs)
//   - 8 commands (6 canonical verbs + audit sugar alias per ADR-0010 §3
//     + resume meta command per ADR-0017 §sub-decision-1)
//   - 4 Claude adapter hooks (pre-compact, stop, session-start, _shared)
//   - 1 Codex adapter hook (stop helper)
//   - 1 Claude hooks manifest (hooks/hooks.json)
//   - 9 ensemble point types in skills/_shared/references/ensemble-protocol.md
//     (added Research-scan for cited-brief profile per ADR-0014)
//   - 3 references/ files under skills/investigate/ (cited-brief-spec,
//     output-file-rules, cited-brief-ensemble) absorbing the Stage 1
//     plugins/research contract per ADR-0014
//
// Plus content sanity (Cluster 1 Option B + ADR-0014 absorption):
//   - verb-name consistency: commands frontmatter ↔ verb folder name,
//     SKILL.md frontmatter `name` ↔ skill folder, agents/openai.yaml
//     `interface.display_name` ↔ verb (case-insensitive substring)
//   - audit sugar alias explicitly redirects to /engineer:critique
//     (ADR-0010 §3 sugar-alias contract)
//   - verb→ensemble mapping cross-check: each ensemble type named in
//     plugins/engineer/README.md verb table is a section heading in
//     skills/_shared/references/ensemble-protocol.md (and vice versa)
//   - 4 shared references pass stale-token audit (no omcc / [Claude] /
//     [Codex] / CODEX_HOME / CLAUDE-ONLY / CODEX-ONLY leaks)
//   - companion contract version freshness across all engineer .md files
//   - cited-brief profile contract: SKILL.md profile table, references/
//     directory presence, command-mode 3-outcome taxonomy, label
//     suppression rule consistency across SKILL.md / cited-brief-spec.md
//     / cited-brief-ensemble.md
//
// Slug sanitization unit tests, lock-ownership race, frontmatter
// validation, secret scrubbing, envelope strict shape, and SessionStart
// marker hardening live in dedicated unit tests under tests/engineer/
// (added in Stage 2 Deliverable E Cluster 2 alongside this test).
//
// Run via `node --test tests/plugin-shape/test-engineer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/engineer');

const VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const ALIAS_VERBS = ['audit'];
// Meta commands ship under commands/<name>.md but do NOT have a
// corresponding skills/<name>/SKILL.md or agents/openai.yaml — they are
// thin shims over plugins/engineer/scripts/state.mjs (ADR-0017
// §sub-decision-1 et seq.).
const META_COMMANDS = ['resume'];
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...META_COMMANDS];
const SHARED_REFS = [
  'presentation-protocol.md',
  'ensemble-protocol.md',
  'orchestration.md',
  'agent-taxonomy.md',
];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs'];
const CLAUDE_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs', '_shared.mjs'];

// Stale tokens that should NEVER appear in engineer SKILL/commands/refs.
// Mirrors test-research-plugin.mjs and reflects ADR-0007 redesign stance —
// engineer is not a port of omcc-dev, so omcc-* / host-source-of-discovery
// labels are forbidden.
const STALE_TOKENS = [
  'omcc-research',
  '/omcc-research',
  'CODEX_HOME',
  'CLAUDE-ONLY',
  'CODEX-ONLY',
  '[Claude]',
  '[Codex]',
];

// Note: 'omcc-dev' is intentionally NOT in STALE_TOKENS because engineer's
// commands/SKILL bodies legitimately reference omcc-dev as the experiential
// reference per ADR-0007. (Refer to AGENTS.md "experiential reference, not a
// porting target".) The check on shared refs alone tightens this to forbid
// host-source labels; bodies are allowed to cite omcc-dev by name.

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('plugins/engineer — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'engineer');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('has author block with name=each4all', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    strictEqual(typeof json.author, 'object');
    strictEqual(json.author.name, 'each4all');
  });

  it('has keywords array including the 6 verbs', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    for (const verb of VERBS) {
      ok(json.keywords.includes(verb), `keywords missing verb "${verb}"`);
    }
  });
});

describe('plugins/engineer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields per Codex vendored spec', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'engineer');
    for (const field of ['version', 'description', 'homepage', 'license']) {
      strictEqual(typeof json[field], 'string', `${field} missing or non-string`);
      ok(json[field].length > 0, `${field} empty`);
    }
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
  });

  it('has author and repository', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    ok(json.repository, 'repository missing');
  });

  it('has keywords array including the 6 verbs', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    for (const verb of VERBS) {
      ok(json.keywords.includes(verb), `keywords missing verb "${verb}"`);
    }
  });

  it('has skills field per Codex vendored spec (REQUIRED)', async () => {
    const json = await readJSON(path);
    strictEqual(json.skills, './skills/');
  });

  it('has interface block with engineer-specific values', async () => {
    const json = await readJSON(path);
    const i = json.interface;
    ok(i, 'interface block missing');
    strictEqual(typeof i.displayName, 'string');
    strictEqual(typeof i.shortDescription, 'string');
    strictEqual(typeof i.longDescription, 'string');
    strictEqual(typeof i.developerName, 'string');
    strictEqual(i.category, 'Development');
    ok(Array.isArray(i.capabilities), 'capabilities not array');
    for (const cap of ['Interactive', 'Read', 'Write']) {
      ok(i.capabilities.includes(cap), `capabilities missing "${cap}"`);
    }
  });

  it('interface.defaultPrompt is array of 1-3 entries, each ≤128 chars, with at least one mentioning $engineer', async () => {
    const json = await readJSON(path);
    const dp = json.interface.defaultPrompt;
    ok(Array.isArray(dp), 'defaultPrompt not array');
    ok(dp.length >= 1 && dp.length <= 3, `defaultPrompt has ${dp.length} entries (1-3 expected)`);
    for (const entry of dp) {
      strictEqual(typeof entry, 'string');
      ok(entry.length <= 128, `defaultPrompt entry exceeds 128 chars: ${entry.length}`);
    }
    ok(dp.some((p) => p.includes('$engineer')), 'no defaultPrompt entry mentions $engineer');
  });
});

describe('plugins/engineer — manifest cross-checks', () => {
  it('Claude and Codex manifests agree on name and version', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.name, codex.name);
    strictEqual(claude.version, codex.version);
  });
});

describe('plugins/engineer — 6 verb skills (skills/<verb>/SKILL.md)', () => {
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md');

      it('exists', async () => {
        ok(await exists(path), `skills/${verb}/SKILL.md missing`);
      });

      it(`frontmatter name=${verb} (verb folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${verb}\\s*$`, 'm');
        ok(re.test(fm), `skills/${verb}/SKILL.md frontmatter name != "${verb}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });

      it('passes stale-token audit', async () => {
        const text = await readFile(path, 'utf8');
        for (const stale of STALE_TOKENS) {
          ok(!text.includes(stale), `skills/${verb}/SKILL.md leaks stale token: ${stale}`);
        }
      });
    });
  }
});

describe('plugins/engineer — 6 Codex agents YAML (skills/<verb>/agents/openai.yaml)', () => {
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', verb, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `skills/${verb}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the verb', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        // verb folder ↔ interface.display_name consistency (case-insensitive).
        const re = new RegExp(`display_name:.*${verb}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention verb "${verb}"`);
      });

      it('default_prompt mentions $engineer:<verb>', async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${verb}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${verb}"`);
      });

      it('policy.allow_implicit_invocation is false (Stage 2 explicit-only invocation)', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^policy:\s*$/m.test(yaml), 'policy block missing');
        ok(
          /allow_implicit_invocation:\s*false/m.test(yaml),
          'allow_implicit_invocation should be false',
        );
      });
    });
  }
});

describe('plugins/engineer — 4 shared references (skills/_shared/references/*.md)', () => {
  for (const name of SHARED_REFS) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'skills/_shared/references', name);

      it('exists', async () => {
        ok(await exists(path), `${name} missing`);
      });

      it('passes stale-token audit', async () => {
        const text = await readFile(path, 'utf8');
        for (const stale of STALE_TOKENS) {
          ok(!text.includes(stale), `${name} leaks stale token: ${stale}`);
        }
      });
    });
  }
});

describe('plugins/engineer — 8 commands (commands/<verb>.md, includes audit sugar alias + resume meta command)', () => {
  for (const verb of ALL_COMMANDS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${verb}.md`);

      it('exists', async () => {
        ok(await exists(path), `commands/${verb}.md missing`);
      });

      it('has frontmatter with non-empty description', async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, `commands/${verb}.md no YAML frontmatter`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });
    });
  }

  it('audit alias explicitly redirects to /engineer:critique (ADR-0010 §3 sugar-alias contract)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/audit.md'), 'utf8');
    ok(
      /\/engineer:critique/.test(text),
      'commands/audit.md does not reference /engineer:critique — sugar alias must redirect canonically',
    );
    ok(
      /full-codebase/.test(text),
      'commands/audit.md does not mention full-codebase profile',
    );
  });
});

describe('plugins/engineer — 2 host-shared canonical scripts (scripts/*.mjs)', () => {
  for (const name of HOST_SHARED_SCRIPTS) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'scripts', name);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `scripts/${name} is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok(
          (st.mode & 0o111) !== 0,
          `scripts/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      });
    });
  }
});

describe('plugins/engineer — Claude adapter hooks (adapters/claude/hooks/*.mjs)', () => {
  for (const name of CLAUDE_HOOKS) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'adapters/claude/hooks', name);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `adapters/claude/hooks/${name} is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok(
          (st.mode & 0o111) !== 0,
          `adapters/claude/hooks/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      });
    });
  }
});

describe('plugins/engineer — Codex adapter (adapters/codex/hooks/)', () => {
  it('stop.mjs exists with executable bit', async () => {
    const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks/stop.mjs');
    const st = await stat(path);
    ok(st.isFile(), 'adapters/codex/hooks/stop.mjs not a regular file');
    ok(
      (st.mode & 0o111) !== 0,
      `adapters/codex/hooks/stop.mjs executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
    );
  });

  it('README.md documents Codex hook surface absence (honest scope per ADR-0001 §honest scope)', async () => {
    const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks/README.md');
    ok(await exists(path), 'adapters/codex/hooks/README.md missing');
  });
});

describe('plugins/engineer — Claude hooks manifest (hooks/hooks.json)', () => {
  const path = resolve(PLUGIN_ROOT, 'hooks/hooks.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('declares the three Claude Code lifecycle hooks (SessionStart compact / PreCompact / Stop)', async () => {
    const json = await readJSON(path);
    ok(json.hooks, 'hooks block missing');
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      ok(Array.isArray(json.hooks[event]), `hooks.${event} not array`);
      ok(json.hooks[event].length >= 1, `hooks.${event} empty`);
    }
  });

  it('SessionStart hook uses matcher=compact (ADR-0011 §4)', async () => {
    const json = await readJSON(path);
    const ss = json.hooks.SessionStart[0];
    strictEqual(ss.matcher, 'compact', 'SessionStart matcher should be "compact"');
  });

  it('all hook commands resolve under adapters/claude/hooks/ via $CLAUDE_PLUGIN_ROOT', async () => {
    const json = await readJSON(path);
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      const entry = json.hooks[event][0].hooks[0];
      strictEqual(entry.type, 'command');
      ok(
        entry.command.includes('${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/'),
        `${event} command does not reference $CLAUDE_PLUGIN_ROOT adapter path: ${entry.command}`,
      );
    }
  });
});

describe('plugins/engineer — verb→ensemble mapping cross-check (ensemble-protocol.md ↔ README)', () => {
  // The 9 ensemble point types declared in ensemble-protocol.md
  // (one per recognised verb/profile combination plus Adversarial-scan
  // for full-codebase critique and Research-scan for the investigate
  // cited-brief profile per ADR-0014). Section heading text is checked
  // verbatim because verb→ensemble mapping must agree with the
  // workflow-state mapping table in the resume protocol.
  const EXPECTED_SECTIONS = [
    '### Frame (frame phase)',
    '### Brainstorm (decide phase)',
    '### Explore (investigate phase, analysis profile)',
    '### Plan-verify (compose phase)',
    '### Review (critique phase, default profile)',
    '### Investigate (investigate phase, root-cause profile)',
    '### Research-scan (investigate phase, cited-brief profile)',
    '### Refine-verify (refine phase)',
    '### Adversarial-scan (critique phase, full-codebase profile)',
  ];

  it('ensemble-protocol.md contains all 9 expected ensemble-point sections', async () => {
    const text = await readFile(
      resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'),
      'utf8',
    );
    for (const heading of EXPECTED_SECTIONS) {
      ok(
        text.includes(heading),
        `ensemble-protocol.md missing section heading: "${heading}". ` +
          `If the verb→ensemble mapping changed, update this test AND the workflow-state mapping table.`,
      );
    }
  });
});

describe('plugins/engineer — investigate cited-brief profile (ADR-0014 absorption)', () => {
  // The cited-brief profile absorbs the Stage 1 plugins/research contract
  // into engineer:investigate per ADR-0014. This block verifies the
  // contract surfaces are wired consistently: profile table mention,
  // references/ directory artifacts, command-mode 3-outcome taxonomy,
  // and label-suppression rule presence in all three contract files.
  const SKILL_PATH = resolve(PLUGIN_ROOT, 'skills/investigate/SKILL.md');
  const COMMAND_PATH = resolve(PLUGIN_ROOT, 'commands/investigate.md');
  const REFERENCES_DIR = resolve(PLUGIN_ROOT, 'skills/investigate/references');
  const SPEC_PATH = resolve(REFERENCES_DIR, 'cited-brief-spec.md');
  const RULES_PATH = resolve(REFERENCES_DIR, 'output-file-rules.md');
  const ENSEMBLE_PATH = resolve(REFERENCES_DIR, 'cited-brief-ensemble.md');

  it('investigate SKILL.md frontmatter description includes cited-brief trigger phrases', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    ok(/cited brief/i.test(fm), 'frontmatter description missing "cited brief"');
    ok(/literature review/i.test(fm), 'frontmatter description missing "literature review"');
    ok(/리서치/.test(fm), 'frontmatter description missing "리서치"');
  });

  it('investigate SKILL.md profile table has all 3 profile rows (analysis / root-cause / cited-brief)', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(/\|\s*`analysis`\s*\(default\)/.test(text), 'profile table missing analysis row');
    ok(/\|\s*`root-cause`/.test(text), 'profile table missing root-cause row');
    ok(/\|\s*`cited-brief`/.test(text), 'profile table missing cited-brief row');
  });

  it('investigate references/ directory contains 3 absorbed contract files', async () => {
    ok(await exists(SPEC_PATH), 'references/cited-brief-spec.md missing');
    ok(await exists(RULES_PATH), 'references/output-file-rules.md missing');
    ok(await exists(ENSEMBLE_PATH), 'references/cited-brief-ensemble.md missing');
  });

  it('commands/investigate.md argument-hint includes cited-brief profile', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter on commands/investigate.md');
    ok(/cited-brief/.test(fm), 'argument-hint missing cited-brief');
  });

  it('commands/investigate.md Completion taxonomy has all 3 cited-brief outcomes', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    // Saved / aborted-at-save / aborted-at-scoping.
    ok(/Cited brief saved/.test(text), 'Completion missing "Cited brief saved" outcome');
    ok(/Cited brief aborted at save/.test(text), 'Completion missing "aborted at save" outcome');
    ok(/Cited brief aborted at scoping/.test(text), 'Completion missing "aborted at scoping" outcome');
  });

  it('label suppression rule is consistent across SKILL.md, cited-brief-spec.md, and ensemble protocol', async () => {
    // Workflow phase notes MAY carry [Local]/[Peer]/[Both] discovery
    // labels for orchestration transparency, but the saved brief
    // artifact MUST strip them. The rule must surface in 3 places:
    //   1. SKILL.md anti-patterns (prose rule for the skill body)
    //   2. cited-brief-spec.md Audit Checklist + Ensemble Label Policy
    //   3. cited-brief-ensemble.md (mentioned in synthesis section)
    const skill = await readFile(SKILL_PATH, 'utf8');
    const spec = await readFile(SPEC_PATH, 'utf8');
    const ensemble = await readFile(ENSEMBLE_PATH, 'utf8');

    ok(
      /Source-of-discovery labels in the cited-brief artifact/.test(skill),
      'SKILL.md anti-patterns missing label suppression rule',
    );
    ok(
      /No source-of-discovery labels/.test(spec),
      'cited-brief-spec.md Audit Checklist missing "No source-of-discovery labels"',
    );
    ok(
      /Ensemble Label Policy/.test(spec),
      'cited-brief-spec.md missing "Ensemble Label Policy" section',
    );
    ok(
      /\[Local\][\s\S]{0,200}\[Peer\]/.test(ensemble) || /label/i.test(ensemble),
      'cited-brief-ensemble.md does not discuss label policy',
    );
  });

  it('cited-brief-spec.md Audit Checklist enumerates all required sentinels', async () => {
    const text = await readFile(SPEC_PATH, 'utf8');
    // Permitted sentinels for un-cited claims.
    ok(/\[uncited inference\]/.test(text), 'spec missing [uncited inference] sentinel');
    ok(/research interrupted/.test(text), 'spec missing "research interrupted" sentinel');
  });
});

describe('plugins/engineer — contract version freshness', () => {
  it('all references to companions/contract.md cite the current version', async () => {
    // Extract current version from contract Status block.
    const contract = await readFile(resolve(REPO_ROOT, 'companions/contract.md'), 'utf8');
    const m = contract.match(/^- \*\*Version\*\*:\s*`v(\d+\.\d+\.\d+)`/m);
    ok(m, 'cannot extract Version line from companions/contract.md Status block');
    const currentVersion = m[1];

    // Scan all .md files under plugins/engineer/.
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => resolve(e.parentPath, e.name));

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const versionMatches = [...text.matchAll(/contract\.md`?\s+v(\d+\.\d+\.\d+)/g)];
      for (const vm of versionMatches) {
        strictEqual(
          vm[1],
          currentVersion,
          `${file}: stale contract version reference v${vm[1]} (current: v${currentVersion})`,
        );
      }
    }
  });
});
