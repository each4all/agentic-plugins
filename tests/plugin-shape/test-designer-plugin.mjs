// plugins/designer plugin-shape conformance test (ADR-0042).
//
// Boundary history (this test EVOLVES with the implementation ladder,
// following the plugins/founder precedent — see test-founder-plugin.mjs):
//   - PR1 shipped the fully-INERT atomic scaffold: dual host manifests +
//     README + CHANGELOG + both marketplace catalog entries + release-please
//     wiring + package.json test-suite wiring. Every functional directory was
//     ABSENT, and the manifests + README carry the `incubating scaffold`
//     marker.
//   - PR2 landed the copy-and-trim WORKFLOW-CONTINUITY machinery (scripts/ +
//     hooks/ + adapters/), exposing the Codex manifest hooks key. Designer
//     mirrors founder's NON-DISPATCH shape (ADR-0042 Non-Goal 2). commands/ +
//     skills/ stayed forbidden.
//   - PR3 lands the first two verb surfaces — investigate
//     (the design-brief profile) and frame — so commands/ + skills/ become
//     REQUIRED (with investigate/frame entries) rather than forbidden, and the
//     Codex manifest gains the skills + interface keys. It ships the named
//     design-brief contract artifacts (design-brief-spec.md,
//     design-brief-ensemble.md, output-file-rules.md) and the SD4 privacy gate
//     (privacy-gate sentinel in the spec + the investigate/frame prompt-guard
//     surfaces + the ensemble surface; screenshots sensitive-by-default). The
//     shared _shared/references/orchestration.md Design Task Profile is
//     deliberately DEFERRED to PR6 (the SKILLs carry a self-contained inline
//     Design Task Profile at PR3), so this revision asserts it ABSENT. The
//     decide engine (decide-registry.mjs + scripts/lib/*) was deferred to PR4.
//   - PR4 lands decide + compose + the decide engine
//     (decide-registry.mjs + scripts/lib/* + skills/decide/references/decision-axes.yml
//     — the 7-axis SD3 registry: usability the common decisive axis,
//     accessibility the single veto gate).
//   - PR5A (this revision) lands critique — the four active quality lenses
//     (usability / accessibility / conversion / consistency, mapped 1:1 onto the
//     SD3 axis ids, `a11y` a profile-flag alias for the accessibility axis) + the
//     single internalized quality-criteria reference (Nielsen 10 + WCAG A/AA +
//     conversion + consistency) + host-direct vision (same-host; the peer path
//     stays code/text, no --image) + candidate-only a11y (Non-Goal 6) + the
//     privacy gate on the critique surface.
//   - PR5B lands refine (the bounded critique → refine → re-critique convergence
//     loop), completing the six-verb cognitive set.
//   - PR6 (this revision) lands the REMAINING persona surface: the
//     `designer:start` lifecycle macro, the checkpoint / resume / peer-now meta
//     skills, the two shared references the verb surfaces have been
//     forward-referencing since PR3 (_shared/references/orchestration.md — the
//     canonical Design Task Profile, bilingual EN/KO triggers, the L4 profile →
//     preset map, the image L2 artifact-handoff boundary — and
//     _shared/references/ensemble-protocol.md — the six design-anchored point
//     types), and the L4 design profiles wired into decide-registry's ADR-0027
//     §1.5(3) profile-override slot. The two ABSENCE guards from PR3/PR5A
//     therefore flip to PRESENCE here, and the DEFERRED "every L4 profile
//     resolves to a defined preset" shape test lands.
//   - PR7 (this revision) de-incubates. The real-topic dogfood ran the persona
//     end-to-end and flipped ADR-0042 to Accepted, so the incubating marker is
//     removed from the manifests + README + both catalogs and every PRESENCE
//     assertion flips to ABSENCE. The dogfood surfaced seven defects; the six
//     that are designer-local are fixed here and guarded below (the seventh, the
//     source-taxonomy gap, is recorded as a demand-gated ADR-0042 follow-up and
//     is guarded as an honest in-spec note rather than a silent workaround).
//
// Run via `node --test tests/plugin-shape/test-designer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/designer');

// ADR-0042 was Accepted at PR7 (the real-topic dogfood validated designer).
// The user-facing surfaces must now be FREE of this incubating marker — the
// assertions below are the de-incubation gate (founder precedent).
const INCUBATING_MARKER = /incubating scaffold/i;

// The PR3 privacy-gate textual sentinel (ADR-0042 SD4). The gate must be
// stated in the spec AND in the investigate/frame prompt-guard surfaces;
// this load-bearing invariant phrase guards against silent removal.
// Checked whitespace-normalized so markdown line-wrapping does not break
// the match.
const PRIVACY_SENTINEL =
  'pass an explicit privacy gate before BOTH web search AND peer-host dispatch';

// The SD4 "screenshots are sensitive by default" invariant — designer's
// vision-input material is treated as sensitive before any external send.
const SCREENSHOT_SENTINEL = 'screenshots are sensitive by default';

// The 5-tier design source taxonomy (ADR-0042 SD2/SD4) — the design/UX
// re-anchoring of the founder business tiers. lens ⇒ authority ladder.
const DESIGN_TIERS = [
  'standards-heuristics',
  'design-system',
  'competitor-reference',
  'user-research',
  'design-press',
];

const VERB_SKILLS = ['investigate', 'frame'];

// The complete designer surface as of PR6: six cognitive verbs + the start
// lifecycle macro + the three meta skills (ADR-0022 category, ADR-0042 SD7).
const ALL_VERB_SKILLS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const META_SKILLS = ['checkpoint', 'resume', 'peer-now'];
const PR6_SKILLS = ['start', ...META_SKILLS];

// ADR-0042 SD6 — the L4 archetype → SD3 decision-preset map. Duplicated here on
// purpose: the test declares the CONTRACT and decide-registry.mjs must match it,
// so a silent edit to the map's single source of truth fails loudly.
const EXPECTED_PROFILE_PRESET_MAP = {
  general: 'balanced',
  flow: 'balanced',
  ui: 'experience',
  cta: 'conversion',
  content: 'clarity',
};

// ADR-0042 SD5 — designer composes the image L2 capability and NEVER implements
// generation. Mirrors the plugins/image direct-OpenAI-API-ban sentinel
// (ADR-0037 Alternative 6): prose (.md/.yaml) legitimately *describes* the ban,
// so only code/shell files are scanned for actual call forms.
const DIRECT_API_FORMS = [
  /\bimages\s*\.\s*(generate|edit|createVariation)\s*\(/,
  /api\.openai\.com/,
  /\bnew\s+OpenAI\b/,
  /\bOPENAI_API_KEY\b/,
  /from\s+['"]openai['"]/,
  /require\(\s*['"]openai['"]\s*\)/,
];

// Shell READS of the parent-linkage env (prose mentions in backticks stay legal).
const PARENT_LINKAGE_READS = [
  /\$\{?AGENTIC_PARENT_WORKFLOW/,
  /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
];

// Stale vocabulary from the copy-trim sources (founder business axes + engineer
// software-quality axis ids). Neither may survive into a designer surface.
const STALE_VOCABULARY = [
  /business_brief/i, /FOUNDER_OUTPUT_ROOT/, /\bventure\b/i, /\bjurisdiction\b/i,
  /unit-economics/i, /market-attractiveness/i, /시장성/, /단위경제/,
  /\bessence\b/i, /\bfoundation\b/i, /practical-fit/i, /\bmaturation\b/i, /canonical-precedent/i,
];

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
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

// Extract the single-quoted trigger phrases from a skill's frontmatter.
// Naive /'([^']*)'/g mispairs on prose apostrophes ("the persona's verb"), so an
// opening quote must follow a word boundary opener and the closing quote must be
// followed by punctuation or whitespace — the shape a quoted phrase actually has.
function quotedTriggerPhrases(frontmatterText) {
  return [...frontmatterText.matchAll(/(?:^|[\s(])'([^']{1,80})'(?=[,.;:)\s]|$)/gm)].map((m) => m[1]);
}

describe('plugins/designer — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'designer');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('no longer carries the incubating marker (ADR-0042 Accepted at PR7)', async () => {
    const json = await readJSON(path);
    ok(!INCUBATING_MARKER.test(json.description),
      'Claude manifest description must drop the incubating marker now that ADR-0042 is Accepted');
  });

  it('carries publishing metadata consistent with sibling plugins', async () => {
    const json = await readJSON(path);
    strictEqual(json.license, 'MIT');
    strictEqual(json.author?.name, 'each4all');
    strictEqual(typeof json.homepage, 'string');
    strictEqual(typeof json.repository, 'string');
    ok(Array.isArray(json.keywords) && json.keywords.length > 0);
  });
});

describe('plugins/designer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON with required scalar fields matching the Claude manifest', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'designer');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(typeof json.description, 'string');
    ok(!INCUBATING_MARKER.test(json.description),
      'Codex manifest description must drop the incubating marker now that ADR-0042 is Accepted');
  });

  it('declares hooks AND the skills/interface keys (PR3 boundary — verb surfaces landed)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json',
      'PR2 machinery hooks remain exposed in the Codex manifest');
    strictEqual(json.skills, './skills/',
      'PR3 lands the first SKILL.md surfaces — the Codex manifest must expose the skills path');
    ok(json.interface && typeof json.interface === 'object',
      'PR3 lands a verb surface — the Codex manifest must carry an interface block');
    strictEqual(json.interface.displayName, 'Designer');
    strictEqual(json.interface.category, 'Development',
      'the Codex interface category must match the designer marketplace category (Development)');
    ok(Array.isArray(json.interface.defaultPrompt) && json.interface.defaultPrompt.length > 0,
      'the Codex interface must carry a non-empty defaultPrompt list');
    // PR5A ships investigate + frame + decide + compose + critique — the
    // defaultPrompt examples must not advertise a verb that has not landed yet.
    const prompts = json.interface.defaultPrompt.join('\n');
    ok(/\$designer:investigate/.test(prompts), 'defaultPrompt must show a $designer:investigate example');
    ok(/\$designer:frame/.test(prompts), 'defaultPrompt must show a $designer:frame example');
    ok(/\$designer:decide/.test(prompts), 'defaultPrompt must show a $designer:decide example (PR4)');
    ok(/\$designer:compose/.test(prompts), 'defaultPrompt must show a $designer:compose example (PR4)');
    ok(/\$designer:critique/.test(prompts), 'defaultPrompt must show a $designer:critique example (PR5A)');
    ok(/\$designer:refine/.test(prompts), 'defaultPrompt must show a $designer:refine example (PR5B)');
    ok(/\$designer:start/.test(prompts), 'defaultPrompt must show a $designer:start example (PR6 lifecycle macro)');
    // The meta skills are workflow-continuity operations, not entry points the
    // interface should advertise as a first prompt (founder PR6 precedent).
    for (const meta of META_SKILLS) {
      ok(!new RegExp(`\\$designer:${meta}\\b`).test(prompts),
        `defaultPrompt must not advertise $designer:${meta} — meta skills are not entry-point prompts`);
    }
  });
});

describe('plugins/designer — PR2 machinery boundary (copy-trim continuity + hooks, non-dispatch)', () => {
  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/discover-runtime.mjs',
    'hooks/hooks.json',
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/hooks.json',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
    'adapters/codex/hooks/_shared.mjs',
    'adapters/codex/hooks/run-node-hook.sh',
    'adapters/codex/hooks/README.md',
  ];

  // Every machinery script the seven-file copy-trim lands, used by the
  // non-dispatch scans below so the guard cannot pass vacuously on a
  // hand-picked subset (Codex Plan-verify §Edge-cases).
  const ALL_SCRIPTS = [
    'scripts/state.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/discover-runtime.mjs',
  ];
  const ALL_HOOK_SCRIPTS = [
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/_shared.mjs',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
  ];

  for (const rel of REQUIRED_MACHINERY) {
    it(`ships ${rel} (PR2 machinery copy-trim)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the PR2 machinery copy-trim and must exist`);
    });
  }

  it('hook entrypoints carry the executable bit', async () => {
    const HOOK_EXECUTABLES = [
      'adapters/claude/hooks/session-start.mjs',
      'adapters/claude/hooks/pre-compact.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/session-start.mjs',
      'adapters/codex/hooks/pre-compact.mjs',
      'adapters/codex/hooks/stop.mjs',
      'adapters/codex/hooks/run-node-hook.sh',
    ];
    for (const rel of HOOK_EXECUTABLES) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.mode & 0o100, `${rel} must be executable (owner x bit)`);
    }
  });

  it('the seven machinery scripts carry the executable bit', async () => {
    for (const rel of ALL_SCRIPTS) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.mode & 0o100, `${rel} must be executable (owner x bit)`);
    }
  });

  it('the Claude hooks.json wires the three events with no cross-persona path leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    const s = JSON.stringify(manifest);
    ok(!s.includes('engineer'), 'no engineer path may leak into the designer Claude hooks.json');
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Claude hooks.json (rebrand completeness)');
  });

  it('the Codex hooks.json wires the three events through run-node-hook.sh + ${PLUGIN_ROOT}, no cross-persona/host leakage', async () => {
    const manifest = await readJSON(resolve(PLUGIN_ROOT, 'adapters/codex/hooks/hooks.json'));
    deepStrictEqual(Object.keys(manifest.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop']);
    for (const event of ['SessionStart', 'PreCompact', 'Stop']) {
      for (const entry of manifest.hooks[event]) {
        for (const h of entry.hooks) {
          ok(h.command.includes('adapters/codex/hooks/run-node-hook.sh'),
            `Codex ${event} hook must dispatch through run-node-hook.sh`);
          ok(h.command.includes('${PLUGIN_ROOT}'),
            `Codex ${event} hook must resolve paths under \${PLUGIN_ROOT}`);
          ok(!h.command.includes('CLAUDE_PLUGIN_ROOT'),
            `Codex ${event} hook must not reference \${CLAUDE_PLUGIN_ROOT}`);
          ok(!/adapters\/claude/.test(h.command),
            `Codex ${event} hook must not reference the Claude adapter tree`);
        }
      }
    }
    const s = JSON.stringify(manifest);
    ok(!s.includes('engineer'), 'no engineer path may leak into the designer Codex hooks.json');
    ok(!/founder/i.test(s), 'no founder path may leak into the designer Codex hooks.json (rebrand completeness)');
  });

  it('the Codex hook source files never import from the Claude adapter tree', async () => {
    const CODEX_HOOK_SOURCES = [
      'adapters/codex/hooks/_shared.mjs',
      'adapters/codex/hooks/session-start.mjs',
      'adapters/codex/hooks/pre-compact.mjs',
      'adapters/codex/hooks/stop.mjs',
    ];
    for (const rel of CODEX_HOOK_SOURCES) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/(?:import|require)\b[^\n]*adapters\/claude/.test(text),
        `${rel} must not import from adapters/claude (Codex adapter must be self-contained)`);
      ok(!/(?:import|from)\s+['"][^'"]*\/claude\/hooks\//.test(text),
        `${rel} must not reach into the Claude hooks tree`);
    }
  });

  // ADR-0042 Non-Goal 2 — designer is NOT an orchestrator dispatch target.
  it('guards the non-dispatch contract: machinery never imports/invokes parent-writeback (ADR-0042 Non-Goal 2)', async () => {
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/(?:import|from|require)\b[^\n]*parent-writeback/.test(text),
        `${rel} must not import parent-writeback machinery (any relative path)`);
      ok(!/writebackParent\s*\(/.test(text),
        `${rel} must not invoke writebackParent`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/designer must not ship a parent-writeback module at all (non-dispatch)');
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/phase7-commit.mjs')), false,
      'plugins/designer must not ship a phase7-commit driver (non-dispatch — no dispatch-linked auto-commit)');
  });

  it('the machinery performs no parent-linkage env read (shell or process.env — ADR-0042 Non-Goal 2)', async () => {
    const FORBIDDEN_READS = [
      /\$\{?AGENTIC_PARENT_WORKFLOW/,
      /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
      /process\.env\.AGENTIC_PARENT_WORKFLOW/,
      /process\.env\.AGENTIC_ORIGINATING_SUBTASK/,
    ];
    for (const rel of [...ALL_SCRIPTS, ...ALL_HOOK_SCRIPTS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of FORBIDDEN_READS) {
        ok(!re.test(text),
          `${rel} must not read ${re} — designer is not an orchestrator dispatch target (ADR-0042 Non-Goal 2)`);
      }
    }
  });

  it('the verb commands carry no parent-linkage env reads (ADR-0042 Non-Goal 2)', async () => {
    // Guard against actual shell reads ($VAR / ${VAR}), not prose mentions:
    // the commands legitimately DOCUMENT that they do NOT read these vars
    // (backtick-quoted plain names), which must remain allowed.
    const READ_FORMS = [
      /\$\{?AGENTIC_PARENT_WORKFLOW/,
      /\$\{?AGENTIC_ORIGINATING_SUBTASK/,
    ];
    for (const verb of VERB_SKILLS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      for (const form of READ_FORMS) {
        ok(!form.test(text),
          `commands/${verb}.md must not shell-read ${form} — designer is not an orchestrator dispatch target (ADR-0042 Non-Goal 2)`);
      }
    }
  });

  // (The PR3-era "decide engine absent" guard was removed at PR4 — the engine
  // now ships; its presence + registry invariants are asserted in the
  // "PR4 decide + compose verb surfaces + decide engine" describe block below.)
});

describe('plugins/designer — PR3 verb surfaces (investigate + frame + design-brief contract)', () => {
  const REQUIRED_SURFACES = [
    'commands/investigate.md',
    'commands/frame.md',
    'skills/investigate/SKILL.md',
    'skills/investigate/agents/openai.yaml',
    'skills/investigate/references/design-brief-spec.md',
    'skills/investigate/references/design-brief-ensemble.md',
    'skills/investigate/references/output-file-rules.md',
    'skills/frame/SKILL.md',
    'skills/frame/agents/openai.yaml',
  ];

  for (const rel of REQUIRED_SURFACES) {
    it(`ships ${rel} (PR3 verb surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the ADR-0042 PR3 verb surface and must exist`);
    });
  }

  // The shared Design Task Profile / Dynamic Orchestration reference was
  // DEFERRED to PR6 (PR3 SKILLs carried a self-contained inline Design Task
  // Profile). PR6 landed it — its content is asserted in the PR6 suite below,
  // and here we only confirm the PR3 forward-reference now resolves.
  it('the PR3 forward-reference to _shared/references/orchestration.md now resolves (landed at PR6)', async () => {
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md')), true,
      'the shared orchestration.md landed at PR6 — the PR3 verb SKILLs forward-reference it');
    for (const rel of ['skills/investigate/SKILL.md', 'skills/frame/SKILL.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /_shared\/references\/orchestration\.md/,
        `${rel} must reference the shared Design Task Profile / orchestration reference`);
    }
  });

  for (const verb of VERB_SKILLS) {
    it(`skills/${verb}/SKILL.md frontmatter name = ${verb} (folder ↔ frontmatter consistency)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${verb}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm),
        `skills/${verb}/SKILL.md frontmatter name != "${verb}"`);
      match(fm, /description:/, `skills/${verb}/SKILL.md frontmatter must carry a description`);
    });

    it(`skills/${verb}/agents/openai.yaml display_name names the verb + persona`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `skills/${verb}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(verb),
        `openai.yaml display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('designer'),
        `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
    });

    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${verb}.md frontmatter must carry a non-empty description`);
    });
  }
});

describe('plugins/designer — design-brief spec contract (PR3 / ADR-0042 SD2/SD4)', () => {
  const SPEC = 'skills/investigate/references/design-brief-spec.md';

  it('declares the 5-tier design source taxonomy', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    for (const tier of DESIGN_TIERS) {
      ok(text.includes(tier), `design-brief-spec.md must define the "${tier}" tier`);
    }
  });

  it('states the freshness/platform and paywalled/vendor-claim rules (design re-anchor of jurisdiction)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    match(text, /platform/i, 'spec must state platform-context tagging rules (the design re-anchor of jurisdiction)');
    match(text, /as-of/i, 'spec must state as-of freshness dating rules');
    match(text, /vendor-claim/i, 'spec must state vendor-claim citation treatment');
    match(text, /paywalled/i, 'spec must state paywalled-source citation treatment');
  });

  it('re-anchors the accessibility honesty boundary (candidate issues, not a conformance certificate — Non-Goal 6)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, SPEC), 'utf8');
    match(text, /accessibility/i, 'spec must address accessibility evidence');
    match(text, /conformance/i, 'spec must state the WCAG-conformance honesty boundary (cannot certify)');
  });

  it('the privacy-gate sentinel appears in the spec AND the investigate prompt-guard surfaces (ADR-0042 SD4)', async () => {
    const REQUIRED = [
      'skills/investigate/references/design-brief-spec.md',
      'commands/investigate.md',
      'skills/investigate/SKILL.md',
    ];
    for (const rel of REQUIRED) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
    }
  });

  it('the privacy-gate sentinel also reaches the ensemble dispatch + frame surfaces', async () => {
    const ALSO = [
      'skills/investigate/references/design-brief-ensemble.md',
      'commands/frame.md',
      'skills/frame/SKILL.md',
    ];
    for (const rel of ALSO) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} should carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
    }
  });

  it('the "screenshots sensitive-by-default" invariant reaches every privacy surface (SD4 item 4)', async () => {
    const SURFACES = [
      'skills/investigate/references/design-brief-spec.md',
      'commands/investigate.md',
      'skills/investigate/SKILL.md',
      'skills/investigate/references/design-brief-ensemble.md',
      'commands/frame.md',
      'skills/frame/SKILL.md',
    ];
    for (const rel of SURFACES) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8')).toLowerCase();
      ok(text.includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" invariant (ADR-0042 SD4)`);
    }
  });

  it('the reference-scan ensemble states the code/text-only vision boundary (no --image to the peer, SD4 item 3)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/references/design-brief-ensemble.md'), 'utf8');
    match(text, /--image/, 'ensemble must state that the peer path has no --image flag');
    match(text, /same-host/i, 'ensemble must state that vision critique is a same-host capability');
  });

  it('the investigate skill names the two evidence streams — external references AND the frontend code read (SD2)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/SKILL.md'), 'utf8');
    match(text, /frontend code/i, 'investigate SKILL must state it reads the existing frontend code (ADR-0042 SD2)');
  });

  it('the frame skill fixes MEASURABLE UX success metrics (SD4 item 1 pre-code quality)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/frame/SKILL.md'), 'utf8');
    match(text, /measurable/i, 'frame SKILL must require measurable UX success metrics');
    match(text, /success metric/i, 'frame SKILL must structure UX success metrics');
  });

  // --- Codex Plan-verify (PR3) remediation guards ---

  it('separates user-research from the web-searched tiers (local-only supplied stream, NOT WebSearch)', async () => {
    // Codex Plan-verify GAP: user-research must not be lumped into
    // "Use WebSearch + WebFetch" across all five tiers — it is a local-only,
    // supplied, no-URL stream (design-brief-spec § User-research citation shape).
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/SKILL.md'), 'utf8');
    match(text, /four URL-bearing tiers/i,
      'investigate SKILL must scope WebSearch to the four URL-bearing tiers, excluding user-research');
    match(text, /never web-searched|not web-searched/i,
      'investigate SKILL must state user-research is a local-only supplied stream, never web-searched');
  });

  it('resolves the user-research authority-vs-relevance conflict (observed-behavior override)', async () => {
    // Codex Plan-verify CONFLICT: "highest-authority first" put user-research
    // below competitor-reference while calling it highest-relevance — the spec
    // must state that user-research outranks competitor/press for an
    // observed-behavior claim, with accessibility as the sole veto.
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/references/design-brief-spec.md'), 'utf8');
    match(text, /authority vs\.? relevance/i,
      'spec must distinguish external-authority from relevance for user-research');
    match(text, /observed-behavior/i,
      'spec must define the observed-behavior override (user-research outranks competitor/press for this product\'s users)');
  });

  it('bars the peer from emitting supplied aggregates as cited sources (context-only)', async () => {
    // Codex Plan-verify CONFLICT: the ensemble both allowed the peer to reason
    // from supplied aggregates and required every claim to carry a URL. The
    // fix: supplied aggregates are context-only; the peer cannot cite them.
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/references/design-brief-ensemble.md'), 'utf8');
    match(text, /context only/i,
      'ensemble citation_contract must mark supplied aggregates as context-only (the peer cannot cite them)');
  });

  it('the state.mjs create --profile boundary is correct: investigate forwards it, frame omits it', async () => {
    // Codex Plan-verify TEST-ISSUE + founder refine regression precedent.
    const inv = await readFile(resolve(PLUGIN_ROOT, 'commands/investigate.md'), 'utf8');
    const frame = await readFile(resolve(PLUGIN_ROOT, 'commands/frame.md'), 'utf8');
    ok(/state\.mjs create[\s\S]*?--profile\s+"\$\{?AGENTIC_PROFILE/.test(inv),
      'commands/investigate.md create path must forward --profile (it carries the design-brief profile)');
    ok(!/--profile\s+"\$\{?AGENTIC_PROFILE/.test(frame),
      'commands/frame.md must not pass --profile in any state.mjs path — frame is single-mode (founder refine precedent)');
  });

  it('the investigate/frame surfaces are de-incubated and name ADR-0042 as Accepted', async () => {
    // Through PR6 these surfaces disclaimed an incubating persona and pointed at
    // the PR7 dogfood as the Accepted-flip gate. The dogfood ran; the flip landed.
    // Both the marker and the forward reference are now false claims.
    for (const rel of [
      'skills/investigate/SKILL.md',
      'skills/frame/SKILL.md',
      'commands/investigate.md',
      'commands/frame.md',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/incubating/i.test(text), `${rel} must drop the incubating disclaimer`);
      match(text, /ADR-0042 is `Accepted`|ADR-0042 Accepted/,
        `${rel} must state that ADR-0042 is Accepted`);
    }
  });

  it('no stale founder/business vocabulary leaks into the live verb surfaces (contrast prose excepted)', async () => {
    // Codex Plan-verify RE-ANCHOR-ERROR: "venture" leaked into frame SKILL.
    // Guard the operational-vocabulary tokens that must never appear in the
    // designer surface (rebrand-miss tokens). Provenance/contrast prose that
    // names "the founder business-brief spec" is allowed; these are the
    // operational tokens a copy-trim miss would leave behind.
    const STALE = [/business_brief/i, /FOUNDER_OUTPUT_ROOT/, /\bventure\b/i, /\bjurisdiction\b/i, /unit-economics/i];
    for (const rel of [
      'skills/investigate/SKILL.md',
      'skills/frame/SKILL.md',
      'commands/investigate.md',
      'commands/frame.md',
      'skills/investigate/references/design-brief-spec.md',
      'skills/investigate/references/design-brief-ensemble.md',
      'skills/investigate/references/output-file-rules.md',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of STALE) {
        ok(!re.test(text), `${rel} carries stale business vocabulary ${re} (copy-trim rebrand miss)`);
      }
    }
  });
});

describe('plugins/designer — PR4 decide + compose verb surfaces + decide engine (ADR-0042 SD3)', () => {
  const REQUIRED_PR4_SURFACES = [
    'scripts/decide-registry.mjs',
    'scripts/lib/decide-args.mjs',
    'scripts/lib/decide-weights.mjs',
    'scripts/lib/decide-scores.mjs',
    'scripts/lib/decide-sensitivity.mjs',
    'scripts/lib/yaml-mini.mjs',
    'skills/decide/references/decision-axes.yml',
    'skills/decide/SKILL.md',
    'skills/decide/agents/openai.yaml',
    'commands/decide.md',
    'skills/compose/SKILL.md',
    'skills/compose/agents/openai.yaml',
    'commands/compose.md',
  ];
  const PR4_VERBS = ['decide', 'compose'];

  for (const rel of REQUIRED_PR4_SURFACES) {
    it(`ships ${rel} (PR4 decide engine / verb surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the ADR-0042 PR4 surface and must exist`);
    });
  }

  // The decision-axes registry lives under skills/decide/references/ — the
  // DEFAULT_PATH decide-registry.mjs resolves relative to scripts/ (../skills/…).
  it('the decision-axes registry lives under skills/decide/references/', async () => {
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/decide/references/decision-axes.yml')), true);
  });

  for (const verb of PR4_VERBS) {
    it(`skills/${verb}/SKILL.md frontmatter name = ${verb}`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${verb}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${verb}\\s*$`, 'm').test(fm),
        `skills/${verb}/SKILL.md frontmatter name != "${verb}"`);
      match(fm, /description:/, `skills/${verb}/SKILL.md frontmatter must carry a description`);
    });

    it(`skills/${verb}/agents/openai.yaml display_name names the verb + persona`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', verb, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `skills/${verb}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(verb), `openai.yaml display_name "${m[1]}" must name the verb "${verb}"`);
      ok(m[1].toLowerCase().includes('designer'), `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
    });

    it(`commands/${verb}.md carries a frontmatter description`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `commands/${verb}.md has no YAML frontmatter`);
      match(fm, /description:\s*\S/, `commands/${verb}.md frontmatter must carry a non-empty description`);
    });

    it(`commands/${verb}.md carries no parent-linkage env reads (ADR-0042 Non-Goal 2)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'commands', `${verb}.md`), 'utf8');
      for (const form of [/\$\{?AGENTIC_PARENT_WORKFLOW/, /\$\{?AGENTIC_ORIGINATING_SUBTASK/]) {
        ok(!form.test(text),
          `commands/${verb}.md must not shell-read ${form} — designer is non-dispatch (ADR-0042 Non-Goal 2)`);
      }
    });
  }

  it('the decide registry loads cleanly (no fallback) with the four design presets', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry, fallbackTriggered } = mod.loadRegistry({});
    strictEqual(fallbackTriggered, false, 'the real designer registry must load without fallback');
    deepStrictEqual(Object.keys(registry.presets).sort(), ['balanced', 'clarity', 'conversion', 'experience']);
  });

  it('7-axis balanced preset (SD3): usability common-decisive, accessibility the single veto gate, >=2 decisive, axis id "accessibility" NOT "a11y"', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry } = mod.loadRegistry({});
    strictEqual(registry.presets.balanced.axes.length, 7, 'balanced is the 7-axis matrix');
    for (const pid of Object.keys(registry.presets)) {
      const axes = registry.presets[pid].axes;
      const decisive = axes.filter((a) => a.role === 'decisive').map((a) => a.id);
      ok(decisive.length >= 2, `preset ${pid} must declare >= 2 decisive axes (${decisive.length})`);
      ok(decisive.includes('usability'), `preset ${pid} must carry usability as a decisive axis (common-decisive)`);
      const gates = axes.filter((a) => a.gate).map((a) => a.id);
      deepStrictEqual(gates, ['accessibility'], `preset ${pid} must have exactly one veto gate: accessibility`);
      const acc = axes.find((a) => a.id === 'accessibility');
      strictEqual(acc.role, 'supporting', 'accessibility is role:supporting + gate:true (portable-reader-compatible)');
      ok(!axes.some((a) => a.id === 'a11y'),
        `preset ${pid} must NOT define an "a11y" axis id — a11y is only a profile-flag alias mapped to the accessibility axis`);
    }
  });

  it('DEFAULT_FALLBACK mirrors the balanced preset (lockstep) — ENOENT resolves to balanced', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry } = mod.loadRegistry({});
    const shape = (axes) => axes.map((a) => ({ id: a.id, role: a.role, gate: a.gate }));
    const balanced = shape(registry.presets.balanced.axes);
    const fb = mod.resolvePreset({ path: '/nonexistent/decision-axes.yml' });
    strictEqual(fb.fallbackTriggered, true);
    strictEqual(fb.context.preset_id, 'balanced');
    deepStrictEqual(shape(fb.context.axes), balanced,
      'DEFAULT_FALLBACK must mirror the balanced preset — keep the two in lockstep');
  });

  // PR4 tested presets-defined + >=2-decisive only. The "every L4 profile
  // resolves to a defined preset" cross-check landed at PR6 (profiles exist
  // now) — see the PR6 suite below.
  it('every registry preset is a defined map with a description and a non-empty axis list', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry } = mod.loadRegistry({});
    for (const pid of Object.keys(registry.presets)) {
      const p = registry.presets[pid];
      strictEqual(typeof p.description, 'string');
      ok(p.description.length > 0, `preset ${pid} must carry a description`);
      ok(Array.isArray(p.axes) && p.axes.length > 0, `preset ${pid} must carry a non-empty axis list`);
    }
  });

  it('the SD4 privacy gate + screenshots-sensitive sentinels reach the decide + compose external-dispatch surfaces (Codex COVERAGE-2)', async () => {
    // decide dispatches a Brainstorm peer; compose dispatches a Plan-verify peer —
    // both are external transmission, so the SD4 privacy gate must reach them.
    for (const rel of ['skills/decide/SKILL.md', 'commands/decide.md', 'skills/compose/SKILL.md', 'commands/compose.md']) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
      ok(text.toLowerCase().includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" invariant (ADR-0042 SD4)`);
    }
  });

  it('the @decide:axis-table SKILL region renders the 7 balanced axes with accessibility as the gate (Codex COVERAGE-4)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md'), 'utf8');
    const m = skill.match(/<!-- @decide:axis-table:begin -->([\s\S]*?)<!-- @decide:axis-table:end -->/);
    ok(m, 'skills/decide/SKILL.md must contain the @decide:axis-table marker region');
    const region = m[1];
    for (const label of ['Usability', 'Consistency', 'Conversion', 'Desirability', 'Content-Clarity', 'Feasibility', 'Accessibility']) {
      ok(region.includes(label), `@decide:axis-table must render the "${label}" axis (SKILL <-> registry drift guard)`);
    }
    ok(/Accessibility[\s\S]*?gate/i.test(region), '@decide:axis-table must mark 접근성 Accessibility as the gate');
  });

  it('decide is single-mode (no --profile flag in any state command); compose forwards --profile in create AND append (Codex COVERAGE-3)', async () => {
    const decideCmd = await readFile(resolve(PLUGIN_ROOT, 'commands/decide.md'), 'utf8');
    const composeCmd = await readFile(resolve(PLUGIN_ROOT, 'commands/compose.md'), 'utf8');
    // decide: never passes a `--profile "<value>"` flag (the prose "no `--profile`
    // argument" is backtick-quoted documentation, not a shell flag, and is allowed).
    ok(!/--profile\s+"/.test(decideCmd),
      'commands/decide.md must not pass a --profile flag in any state.mjs call — decide is single-mode');
    // compose: --profile forwarded from AGENTIC_PROFILE in create AND carried in the append/resume path.
    ok(/--profile\s+"\$\{?AGENTIC_PROFILE/.test(composeCmd),
      'commands/compose.md must forward --profile from AGENTIC_PROFILE (create path, spec/flow/wireframe)');
    ok(/--profile\s+"<profile/.test(composeCmd),
      'commands/compose.md append/resume path must carry --profile (resume continuity)');
  });

  it('the decide/compose surfaces are de-incubated (ADR-0042 Accepted)', async () => {
    for (const rel of ['skills/decide/SKILL.md', 'skills/compose/SKILL.md', 'commands/decide.md', 'commands/compose.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/incubating/i.test(text), `${rel} must drop the incubating disclaimer`);
    }
  });

  it('no stale founder/business vocabulary leaks into the decide/compose surfaces (copy-trim rebrand)', async () => {
    const STALE = [
      // founder / business vocabulary
      /business_brief/i, /FOUNDER_OUTPUT_ROOT/, /\bventure\b/i, /\bjurisdiction\b/i, /unit-economics/i, /market-attractiveness/i, /시장성/, /단위경제/,
      // engineer decide-axis ids — must not leak into designer surfaces (Codex COVERAGE-1 / REBRAND-1)
      /\bessence\b/i, /\bfoundation\b/i, /practical-fit/i, /\bmaturation\b/i, /canonical-precedent/i,
    ];
    for (const rel of [
      'skills/decide/SKILL.md',
      'skills/compose/SKILL.md',
      'commands/decide.md',
      'commands/compose.md',
      'skills/decide/references/decision-axes.yml',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of STALE) {
        ok(!re.test(text), `${rel} carries stale business vocabulary ${re} (copy-trim rebrand miss)`);
      }
    }
  });

  it('package.json wires the designer decide unit suite into test:plugin-shape (PR4)', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    const suite = pkg.scripts['test:plugin-shape'];
    for (const t of [
      'tests/designer/test-decide-registry.mjs',
      'tests/designer/test-decide-args.mjs',
      'tests/designer/test-decide-weights.mjs',
      'tests/designer/test-decide-scores.mjs',
      'tests/designer/test-decide-sensitivity.mjs',
      'tests/designer/test-yaml-mini.mjs',
    ]) {
      ok(suite.includes(t), `test:plugin-shape must run ${t} (PR4 decide unit suite)`);
    }
  });
});

describe('plugins/designer — PR5A critique verb surface + quality lenses (ADR-0042 SD4)', () => {
  const REQUIRED_PR5A_SURFACES = [
    'commands/critique.md',
    'skills/critique/SKILL.md',
    'skills/critique/agents/openai.yaml',
    'skills/critique/references/quality-criteria.md',
  ];

  for (const rel of REQUIRED_PR5A_SURFACES) {
    it(`ships ${rel} (PR5A critique surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the ADR-0042 PR5A critique surface and must exist`);
    });
  }

  it('skills/critique/SKILL.md frontmatter name = critique', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'skills/critique/SKILL.md has no YAML frontmatter');
    ok(/^name:\s*critique\s*$/m.test(fm), 'skills/critique/SKILL.md frontmatter name != "critique"');
    match(fm, /description:/, 'skills/critique/SKILL.md frontmatter must carry a description');
  });

  it('skills/critique/agents/openai.yaml display_name names the verb + persona', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/agents/openai.yaml'), 'utf8');
    const m = text.match(/display_name:\s*"([^"]+)"/);
    ok(m, 'skills/critique/agents/openai.yaml must declare interface.display_name');
    ok(m[1].toLowerCase().includes('critique'), `openai.yaml display_name "${m[1]}" must name the verb "critique"`);
    ok(m[1].toLowerCase().includes('designer'), `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
  });

  it('commands/critique.md carries a frontmatter description', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/critique.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'commands/critique.md has no YAML frontmatter');
    match(fm, /description:\s*\S/, 'commands/critique.md frontmatter must carry a non-empty description');
  });

  it('commands/critique.md carries no parent-linkage env reads (ADR-0042 Non-Goal 2)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/critique.md'), 'utf8');
    for (const form of [/\$\{?AGENTIC_PARENT_WORKFLOW/, /\$\{?AGENTIC_ORIGINATING_SUBTASK/]) {
      ok(!form.test(text),
        `commands/critique.md must not shell-read ${form} — designer is non-dispatch (ADR-0042 Non-Goal 2)`);
    }
  });

  it('critique forwards --profile from AGENTIC_PROFILE (lens-bearing, create + append)', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/critique.md'), 'utf8');
    ok(/--profile\s+"\$\{?AGENTIC_PROFILE/.test(cmd),
      'commands/critique.md must forward --profile from AGENTIC_PROFILE (create path — critique is lens-bearing)');
    ok(/--profile\s+"<profile/.test(cmd),
      'commands/critique.md append/resume path must carry --profile (resume continuity)');
  });

  it('the @critique:lens-table maps the 4 active lenses 1:1 onto the SD3 axes (exactly, no extras), accessibility the gate, each row routed to a criteria section (SD4)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    const m = skill.match(/<!-- @critique:lens-table:begin -->([\s\S]*?)<!-- @critique:lens-table:end -->/);
    ok(m, 'skills/critique/SKILL.md must contain the @critique:lens-table marker region');
    const region = m[1];
    // Parse the data rows (markdown rows starting "| <n> |") and tie each lens
    // flag to the axis it evaluates + its criteria section. A substring check
    // would pass with an extra active lens, a mis-mapped row, or the criteria
    // file named only in the header (Codex Plan-verify MAJOR — 1:1 not enforced).
    const rows = region.split('\n').filter((l) => /^\s*\|\s*\d+\s*\|/.test(l));
    const EXPECT = [
      ['usability', 'usability', 'Usability'],
      ['a11y', 'accessibility', 'Accessibility'],
      ['conversion', 'conversion', 'Conversion'],
      ['consistency', 'consistency', 'Consistency'],
    ];
    strictEqual(rows.length, EXPECT.length,
      `@critique:lens-table must declare EXACTLY ${EXPECT.length} active lenses (no extras) — found ${rows.length}`);
    EXPECT.forEach(([flag, axis, section], i) => {
      ok(new RegExp('`' + flag + '`').test(rows[i]),
        `@critique:lens-table row ${i + 1} must carry the \`${flag}\` lens flag`);
      ok(new RegExp('\\b' + axis + '\\b').test(rows[i]),
        `@critique:lens-table row ${i + 1} (\`${flag}\`) must map 1:1 to the ${axis} axis`);
      ok(rows[i].includes(`§ ${section}`),
        `@critique:lens-table row ${i + 1} must route to the § ${section} criteria section (single criteria file)`);
    });
    // the a11y (accessibility) row is the veto gate; the other three are not.
    match(rows.find((r) => /`a11y`/.test(r)), /gate/i, 'the a11y (accessibility) lens row must be the veto gate');
    for (const nonGate of ['usability', 'conversion', 'consistency']) {
      ok(!/gate/i.test(rows.find((r) => new RegExp('`' + nonGate + '`').test(r))),
        `the ${nonGate} lens row must NOT be marked a gate (accessibility is the sole gate)`);
    }
    ok(region.includes('quality-criteria.md'),
      'the lens table header must name the single internalized criteria file (references/quality-criteria.md)');
  });

  it('critique lenses reuse the SD3 axis vocabulary 1:1 — inactive == registry axes minus the 4 active; a11y is the accessibility alias (SD4)', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry } = mod.loadRegistry({});
    const axisIds = new Set(Object.values(registry.presets).flatMap((p) => p.axes.map((a) => a.id)));
    const ACTIVE_AXES = ['usability', 'accessibility', 'conversion', 'consistency'];
    for (const lensAxis of ACTIVE_AXES) {
      ok(axisIds.has(lensAxis),
        `active critique lens "${lensAxis}" must be a decision-axes.yml axis id (one shared vocabulary, no orphan lens)`);
    }
    ok(!axisIds.has('a11y'), 'there is no a11y axis id — a11y is only a critique profile-flag alias');
    // The inactive lenses must be EXACTLY the SD3 axes minus the 4 active-lens
    // axes — a true 1:1 coverage guard, not a hand-picked list (Codex Plan-verify
    // MAJOR: substring checks did not tie the lens set to the registry).
    const inactiveExpected = [...axisIds].filter((a) => !ACTIVE_AXES.includes(a)).sort();
    deepStrictEqual(inactiveExpected, ['content-clarity', 'desirability', 'feasibility'],
      'the defined-but-inactive lenses must equal the 7 SD3 axes minus the 4 active-lens axes');
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    match(skill, /a11y[\s\S]{0,120}?(alias|accessibility)/i,
      'critique SKILL must document the a11y lens flag as an alias for the accessibility axis');
    for (const inactive of inactiveExpected) {
      ok(skill.includes(inactive), `critique SKILL must name the defined-but-inactive lens "${inactive}" (completes 1:1 axis coverage)`);
    }
    match(skill, /defined-but-inactive/i,
      'critique SKILL must mark desirability / content-clarity / feasibility as defined-but-inactive lenses');
  });

  it('the critique forward-reference to _shared/references/ensemble-protocol.md § Review now resolves (landed at PR6)', async () => {
    // Codex Plan-verify MINOR (PR5A) guarded the shared protocol's ABSENCE until
    // PR6. PR6 authored it, so the guard flips: the forward-reference must
    // resolve, and the § Review point it names must exist in the shipped file.
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md')), true,
      'the shared ensemble-protocol.md (design-anchored ensemble point types) landed at PR6');
    const protocol = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(protocol, /^### Review /m, 'ensemble-protocol.md must define the § Review point critique names');
    for (const rel of ['skills/critique/SKILL.md', 'commands/critique.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /ensemble-protocol\.md/, `${rel} must reference the shared ensemble protocol`);
    }
  });

  it('the single internalized criteria file names all four active-lens standards (Nielsen / WCAG / conversion / consistency) — SD4', async () => {
    const criteria = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/references/quality-criteria.md'), 'utf8');
    match(criteria, /Nielsen/i, "criteria file must ground the usability lens in Nielsen's heuristics");
    match(criteria, /WCAG/i, 'criteria file must ground the accessibility lens in WCAG A/AA');
    match(criteria, /conversion/i, 'criteria file must carry the conversion criteria');
    match(criteria, /consistency/i, 'criteria file must carry the consistency criteria');
    for (const section of ['Usability', 'Accessibility', 'Conversion', 'Consistency']) {
      ok(criteria.includes(section), `criteria file must carry the § ${section} section (a lens references it)`);
    }
  });

  it('the critique SKILL references the single internalized criteria file (SD4 — every lens applies the same standard)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    match(skill, /references\/quality-criteria\.md/,
      'critique SKILL must reference the single internalized criteria file');
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/critique/references/quality-criteria.md')), true);
  });

  it('host-direct vision + code/text-only peer path is stated across SKILL + command + openai, and the peer dispatch never passes --image (SD4 item 3)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/critique.md'), 'utf8');
    const openai = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/agents/openai.yaml'), 'utf8');
    // Codex Plan-verify MAJOR: the guard read only SKILL.md and broad words — a
    // regression could add --image to the peer command and still pass. Cover the
    // command dispatch + openai surfaces and assert the peer path has no --image.
    for (const [rel, text] of [['SKILL.md', skill], ['commands/critique.md', cmd]]) {
      match(text, /codex exec --image/, `critique ${rel} must state Codex host-direct vision via codex exec --image (active host only)`);
      match(text, /same-host/i, `critique ${rel} must state vision-grounded critique is a same-host capability`);
      match(text, /no .{0,3}--image/i, `critique ${rel} must state the companion peer path has no --image flag`);
    }
    match(skill, /inline image bytes|never as inline/i, 'critique SKILL must state the peer never receives inline image bytes');
    // The peer dispatch invocation must NEVER carry --image — the companion has
    // no image channel; vision is host-direct only.
    const dispatch = cmd.match(/peer-runner\.mjs[\s\S]*?&\s*\n/);
    ok(dispatch, 'commands/critique.md must dispatch the peer ensemble via peer-runner.mjs run');
    ok(!/--image/.test(dispatch[0]),
      'the peer-runner dispatch must never pass --image — the companion peer path has no image channel');
    // openai.yaml frames vision as host-direct (active host), never a peer capability.
    ok(/host-direct|active host/i.test(openai),
      'agents/openai.yaml must frame vision as host-direct (active host), not a companion capability');
    ok(!/peer[^\n]{0,40}--image/i.test(openai), 'agents/openai.yaml must not claim the peer takes --image');
  });

  it('critique flags CANDIDATE accessibility issues only, not conformance certification (ADR-0042 Non-Goal 6)', async () => {
    for (const rel of ['skills/critique/SKILL.md', 'skills/critique/references/quality-criteria.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /candidate/i, `${rel} must state critique flags candidate a11y issues`);
      match(text, /conformance/i, `${rel} must state the WCAG-conformance honesty boundary (cannot certify)`);
    }
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    match(skill, /Non-Goal 6/, 'critique SKILL must cite ADR-0042 Non-Goal 6 for the candidate-only a11y boundary');
  });

  it('an unmitigated accessibility veto gate is a CRITICAL finding (SD4 gate severity rule)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/critique/SKILL.md'), 'utf8');
    ok(/CRITICAL/.test(skill) && /SUGGESTION/.test(skill),
      'critique SKILL must use the CRITICAL / MAJOR / MINOR / SUGGESTION severity scheme');
    match(skill, /unmitigated[\s\S]{0,160}?CRITICAL/i,
      'critique SKILL must state that an unmitigated accessibility veto gate is CRITICAL by definition');
  });

  it('the SD4 privacy gate + screenshots-sensitive sentinels reach the critique external-dispatch surfaces', async () => {
    for (const rel of ['skills/critique/SKILL.md', 'commands/critique.md']) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
      ok(text.toLowerCase().includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" invariant (ADR-0042 SD4)`);
    }
  });

  it('the critique surface is de-incubated (ADR-0042 Accepted)', async () => {
    for (const rel of ['skills/critique/SKILL.md', 'commands/critique.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/incubating/i.test(text), `${rel} must drop the incubating disclaimer`);
    }
  });

  it('no stale founder/business or engineer-axis vocabulary leaks into the critique surfaces (copy-trim rebrand)', async () => {
    const STALE = [
      /business_brief/i, /FOUNDER_OUTPUT_ROOT/, /\bventure\b/i, /\bjurisdiction\b/i, /unit-economics/i, /market-attractiveness/i, /시장성/, /단위경제/,
      /\bessence\b/i, /\bfoundation\b/i, /practical-fit/i, /\bmaturation\b/i, /canonical-precedent/i,
    ];
    for (const rel of [
      'skills/critique/SKILL.md',
      'commands/critique.md',
      'skills/critique/references/quality-criteria.md',
      'skills/critique/agents/openai.yaml',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of STALE) {
        ok(!re.test(text), `${rel} carries stale vocabulary ${re} (copy-trim rebrand miss)`);
      }
    }
  });
});

describe('plugins/designer — PR5B refine verb surface + convergence loop (ADR-0042 SD4)', () => {
  const REQUIRED_PR5B_SURFACES = [
    'commands/refine.md',
    'skills/refine/SKILL.md',
    'skills/refine/agents/openai.yaml',
  ];

  for (const rel of REQUIRED_PR5B_SURFACES) {
    it(`ships ${rel} (PR5B refine surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the ADR-0042 PR5B refine surface and must exist`);
    });
  }

  it('skills/refine/SKILL.md frontmatter name = refine', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'skills/refine/SKILL.md has no YAML frontmatter');
    ok(/^name:\s*refine\s*$/m.test(fm), 'skills/refine/SKILL.md frontmatter name != "refine"');
    match(fm, /description:/, 'skills/refine/SKILL.md frontmatter must carry a description');
  });

  it('skills/refine/agents/openai.yaml display_name names the verb + persona', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/agents/openai.yaml'), 'utf8');
    const m = text.match(/display_name:\s*"([^"]+)"/);
    ok(m, 'skills/refine/agents/openai.yaml must declare interface.display_name');
    ok(m[1].toLowerCase().includes('refine'), `openai.yaml display_name "${m[1]}" must name the verb "refine"`);
    ok(m[1].toLowerCase().includes('designer'), `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
  });

  it('commands/refine.md carries a frontmatter description', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'commands/refine.md has no YAML frontmatter');
    match(fm, /description:\s*\S/, 'commands/refine.md frontmatter must carry a non-empty description');
  });

  it('commands/refine.md carries no parent-linkage env reads (ADR-0042 Non-Goal 2)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    for (const form of [/\$\{?AGENTIC_PARENT_WORKFLOW/, /\$\{?AGENTIC_ORIGINATING_SUBTASK/]) {
      ok(!form.test(text),
        `commands/refine.md must not shell-read ${form} — designer is non-dispatch (ADR-0042 Non-Goal 2)`);
    }
  });

  // refine is SINGLE-MODE (founder/engineer refine + designer frame precedent):
  // no --profile in any state.mjs call. The prose "no --profile argument" is
  // backtick/paren documentation, not a shell flag, and remains allowed.
  it('refine is single-mode — no --profile flag in ANY form in any state.mjs call (Codex m2: =, ", \', $)', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    // Catch every real flag form (--profile=, --profile ", --profile ', --profile $value),
    // not just the double-quoted one. Backtick-prose `--profile` is followed by a
    // backtick, so it is not matched — documentation stays allowed (Codex m2).
    ok(!/--profile(=|\s+["'$])/.test(cmd),
      "commands/refine.md must not pass a --profile flag in ANY form (=, \", ', or $value) — refine is single-mode");
  });

  it('the refine SKILL + command state the critique → refine → re-critique convergence loop (ADR-0042 SD4)', async () => {
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /re-critique/i, `${rel} must name the re-critique convergence step`);
      match(text, /converge/i, `${rel} must state the loop runs until findings converge`);
      match(text, /SD4/, `${rel} must cite ADR-0042 SD4 for the convergence loop`);
    }
  });

  // Codex C1/C2: Phase 2 must NOT mark the workflow terminal on a non-converged /
  // paused refine (a new inconsistency / accessibility barrier / bounded-pass
  // exhaustion / an unverifiable post-code re-render). set-terminal must be gated
  // by the CONVERGED check, with an explicit paused branch leaving the wf active.
  it('Phase 2 guards the terminal write behind convergence — a paused refine is NOT marked terminal (Codex C1)', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    const guarded = cmd.match(/if \[ "\$\{CONVERGED[\s\S]*?set-terminal/);
    ok(guarded, 'commands/refine.md set-terminal must sit inside the CONVERGED convergence guard (not unconditional)');
    match(cmd, /PAUSED[\s\S]{0,200}(left ACTIVE|NOT marked terminal)/i,
      'commands/refine.md must describe the paused branch leaving the workflow ACTIVE (not terminal)');
  });

  it('the convergence loop is bounded — persistent non-convergence pauses/routes, not an infinite loop (Codex M1)', async () => {
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /bound(ed)? (the |it|convergence)|hard cap/i, `${rel} must bound the convergence loop (no unbounded loop)`);
      ok(/owner decision|\/designer:decide|\/designer:investigate/i.test(text),
        `${rel} must route persistent non-convergence to a decision / pause, not an infinite loop`);
    }
  });

  it('post-code re-critique is honest about an unavailable/broken re-render — designer does not run the build (Codex M2)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/SKILL.md'), 'utf8');
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    for (const [rel, text] of [['SKILL.md', skill], ['commands/refine.md', cmd]]) {
      // normalize whitespace so a markdown line-wrap inside "run the ... build" does not break the match.
      ok(/does (\*\*)?not(\*\*)? run the (frontend )?build/i.test(normalizeWhitespace(text)),
        `refine ${rel} must state designer does not run the frontend build (the re-rendered screen is host-supplied)`);
      match(text, /UNVERIFIED/, `refine ${rel} must flag the vision re-critique UNVERIFIED when the re-render is unavailable`);
    }
    ok(/do not claim (full )?convergence|not a substitute/i.test(normalizeWhitespace(cmd)),
      'commands/refine.md must forbid claiming convergence on a code/text-only pass when the re-render could not be re-critiqued');
  });

  // The load-bearing design gate: a refine must NOT clear a usability/conversion
  // problem by opening a new accessibility barrier (the design analog of the
  // founder veto-gate-exposure rule). Author-guard against silent removal.
  it('refine guards the accessibility veto gate — a revision must not open a new a11y barrier (SD4)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/SKILL.md'), 'utf8');
    match(skill, /accessibility barrier/i, 'refine SKILL must name the new-accessibility-barrier gate exposure');
    match(skill, /moved the (veto )?gate/i,
      'refine SKILL must state that opening a barrier moves the veto gate rather than clearing it');
  });

  it('refine keeps the candidate-only accessibility boundary on re-critique (ADR-0042 Non-Goal 6)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/SKILL.md'), 'utf8');
    match(skill, /candidate/i, 'refine SKILL must keep the candidate-only a11y boundary on re-critique');
    match(skill, /Non-Goal 6/, 'refine SKILL must cite ADR-0042 Non-Goal 6');
  });

  it('the Refine-verify ensemble dispatches via peer-runner.mjs and never passes --image (SD4 item 3)', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    const dispatch = cmd.match(/peer-runner\.mjs[\s\S]*?&\s*\n/);
    ok(dispatch, 'commands/refine.md must dispatch the peer ensemble via peer-runner.mjs run');
    ok(/--ensemble-type refine-verify/.test(dispatch[0]),
      'the refine dispatch must use the refine-verify ensemble point type');
    ok(!/--image/.test(dispatch[0]),
      'the peer-runner dispatch must never pass --image — the companion peer path has no image channel');
  });

  it('the refine forward-reference to the shared ensemble-protocol.md § Refine-verify now resolves (landed at PR6)', async () => {
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /ensemble-protocol\.md/, `${rel} must reference the shared ensemble-protocol.md`);
      match(text, /Refine-verify/, `${rel} must name the Refine-verify ensemble point`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md')), true,
      'the shared ensemble-protocol.md landed at PR6; PR5B refine forward-referenced it');
    const protocol = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(protocol, /^### Refine-verify /m,
      'ensemble-protocol.md must define the § Refine-verify point refine names');
  });

  it('the SD4 privacy gate + screenshots-sensitive sentinels reach the refine external-dispatch surfaces', async () => {
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md']) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
      ok(text.toLowerCase().includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" invariant (ADR-0042 SD4)`);
    }
  });

  it('the refine surface is de-incubated (ADR-0042 Accepted)', async () => {
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/incubating/i.test(text), `${rel} must drop the incubating disclaimer`);
    }
  });

  // Codex C1 (PR5B) required the guard to EXIST; it did not require it to fail
  // closed. `${CONVERGED:-yes}` is not a guard: shell state does not survive
  // across Bash tool invocations, so a lost variable marks a paused refine
  // terminal — and `state.mjs set-terminal` defaults `--terminal-marker` to true,
  // so nothing downstream catches it.
  it('the refine convergence guard FAILS CLOSED — an unset CONVERGED must not mark the workflow terminal', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/refine.md'), 'utf8');
    match(cmd, /if \[ "\$\{CONVERGED:-no\}" = "yes" \]/,
      'commands/refine.md must default CONVERGED to "no" (fail-closed), not "yes" (fail-open)');
    ok(!/\$\{CONVERGED:-yes\}/.test(cmd),
      'commands/refine.md must not carry a fail-open ${CONVERGED:-yes} default');
  });

  it('no stale founder/business or engineer-axis vocabulary leaks into the refine surfaces (copy-trim rebrand)', async () => {
    const STALE = [
      /business_brief/i, /FOUNDER_OUTPUT_ROOT/, /\bventure\b/i, /\bjurisdiction\b/i, /unit-economics/i, /market-attractiveness/i, /시장성/, /단위경제/,
      /\bessence\b/i, /\bfoundation\b/i, /practical-fit/i, /\bmaturation\b/i, /canonical-precedent/i,
    ];
    for (const rel of [
      'skills/refine/SKILL.md',
      'commands/refine.md',
      'skills/refine/agents/openai.yaml',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of STALE) {
        ok(!re.test(text), `${rel} carries stale vocabulary ${re} (copy-trim rebrand miss)`);
      }
    }
  });
});

describe('plugins/designer — PR6 start macro + meta skills + shared references + L4 profiles (ADR-0042 SD5/SD6/SD7)', () => {
  const REQUIRED_PR6_SURFACES = [
    'skills/_shared/references/orchestration.md',
    'skills/_shared/references/ensemble-protocol.md',
    'commands/start.md',
    'commands/checkpoint.md',
    'commands/resume.md',
    'commands/peer-now.md',
    'skills/start/SKILL.md',
    'skills/start/agents/openai.yaml',
    'skills/checkpoint/SKILL.md',
    'skills/checkpoint/agents/openai.yaml',
    'skills/resume/SKILL.md',
    'skills/resume/agents/openai.yaml',
    'skills/peer-now/SKILL.md',
    'skills/peer-now/agents/openai.yaml',
  ];

  for (const rel of REQUIRED_PR6_SURFACES) {
    it(`ships ${rel} (PR6 surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/designer/${rel} is part of the ADR-0042 PR6 surface and must exist`);
    });
  }

  for (const skill of PR6_SKILLS) {
    it(`skills/${skill}/SKILL.md frontmatter name = ${skill} (folder ↔ frontmatter consistency)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${skill}/SKILL.md has no YAML frontmatter`);
      ok(new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(fm),
        `skills/${skill}/SKILL.md frontmatter name != "${skill}"`);
      match(fm, /description:/, `skills/${skill}/SKILL.md frontmatter must carry a description`);
    });

    it(`skills/${skill}/agents/openai.yaml display_name names the surface + persona`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'agents/openai.yaml'), 'utf8');
      const m = text.match(/display_name:\s*"([^"]+)"/);
      ok(m, `skills/${skill}/agents/openai.yaml must declare interface.display_name`);
      ok(m[1].toLowerCase().includes(skill), `openai.yaml display_name "${m[1]}" must name "${skill}"`);
      ok(m[1].toLowerCase().includes('designer'), `openai.yaml display_name "${m[1]}" must name the persona "designer"`);
    });

    // ADR-0022 mandates the Host-availability matrix on every macro + meta skill
    // (founder PR6 precedent): the cross-host contract must be stated, not implied.
    it(`skills/${skill}/SKILL.md carries the mandatory Host-availability matrix (ADR-0022)`, async () => {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      match(text, /^## Host availability \(ADR-0022\)$/m,
        `skills/${skill}/SKILL.md must carry a "## Host availability (ADR-0022)" section`);
      match(text, /^\|\s*Operation\s*\|/m,
        `skills/${skill}/SKILL.md host-availability section must be a table with an Operation column`);
      ok(/--host codex/.test(text) && /--host claude/.test(text),
        `skills/${skill}/SKILL.md must state both host flags in the matrix`);
      match(text, /^## Claude\/Codex command resolution$/m,
        `skills/${skill}/SKILL.md must carry the Claude/Codex command-resolution table`);
    });
  }

  // ADR-0042 SD6 — bilingual EN/KO triggers per skill. The operator's own
  // vocabulary is the auto-activation surface; an English-only description is a
  // regression. "Any Korean character somewhere in the frontmatter" is too weak —
  // a stray Korean noun in prose would pass while every real trigger phrase was
  // deleted. Require ≥2 QUOTED Korean trigger phrases, the shape the descriptions
  // actually use ('체크포인트', '진행 메모', …).
  it('every skill description carries at least two quoted Korean trigger phrases (SD6)', async () => {
    for (const skill of [...ALL_VERB_SKILLS, ...PR6_SKILLS]) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      ok(fm, `skills/${skill}/SKILL.md has no YAML frontmatter`);
      const phrases = quotedTriggerPhrases(fm);
      const koreanTriggers = phrases.filter((p) => /[가-힣]/.test(p));
      ok(koreanTriggers.length >= 2,
        `skills/${skill}/SKILL.md must quote >= 2 Korean trigger phrases (ADR-0042 SD6); found ${koreanTriggers.length}: ${JSON.stringify(koreanTriggers)}`);
      // English triggers must survive alongside them.
      const englishTriggers = phrases.filter((p) => !/[가-힣]/.test(p) && /[a-z]{3}/i.test(p));
      ok(englishTriggers.length >= 2,
        `skills/${skill}/SKILL.md must quote >= 2 English trigger phrases; found ${englishTriggers.length}: ${JSON.stringify(englishTriggers)}`);
    }
  });

  // Codex Plan-verify MAJOR (sequencing): PR6 landed `start` + the meta skills,
  // so no surface may still tell the user those commands are unlanded. The scan
  // covers the WHOLE plugin, not just PR6's own files — the stale text lives in
  // the PR3/PR4/PR5 surfaces.
  it('no designer surface claims an unlanded verb / a not-runnable next_command / a pending PR6 file', async () => {
    const STALE_CLAIMS = [
      /directional,\s*not\s*runnable/i,
      /\bunlanded\b/i,
      /not yet installed/i,
      /(lands?|landing) at PR6/i,
    ];
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    const offenders = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(md|yml|yaml)$/.test(ent.name)) continue;
      if (ent.name === 'CHANGELOG.md') continue; // history is allowed to be historical
      const parent = ent.parentPath ?? ent.path;
      const full = resolve(parent, ent.name);
      const rel = full.slice(PLUGIN_ROOT.length + 1);
      const text = await readFile(full, 'utf8');
      for (const re of STALE_CLAIMS) {
        if (re.test(text)) offenders.push(`${rel} :: ${re.source}`);
      }
    }
    deepStrictEqual(offenders, [],
      `PR6 installed start + the meta skills; no surface may still call them unlanded:\n  ${offenders.join('\n  ')}`);
  });

  // The Host-availability matrices name state.mjs operations. A matrix that
  // claims an operation the CLI does not implement is a documentation lie a
  // substring check would never catch.
  it('every state.mjs subcommand named in a PR6 host-availability matrix actually exists', async () => {
    const usage = await readFile(resolve(PLUGIN_ROOT, 'scripts/state.mjs'), 'utf8');
    const implemented = new Set([...usage.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]));
    ok(implemented.size >= 10, `expected to parse the state.mjs subcommand switch (got ${implemented.size})`);
    let named = 0;
    for (const skill of PR6_SKILLS) {
      const text = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      for (const m of text.matchAll(/state\.mjs\s+([a-z][a-z-]+)/g)) {
        const sub = m[1];
        named += 1;
        ok(implemented.has(sub),
          `skills/${skill}/SKILL.md names \`state.mjs ${sub}\`, which scripts/state.mjs does not implement`);
      }
    }
    ok(named >= 6, `the PR6 SKILL matrices must actually name state.mjs operations (found ${named})`);
  });

  it('the shared orchestration.md carries the canonical Design Task Profile with every field', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md'), 'utf8');
    match(text, /Design Task Profile:/, 'orchestration.md must render the Design Task Profile block');
    for (const field of ['Surface:', 'Users:', 'Stage:', 'Persona:', 'Skill-profile:', 'Profile:', 'Platform:', 'Evidence-confidence:', 'Ensemble Affinity:']) {
      ok(text.includes(field), `Design Task Profile must declare the "${field}" field`);
    }
    // Skill-profile (verb mode) vs Profile (L4 archetype) must stay distinguished.
    match(text, /Skill-profile[\s\S]{0,600}?L4/,
      'orchestration.md must keep the Skill-profile and the L4 Profile axes explicitly separate');
    match(text, /Ensemble Affinity[\s\S]{0,400}?NOT a dispatch gate/i,
      'orchestration.md must state that Ensemble Affinity does not gate dispatch (always-max policy)');
  });

  it('the shared orchestration.md documents the bilingual EN/KO trigger convention (SD6)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md'), 'utf8');
    match(text, /Bilingual triggers/i, 'orchestration.md must carry the bilingual trigger convention section');
    ok(/[가-힣]/.test(text), 'the bilingual trigger table must contain Korean trigger phrases');
  });

  it('the shared orchestration.md documents the L4 profile → preset map, row-for-row, matching the code', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md'), 'utf8');
    // Parse the markdown table rows rather than substring-matching the names: a
    // doc that said `cta` → `clarity` while mentioning `conversion` elsewhere
    // would pass a substring check (Codex Plan-verify MINOR).
    const documented = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^\|\s*`([a-z]+)`\s*\|[^|]*\|\s*`([a-z]+)`\s*\|/);
      if (m) documented[m[1]] = m[2];
    }
    deepStrictEqual(documented, EXPECTED_PROFILE_PRESET_MAP,
      'the orchestration.md L4 table must map each profile to exactly the preset the code map does');
    // The doc must point at the code map rather than re-declaring it as data.
    match(text, /PROFILE_PRESET_MAP/,
      'orchestration.md must name PROFILE_PRESET_MAP as the single source of truth for the map');
    match(text, /accessibility[\s\S]{0,200}?veto gate/i,
      'orchestration.md must state accessibility is the veto gate in every preset');
    // The L4 archetype must not be conflated with the state.mjs skill-profile.
    match(text, /AGENTIC_DESIGNER_PROFILE/,
      'orchestration.md must document how the L4 archetype reaches decide-registry');
    // The env seam is ambient, not durable — both hazards must be stated.
    match(text, /does not survive across Bash tool invocations/i,
      'orchestration.md must warn that the export is lost across Bash tool invocations');
    match(text, /stale|inherited/i,
      'orchestration.md must warn that a stale ambient export leaks into a standalone decide');
    match(text, /--size[\s\S]{0,400}?(drops|outranks)/i,
      'orchestration.md must state that an explicit --size outranks (and drops) the L4 archetype');
  });

  // The DEFERRED PR4 cross-check, landed here now that the profiles exist.
  it('every L4 profile resolves to a preset the SD3 registry defines (ADR-0042 SD3, DEFERRED from PR4)', async () => {
    const mod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry } = mod.loadRegistry({});
    ok(mod.PROFILE_PRESET_MAP, 'decide-registry.mjs must export PROFILE_PRESET_MAP (the §1.5(3) profile slot)');
    deepStrictEqual({ ...mod.PROFILE_PRESET_MAP }, EXPECTED_PROFILE_PRESET_MAP,
      'the shipped L4 profile → preset map must match the ADR-0042 SD6 contract');
    for (const [profile, presetId] of Object.entries(mod.PROFILE_PRESET_MAP)) {
      ok(Object.hasOwn(registry.presets, presetId),
        `L4 profile "${profile}" maps to preset "${presetId}", which decision-axes.yml does not define`);
      // and it must actually resolve, with the veto gate intact.
      const { context, fallbackTriggered } = mod.resolvePreset({ profileOverride: profile });
      strictEqual(fallbackTriggered, false, `resolving L4 profile "${profile}" must not trigger the registry fallback`);
      strictEqual(context.preset_id, presetId, `L4 profile "${profile}" must resolve preset "${presetId}"`);
      deepStrictEqual(context.axes.filter((a) => a.gate).map((a) => a.id), ['accessibility'],
        `L4 profile "${profile}" must keep accessibility as the single veto gate`);
    }
  });

  // Codex Plan-verify MAJOR: the env seam is process state, not workflow state.
  // The lifecycle must not pretend an `export` survives to a later Bash block, and
  // it must warn that a stale ambient export leaks into a standalone decide.
  it('the start surfaces treat the L4 env seam as ambient, not durable (inline carry + stale-export hazard)', async () => {
    for (const rel of ['skills/start/SKILL.md', 'commands/start.md']) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      match(text, /does not survive across Bash tool invocations/i,
        `${rel} must state that shell state (the export) is lost across Bash tool invocations`);
      match(text, /AGENTIC_DESIGNER_PROFILE="[^"]*" \\? ?node/,
        `${rel} must show the inline-prefix form that carries the archetype into the resolve call`);
      match(text, /stale/i,
        `${rel} must warn that a stale ambient export leaks into an unrelated standalone /designer:decide`);
    }
    // The resolver must actually emit the provenance diagnostic the docs promise.
    const registry = await readFile(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs'), 'utf8');
    match(registry, /L4 profile "\$\{profileOverride\}" \(AGENTIC_DESIGNER_PROFILE\) resolved preset/,
      'decide-registry.mjs must emit a provenance diagnostic when an archetype changes the resolved preset');
    match(registry, /outranks the L4 profile/,
      'decide-registry.mjs must warn when an explicit --size silently drops the archetype');
  });

  it('the L4 archetype does NOT enter the ADR-0027 §2.2 decide grammar (no --profile flag)', async () => {
    // decide stays single-mode: the archetype is ambient context (env), never a
    // decide flag and never the state.mjs skill-profile field.
    const args = await readFile(resolve(PLUGIN_ROOT, 'scripts/lib/decide-args.mjs'), 'utf8');
    match(args, /KNOWN_FLAGS\s*=\s*new Set\(\["preset", "size", "weights"\]\)/,
      'decide-args.mjs KNOWN_FLAGS must stay {preset, size, weights} — the L4 profile is not a decide flag');
    for (const rel of ['commands/start.md', 'commands/decide.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/--profile(=|\s+["'$])/.test(text),
        `${rel} must not pass a --profile flag in any form — start and decide are both single-mode`);
    }
  });

  it('the shared ensemble-protocol.md defines all six design-anchored point types', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    for (const point of ['Frame', 'Brainstorm', 'Plan-verify', 'Review', 'Refine-verify', 'Reference-scan']) {
      match(text, new RegExp(`^### ${point} `, 'm'), `ensemble-protocol.md must define the § ${point} point type`);
    }
    // Every --ensemble-type the shipped verb commands dispatch must be mapped.
    for (const type of ['reference-scan', 'frame', 'brainstorm', 'plan-verify', 'review', 'refine-verify']) {
      ok(new RegExp('`' + type + '`').test(text),
        `ensemble-protocol.md must map the \`${type}\` --ensemble-type to its point`);
    }
    // reference-scan cross-references the canonical contract, never duplicates it.
    match(text, /design-brief-ensemble\.md/,
      'the reference-scan point must cross-reference the canonical design-brief-ensemble.md contract');
    // The four base synthesis categories are the schema-stable public vocabulary.
    for (const cat of ['AGREED', 'LOCAL-ONLY', 'PEER-ONLY', 'CONFLICT']) {
      ok(text.includes(cat), `ensemble-protocol.md must carry the ${cat} synthesis category`);
    }
  });

  it('the shared ensemble-protocol.md states the peer has no image channel and vision is same-host (SD4 item 3)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(text, /no .{0,3}--image/i, 'ensemble-protocol.md must state the companion peer path has no --image flag');
    match(text, /same-host/i, 'ensemble-protocol.md must state vision-grounded judgment is same-host');
    match(text, /inline image bytes/i, 'ensemble-protocol.md must forbid inline image bytes in a peer prompt');
    match(text, /codex exec --image/, 'ensemble-protocol.md must name the Codex host-direct vision path');
    match(text, /UNVERIFIED/, 'ensemble-protocol.md must keep the UNVERIFIED honesty boundary for unseen screens');
  });

  it('the shared ensemble-protocol.md structurally excludes peer-now from ensemble_results (State Bookkeeping)', async () => {
    const text = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(text, /^### State Bookkeeping$/m, 'ensemble-protocol.md must carry the § State Bookkeeping section peer-now cites');
    match(text, /peer-now[\s\S]{0,300}?excluded[\s\S]{0,120}?ensemble_results/i,
      'State Bookkeeping must state the peer-now structural exclusion from ensemble_results');
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/peer-now/SKILL.md'), 'utf8');
    match(skill, /_shared\/references\/ensemble-protocol\.md.{0,80}State Bookkeeping/s,
      'peer-now SKILL must cite ensemble-protocol.md § State Bookkeeping for the exclusion');
    match(skill, /--kind peer-now/, 'peer-now SKILL must dispatch with --kind peer-now (side-channel, not an ensemble)');
  });

  // ADR-0042 SD7 / Non-Goal 2 — designer is not an orchestrator dispatch target.
  it('the PR6 commands + skills carry no parent-linkage env reads (ADR-0042 Non-Goal 2)', async () => {
    const files = [
      ...PR6_SKILLS.map((s) => `skills/${s}/SKILL.md`),
      'commands/start.md', 'commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md',
      'skills/_shared/references/orchestration.md',
      'skills/_shared/references/ensemble-protocol.md',
    ];
    for (const rel of files) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const form of PARENT_LINKAGE_READS) {
        ok(!form.test(text),
          `${rel} must not shell-read ${form} — designer is non-dispatch (ADR-0042 Non-Goal 2)`);
      }
    }
    // start.md must say so plainly, and must never reach for a dispatch CLI.
    const start = await readFile(resolve(PLUGIN_ROOT, 'commands/start.md'), 'utf8');
    match(start, /Non-Goal 2/, 'commands/start.md must cite ADR-0042 Non-Goal 2 (non-dispatch)');
    ok(!/parent-writeback|subtask-update/.test(start),
      'commands/start.md must never invoke orchestrator dispatch/writeback machinery');
  });

  it('the start macro bootstraps workflow_type=start and guards the terminal write behind convergence', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/start.md'), 'utf8');
    match(cmd, /state\.mjs" create[\s\S]*?--workflow-type start/,
      'commands/start.md must create the workflow with --workflow-type start (ADR-0020 §Sub-decision 5)');
    match(cmd, /check-clean-baseline/, 'commands/start.md must run the clean-baseline gate before bootstrap');
    match(cmd, /fail-closed|Fail CLOSED/i, 'the clean-baseline gate must fail closed');
    // The refine C1 precedent, hardened: the guard must exist AND fail closed.
    // A `${CONVERGED:-yes}` default is not a guard — shell state does not survive
    // across Bash tool invocations, so a lost variable would mark a paused Phase 4
    // terminal (and `set-terminal` defaults `--terminal-marker` to true).
    const guarded = cmd.match(/if \[ "\$\{CONVERGED[\s\S]*?set-terminal/);
    ok(guarded, 'commands/start.md set-terminal must sit inside the CONVERGED convergence guard (not unconditional)');
    match(cmd, /if \[ "\$\{CONVERGED:-no\}" = "yes" \]/,
      'commands/start.md must default CONVERGED to "no" (fail-closed), not "yes" (fail-open)');
    ok(!/\$\{CONVERGED:-yes\}/.test(cmd),
      'commands/start.md must not carry a fail-open ${CONVERGED:-yes} default');
    match(cmd, /PAUSED[\s\S]{0,240}(left ACTIVE|NOT marked terminal)/i,
      'commands/start.md must describe the paused branch leaving the workflow ACTIVE (not terminal)');
    // The lifecycle macro must not absorb a single-verb workflow.
    match(cmd, /workflow_type[\s\S]{0,400}?verb-chain[\s\S]{0,400}?reject/i,
      'commands/start.md must reject absorbing a verb-chain workflow into lifecycle phase space');
  });

  it('the start SKILL sequences the six verbs with approval gates at the direction and the spec', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/start/SKILL.md'), 'utf8');
    for (const verb of ALL_VERB_SKILLS) {
      ok(skill.includes(verb), `start SKILL must sequence the ${verb} verb`);
    }
    match(skill, /Do not proceed to Phase 2 until the user approves a direction/i,
      'start SKILL must gate Phase 2 on direction approval');
    match(skill, /Do not proceed to Phase 3 until the user approves the spec/i,
      'start SKILL must gate Phase 3 on spec approval');
    match(skill, /bounded/i, 'start SKILL must bound the Phase 4 convergence loop');
    match(skill, /single-pass/i, 'start SKILL must state the macro is single-pass');
    match(skill, /does .{0,12}not.{0,12} run the (frontend )?build/i,
      'start SKILL must state designer does not run the frontend build (the re-render is host-supplied)');
  });

  // ADR-0042 SD5 — image L2 is COMPOSED via artifact handoff, never re-implemented.
  it('the image L2 composition boundary is stated as an artifact handoff, never a dispatch or a generator (SD5)', async () => {
    const orch = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md'), 'utf8');
    match(orch, /image L2 composition boundary/i, 'orchestration.md must carry the image L2 composition boundary section');
    match(orch, /image:compose/, 'orchestration.md must name the image:compose surface designer composes');
    match(orch, /artifact handoff/i, 'the image composition must be an artifact handoff (designer is non-dispatch)');
    // whitespace-normalized: markdown emphasis + line wrapping sit inside the phrase.
    match(normalizeWhitespace(orch), /never\*{0,2}\s*calls the OpenAI image API directly/i,
      'orchestration.md must state agentic-plugins never calls the OpenAI image API directly (ADR-0037 Alternative 6)');
    match(orch, /gpt-image/, 'orchestration.md must state generation runs through Codex\'s integrated gpt-image tool');
    // The composing surfaces must repeat the boundary where the handoff happens.
    // `compose` is the verb that actually produces the image brief, so it is the
    // load-bearing one — a regression there would pass a start-only check
    // (Codex Plan-verify MINOR).
    for (const rel of ['skills/start/SKILL.md', 'commands/start.md', 'skills/compose/SKILL.md', 'commands/compose.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /image:compose/, `${rel} must name the image:compose handoff for generated imagery`);
      match(text, /never (drawn|draws|implements|implement|re-implements)/i,
        `${rel} must state designer never generates imagery itself`);
    }
  });

  it('no designer code file calls an image generation API (direct-OpenAI-API-ban sentinel, ADR-0037 Alternative 6)', async () => {
    const entries = await readdir(PLUGIN_ROOT, { recursive: true, withFileTypes: true });
    const offenders = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.mjs') && !ent.name.endsWith('.js') && !ent.name.endsWith('.sh')) continue;
      const parent = ent.parentPath ?? ent.path;
      const full = resolve(parent, ent.name);
      const rel = full.slice(PLUGIN_ROOT.length + 1);
      const text = await readFile(full, 'utf8');
      for (const form of DIRECT_API_FORMS) {
        if (form.test(text)) offenders.push(`${rel} :: ${form.source}`);
      }
    }
    deepStrictEqual(offenders, [],
      `designer composes the image L2 capability and never implements generation — no direct image-API calls (ADR-0042 SD5):\n  ${offenders.join('\n  ')}`);
  });

  it('the SD4 privacy gate + screenshots-sensitive sentinels reach the start + peer-now external-dispatch surfaces', async () => {
    // start dispatches the peer at every phase boundary and runs web search;
    // peer-now sends a verbatim prompt. checkpoint/resume make no external call.
    for (const rel of ['skills/start/SKILL.md', 'commands/start.md', 'skills/peer-now/SKILL.md', 'commands/peer-now.md']) {
      const text = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, rel), 'utf8'));
      ok(text.includes(PRIVACY_SENTINEL),
        `${rel} must carry the privacy-gate sentinel "${PRIVACY_SENTINEL}"`);
      ok(text.toLowerCase().includes(SCREENSHOT_SENTINEL),
        `${rel} must carry the "screenshots are sensitive by default" invariant (ADR-0042 SD4)`);
    }
    // ...and the shared protocol, which every ensemble dispatch reads.
    const protocol = normalizeWhitespace(await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8'));
    ok(protocol.includes(PRIVACY_SENTINEL), 'ensemble-protocol.md must carry the privacy-gate sentinel');
    ok(protocol.toLowerCase().includes(SCREENSHOT_SENTINEL),
      'ensemble-protocol.md must carry the "screenshots are sensitive by default" invariant');
  });

  // Repo-wide, non-vacuous: collect EVERY peer-runner dispatch block across the
  // whole designer surface (start.md delegates and dispatches none of its own, so
  // a per-file `if (dispatch)` guard would pass vacuously there). Assert the block
  // count matches the shipped dispatchers, then assert none carries --image.
  it('no designer surface dispatches the peer with --image, and every dispatched ensemble type is a documented point', async () => {
    const DISPATCH_RE = /node "[^"]*peer-runner\.mjs" run[\s\S]*?(?:\n\n|&\n)/g;
    const surfaces = [
      ...ALL_VERB_SKILLS.map((v) => `commands/${v}.md`),
      ...ALL_VERB_SKILLS.map((v) => `skills/${v}/SKILL.md`),
      ...PR6_SKILLS.map((s) => `skills/${s}/SKILL.md`),
      'commands/start.md', 'commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md',
    ];
    let blocks = 0;
    const withImage = [];
    const dispatchedTypes = new Set();
    for (const rel of surfaces) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const m of text.matchAll(DISPATCH_RE)) {
        blocks += 1;
        if (/--image/.test(m[0])) withImage.push(rel);
      }
      for (const m of text.matchAll(/--ensemble-type\s+([a-z-]+)/g)) dispatchedTypes.add(m[1]);
    }
    ok(blocks >= 6, `expected the shipped peer-runner dispatch blocks to be found (got ${blocks}) — the scan must not pass vacuously`);
    deepStrictEqual(withImage, [],
      `the companion peer path has no image channel — these dispatches pass --image: ${withImage.join(', ')}`);

    // Cross-check: every --ensemble-type the surface actually dispatches must be a
    // point type ensemble-protocol.md defines. Derived from both files, not a list.
    const protocol = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    const documented = new Set(
      [...protocol.matchAll(/^### ([A-Za-z][A-Za-z-]*) \(/gm)].map((m) => m[1].toLowerCase()),
    );
    deepStrictEqual([...dispatchedTypes].sort(), ['brainstorm', 'frame', 'plan-verify', 'reference-scan', 'refine-verify', 'review'],
      'the six shipped verbs must dispatch exactly the six design-anchored ensemble types');
    for (const type of dispatchedTypes) {
      ok(documented.has(type),
        `--ensemble-type ${type} is dispatched but ensemble-protocol.md defines no "### ${type}" point (documented: ${[...documented].join(', ')})`);
    }
  });

  it('peer-now dispatches as a side-channel: --kind peer-now, no ensemble-accounting flags', async () => {
    const cmd = await readFile(resolve(PLUGIN_ROOT, 'commands/peer-now.md'), 'utf8');
    match(cmd, /--kind peer-now/, 'commands/peer-now.md must dispatch with --kind peer-now');
    for (const flag of ['--ensemble-type', '--workflow-path', '--phase ']) {
      ok(!new RegExp(flag.replace(/[-]/g, '\\-')).test(cmd.match(/node "[^"]*peer-runner\.mjs" run[\s\S]*?\n\n/)?.[0] ?? ''),
        `peer-now's peer-runner dispatch must omit ${flag} — it is a side-channel, not an ensemble`);
    }
    // --run-id IS passed: it is the peer-run ledger key, not an ensemble key. The
    // structural exclusion lives in peer-runner (kind !== 'ensemble' → no pending row).
    match(cmd, /--run-id "\$RUN_ID"/, 'peer-now passes --run-id as the peer-run ledger key');
    const runner = await readFile(resolve(PLUGIN_ROOT, 'scripts/peer-runner.mjs'), 'utf8');
    match(runner, /if \(handle\.kind !== 'ensemble'\) return;/,
      'peer-runner must register pending_ensemble only for kind=ensemble (the structural exclusion peer-now relies on)');
  });

  it('no stale founder/business or engineer-axis vocabulary leaks into the PR6 surfaces (copy-trim rebrand)', async () => {
    const files = [
      ...PR6_SKILLS.map((s) => `skills/${s}/SKILL.md`),
      ...PR6_SKILLS.map((s) => `skills/${s}/agents/openai.yaml`),
      'commands/start.md', 'commands/checkpoint.md', 'commands/resume.md', 'commands/peer-now.md',
      'skills/_shared/references/orchestration.md',
      'skills/_shared/references/ensemble-protocol.md',
    ];
    for (const rel of files) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      for (const re of STALE_VOCABULARY) {
        ok(!re.test(text), `${rel} carries stale vocabulary ${re} (copy-trim rebrand miss)`);
      }
    }
  });

  it('the start macro surface is de-incubated (ADR-0042 Accepted)', async () => {
    for (const rel of ['skills/start/SKILL.md', 'commands/start.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/incubating/i.test(text), `${rel} must drop the incubating disclaimer`);
      match(text, /ADR-0042 is `Accepted`/, `${rel} must state that ADR-0042 is Accepted`);
    }
  });
});

describe('plugins/designer — inert boundary (persona directories never ship)', () => {
  // commands/ + skills/ landed across PR3 (investigate + frame), PR4 (decide +
  // compose), PR5A (critique), PR5B (refine), and PR6 (start + meta skills +
  // shared references). The persona dirs never ship.
  const FORBIDDEN_DIRS = [
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of FORBIDDEN_DIRS) {
    it(`has no ${dir}/ directory (not part of the designer surface)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/designer/${dir}/ must not exist — designer uses commands/ + skills/ only`);
    });
  }

  it('ships README.md without the incubating marker but with the ADR-0042 pointer (Accepted)', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(!INCUBATING_MARKER.test(readme),
      'plugin README must drop the incubating marker now that ADR-0042 is Accepted');
    ok(/ADR-0042/.test(readme), 'plugin README must point at ADR-0042');
    ok(/\*\*Accepted\*\*/.test(readme), 'plugin README must state the persona is Accepted');
  });

  it('ships CHANGELOG.md with the initial scaffold seed entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(/scaffold seed/i.test(changelog), 'CHANGELOG.md must carry the initial scaffold seed entry');
  });
});

describe('plugins/designer — marketplace catalog wiring (both hosts)', () => {
  it('the Claude catalog carries a designer entry resolving to the plugin dir at the manifest version', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .claude-plugin/marketplace.json');
    strictEqual(entry.source, './plugins/designer');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version,
      'Claude catalog entry version must match the manifest version');
    ok(!INCUBATING_MARKER.test(entry.description),
      'Claude catalog description must drop the incubating marker now that ADR-0042 is Accepted');
  });

  it('the Codex catalog carries a designer entry resolving to the plugin dir', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .agents/plugins/marketplace.json');
    strictEqual(entry.source?.path, './plugins/designer');
  });
});

describe('plugins/designer — release-please + test-suite wiring', () => {
  it('release-please-config.json declares the plugins/designer package with both-manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/designer'];
    ok(pkg, 'release-please-config.json must declare the plugins/designer package');
    strictEqual(pkg['package-name'], 'plugin-designer');
    const paths = (pkg['extra-files'] || []).map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'), 'extra-files must bump the Claude manifest version');
    ok(paths.includes('.codex-plugin/plugin.json'), 'extra-files must bump the Codex manifest version');
  });

  it('.release-please-manifest.json seeds plugins/designer at 0.1.0', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(manifest['plugins/designer'], '0.1.0');
  });

  it('package.json wires the designer shape test into test:plugin-shape', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(/tests\/plugin-shape\/test-designer-plugin\.mjs/.test(pkg.scripts['test:plugin-shape']),
      'test:plugin-shape must run tests/plugin-shape/test-designer-plugin.mjs');
  });

  it('package.json wires the designer machinery unit suite into test:plugin-shape (PR2)', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    const suite = pkg.scripts['test:plugin-shape'];
    const REQUIRED_UNIT_TESTS = [
      'tests/designer/test-state.mjs',
      'tests/designer/test-dispatch-peer.mjs',
      'tests/designer/test-peer-runner.mjs',
      'tests/designer/test-session-handoff.mjs',
      'tests/designer/test-stop-archive.mjs',
      'tests/designer/test-hooks.mjs',
    ];
    for (const t of REQUIRED_UNIT_TESTS) {
      ok(suite.includes(t), `test:plugin-shape must run ${t} (PR2 machinery unit suite)`);
    }
  });
});

// ---------------------------------------------------------------------------
// PR7 — ADR-0042 Accepted. designer is a complete persona, not mid-roadmap.
// Two guard families:
//   1. Stale build-phase forward references. The surfaces were authored across
//      a seven-PR ladder and accumulated "lands at PR5A" / "at PR3" / "until
//      then" prose that is now false. (founder PR7 precedent — its Codex
//      Plan-verify peer caught the same systemic residue.)
//   2. The six designer-local defects the real-topic dogfood surfaced. Each is
//      a contradiction between two designer surfaces, so each guard pins BOTH
//      sides rather than just asserting the corrected phrasing exists.
// ---------------------------------------------------------------------------
describe('plugins/designer — de-incubated surface (PR7 / ADR-0042 Accepted)', () => {
  const STALE_BUILD_PHRASES = [
    /\bincubating\b/i,
    /lands? at PR\d/i,
    /landing at PR\d/i,
    /\(PR\d[AB]?\)\s+(?:later\s+)?holds/i,
    /at PR3\b/i,
    /flips to `Accepted`/i,
    /until then,? (?:use|read|state)/i,
    /implementation ladder/i,
    /later roadmap PRs/i,
    /stay PROVISIONAL/i,
  ];

  // Scan `.md` AND `agents/*.yaml`. The Codex Refine-verify peer caught the
  // PR7 sweep missing `skills/refine/agents/openai.yaml`, whose default_prompt
  // restated the old "gate PASSES" convergence rule: the Codex-facing surface
  // is authored in YAML, not markdown, and an .md-only scan cannot see it.
  const SURFACE_EXTS = ['.md', '.yaml', '.yml'];

  it('the designer command + skill surface carries no stale build-phase forward-references', async () => {
    const offenders = [];
    for (const root of ['commands', 'skills']) {
      const entries = await readdir(resolve(PLUGIN_ROOT, root), { recursive: true, withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !SURFACE_EXTS.some((e) => ent.name.endsWith(e))) continue;
        const parent = ent.parentPath ?? ent.path;
        const full = resolve(parent, ent.name);
        const text = await readFile(full, 'utf8');
        for (const re of STALE_BUILD_PHRASES) {
          if (re.test(text)) offenders.push(`${full.slice(PLUGIN_ROOT.length + 1)} :: ${re.source}`);
        }
      }
    }
    deepStrictEqual(offenders, [],
      `stale build-phase forward-references must be removed now that ADR-0042 is Accepted:\n  ${offenders.join('\n  ')}`);
  });

  // The gate-verdict vocabulary and the convergence predicate are restated across
  // SKILL.md / commands/*.md / agents/*.yaml. A fix applied to one surface and not
  // its siblings is the recurring defect class in this plugin — the peer found two
  // instances of it in the first PR7 pass. Pin every surface that names the rules.
  it('no designer surface — markdown OR Codex agent yaml — still requires a PASS gate to converge (F7 cross-surface)', async () => {
    const offenders = [];
    for (const root of ['commands', 'skills']) {
      const entries = await readdir(resolve(PLUGIN_ROOT, root), { recursive: true, withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !SURFACE_EXTS.some((e) => ent.name.endsWith(e))) continue;
        const parent = ent.parentPath ?? ent.path;
        const full = resolve(parent, ent.name);
        const rel = full.slice(PLUGIN_ROOT.length + 1);
        const text = await readFile(full, 'utf8');
        if (/converge[^.]{0,80}\bgate (?:PASSES|passes)\b/i.test(text)) offenders.push(`${rel} :: convergence requires gate PASS`);
        if (/gate PASS —/.test(text)) offenders.push(`${rel} :: "gate PASS —" as the clean-result example`);
      }
    }
    deepStrictEqual(offenders, [], `convergence must be "gate not FAIL" on every surface:\n  ${offenders.join('\n  ')}`);
  });

  it('the start macro approval gate uses the four-value gate vocabulary (F5 cross-surface)', async () => {
    const start = await readFile(resolve(PLUGIN_ROOT, 'skills/start/SKILL.md'), 'utf8');
    match(start, /PASS \/ CONDITIONAL \/ CANDIDATE-FAIL \/\s*\n?UNKNOWN/,
      'the direction-approval prompt must carry the same four verdicts the peer contract offers');
    match(start, /A \*\*CONDITIONAL\*\*\s*\n?direction may be recommended, but only with its remediation named as a\s*\n?blocking precondition/,
      'the start macro must allow a CONDITIONAL direction with a named precondition');
    match(start, /A \*\*CANDIDATE-FAIL\*\* direction vetoes/,
      'the start macro must keep CANDIDATE-FAIL as a veto');
  });

  // Dogfood finding F1 — ADR-0042 SD3's table renders a role for all 7 axes in
  // all 4 presets, but the shipped archetype presets carry 5. The trimming is
  // intentional; the registry must SAY so, or the next reader "fixes" it back.
  it('the registry documents that archetype presets carry a trimmed axis list on purpose (F1)', async () => {
    const yml = await readFile(resolve(PLUGIN_ROOT, 'skills/decide/references/decision-axes.yml'), 'utf8');
    match(yml, /Preset axis counts differ ON PURPOSE/,
      'decision-axes.yml must state that the archetype presets trim their axis list deliberately');
    match(yml, /is not evaluated for that decision; it is not a silent zero/,
      'decision-axes.yml must say an omitted axis is unevaluated, not zero-weighted');

    const mod = await import(
      pathToFileURL(resolve(PLUGIN_ROOT, 'scripts/decide-registry.mjs')).href);
    const { registry, fallbackTriggered } = mod.loadRegistry({});
    strictEqual(fallbackTriggered, false, 'the shipped registry must load without falling back');
    const counts = Object.fromEntries(
      Object.entries(registry.presets).map(([id, p]) => [id, p.axes.length]));
    deepStrictEqual(counts, { balanced: 7, conversion: 5, experience: 5, clarity: 5 },
      'the shipped axis counts are 7/5/5/5 — if this changes, ADR-0042 SD3\'s table must change with it');
    // Every L4 profile still resolves to a defined preset (SD3 shape invariant).
    for (const [profile, presetId] of Object.entries(mod.PROFILE_PRESET_MAP)) {
      ok(registry.presets[presetId], `L4 profile "${profile}" must resolve to a defined preset`);
    }
  });

  // Dogfood finding F3 — decide/SKILL.md claimed the gate "is never expressed as
  // a weight" while the resolver emits accessibility:1.0 and accepts an explicit
  // override. The veto is categorical; the weight is advisory. Say both.
  it('decide/SKILL.md describes the gate weight honestly — the VETO is not a weight (F3)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/decide/SKILL.md'), 'utf8');
    ok(!/gate is never expressed as a weight/i.test(skill),
      'the old claim contradicts the resolver, which emits a weight for the accessibility axis');
    match(skill, /veto is never encoded as a weight/i,
      'decide SKILL must say the VETO (not the axis) is what carries no weight');
    match(skill, /no weight \(including\s*\n?`accessibility:0`\) can remove, soften, or strengthen the veto/i,
      'decide SKILL must state that no weight value waives the veto');
  });

  // Dogfood finding F5 — the Brainstorm peer contract offered PASS /
  // CANDIDATE-FAIL / UNKNOWN, but the decide recommendation-rule is built on
  // CONDITIONAL. Observed live: the peer returned PASS for three directions and
  // demoted their real barriers into prose. The vocabularies must match.
  it('the Brainstorm ensemble gate vocabulary includes CONDITIONAL, matching decide/critique (F5)', async () => {
    const proto = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(proto, /gate verdict for the direction: PASS \/ CONDITIONAL \/\s*\n?\s*CANDIDATE-FAIL \/ UNKNOWN/,
      'Brainstorm structured_output_contract must offer the peer a CONDITIONAL verdict');
    match(proto, /Do NOT report PASS and then name a barrier in the risk areas/,
      'Brainstorm must forbid the PASS-plus-prose-barrier shape the dogfood peer produced');
    match(proto, /a peer `CONDITIONAL` adds its named\s*\n?\s*remediation to the direction's preconditions \(it does not veto\)/,
      'synthesis must map CONDITIONAL to preconditions, not to a veto');
    match(proto, /the \*\*stricter\*\* verdict holds/,
      'synthesis must resolve a gate-verdict disagreement toward the stricter verdict');

    // The four values the peer may return must be exactly the values the local
    // surfaces render (plus UNKNOWN for an under-described input).
    for (const rel of ['skills/decide/SKILL.md', 'skills/critique/SKILL.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /PASS \/ CONDITIONAL \/\s*\n?FAIL/,
        `${rel} must render the three-value gate verdict the ensemble contract mirrors`);
    }
  });

  // Dogfood finding F6 — the Brainstorm risk-area list was hardcoded to five
  // names, so under preset=conversion the peer was solicited for `feasibility`
  // (not an axis of that preset) and never for `content-clarity` (which is).
  it('the Brainstorm risk areas derive from the snapshotted axes, not a hardcoded list (F6)', async () => {
    const proto = await readFile(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md'), 'utf8');
    match(proto, /Risk areas — one per axis listed in <axis_awareness>, using that\s*\n?\s*axis's label/,
      'Brainstorm must derive the risk-area list from the axis snapshot');
    ok(!/Risk areas \(usability \/ accessibility \/ conversion \/ consistency \/\s*\n?\s*feasibility\)/.test(proto),
      'the hardcoded five-name risk-area list must be gone — it solicited axes outside the resolved preset');
  });

  // Dogfood finding F7 — refine's convergence predicate demanded a PASS gate,
  // but Non-Goal 6 makes CONDITIONAL the honest verdict for any spec naming
  // runtime-verifiable remediations. A correct design could never converge.
  it('refine converges on a CONDITIONAL gate, not only on PASS (F7)', async () => {
    const skill = await readFile(resolve(PLUGIN_ROOT, 'skills/refine/SKILL.md'), 'utf8');
    match(skill, /<!-- @refine:convergence-predicate:begin -->/,
      'refine SKILL must carry a named convergence-predicate region');
    match(skill, /`CONDITIONAL` converges \*\*on purpose\*\*/,
      'the predicate must state that CONDITIONAL converges deliberately');
    match(skill, /Requiring `PASS` to converge would mean an\s*\n?honest design never converges/,
      'the predicate must record WHY a PASS-only rule is wrong (the Non-Goal 6 tension)');
    match(skill, /What does \*\*not\*\* converge: a `FAIL` gate/,
      'the predicate must keep FAIL non-converging — the veto survives the widening');

    // No surface may still define convergence as requiring the gate to pass.
    for (const rel of ['skills/refine/SKILL.md', 'commands/refine.md', 'commands/critique.md',
      'skills/critique/SKILL.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!/converge[^.]{0,60}\bgate passes\b/i.test(text),
        `${rel} must not define convergence as requiring the accessibility gate to PASS`);
    }
  });

  // Dogfood finding F4 — the 5-tier taxonomy has no slot for independently
  // published third-party usability research. Not fixed here (a sixth tier is a
  // cross-surface contract change); the spec must name the gap so an
  // investigator neither launders the source up nor discards it.
  it('the design-brief spec names the third-party-research taxonomy gap instead of hiding it (F4)', async () => {
    const spec = await readFile(resolve(PLUGIN_ROOT, 'skills/investigate/references/design-brief-spec.md'), 'utf8');
    match(spec, /Known gap — third-party published usability research/,
      'the spec must name the taxonomy gap explicitly');
    match(spec, /Filing such a source at tier 4 is both a\s*\n?shape violation and tier laundering/,
      'the spec must forbid laundering third-party research into the first-party user-research tier');
    match(spec, /State the mismatch in the \*\*Confidence Note\*\*/,
      'the spec must require the under-ranking be disclosed, not silently absorbed');
    // The gap must not be closed by quietly redefining tier 4 — user-research
    // stays first-party and stays out of WebSearch (the PR3 peer invariant).
    match(spec, /4\. \*\*user-research\*\* — first-party research gathered for this\n   investigation/,
      'tier 4 must remain first-party by definition');
  });
});
