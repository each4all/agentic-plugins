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
//     privacy gate on the critique surface. PR5B lands refine; PR6 lands start +
//     meta skills + orchestration.md + L4 profiles.
//   - PR7 de-incubates: the incubating marker is removed from the manifests +
//     README, and these PRESENCE assertions flip to ABSENCE.
//
// Run via `node --test tests/plugin-shape/test-designer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/designer');

// ADR-0042 is Proposed; the persona is incubating until the PR7 dogfood
// flips it to Accepted. Until then the user-facing surfaces MUST carry
// this marker so the scaffold never reads as a shipped persona. At PR7
// these assertions flip from "must carry" to "must NOT carry" (founder
// precedent).
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

  it('carries the incubating marker (ADR-0042 Proposed — removed at PR7)', async () => {
    const json = await readJSON(path);
    ok(INCUBATING_MARKER.test(json.description),
      'Claude manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
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
    ok(INCUBATING_MARKER.test(json.description),
      'Codex manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
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
    for (const notyet of ['refine', 'start']) {
      ok(!new RegExp(`\\$designer:${notyet}\\b`).test(prompts),
        `defaultPrompt must not advertise $designer:${notyet} — it lands in a later PR`);
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

  // The shared Design Task Profile / Dynamic Orchestration reference is
  // DEFERRED to PR6 (macro plan): PR3 SKILLs carry a self-contained inline
  // Design Task Profile instead. Assert it absent so PR6 owns it cleanly.
  it('does NOT yet ship _shared/references/orchestration.md (Design Task Profile lands at PR6)', async () => {
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/_shared/references/orchestration.md')), false,
      'the shared orchestration.md (Design Task Profile + bilingual triggers) lands at PR6, not PR3');
  });

  it('the six-verb enum is NOT yet complete — refine skill absent (lands at PR5B)', async () => {
    for (const notyet of ['refine']) {
      strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills', notyet, 'SKILL.md')), false,
        `skills/${notyet}/SKILL.md lands at PR5B, not PR5A`);
      strictEqual(await exists(resolve(PLUGIN_ROOT, 'commands', `${notyet}.md`)), false,
        `commands/${notyet}.md lands at PR5B, not PR5A`);
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

  it('the PR3 verb surfaces carry the incubating next-action disclaimer (unlanded verbs directional, not runnable)', async () => {
    // Codex Plan-verify GAP: investigate/frame recommend /designer:decide +
    // /designer:compose as next commands, but those verbs are absent until PR4.
    // Each surface must disclaim that an unlanded verb's next_command is
    // directional, not runnable.
    for (const rel of [
      'skills/investigate/SKILL.md',
      'skills/frame/SKILL.md',
      'commands/investigate.md',
      'commands/frame.md',
    ]) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /incubating/i, `${rel} must carry the incubating next-action disclaimer`);
      ok(/PR4/.test(text) && /\bdirectional\b/.test(text),
        `${rel} must note decide/compose land at PR4 so an unlanded next_command is directional, not runnable`);
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

  // PR4 tests presets-defined + >=2-decisive only. The "every L4 profile
  // resolves to a defined preset" cross-check is DEFERRED to PR6 (profiles
  // land at PR6 — ADR-0042 macro plan).
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

  it('the decide/compose surfaces carry the incubating disclaimer (critique/refine/start directional, not runnable)', async () => {
    for (const rel of ['skills/decide/SKILL.md', 'skills/compose/SKILL.md', 'commands/decide.md', 'commands/compose.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /incubating/i, `${rel} must carry the incubating disclaimer`);
      ok(/PR5A|PR5B/.test(text) && /\bdirectional\b/.test(text),
        `${rel} must note critique/refine land at PR5A/PR5B so an unlanded next_command is directional, not runnable`);
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

  it('does NOT ship _shared/references/ensemble-protocol.md — critique only forward-references it (lands at PR6)', async () => {
    // Codex Plan-verify MINOR: critique forward-references the shared ensemble
    // protocol (skills/critique/SKILL.md + commands/critique.md), so guard its
    // absence until PR6 the way orchestration.md is guarded above.
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'skills/_shared/references/ensemble-protocol.md')), false,
      'the shared ensemble-protocol.md (design-anchored ensemble point types) lands at PR6; critique only forward-references it');
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

  it('the critique surface carries the incubating disclaimer (refine/start directional, not runnable)', async () => {
    for (const rel of ['skills/critique/SKILL.md', 'commands/critique.md']) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      match(text, /incubating/i, `${rel} must carry the incubating disclaimer`);
      ok(/PR5B|PR6/.test(text) && /\bdirectional\b/.test(text),
        `${rel} must note refine/start land at PR5B/PR6 so an unlanded next_command is directional, not runnable`);
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

describe('plugins/designer — inert boundary (remaining verb surfaces land in later PRs)', () => {
  // commands/ + skills/ landed across PR3 (investigate + frame) + PR4 (decide
  // + compose) + PR5A (critique); the persona dirs never ship. refine + start +
  // meta land in later PRs (asserted absent in the verb-surface suites above).
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

  it('ships README.md carrying the incubating marker AND the ADR-0042 pointer', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(INCUBATING_MARKER.test(readme),
      'plugin README must carry the incubating marker until ADR-0042 is Accepted at PR7');
    ok(/ADR-0042/.test(readme), 'plugin README must point at ADR-0042');
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
