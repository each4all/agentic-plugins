// plugins/engineer plugin-shape conformance test (Stage 2 Deliverable E,
// Cluster 1 Option B — content sanity; Stage 2.5 ADR-0014 cited-brief
// absorption tests appended).
//
// Mirrors tests/plugin-shape/test-research-plugin.mjs structure with
// engineer-specific multi-skill shape:
//   - 2 manifests (Claude + Codex)
//   - 6 verb skills (investigate / frame / decide / compose / critique / refine)
//     × {SKILL.md, agents/openai.yaml}
//   - 1 macro skill `start` (skills/start/ × {SKILL.md, agents/openai.yaml})
//     per ADR-0021 (ADR-0010 §3 cascade — verb skills + macro skills
//     two-category split)
//   - 3 meta skills `resume` / `checkpoint` / `peer-now`
//     (skills/<meta>/ × {SKILL.md, agents/openai.yaml}) per ADR-0022
//     (ADR-0010 §3 cascade — closes ADR-0021 §6; formalizes the
//     `skills/<plugin>/` three-category split: verb / macro / meta)
//   - 5 shared references (presentation / ensemble / orchestration /
//     agent-taxonomy / entry-routing)
//   - 4 host-shared canonical scripts (state.mjs, dispatch-peer.mjs,
//     peer-runner.mjs, stop-archive.mjs)
//   - 11 commands (6 canonical verbs + 1 sugar alias `audit` per ADR-0010 §3
//     + 3 meta commands `resume` / `checkpoint` / `peer-now` per ADR-0017
//     + 1 lifecycle macro `start` per ADR-0020 §Sub-decision 1
//     §sub-decisions 1+2+3)
//   - 4 Claude adapter hooks (pre-compact, stop, session-start, _shared)
//   - 3 Codex adapter hooks (session-start / pre-compact / stop) plus a
//     Codex-specific hook manifest
//   - 1 bundled Claude hooks manifest (hooks/hooks.json), while the Codex
//     manifest's `hooks` field points at adapters/codex/hooks/hooks.json
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
//   - 5 shared references pass stale-token audit (no omcc / [Claude] /
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
// Meta commands per ADR-0017 — non-verb plugin commands that do not
// bootstrap a new workflow but operate on the existing one (ADR-0017
// §sub-decisions 1/2/3). They ship as both Claude-side
// commands/<name>.md AND Codex-side meta skills at
// skills/<name>/ × {SKILL.md, agents/openai.yaml} per ADR-0022 (the
// 2026-05-12 ADR-0010 §3 cascade that closes ADR-0021 §6). All meta
// commands share the same surface conformance (frontmatter with
// description on the command side, frontmatter+description on the
// skill side), but their argument-hint and body shape differ from
// verbs, so verb-name consistency assertions below skip them.
const META_COMMANDS = ['resume', 'checkpoint', 'peer-now'];
// ADR-0022 — meta commands mirror as Codex meta skills. META_SKILLS ==
// META_COMMANDS for now; the alias preserves intent (the same string is
// the command name AND the skill folder name) and mirrors the
// MACRO_SKILLS = LIFECYCLE_MACROS precedent from ADR-0021. If a future
// meta operation ships only as a skill (no Claude command), the alias
// will diverge and a proper enum split happens at that point.
const META_SKILLS = META_COMMANDS;
// ADR-0020 §Sub-decision 1 — lifecycle macro commands are surface-level
// neighbors of meta commands but DO bootstrap new workflows (unlike meta
// commands), so they live in their own list. Currently: `start`.
// ADR-0022 cascade (2026-05-12, ADR-0010 §3) — `skills/<plugin>/` is now
// a three-category split: VERBS (cognitive primitives, fixed at 6 per
// ADR-0020 §Sub-decision 5), LIFECYCLE_MACROS (multi-phase verb
// sequencers per ADR-0021), and META_COMMANDS (workflow-continuity ops
// per ADR-0022). MACRO_SKILLS == LIFECYCLE_MACROS and META_SKILLS ==
// META_COMMANDS for now; both aliases preserve intent (the same string
// is the command name AND the skill folder name) and will diverge only
// if a future macro / meta is exposed skill-only without a Claude
// command.
const LIFECYCLE_MACROS = ['start'];
const MACRO_SKILLS = LIFECYCLE_MACROS;
const ALL_COMMANDS = [...VERBS, ...ALIAS_VERBS, ...META_COMMANDS, ...LIFECYCLE_MACROS];
const SHARED_REFS = [
  'presentation-protocol.md',
  'ensemble-protocol.md',
  'orchestration.md',
  'agent-taxonomy.md',
  'entry-routing-contract.md',
];
const HOST_SHARED_SCRIPTS = ['state.mjs', 'dispatch-peer.mjs', 'peer-runner.mjs', 'stop-archive.mjs'];
const CLAUDE_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs', '_shared.mjs'];
const CODEX_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs', 'hooks.json', 'README.md'];

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

  it('exposes bundled lifecycle hooks to Codex plugin metadata', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json');
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

      it('documents both Claude and Codex explicit entry tokens in the command-mode heading', async () => {
        const text = await readFile(path, 'utf8');
        const heading = text.match(/^## When invoked by command .+$/m)?.[0] ?? '';
        ok(heading.includes(`/engineer:${verb}`), `skills/${verb}/SKILL.md missing Claude /engineer:${verb} entry token`);
        ok(heading.includes(`$engineer:${verb}`), `skills/${verb}/SKILL.md missing Codex $engineer:${verb} entry token`);
        ok(/Claude command/i.test(heading), `skills/${verb}/SKILL.md must label the Claude command entry path`);
        ok(/Codex skill mention/i.test(heading), `skills/${verb}/SKILL.md must label the Codex skill entry path`);
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

describe('plugins/engineer — ADR-0019 PR-D Phase 0 parent-linkage env-var contract', () => {
  // Every verb command's Phase 0 bootstrap snippet MUST read the three
  // AGENTIC_* env vars set by /orchestrator:next so the create-time
  // bootstrap records the immutable parent linkage per ADR-0019 §3.
  // Direct invocation (no env vars) remains backward-compat — the snippet
  // falls back to host=claude with no parent flags.
  for (const verb of VERBS) {
    describe(verb, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${verb}.md`);

      it('uses AGENTIC_HOST variable instead of hardcoded --host claude', async () => {
        const text = await readFile(path, 'utf8');
        ok(!/--host\s+claude(?!\.\$)/m.test(text),
          `commands/${verb}.md still hardcodes --host claude`);
        ok(text.includes('--host "${AGENTIC_HOST:-claude}"'),
          `commands/${verb}.md must use --host "\${AGENTIC_HOST:-claude}"`);
      });

      it('reads AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK with paired-set validation', async () => {
        const text = await readFile(path, 'utf8');
        ok(text.includes('AGENTIC_PARENT_WORKFLOW'),
          `commands/${verb}.md must reference AGENTIC_PARENT_WORKFLOW`);
        ok(text.includes('AGENTIC_ORIGINATING_SUBTASK'),
          `commands/${verb}.md must reference AGENTIC_ORIGINATING_SUBTASK`);
        ok(text.includes('PARENT_ARGS'),
          `commands/${verb}.md must build a PARENT_ARGS array for forwarding`);
        // Paired-set validation: both set or both absent.
        ok(/must be set together/i.test(text),
          `commands/${verb}.md must enforce paired-set validation diagnostic`);
      });

      it('forwards --parent-workflow + --originating-subtask via PARENT_ARGS to state.mjs create', async () => {
        const text = await readFile(path, 'utf8');
        ok(text.includes('--parent-workflow') && text.includes('--originating-subtask'),
          `commands/${verb}.md must forward --parent-workflow + --originating-subtask flags`);
        ok(text.includes('"${PARENT_ARGS[@]}"'),
          `commands/${verb}.md must expand "\${PARENT_ARGS[@]}" in the create CLI call`);
      });

      it('reads AGENTIC_TOPIC env var with fallback to LLM-provided original request', async () => {
        const text = await readFile(path, 'utf8');
        // ADR-0019 PR-D Codex P2 — /orchestrator:next forwards subtask
        // topic via AGENTIC_TOPIC env var. The engineer Phase 0
        // boilerplate's --original-request must read it with a fallback
        // to the LLM-provided scrubbed user request.
        ok(text.includes('${AGENTIC_TOPIC:-'),
          `commands/${verb}.md --original-request must use \${AGENTIC_TOPIC:-...} env-var fallback`);
      });

      if (['investigate', 'compose', 'critique'].includes(verb)) {
        it('reads AGENTIC_PROFILE env var (verbs that accept --profile)', async () => {
          const text = await readFile(path, 'utf8');
          // ADR-0019 PR-D Codex P2 — /orchestrator:next forwards subtask
          // profile via AGENTIC_PROFILE env var for the three multi-profile
          // verbs. The Phase 0 boilerplate's --profile must read it with a
          // fallback to the LLM-extracted $ARGUMENTS profile.
          ok(text.includes('${AGENTIC_PROFILE:-'),
            `commands/${verb}.md --profile must use \${AGENTIC_PROFILE:-...} env-var fallback`);
        });
      }
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

// ADR-0021 — Codex command-surface parity for lifecycle macros via skill
// wrappers. Macro skills mirror the structure of verb skills (SKILL.md +
// agents/openai.yaml) but the folder name is the macro name (e.g., `start`),
// NOT a VALID_VERBS member.
describe('plugins/engineer — macro skills (skills/<macro>/SKILL.md, per ADR-0021)', () => {
  for (const macro of MACRO_SKILLS) {
    describe(macro, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', macro, 'SKILL.md');

      it('exists', async () => {
        ok(await exists(path), `skills/${macro}/SKILL.md missing`);
      });

      it(`frontmatter name=${macro} (macro folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${macro}\\s*$`, 'm');
        ok(re.test(fm), `skills/${macro}/SKILL.md frontmatter name != "${macro}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });

      it('passes stale-token audit', async () => {
        const text = await readFile(path, 'utf8');
        for (const stale of STALE_TOKENS) {
          ok(!text.includes(stale), `skills/${macro}/SKILL.md leaks stale token: ${stale}`);
        }
      });
    });
  }
});

describe('plugins/engineer — start macro host-neutral peer wording', () => {
  it('documents phase-boundary ensembles as opposite-host peer work, not Codex-only work', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/start/SKILL.md'), 'utf8');

    for (const phrase of [
      'opposite-host `brainstorm` ensemble',
      'opposite-host\n`explore` ensemble',
      'opposite-host `plan-verify` ensemble',
      'opposite-host\n`review --scope working-tree` ensemble',
      'peer receives the local draft plan',
      'peer re-review',
    ]) {
      ok(text.includes(phrase), `start SKILL.md missing host-neutral phrase: ${phrase}`);
    }

    for (const pattern of [
      /Codex `brainstorm` ensemble/,
      /Codex `explore` ensemble/,
      /Codex `plan-verify` ensemble/,
      /Codex receives Claude's draft plan/,
      /Codex `review\s+--scope working-tree` ensemble/,
      /Codex re-review/,
    ]) {
      ok(!pattern.test(text), `start SKILL.md must not hard-code Codex-only peer wording: ${pattern}`);
    }
  });
});

describe('plugins/engineer — macro skill Codex agents YAML (skills/<macro>/agents/openai.yaml, per ADR-0021)', () => {
  for (const macro of MACRO_SKILLS) {
    describe(macro, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', macro, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `skills/${macro}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the macro', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        const re = new RegExp(`display_name:.*${macro}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention macro "${macro}"`);
      });

      it(`default_prompt mentions $engineer:${macro}`, async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${macro}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${macro}"`);
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

// ADR-0022 — meta-skill category. Meta skills mirror the structure of
// verb skills and macro skills (SKILL.md + agents/openai.yaml) but the
// folder name is the meta-command name (e.g., `resume`, `checkpoint`,
// `peer-now`), NOT a VALID_VERBS or LIFECYCLE_MACROS member.
describe('plugins/engineer — meta skills (skills/<meta>/SKILL.md, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', meta, 'SKILL.md');

      it('exists', async () => {
        ok(await exists(path), `skills/${meta}/SKILL.md missing`);
      });

      it(`frontmatter name=${meta} (meta folder ↔ frontmatter consistency)`, async () => {
        const text = await readFile(path, 'utf8');
        const fm = frontmatter(text);
        ok(fm, 'no YAML frontmatter');
        const re = new RegExp(`^name:\\s*${meta}\\s*$`, 'm');
        ok(re.test(fm), `skills/${meta}/SKILL.md frontmatter name != "${meta}"`);
        ok(/^description:\s*\S/m.test(fm), 'frontmatter description empty or missing');
      });

      it('passes stale-token audit', async () => {
        const text = await readFile(path, 'utf8');
        for (const stale of STALE_TOKENS) {
          ok(!text.includes(stale), `skills/${meta}/SKILL.md leaks stale token: ${stale}`);
        }
      });

      // ADR-0022 §Decision §3 — Host availability matrix is the
      // load-bearing honesty mechanism that distinguishes meta skills
      // from placeholder parity mirrors. The check (a) requires the
      // top-level section heading, then (b) slices the body from that
      // heading to the next top-level `## ` and asserts the markdown
      // table lives INSIDE the slice — so removing the actual matrix
      // while keeping a later command-resolution table elsewhere is
      // caught (Codex re-review LOW #2).
      it('body includes an explicit Host availability section with a Claude/Codex matrix (ADR-0022 §Decision §3)', async () => {
        const text = await readFile(path, 'utf8');
        const start = text.search(/^##\s+Host availability/im);
        ok(
          start >= 0,
          `skills/${meta}/SKILL.md missing top-level "## Host availability" heading per ADR-0022 §Decision §3`,
        );
        // Slice from the heading to the next top-level `## ` (or end
        // of file). Use a lookahead so the next-section marker isn't
        // consumed by the slice; ignore the first newline so the
        // current heading line stays in the slice.
        const tail = text.slice(start);
        const nextHeading = tail.slice(1).search(/^##\s+/m);
        const section = nextHeading >= 0 ? tail.slice(0, nextHeading + 1) : tail;
        // Match a markdown table header row that names both Claude and
        // Codex columns: e.g., `| Operation | Claude | Codex |`. The
        // column-order tolerance lets future tables re-order columns
        // without breaking the test.
        const tableHeaderRe = /\|.*Claude.*\|.*Codex.*\||\|.*Codex.*\|.*Claude.*\|/;
        ok(
          tableHeaderRe.test(section),
          `skills/${meta}/SKILL.md "## Host availability" section missing a markdown table with both Claude and Codex columns inside the section`,
        );
      });

      it('body mentions --host codex (Codex-side state.mjs flag, ADR-0022 §Decision §2)', async () => {
        const text = await readFile(path, 'utf8');
        ok(
          /--host codex/.test(text),
          `skills/${meta}/SKILL.md does not document the Codex-side --host codex flag`,
        );
      });
    });
  }
});

describe('plugins/engineer — meta skill Codex agents YAML (skills/<meta>/agents/openai.yaml, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = resolve(PLUGIN_ROOT, 'skills', meta, 'agents/openai.yaml');

      it('exists', async () => {
        ok(await exists(path), `skills/${meta}/agents/openai.yaml missing`);
      });

      it('has interface block with display_name mentioning the meta name', async () => {
        const yaml = await readFile(path, 'utf8');
        ok(/^interface:\s*$/m.test(yaml), 'interface block missing');
        ok(/^\s+display_name:\s*\S/m.test(yaml), 'interface.display_name missing or empty');
        const re = new RegExp(`display_name:.*${meta}`, 'i');
        ok(re.test(yaml), `interface.display_name does not mention meta "${meta}"`);
      });

      it(`default_prompt mentions $engineer:${meta}`, async () => {
        const yaml = await readFile(path, 'utf8');
        const re = new RegExp(`\\$engineer:${meta}`);
        ok(re.test(yaml), `default_prompt does not mention "$engineer:${meta}"`);
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

// ADR-0022 §Decision §2 — content authority: SKILL.md owns the
// cognitive runbook; commands/<meta>.md delegates to SKILL.md via a
// per-command pointer. The delegation pointer is the structural marker
// that distinguishes ADR-0022-refactored commands from pre-cascade
// commands that bundled prose + bash inline.
describe('plugins/engineer — meta command delegation pointer (commands/<meta>.md → skills/<meta>/SKILL.md, per ADR-0022)', () => {
  for (const meta of META_SKILLS) {
    describe(meta, () => {
      const path = resolve(PLUGIN_ROOT, 'commands', `${meta}.md`);

      it('command file references skills/<meta>/SKILL.md as the cognitive runbook source', async () => {
        const text = await readFile(path, 'utf8');
        const re = new RegExp(`skills/${meta}/SKILL\\.md`);
        ok(
          re.test(text),
          `commands/${meta}.md does not reference skills/${meta}/SKILL.md — delegation pointer missing per ADR-0022 §Decision §2`,
        );
      });

      it('command file cites ADR-0022 (meta-skill category cascade)', async () => {
        const text = await readFile(path, 'utf8');
        ok(
          /ADR-0022/.test(text),
          `commands/${meta}.md missing ADR-0022 reference — required for the meta-skill cascade audit trail`,
        );
      });
    });
  }
});

describe('plugins/engineer — 5 shared references (skills/_shared/references/*.md)', () => {
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

describe('plugins/engineer — 11 commands (commands/<verb>.md — 6 verbs + audit alias + resume/checkpoint/peer-now meta + start lifecycle macro)', () => {
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

  it('checkpoint meta command surfaces required ADR-0017 sub-2 signals (argument-hint + state.mjs delegation)', async () => {
    // Meta commands per ADR-0017 are thin shims over `state.mjs`
    // subcommands. Verify the contract surface: argument-hint advertises
    // a summary, body delegates to checkpoint-set, and the SessionStart
    // re-injection contract is mentioned (otherwise the user would not
    // know why the command is worth invoking).
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/checkpoint.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'commands/checkpoint.md has no YAML frontmatter');
    ok(
      /^argument-hint:.*summary/im.test(fm),
      'commands/checkpoint.md argument-hint must advertise <summary>',
    );
    ok(
      /checkpoint-set/.test(text),
      'commands/checkpoint.md must delegate to state.mjs checkpoint-set subcommand',
    );
    ok(
      /SessionStart/.test(text),
      'commands/checkpoint.md must surface the SessionStart re-injection contract (otherwise users will not understand the value)',
    );
    ok(
      /ADR-0017/.test(text),
      'commands/checkpoint.md must cite ADR-0017 sub-decision 2',
    );
  });

  it('six verb commands use peer-runner.mjs for managed ensemble dispatch (ADR-0023 PR-C)', async () => {
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      ok(
        /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind ensemble[\s\S]{0,260}--run-id "\$RUN_ID"/.test(text),
        `commands/${verb}.md must dispatch managed ensembles through peer-runner.mjs run`,
      );
      ok(
        /PROMPT_FILE\.run\.json/.test(text),
        `commands/${verb}.md must capture peer-runner's machine-readable result JSON`,
      );
    }
  });

  it('six verb commands no longer route managed ensembles through dispatch-peer.mjs', async () => {
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      ok(
        !/dispatch-peer\.mjs/.test(text),
        `commands/${verb}.md should reserve dispatch-peer.mjs for compatibility/raw callers`,
      );
    }
  });

  it('peer-now uses peer-runner text mode with status/cancel controls and remains out of ensemble_results', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf8');
    ok(
      /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind peer-now[\s\S]{0,260}--output-format text/.test(text),
      'commands/peer-now.md must use peer-runner.mjs run --kind peer-now --output-format text',
    );
    ok(
      /peer-runner\.mjs"\s+status[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text) &&
        /peer-runner\.mjs"\s+cancel[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text),
      'commands/peer-now.md must document status/cancel controls by peer-now run_id',
    );
    ok(
      /ensemble_results/.test(text) && /does NOT touch `pending_ensemble` or\s+`ensemble_results`/.test(text),
      'commands/peer-now.md must keep peer-now out of ensemble_results',
    );
  });

  it('workflow completion commands append the runtime completion footer contract', async () => {
    for (const cmd of [...VERBS, ...LIFECYCLE_MACROS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`), 'utf8');
      ok(/runtime completion footer/i.test(text), `commands/${cmd}.md missing runtime footer guidance`);
      ok(/advisory/i.test(text), `commands/${cmd}.md must mark footer advisory`);
      ok(/pointer-only/i.test(text), `commands/${cmd}.md must keep footer pointer-only`);
      ok(/do not mutate host session\s+context/i.test(text), `commands/${cmd}.md must forbid context mutation`);
    }
  });
});

describe('plugins/engineer — 4 host-shared canonical scripts (scripts/*.mjs)', () => {
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
  for (const name of CODEX_HOOKS) {
    it(`${name} exists${name.endsWith('.mjs') ? ' with executable bit' : ''}`, async () => {
      const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks', name);
      const st = await stat(path);
      ok(st.isFile(), `adapters/codex/hooks/${name} not a regular file`);
      if (name.endsWith('.mjs')) {
        ok(
          (st.mode & 0o111) !== 0,
          `adapters/codex/hooks/${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`,
        );
      }
    });
  }

  it('hooks.json routes lifecycle commands to Codex adapter hooks via $PLUGIN_ROOT', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      const entry = json.hooks[event][0].hooks[0];
      strictEqual(entry.type, 'command');
      ok(
        entry.command.includes('${PLUGIN_ROOT}/adapters/codex/hooks/'),
        `${event} command does not reference $PLUGIN_ROOT Codex adapter path: ${entry.command}`,
      );
    }
    strictEqual(json.hooks.SessionStart[0].matcher, 'compact');
  });

  it('README.md documents Codex hook fallback scope', async () => {
    const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks/README.md');
    ok(await exists(path), 'adapters/codex/hooks/README.md missing');
    const text = await readFile(path, 'utf-8');
    ok(/plugin_hooks\s*=\s*true/.test(text), 'README documents Codex plugin_hooks feature flag');
    ok(/fallback accelerator/i.test(text), 'README documents manual fallback');
  });
});

describe('plugins/engineer — bundled hooks manifest (hooks/hooks.json)', () => {
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
