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
//     Node resolver wrapper and Codex-specific hook manifest
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
const CODEX_HOOKS = ['pre-compact.mjs', 'stop.mjs', 'session-start.mjs', 'run-node-hook.sh', 'hooks.json', 'README.md'];

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

  it('six verb skills mirror the entry-routing Active Next-Action Proposal at completion (ADR-0029 §1, PR-D)', async () => {
    // ADR-0029 PR-D — the SKILL.md completion (the Codex skill-mention path,
    // and the shared cognitive runbook) must mirror the §1 Active Next-Action
    // Proposal that PR-B wired into commands/<verb>.md, so a standalone verb
    // completion on either host emits the evidence-based proposal instead of a
    // fixed lifecycle-table literal. Unlike the command file (two loci — the
    // durable Phase 2 NOTE skeleton AND the Completion display), SKILL.md is
    // cognition-only (ADR-0022 commands-hold-bootstrap: the state.mjs NOTE
    // writes live in commands/<verb>.md), so it carries a SINGLE locus: a
    // `## Completion` proposal section. This per-completion consult is the
    // SKILL.md-side enforcement point that keeps the contract's reach from
    // regressing to /engineer:start-only — the drift ADR-0029 Consequences
    // §Negative warns about, mirrored here for the skill surface. The
    // assertions are deliberately strict (all six proposal fields, scoped to
    // the Completion section) so the test cannot pass on a 2-field stub.
    const PROPOSAL_FIELDS = [
      'selected_next',
      'rejected_alternatives',
      'rationale',
      'evidence_pointers',
      'confidence',
      'next_command',
    ];
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');

      // The fixed-literal "static lifecycle table" anti-pattern (ADR-0029 W1)
      // must be gone. Two guards:
      //   (a) investigate's presented-output `Recommended next step:` literal
      //       — a REAL literal PR-D removes from skills/investigate/SKILL.md.
      //   (b) the command-style `### Recommended next verb` heading — DEFENSIVE
      //       only: it never existed in any skill (it was the commands/<verb>.md
      //       literal PR-B removed), but guarding it here stops a future
      //       copy-paste from a command file from re-introducing it in a skill.
      ok(
        !/###\s+Recommended next verb/.test(text),
        `skills/${verb}/SKILL.md carries the command-style "### Recommended next verb" literal — it must never be copied into a skill (ADR-0029 W1)`,
      );
      ok(
        !/Recommended next step:/.test(text),
        `skills/${verb}/SKILL.md still carries the fixed "Recommended next step:" literal — replace it with the Active Next-Action Proposal (ADR-0029 W1)`,
      );

      // The single SKILL.md locus — a `## Completion` proposal section. Bound
      // the region to the section itself (up to the next `## ` heading, e.g.
      // `## Anti-patterns`) so the field checks assert presence IN the
      // proposal, not merely anywhere downstream.
      const compIdx = text.indexOf('## Completion');
      ok(compIdx !== -1, `skills/${verb}/SKILL.md has no "## Completion" section to host the Active Next-Action Proposal (ADR-0029 §1 / PR-D)`);
      const afterHeading = text.slice(compIdx + '## Completion'.length);
      const nextHeadingRel = afterHeading.search(/\n##\s/);
      const completionRegion = nextHeadingRel === -1
        ? text.slice(compIdx)
        : text.slice(compIdx, compIdx + '## Completion'.length + nextHeadingRel);

      ok(
        /Active Next-Action Proposal/i.test(completionRegion),
        `skills/${verb}/SKILL.md Completion must reference the contract's Active Next-Action Proposal section (ADR-0029 §1)`,
      );
      ok(
        completionRegion.includes('../_shared/references/entry-routing-contract.md'),
        `skills/${verb}/SKILL.md Completion must cite the contract by its skill-relative path "../_shared/references/entry-routing-contract.md" (ADR-0029 §1; the command-side "skills/_shared/..." path would NOT resolve from skills/<verb>/SKILL.md — ADR-0010 §5 copy-not-import means the path is re-based, not copied verbatim)`,
      );
      for (const field of PROPOSAL_FIELDS) {
        ok(
          new RegExp(`-\\s+${field}:`).test(completionRegion),
          `skills/${verb}/SKILL.md Completion is missing the "- ${field}:" proposal skeleton line (ADR-0029 §1 proposal shape — a bare token mention is not enough; the field must appear as a skeleton line so the mirror cannot degrade to a generic stub)`,
        );
      }
    }
  });
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

  it('workflow completion commands defer to the code-emitted runtime completion footer (ADR-0039)', async () => {
    for (const cmd of [...VERBS, ...LIFECYCLE_MACROS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${cmd}.md`), 'utf8');
      ok(/runtime completion footer/i.test(text), `commands/${cmd}.md missing runtime footer guidance`);
      // ADR-0039 §9 — the footer is CODE-EMITTED on the terminal path, not
      // hand-composed. Guard both the new contract phrasing and the removal of
      // the old "render the same fields manually" hand-compose instruction.
      ok(/code-emitted/i.test(text), `commands/${cmd}.md must state the footer is code-emitted (ADR-0039 §9)`);
      ok(!/render the same fields manually/i.test(text), `commands/${cmd}.md must not instruct hand-composing the footer`);
      ok(/advisory/i.test(text), `commands/${cmd}.md must mark footer advisory`);
      ok(/pointer-only/i.test(text), `commands/${cmd}.md must keep footer pointer-only`);
      ok(
        /(do not\s+mutate|never\s+mutates)\s+host\s+session\s+context/i.test(text),
        `commands/${cmd}.md must forbid host session context mutation`,
      );
    }
  });

  it('six verb commands consult the entry-routing contract for an active next-action proposal (ADR-0029 §1, PR-B)', async () => {
    // ADR-0029 W1 — a standalone verb completion must replace the fixed
    // `### Recommended next verb` literal with the contract's evidence-based
    // Active Next-Action Proposal. This per-completion consult IS the
    // enforcement point that keeps the contract's reach from regressing to
    // /engineer:start-only — the drift ADR-0029 Consequences §Negative warns
    // about. PR-B wires the six verb commands; the skills/<verb>/SKILL.md
    // mirror is PR-D. The assertions below are deliberately strict (all six
    // proposal fields + both loci) so the test cannot pass on a 2-field stub.
    // The guard is STRUCTURAL (per-locus), not mere text-presence: the full
    // proposal skeleton must live in the Phase 2 region (the durable NOTE
    // phase note) AND the Completion display must instruct emitting it — each
    // citing the contract. This prevents a half-wired completion (or fields
    // scattered across the file) from satisfying the check.
    const PROPOSAL_FIELDS = [
      'selected_next',
      'rejected_alternatives',
      'rationale',
      'evidence_pointers',
      'confidence',
      'next_command',
    ];
    for (const verb of VERBS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');

      // The fixed-literal anti-pattern must be gone entirely.
      ok(
        !/###\s+Recommended next verb/.test(text),
        `commands/${verb}.md still carries the fixed "### Recommended next verb" literal — the ADR-0029 W1 anti-pattern must be removed`,
      );

      // Split into the Phase 2 region (durable NOTE phase note) and the
      // Completion display, then check each locus independently.
      const compIdx = text.indexOf('## Completion');
      ok(compIdx !== -1, `commands/${verb}.md has no "## Completion" section to host the proposal (ADR-0029 §1)`);
      const phase2Region = text.slice(0, compIdx);
      const completionRegion = text.slice(compIdx);

      // Locus 1 — the durable phase note records a full proposal skeleton.
      ok(
        /###\s+Active next-action proposal/i.test(phase2Region),
        `commands/${verb}.md Phase 2 NOTE must record the "### Active next-action proposal" skeleton (ADR-0029 §1)`,
      );
      ok(
        /entry-routing-contract\.md/.test(phase2Region),
        `commands/${verb}.md Phase 2 NOTE must cite entry-routing-contract.md (ADR-0029 §1)`,
      );
      for (const field of PROPOSAL_FIELDS) {
        ok(
          new RegExp(`-\\s+${field}:`).test(phase2Region),
          `commands/${verb}.md Phase 2 NOTE skeleton is missing the "${field}" line (ADR-0029 §1 proposal shape)`,
        );
      }

      // Locus 2 — the Completion display names the contract section, cites the
      // file, and surfaces all six proposal fields.
      ok(
        /Active Next-Action Proposal/i.test(completionRegion),
        `commands/${verb}.md Completion must reference the contract's Active Next-Action Proposal section (ADR-0029 §1)`,
      );
      ok(
        /entry-routing-contract\.md/.test(completionRegion),
        `commands/${verb}.md Completion must cite entry-routing-contract.md (ADR-0029 §1)`,
      );
      for (const field of PROPOSAL_FIELDS) {
        ok(
          completionRegion.includes(field),
          `commands/${verb}.md Completion is missing the "${field}" proposal field (ADR-0029 §1 proposal shape)`,
        );
      }
    }
  });
});

describe('plugins/engineer — ADR-0029 §2 cross-verb multi-axis lens (PR-C)', () => {
  // ADR-0029 W2 / §2 — a NON-decide verb that reaches a genuine 2+-branch
  // decision point (two viable hypotheses / designs / remediation directions,
  // or a non-neutral Active Next-Action `selected_next` with 2+ candidates)
  // must surface a COMPACT multi-axis lens resolved from the SHARED
  // decide-registry.mjs resolver — the single axis source of truth — sized per
  // the decision (minor→compact / standard→default / major→nine-axis) and
  // bounded to genuine branch points (never every invocation, never the full
  // 9-axis matrix for a trivial reversible step).
  //
  // `decide` is EXEMPT: it already resolves the registry in commands/decide.md
  // Phase 0.5, so the §2 cross-verb wiring targets the other five verbs. The
  // exemption is asserted positively (decide still resolves) so a future
  // regression that drops Phase 0.5 is caught rather than silently passing the
  // exemption as a missing wire.
  //
  // W-A (approved direction) — the resolve mechanism + bash invocation live
  // ONCE in the contract; each verb surface carries a THIN consult-pointer.
  // The §2-specific structural markers (what distinguishes a §2 consult from
  // the §1 Active Next-Action Proposal, which already cites the contract) are:
  // (a) NAMING the decide-registry.mjs resolver, (b) naming the --size sizing
  // flag, (c) bounding language for a genuine 2+-branch point. The pointer is
  // hosted in a dedicated, heading-bounded section so the markers assert
  // presence IN the §2 wiring, not merely anywhere in the file (mirrors the
  // Completion-region bounding the §1 PR-B / PR-D tests use).
  const NON_DECIDE = ['investigate', 'frame', 'compose', 'critique', 'refine'];
  const SECTION_HEADING = '## Multi-axis lens at a 2+-branch point';

  // Bound a `## ` section from its heading up to the next `## ` heading (or
  // EOF), so a marker downstream of the section cannot satisfy the check.
  function boundSection(text, startIdx, heading) {
    const after = text.slice(startIdx + heading.length);
    const rel = after.search(/\n##\s/);
    return rel === -1
      ? text.slice(startIdx)
      : text.slice(startIdx, startIdx + heading.length + rel);
  }

  it('the contract documents the §2 non-decide-verb lens mechanism in a bounded subsection (single source)', async () => {
    const text = await readFile(
      resolve(PLUGIN_ROOT, 'skills/_shared/references/entry-routing-contract.md'),
      'utf8',
    );
    // Bound to the §2 mechanism subsection itself (not a whole-file scan) so
    // the markers must live IN the §2 section — future drift cannot satisfy
    // them from elsewhere in the contract (Codex review MINOR-1).
    const HEADING = '### Surfacing the multi-axis lens from a non-decide verb';
    const idx = text.indexOf(HEADING);
    ok(idx !== -1, `entry-routing-contract.md missing the "${HEADING}" §2 mechanism subsection (ADR-0029 §2 / PR-C)`);
    const region = boundSection(text, idx, HEADING);
    ok(
      /decide-registry\.mjs/.test(region),
      'contract §2 subsection must NAME the shared decide-registry.mjs resolver as the lens source (single axis source — ADR-0029 §2)',
    );
    ok(
      /non-.?decide verb/i.test(region),
      'contract §2 subsection must scope the lens mechanism to non-decide verbs (ADR-0029 §2)',
    );
    ok(
      /single axis source|single source of (the )?axis truth|single source of truth/i.test(region),
      'contract §2 subsection must state the registry is the single axis source (no second axis list — ADR-0029 §2)',
    );
    ok(
      /--size=/.test(region),
      'contract §2 subsection must name the --size sizing flag (minor→compact / standard→default / major→nine-axis)',
    );
    ok(
      /ADR-0013/.test(region),
      'contract §2 subsection must note the Codex registry-resolution fallback (ADR-0013 asymmetry)',
    );
    // Single-source guard (Codex review MAJOR) — the §2 subsection must NOT
    // re-enumerate the compact preset's supporting axes inline; that axis
    // membership is owned by decision-axes.yml, and the decision-sizing
    // subsection above already lists it once. entry-routing-guarantee is the
    // compact-specific supporting axis, so its presence INSIDE §2 signals a
    // duplicated / hand-authored axis list (the boundary §2 itself forbids).
    ok(
      !/entry-routing-guarantee/.test(region),
      'contract §2 subsection must NOT hand-author the compact supporting-axis list inline (entry-routing-guarantee belongs to decision-axes.yml + the decision-sizing subsection — ADR-0029 §2 single axis source)',
    );
  });

  it('five non-decide verb commands carry a §2 consult-pointer naming the shared resolver', async () => {
    for (const verb of NON_DECIDE) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const idx = text.indexOf(SECTION_HEADING);
      ok(idx !== -1, `commands/${verb}.md missing the "${SECTION_HEADING}" §2 section (ADR-0029 §2 / PR-C)`);
      const region = boundSection(text, idx, SECTION_HEADING);
      ok(
        /decide-registry\.mjs/.test(region),
        `commands/${verb}.md §2 section must NAME the shared decide-registry.mjs resolver (ADR-0029 §2 — the registry is the single axis source, not a hand-authored list)`,
      );
      ok(
        /--size=/.test(region),
        `commands/${verb}.md §2 section must name the --size sizing flag (minor→compact / standard→default / major→nine-axis)`,
      );
      ok(
        region.includes('skills/_shared/references/entry-routing-contract.md'),
        `commands/${verb}.md §2 section must cite the contract by its command-relative path "skills/_shared/references/entry-routing-contract.md" (W-A: the mechanism lives in the contract; matches the skill-side ../_shared/... path rigor — Codex review SUGGESTION)`,
      );
      ok(
        /genuine/i.test(region),
        `commands/${verb}.md §2 section must bound the lens to a genuine 2+-branch point (ADR-0029 §2 — not every invocation)`,
      );
    }
  });

  it('five non-decide verb skills mirror the §2 consult-pointer (host parity + ADR-0013 fallback)', async () => {
    for (const verb of NON_DECIDE) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const idx = text.indexOf(SECTION_HEADING);
      ok(idx !== -1, `skills/${verb}/SKILL.md missing the "${SECTION_HEADING}" §2 section (ADR-0029 §2 / PR-C host parity)`);
      const region = boundSection(text, idx, SECTION_HEADING);
      ok(
        /decide-registry\.mjs/.test(region),
        `skills/${verb}/SKILL.md §2 section must NAME the shared decide-registry.mjs resolver (ADR-0029 §2)`,
      );
      ok(
        /--size=/.test(region),
        `skills/${verb}/SKILL.md §2 section must name the --size sizing flag`,
      );
      ok(
        region.includes('../_shared/references/entry-routing-contract.md'),
        `skills/${verb}/SKILL.md §2 section must cite the contract by its skill-relative path "../_shared/references/entry-routing-contract.md" (ADR-0010 §5 copy-not-import path re-base — the command-side "skills/_shared/..." path would not resolve from skills/<verb>/)`,
      );
      ok(
        /ADR-0013/.test(region),
        `skills/${verb}/SKILL.md §2 section must note the Codex registry-resolution fallback (ADR-0013 — when the resolver CLI is not reachable)`,
      );
      // Single-source guards (Codex review MAJOR + MINOR-2) — the SKILL is a
      // THIN consult-pointer (W-A), so its CLI-unreachable fallback must POINT
      // to the registry source rather than re-listing the compact preset's
      // supporting axes inline. Positive: cite decision-axes.yml as the axis
      // source. Negative: entry-routing-guarantee (the compact-specific
      // supporting axis) must NOT be hand-authored into the section — that
      // membership lives only in decision-axes.yml.
      ok(
        /decision-axes\.yml/.test(region),
        `skills/${verb}/SKILL.md §2 fallback must point to decision-axes.yml as the axis source rather than re-listing axes inline (ADR-0029 §2 single source)`,
      );
      ok(
        !/entry-routing-guarantee/.test(region),
        `skills/${verb}/SKILL.md §2 must NOT hand-author the compact supporting-axis list inline (entry-routing-guarantee belongs to decision-axes.yml — ADR-0029 §2 single axis source; W-A thin consult-pointer)`,
      );
    }
  });

  // ---------------------------------------------------------------------
  // Codex path-resolution fallback — the reason, and the one-of-N guard.
  //
  // The §2 fallback used to blame "Codex auto-activated skill mode". That
  // mode does not exist for these skills: all ten agents/openai.yaml files
  // set policy.allow_implicit_invocation: false and the Codex binary parses
  // the key. The measured cause is that a Codex skill mention has no
  // plugin-root variable in its environment, so a $CLAUDE_PLUGIN_ROOT-based
  // path resolves empty. Hook COMMANDS do receive ${PLUGIN_ROOT}, so the
  // corrected wording is scoped to the skill-mention shell — an unscoped
  // "Codex has no PLUGIN_ROOT" would be a fresh falsehood.
  //
  // Three ways the obvious guards pass vacuously, each closed below:
  //   1. a raw substring scan misses copies that wrap mid-phrase (the five
  //      SKILLs break between "auto-activated" and "skill mode"; the old
  //      contract broke between "Codex" and "auto-activated"), so every
  //      scan here normalizes whitespace first;
  //   2. new Set(x).size === 1 is also true when every extraction is the
  //      empty string, so extraction count and per-item content are
  //      asserted BEFORE the equality;
  //   3. a region-level PLUGIN_ROOT token proves nothing — the §2 region
  //      already contains $CLAUDE_PLUGIN_ROOT in its resolver example — so
  //      the positive assertion is bound to the single-axis-source bullet.
  const squash = (s) => s.replace(/\s+/g, ' ');
  const DEAD_REASON = /auto-activated\s+skill\s+mode/i;

  it('the Codex fallback reason is stated once and identically across all five SKILL mirrors', async () => {
    const START = 'On Codex the resolver takes one extra step';
    const END = 'not the reachability of the script.';
    const paragraphs = [];
    for (const verb of NON_DECIDE) {
      const raw = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const flat = squash(raw);
      const from = flat.indexOf(START);
      ok(
        from !== -1,
        `skills/${verb}/SKILL.md must carry the Codex path-resolution fallback paragraph (starts "${START}") — a mirror that lost it would otherwise pass the equality check below by being excluded`,
      );
      const to = flat.indexOf(END, from);
      ok(
        to !== -1,
        `skills/${verb}/SKILL.md fallback paragraph must run through "${END}" — a truncated copy must fail rather than compare equal on a shared prefix`,
      );
      const paragraph = flat.slice(from, to + END.length);
      // Non-vacuity: an empty or content-free extraction must not be able to
      // satisfy the size-1 equality below.
      ok(paragraph.length > 200, `skills/${verb}/SKILL.md fallback paragraph is implausibly short (${paragraph.length} chars) — extraction likely broke`);
      ok(/ADR-0013/.test(paragraph), `skills/${verb}/SKILL.md fallback paragraph must keep the ADR-0013 attribution (the absent Codex command file, not script reachability)`);
      ok(/decision-axes\.yml/.test(paragraph), `skills/${verb}/SKILL.md fallback paragraph must keep decision-axes.yml as the axis source`);
      // Semantic predicates applied PER MIRROR, not only to the contract:
      // five copies drifting together must not pass on equality alone.
      ok(/plugin-root variable/.test(paragraph), `skills/${verb}/SKILL.md fallback must state the measured cause (no plugin-root variable in a Codex skill mention), not a mode that does not exist`);
      ok(/skill mention's shell/.test(paragraph), `skills/${verb}/SKILL.md fallback must scope the absence to the skill-mention SHELL — hook commands do receive the substituted names, so an unscoped claim would be a new falsehood`);
      ok(!/hook-command-only/.test(paragraph), `skills/${verb}/SKILL.md fallback must not reassert "hook-command-only" — that is a global negative about Codex substitution that was never measured`);
      strictEqual(
        flat.split(START).length - 1,
        1,
        `skills/${verb}/SKILL.md must state the fallback exactly once — a second copy would sit outside the compared extraction and drift unnoticed`,
      );
      ok(/checkpoint\/SKILL\.md/.test(paragraph), `skills/${verb}/SKILL.md fallback must point at the documented Codex install root so the fallback narrows to "path cannot be built"`);
      paragraphs.push(paragraph);
    }
    strictEqual(
      paragraphs.length,
      NON_DECIDE.length,
      'every non-decide verb SKILL must contribute exactly one fallback paragraph before the copies are compared',
    );
    strictEqual(
      new Set(paragraphs).size,
      1,
      `the five SKILL fallback paragraphs must stay identical — updating one copy and not the others is the exact defect this guard exists to catch. Distinct values: ${new Set(paragraphs).size}`,
    );
  });

  it('the retired auto-activated-mode reason survives nowhere in the engineer plugin', async () => {
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    const scanned = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(md|yaml|yml|json)$/.test(entry.name)) continue;
      // CHANGELOG is release history — a past entry may legitimately quote
      // the retired wording, and rewriting history is not this guard's job.
      if (entry.name === 'CHANGELOG.md') continue;
      const path = resolve(entry.parentPath ?? entry.path, entry.name);
      const text = squash(await readFile(path, 'utf8'));
      scanned.push(path);
      ok(
        !DEAD_REASON.test(text),
        `${path} still blames the retired "auto-activated skill mode" for Codex registry-resolution. The measured cause is an unset plugin-root variable (ADR-0029 Amendment 2026-08-08).`,
      );
    }
    ok(scanned.length > 20, `the stale-reason scan must actually reach the plugin's documents (scanned ${scanned.length})`);
  });

  it('the contract bullet — not merely the §2 region — carries the measured reason and the recovery path', async () => {
    const text = await readFile(
      resolve(PLUGIN_ROOT, 'skills/_shared/references/entry-routing-contract.md'),
      'utf8',
    );
    // Bound to the single-axis-source BULLET. A region-scoped assertion would
    // pass on the $CLAUDE_PLUGIN_ROOT already present in §2's resolver
    // example, proving nothing about the corrected reason.
    const BULLET = '- **The registry is the single axis source.**';
    const start = text.indexOf(BULLET);
    ok(start !== -1, `entry-routing-contract.md must keep the "${BULLET}" bullet`);
    const rest = text.slice(start + BULLET.length);
    // Stop at ANY sibling list item, not only a bold one: if the next bullet
    // stops being bold, a region-bleeding extraction could satisfy these
    // assertions from unrelated later content (peer review SUGGESTION).
    const next = rest.search(/\n- /);
    const bullet = squash(next === -1 ? rest : rest.slice(0, next));
    ok(/Codex\s+skill mention/.test(bullet), 'the bullet must scope the absence to a Codex SKILL MENTION (hook commands do receive ${PLUGIN_ROOT})');
    ok(/skill mention's shell/.test(bullet), "the bullet must scope the absence to a skill mention's SHELL, so it cannot be read as \"Codex has no plugin root\" — hook commands do receive the substituted names");
    ok(
      /not\s+a claim about every place/.test(bullet),
      'the bullet must state the limit of its own evidence — the shell observation is not a global claim about Codex substitution',
    );
    ok(!/hook-command-only/.test(bullet), 'the bullet must not reassert the unmeasured global negative');
    ok(/all empty/.test(bullet), 'the bullet must state the measured observation (the plugin-root variables read empty), not a vague unreachability');
    ok(/checkpoint\/SKILL\.md/.test(bullet), 'the bullet must point at the documented Codex install root as the recovery path');
    ok(/ADR-0013/.test(bullet), 'the bullet must keep ADR-0013 scoped to the missing command file rather than to script reachability');
    ok(!DEAD_REASON.test(bullet), 'the bullet must not reintroduce the retired auto-activated-mode reason');
  });

  it('checkpoint re-injection is documented as post-compact on BOTH hosts, never as Claude-only', async () => {
    // Both hosts register SessionStart with matcher "compact", so a claim that
    // Codex cannot re-inject is false AND a claim that either host re-injects
    // into an arbitrary new session is an overstatement. Read the matcher from
    // the manifests so this guard tracks the hooks rather than restating them.
    for (const [label, rel] of [
      ['claude', 'hooks/hooks.json'],
      ['codex', 'adapters/codex/hooks/hooks.json'],
    ]) {
      const hooks = JSON.parse(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      const sessionStart = hooks.hooks?.SessionStart ?? [];
      ok(
        sessionStart.length > 0 && sessionStart.every((row) => row.matcher === 'compact'),
        `${label} SessionStart must stay matcher:"compact" — the prose guards below describe post-compact re-injection, and a matcher change would make that prose wrong`,
      );
    }
    // commands/checkpoint.md was MISSED by the first pass of this change and
    // kept its own copy of the corrected paragraph, including the
    // `claude --continue` claim. A negative-only guard over a hand-listed
    // subset is how that survived; the positive assertion below is what makes
    // deleting the corrected wording fail too.
    const CHECKPOINT_SURFACES = [
      'skills/checkpoint/SKILL.md',
      'commands/checkpoint.md',
      'skills/resume/SKILL.md',
      'README.md',
      'skills/checkpoint/agents/openai.yaml',
    ];
    let compactStatements = 0;
    for (const rel of CHECKPOINT_SURFACES) {
      const text = squash(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      if (/post-compact|matcher: "compact"|after compact/.test(text)) compactStatements += 1;
      ok(
        !/claude --continue\)? re-inject|after `\/compact` or `claude --continue`/i.test(text),
        `${rel} must not promise re-injection on claude --continue — that SessionStart source is not selected by the compact matcher`,
      );
      ok(
        !/the Codex session itself does not re-inject/i.test(text),
        `${rel} must not claim the Codex session cannot re-inject — bundled hooks re-inject post-compact once /hooks-trusted (ADR-0030)`,
      );
      ok(
        !/re-injection[^.]{0,80}is \*\*Claude-only\*\*/i.test(text),
        `${rel} must not call SessionStart re-injection Claude-only — it runs on both hosts, post-compact`,
      );
      ok(
        !/the next Claude session(?:'s)? .{0,40}re-inject/i.test(text) && !/Yes \(next Claude session\)/.test(text),
        `${rel} must not promise re-injection in "the next Claude session" — the hook is post-compact-scoped on both hosts`,
      );
    }
    // The packaged interface metadata carries the claim TWICE and Codex shows
    // both fields to users, so a per-file "at least one" check passes when one
    // of the two is reverted (observed: mutation M7 survived that shape).
    // Assert per FIELD here rather than per file.
    const yamlText = await readFile(resolve(PLUGIN_ROOT, 'skills/checkpoint/agents/openai.yaml'), 'utf8');
    for (const field of ['short_description', 'default_prompt']) {
      const line = yamlText.split('\n').find((l) => l.trimStart().startsWith(`${field}:`));
      ok(line, `checkpoint agents/openai.yaml must define ${field}`);
      ok(
        /post-compact|after compact/.test(line),
        `checkpoint agents/openai.yaml ${field} must carry the post-compact scope — Codex renders this metadata directly, and a per-file check would let one of the two fields revert unnoticed`,
      );
    }

    // Positive counterpart: a guard that only forbids phrases would also pass
    // if every corrected statement were deleted outright.
    strictEqual(
      compactStatements,
      CHECKPOINT_SURFACES.length,
      `every checkpoint surface must positively state the post-compact scope (${compactStatements}/${CHECKPOINT_SURFACES.length} do) — deleting the corrected wording must fail, not pass`,
    );
  });

  it('decide is exempt from §2 wiring because it already resolves the registry natively (Phase 0.5)', async () => {
    // The exemption must be a REAL native resolution, not a missing wire — so
    // assert decide still resolves the registry. If a future change drops
    // decide's Phase 0.5 resolve, this fails and forces re-evaluating the
    // exemption rather than leaving decide silently lens-less.
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/decide.md'), 'utf8');
    ok(
      /decide-registry\.mjs"\s+resolve/.test(text),
      'commands/decide.md must still resolve the registry (Phase 0.5) — decide is the §2 exemption baseline (ADR-0029 §2)',
    );
    ok(
      !text.includes(SECTION_HEADING),
      'commands/decide.md should NOT carry the cross-verb §2 pointer section — decide resolves the registry natively (ADR-0029 §2 exemption)',
    );
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
      ok(
        entry.command.startsWith('/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh"'),
        `${event} command does not route through the Node resolver wrapper: ${entry.command}`,
      );
    }
    strictEqual(json.hooks.SessionStart[0].matcher, 'compact');
  });

  it('README.md documents Codex hook fallback scope', async () => {
    const path = resolve(PLUGIN_ROOT, 'adapters/codex/hooks/README.md');
    ok(await exists(path), 'adapters/codex/hooks/README.md missing');
    const text = await readFile(path, 'utf-8');
    ok(/\[features\]\.hooks/.test(text), 'README documents the generic Codex [features].hooks gate (ADR-0030)');
    // The hub README legitimately retains the legacy plugin_hooks=true literal,
    // but ONLY qualified as legacy-only — guard that the removal/legacy framing
    // sits in the README so a future edit cannot reintroduce it as the current
    // gate (Codex Phase 5 review MINOR — guard was previously too loose).
    ok(/plugin_hooks\s*=\s*true/.test(text), 'README retains the legacy plugin_hooks note (stage-aware hub)');
    ok(/removed in Codex/i.test(text) && /legacy Codex/i.test(text),
      'README qualifies plugin_hooks=true as legacy-only (removed on current Codex), not the current gate');
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

// =====================
// ADR-0027 §3.5 — extension-marker validation for skills/decide/SKILL.md
// =====================
//
// Structural checks (every marker pair present, paired, non-nested,
// canonical id, exact wording) + content-sanity checks (first non-empty
// line inside each pair matches the §3.5 sentinel regex).

// Marker order in SKILL.md document order — PR4 adds the new fifth pair
// `weighting-sensitivity-output` between `comparison-table` and
// `recommendation-rule` per ADR-0027 §3.4 disjoint-region contract.
// The order is enforced by the dedicated test below (peer G8).
const DECIDE_MARKER_IDS = [
  'axis-table',
  'per-option-output',
  'comparison-table',
  'weighting-sensitivity-output',
  'recommendation-rule',
];

// First-non-empty-line sentinel regex per ADR-0027 §3.5 table. These
// patterns are conservative (anchored) — they catch "marker pair
// exists but wraps the wrong content" without over-fitting to
// byte-exact wording (peer P-14).
const DECIDE_MARKER_SENTINELS = {
  'axis-table':         /^\| # \| Perspective \| Core question \|/,
  'per-option-output':  /^#### REQUIRED output format — for each option:/,
  'comparison-table':   /^#### REQUIRED output format — after all options:/,
  'weighting-sensitivity-output': /^#### REQUIRED output format — weighting/,
  'recommendation-rule': /^When /,
};

const MARKER_LINE_RE = /^<!-- @decide:([a-z][a-z0-9-]*):(begin|end) -->$/;

describe('plugins/engineer — decide skill extension markers (ADR-0027 §3.5)', () => {
  it('all marker pairs are present, paired, non-nested, with canonical wording', async () => {
    const skillPath = resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const lines = text.split('\n');

    const stack = [];            // open begin markers, FIFO-as-stack
    const pairs = {};            // id -> { beginLine, endLine }
    const seenBegin = new Set();
    const seenEnd = new Set();

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_LINE_RE);
      if (!m) continue;
      const id = m[1];
      const side = m[2];
      strictEqual(
        DECIDE_MARKER_IDS.includes(id),
        true,
        `${skillPath}:${i + 1}: marker id "${id}" is not in the canonical set ${DECIDE_MARKER_IDS.join(', ')}`,
      );
      if (side === 'begin') {
        ok(!seenBegin.has(id), `${skillPath}:${i + 1}: duplicate :begin for "${id}"`);
        ok(stack.length === 0, `${skillPath}:${i + 1}: nested marker (open: ${stack.map((s) => s.id).join(',')}); markers must not nest`);
        stack.push({ id, line: i + 1 });
        seenBegin.add(id);
      } else {
        ok(stack.length > 0, `${skillPath}:${i + 1}: :end for "${id}" with no preceding :begin`);
        const top = stack.pop();
        strictEqual(top.id, id, `${skillPath}:${i + 1}: :end mismatch — expected "${top.id}" got "${id}"`);
        pairs[id] = { beginLine: top.line, endLine: i + 1 };
        seenEnd.add(id);
      }
    }
    strictEqual(stack.length, 0, `${skillPath}: unclosed marker(s): ${stack.map((s) => s.id).join(', ')}`);

    for (const id of DECIDE_MARKER_IDS) {
      ok(seenBegin.has(id), `${skillPath}: missing :begin marker for "${id}"`);
      ok(seenEnd.has(id), `${skillPath}: missing :end marker for "${id}"`);
    }
  });

  it('marker ORDER assertion (peer G8): pairs appear in DECIDE_MARKER_IDS document order', async () => {
    // Per ADR-0027 §3.4 disjoint-region contract: PR4 inserts the new
    // weighting-sensitivity-output region AFTER comparison-table:end and
    // BEFORE recommendation-rule:begin. Order drift (e.g., a future edit
    // that moves the new region above comparison-table) would silently
    // break the "weighted aggregate appended AFTER all axis rows" guarantee
    // documented in the new region's prose. This test pins the canonical
    // order so any reordering becomes a CI failure.
    const skillPath = resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const lines = text.split('\n');

    const beginLineById = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_LINE_RE);
      if (!m || m[2] !== 'begin') continue;
      beginLineById.set(m[1], i + 1);
    }

    // Build the (id, beginLine) sequence in the order they appear in
    // the file, then assert it matches DECIDE_MARKER_IDS canonical order.
    const observedOrder = [...beginLineById.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);

    for (let k = 0; k < DECIDE_MARKER_IDS.length; k++) {
      strictEqual(
        observedOrder[k],
        DECIDE_MARKER_IDS[k],
        `${skillPath}: marker position ${k} expected "${DECIDE_MARKER_IDS[k]}" but found "${observedOrder[k]}"\n  observed full order: ${observedOrder.join(' → ')}\n  expected canonical:  ${DECIDE_MARKER_IDS.join(' → ')}`,
      );
    }
  });

  it('content-sanity: first non-empty line inside each marker matches the §3.5 sentinel', async () => {
    const skillPath = resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const lines = text.split('\n');

    // Re-scan to find pair line ranges.
    const stack = [];
    const pairs = {};
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_LINE_RE);
      if (!m) continue;
      if (m[2] === 'begin') stack.push({ id: m[1], line: i + 1 });
      else {
        const top = stack.pop();
        pairs[m[1]] = { beginLine: top.line, endLine: i + 1 };
      }
    }

    for (const id of DECIDE_MARKER_IDS) {
      const range = pairs[id];
      ok(range, `${skillPath}: no pair found for "${id}"`);
      const sentinel = DECIDE_MARKER_SENTINELS[id];
      // Find first non-empty line strictly between begin and end.
      let found = false;
      for (let i = range.beginLine; i < range.endLine - 1; i++) {
        // beginLine is the begin-marker line (1-indexed); content is
        // lines[range.beginLine] (0-indexed line after the begin
        // marker). Iterate until just before lines[range.endLine - 1].
        const line = lines[i];
        if (line.trim() === '') continue;
        if (sentinel.test(line)) {
          found = true;
          break;
        }
        // First non-empty content line that did NOT match the sentinel.
        ok(false, `${skillPath}:${i + 1}: first non-empty line inside @decide:${id} marker pair does not match ADR-0027 §3.5 sentinel\n  expected: ${sentinel}\n  got: ${line}`);
      }
      ok(found, `${skillPath}: @decide:${id} pair contains no content matching the §3.5 sentinel ${sentinel}`);
    }
  });
});

// =====================
// ADR-0027 PR3 — size-aware ritual prose presence inside marked regions
// =====================
//
// Per peer Plan-verify gap #5 + Refine-verify follow-up: ritual depth is
// LLM-prose only with no programmatic test of "depth varies by size".
// Without this content-sanity lint, a future SKILL.md edit could silently
// strip the size-aware rendering rules inside any of the four marker
// regions. The check requires each marked region to mention the literal
// word `size` AND ALL THREE ritual tier names (`minor`, `standard`,
// `major`) — the "all three" gate beats a weaker "any one tier" rule
// where unrelated phrases like "size of this table is minor" could mask
// the actual ritual contract going missing.

describe('plugins/engineer — decide skill size-contract prose (ADR-0027 PR3 ritual sizing)', () => {
  it('each @decide:* marker region mentions `size` and all three ritual tier names', async () => {
    const skillPath = resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const lines = text.split('\n');

    // Re-scan to find pair line ranges (same shape as the §3.5 tests above).
    const stack = [];
    const pairs = {};
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_LINE_RE);
      if (!m) continue;
      if (m[2] === 'begin') stack.push({ id: m[1], line: i + 1 });
      else {
        const top = stack.pop();
        pairs[m[1]] = { beginLine: top.line, endLine: i + 1 };
      }
    }

    // Tightened per critique peer review: require BOTH the `size` surface
    // term AND all three tier names (minor, standard, major) per region.
    // The original "size + any one tier" check could pass on unrelated
    // phrases like "size of this table is minor"; requiring all three
    // tiers makes the lint a meaningful drift detector against future
    // SKILL.md edits that silently drop the size-aware ritual rules.
    const SIZE_RE = /\bsize\b/i;
    const REQUIRED_TIERS = ['minor', 'standard', 'major'];

    for (const id of DECIDE_MARKER_IDS) {
      const range = pairs[id];
      ok(range, `${skillPath}: no pair found for "${id}"`);
      // Body is everything strictly between the begin and end marker
      // (exclusive of marker lines themselves).
      const body = lines.slice(range.beginLine, range.endLine - 1).join('\n');
      ok(
        SIZE_RE.test(body),
        `${skillPath}: @decide:${id} marker region must mention "size" so the ADR-0027 PR3 ritual contract remains visible to LLM readers (peer gap #5).`,
      );
      const missingTiers = REQUIRED_TIERS.filter(
        (t) => !new RegExp(`\\b${t}\\b`, 'i').test(body),
      );
      ok(
        missingTiers.length === 0,
        `${skillPath}: @decide:${id} marker region must mention all three ritual tiers (minor|standard|major) so size-aware rendering does not silently regress (peer gap #5). Missing: ${missingTiers.join(', ')}.`,
      );
    }
  });

  it('PR4 refine M5: SKILL.md @decide:weighting-sensitivity-output region pins backward-compat + §1.3 advisory invariants in prose', async () => {
    // Peer M5: the PR4 output invariants (default invocation MUST NOT
    // emit weighting/sensitivity output; §1.3 winner stability under
    // advisory cases) are LLM-prose contract only — subprocess tests
    // can't observe LLM markdown rendering. To keep the prose from
    // silently drifting, lint the region body for the load-bearing
    // invariant phrases.
    const skillPath = resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const lines = text.split('\n');

    // Locate the weighting-sensitivity-output region body.
    let beginLine = -1, endLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '<!-- @decide:weighting-sensitivity-output:begin -->') beginLine = i + 1;
      else if (lines[i] === '<!-- @decide:weighting-sensitivity-output:end -->') { endLine = i + 1; break; }
    }
    ok(beginLine > 0 && endLine > beginLine, 'weighting-sensitivity-output marker pair must exist (covered by ORDER assertion above; redundant safety)');
    const body = lines.slice(beginLine, endLine - 1).join('\n');

    // Invariant 1 — backward-compat: default invocation must NOT emit
    // the region. Phrase pinned: "byte-identical to the pre-PR4 baseline"
    // OR "backward-compat invariant" OR "stay prose-only".
    ok(
      /byte.identical|backward.compat|prose.only/i.test(body),
      `${skillPath}: @decide:weighting-sensitivity-output region must pin the backward-compat invariant in prose (one of: "byte-identical to the pre-PR4 baseline" / "backward-compat invariant" / "stays prose-only")`,
    );

    // Invariant 2 — advisory-only: the region must explicitly say the
    // weighted aggregate is advisory, NOT the recommendation winner.
    ok(
      /advisory[\s-]+only|advisory information/i.test(body),
      `${skillPath}: @decide:weighting-sensitivity-output region must pin the "advisory only" invariant in prose`,
    );

    // Invariant 3 — §1.3 winner stability: prose must reference the
    // decisive-axis rule as the winner-picker and explicitly state the
    // recommendation does not flip on aggregate/sensitivity advisory.
    ok(
      /§1\.3|decisive[\s-]+axis/i.test(body),
      `${skillPath}: @decide:weighting-sensitivity-output region must reference §1.3 decisive-axis rule as the winner-picker`,
    );
    ok(
      /does NOT flip|sole winner-picker|recommendation .*stays|stays bound to/i.test(body),
      `${skillPath}: @decide:weighting-sensitivity-output region must pin "recommendation does not flip on advisory" invariant`,
    );

    // Invariant 4 — opt-in gate observable signals: prose must reference
    // the on-wire JSON context fields (snake_case) not just JS-API names.
    ok(
      /context\.weights_explicit|weights_explicit/.test(body),
      `${skillPath}: @decide:weighting-sensitivity-output region must reference the snake_case "weights_explicit" on-wire field (peer M1 refine)`,
    );
  });

  it('compact preset shipped (ADR-0027 PR3 §1.2) and decision-axes.yml has 3 presets', async () => {
    const yamlPath = resolve(PLUGIN_ROOT, 'skills/decide/references/decision-axes.yml');
    const text = await readFile(yamlPath, 'utf8');
    // Coarse YAML-shape check (the registry reader tests cover the parsed
    // semantics; this lint just guards against the YAML being accidentally
    // truncated / unshipped).
    ok(/^\s*compact:\s*$/m.test(text), `${yamlPath}: missing top-level "compact:" preset key`);
    ok(/^\s*default:\s*$/m.test(text), `${yamlPath}: missing top-level "default:" preset key`);
    ok(/^\s*nine-axis:\s*$/m.test(text), `${yamlPath}: missing top-level "nine-axis:" preset key`);
    ok(
      /entry-routing-guarantee/.test(text),
      `${yamlPath}: compact preset must include the entry-routing-guarantee axis (ADR-0027 §1.2)`,
    );
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

// ADR-0031 — the session-level continue-vs-fresh preflight is wired into the
// Claude commands; the Codex skills (SKILL.md) must mirror it or `$engineer:*`
// on Codex silently skips the preflight (the capability-① asymmetry). This
// guards against a future command-only edit that re-opens the gap.
//
// Parity is checked on the load-bearing `session-handoff.md` reference plus the
// `continue-vs-fresh` phrasing — NOT a bare `ADR-0031` mention, which also
// appears in the detached-HEAD guard (not a firing point). `start` must surface
// it at BOTH firing points (Phase 0 entry + Phase 7 completion), so losing
// either one while keeping the other still fails.
describe('plugins/engineer — ADR-0031 session-handoff preflight Claude/Codex parity', () => {
  const refsToHandoff = (text) => (text.match(/session-handoff\.md/g) || []).length;
  const surfacesPreflight = (text) => /session-handoff\.md/.test(text) && /continue-vs-fresh/.test(text);

  it('every verb whose command surfaces the preflight has it mirrored in the skill', async () => {
    for (const verb of VERBS) {
      const command = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const skill = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      if (surfacesPreflight(command)) {
        ok(
          surfacesPreflight(skill),
          `commands/${verb}.md surfaces the ADR-0031 preflight but skills/${verb}/SKILL.md does not mirror it (Codex asymmetry)`,
        );
      }
    }
  });

  it('the start macro surfaces the preflight at BOTH firing points (Phase 0 + Phase 7) in command and skill', async () => {
    for (const rel of ['commands/start.md', 'skills/start/SKILL.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(surfacesPreflight(text), `${rel} lacks the ADR-0031 session-handoff preflight`);
      const refs = refsToHandoff(text);
      ok(
        refs >= 2,
        `${rel} should surface the preflight at 2 firing points (Phase 0 entry + Phase 7 completion); found ${refs} session-handoff.md reference(s)`,
      );
    }
  });
});
