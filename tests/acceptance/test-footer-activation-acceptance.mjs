// ADR-0039 — completion/handoff footer activation: BLACK-BOX ACCEPTANCE.
//
// This is the holistic, cross-persona AND cross-host acceptance gate for the
// ADR-0039 series (engineer-wire → orch-wire + orch-next-action-shape →
// acceptance), extended per persona as the ADR-0043 onboardings landed (S3
// added founder; S4 added designer, completing the four-persona matrix per
// ADR-0043 §5 shared-surface serialization). The per-plugin suites
// (tests/engineer/test-footer-activation.mjs,
// tests/orchestrator/test-footer-activation.mjs,
// tests/founder/test-footer-activation.mjs,
// tests/designer/test-footer-activation.mjs) prove each path's mechanics in
// depth; THIS suite proves the same load-bearing acceptance criteria hold
// UNIFORMLY across every persona terminal path × host, driven through each
// plugin's REAL completion CLI (no direct imports of the persona internals — a
// genuine black box), plus the ADR-0010 §5 subprocess-only boundary.
//
// Acceptance criteria (per persona × host, via the real `state.mjs set-terminal`):
//   AC1  stdout stays a machine channel (EXACTLY the workflow path) — the footer
//        NEVER leaks there; the footer renders on stderr.
//   AC2  the promoted completion elements are CONCRETE: the recorded next-action
//        flows verbatim to "recommended next work", the completion state is one
//        of the mapped values (never a generic default), and the continue-vs-fresh
//        session handoff renders. Asserted for BOTH hosts (claude + codex) so the
//        codex terminal path is proven to render a concrete footer end-to-end,
//        not just claude. The PERSONA routing command in the handoff is asserted
//        HOST-LOCALIZED: the projection passes Claude-shaped routing
//        (/engineer:resume) as host-neutral data and footer.mjs
//        localizePluginCommands rewrites it to the render host's prefix, so a
//        codex user sees $engineer:resume (the former localizeRuntimeCommands
//        follow-up gap, now closed).
//   AC3  fail-closed: with a missing runtime the completion still succeeds
//        (exit 0), stdout stays path-only, NO footer, NO stale-cache fallback.
//        (The TOO-OLD gate is deliberately NOT black-box-tested here: the
//        AGENTIC_RUNTIME_ROOT env override is an explicit operator trust bypass
//        that does NOT version-gate — discover-runtime.mjs:159-168 — so the
//        version floor is a cache-ladder concern, covered precisely at the
//        resolver level by tests/{engineer,orchestrator}/test-discover-runtime.mjs
//        "too-old cache → null (no stale-cache fallback)".)
//   AC4  ADR-0010 §5 boundary: no persona plugin (engineer/orchestrator/founder)
//        STATICALLY, DYNAMICALLY, or via re-export imports the L1 runtime
//        footer.mjs; the render engine is reached only by subprocess.
//
// Host-free + deterministic: throwaway git repos + state homes; the runtime is
// pinned to the repo's own plugins/runtime via AGENTIC_RUNTIME_ROOT so discovery
// never depends on the host's plugin cache. Run via
// `node --test tests/acceptance/test-footer-activation-acceptance.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGit, runNode, runNodeOk } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime'); // pin discovery deterministically
const FOOTER_HEADER = 'Runtime completion footer (advisory)';
const BASELINE_HEAD = '1111111111111111111111111111111111111111';
// A distinctive next-action so AC2 can prove the element is concrete (the exact
// caller-supplied string reaches the footer), not a generic default.
const NEXT_ACTION = 'ACCEPTANCE-concrete-next-step-42';
// The mapped completion states each persona's set-terminal path can infer
// (footer.mjs VALID_COMPLETION_STATES / the persona's own mapper) — AC2
// asserts one of the PERSONA's states, never an arbitrary/generic value and
// never another persona's mapping (Codex Plan-verify: a shared alternation
// would have weakened the engineer/orchestrator assertions). publish-needed
// belongs only to the manually-published personas (founder/designer,
// completion-output contract §2).
const AUTO_COMMIT_STATES_RE = /completion state: (next-work-available|blocked)\b/;
const MANUAL_PUBLISH_STATES_RE = /completion state: (next-work-available|publish-needed|blocked)\b/;

function initRepo(root) {
  runGit(['init', '-q', '-b', 'feat/x'], { cwd: root });
  runGit(['config', 'user.name', 'footer-accept'], { cwd: root });
  runGit(['config', 'user.email', 'footer-accept@example.invalid'], { cwd: root });
  runGit(['config', 'commit.gpgsign', 'false'], { cwd: root });
  runGit(['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });
}

// Each persona knows how to create a workflow via its real state.mjs CLI and
// names its terminal phase. Both drive the SAME `set-terminal` completion CLI.
const PERSONAS = [
  {
    name: 'engineer',
    state: resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs'),
    branch: 'feat/x',
    terminalPhase: 'summary-complete',
    mappedStateRe: AUTO_COMMIT_STATES_RE,
    create(root, host) {
      return runNodeOk([
        this.state, 'create', '--repo-root', root,
        '--verb', 'compose', '--host', host, '--persona', 'engineer',
        '--git-baseline-branch', this.branch, '--git-baseline-head', BASELINE_HEAD,
        '--status-digest', 'deadbeef', '--profile', 'backend',
        '--original-request', 'acceptance fixture',
        '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
      ]);
    },
  },
  {
    name: 'orchestrator',
    state: resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs'),
    branch: 'main',
    terminalPhase: 'finalized',
    mappedStateRe: AUTO_COMMIT_STATES_RE,
    create(root, host) {
      // A bare macro (verb=plan → macro id); the terminal footer fires from the
      // macro handoff sidecar on set-terminal regardless of subtasks.
      return runNodeOk([
        this.state, 'create', '--repo-root', root,
        '--verb', 'plan', '--host', host,
        '--git-baseline-branch', this.branch, '--git-baseline-head', BASELINE_HEAD,
        '--status-digest', 'deadbeef', '--original-request', 'acceptance macro fixture',
      ]);
    },
  },
  {
    // ADR-0043 S3 — founder onboarding row. Same set-terminal completion CLI;
    // the BASELINE_HEAD fixture differs from the repo's real HEAD, so the
    // head_moved gate passes and AC2 observes next-work-available (the
    // publish-needed mapping is pinned in tests/founder/test-footer-activation.mjs).
    name: 'founder',
    state: resolve(REPO_ROOT, 'plugins/founder/scripts/state.mjs'),
    branch: 'feat/x',
    terminalPhase: 'summary-complete',
    mappedStateRe: MANUAL_PUBLISH_STATES_RE,
    create(root, host) {
      return runNodeOk([
        this.state, 'create', '--repo-root', root,
        '--verb', 'compose', '--host', host, '--persona', 'founder',
        '--git-baseline-branch', this.branch, '--git-baseline-head', BASELINE_HEAD,
        '--status-digest', 'deadbeef', '--profile', 'plan',
        '--original-request', 'acceptance fixture',
        '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
      ]);
    },
  },
  {
    // ADR-0043 S4 — designer onboarding row, completing the four-persona
    // matrix (§5 shared-surface serialization: the second of S3/S4 to land
    // extends this suite for its persona). Manually-published mapping like
    // founder; the publish-needed specifics are pinned in
    // tests/designer/test-footer-activation.mjs.
    name: 'designer',
    state: resolve(REPO_ROOT, 'plugins/designer/scripts/state.mjs'),
    branch: 'feat/x',
    terminalPhase: 'summary-complete',
    mappedStateRe: MANUAL_PUBLISH_STATES_RE,
    create(root, host) {
      return runNodeOk([
        this.state, 'create', '--repo-root', root,
        '--verb', 'compose', '--host', host, '--persona', 'designer',
        '--git-baseline-branch', this.branch, '--git-baseline-head', BASELINE_HEAD,
        '--status-digest', 'deadbeef', '--profile', 'general',
        '--original-request', 'acceptance fixture',
        '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
      ]);
    },
  },
];

// Both hosts run the SAME acceptance criteria — the cross-host coverage proves
// the codex terminal path renders a concrete footer end-to-end (the CLI accepts
// --host codex, the sidecar computes, footer.mjs renders), not just claude.
const HOSTS = [{ name: 'claude' }, { name: 'codex' }];

// The REAL terminal CLI shared by both personas. runtimeRoot === null forces a
// missing runtime; a string overrides the pinned runtime (e.g. a too-old stub).
function setTerminal(persona, host, root, wfPath, { runtimeRoot = RUNTIME_ROOT } = {}) {
  return runNode([
    persona.state, 'set-terminal', '--workflow-path', wfPath, '--host', host,
    '--terminal-phase', persona.terminalPhase, '--terminal-marker', 'true',
    '--next-action', NEXT_ACTION, '--event', 'updated',
  ], {
    cwd: root,
    env: { AGENTIC_RUNTIME_ROOT: runtimeRoot === null ? join(root, 'no-such-runtime') : runtimeRoot },
  });
}

function freshWorkflow(persona, host) {
  const root = mkdtempSync(join(tmpdir(), `accept-${persona.name}-${host}-`));
  initRepo(root);
  return { root, wf: persona.create(root, host) };
}

describe('ADR-0039 acceptance — cross-persona × cross-host completion-footer gate (host-free black box)', () => {
  for (const persona of PERSONAS) {
    for (const host of HOSTS) {
      describe(`${persona.name} · ${host.name}`, () => {
        it('AC1: footer on STDERR; stdout stays EXACTLY the workflow path (machine channel)', () => {
          const { root, wf } = freshWorkflow(persona, host.name);
          const res = setTerminal(persona, host.name, root, wf);
          strictEqual(res.status, 0, `set-terminal must succeed; stderr:\n${res.stderr}`);
          strictEqual(res.stdout, `${wf}\n`, 'stdout must be EXACTLY the workflow path + newline (nothing else)');
          ok(!res.stdout.includes(FOOTER_HEADER), 'the footer must NOT leak onto stdout');
          ok(res.stderr.includes(FOOTER_HEADER), 'the footer header must render on stderr');
        });

        it('AC2: elements CONCRETE (verbatim next-action, mapped completion state, session handoff)', () => {
          const { root, wf } = freshWorkflow(persona, host.name);
          const res = setTerminal(persona, host.name, root, wf);
          strictEqual(res.status, 0, res.stderr);
          // element 3/4 — the caller-supplied next-action reaches "recommended
          // next work" verbatim (concrete, not a generic default).
          ok(
            res.stderr.includes(`recommended next work: ${NEXT_ACTION}`),
            `recommended next work must carry the concrete next-action; got:\n${res.stderr}`,
          );
          // element 2 — a MAPPED completion state (not any arbitrary token),
          // drawn from THIS persona's own mapping.
          match(res.stderr, persona.mappedStateRe);
          // element 7/8 — the continue-vs-fresh session handoff renders.
          ok(res.stderr.includes('session handoff (continue-vs-fresh)'), 'the session handoff must render');
          // cross-host localization — the persona routing command renders with
          // the RENDER host's prefix (/ on claude, $ on codex), never the other
          // host's shape.
          const prefix = host.name === 'claude' ? '/' : '$';
          const wrongPrefix = host.name === 'claude' ? '$' : '/';
          ok(
            res.stderr.includes(`- routing: ${prefix}${persona.name}:resume`),
            `the persona routing must be ${host.name}-localized; got:\n${res.stderr}`,
          );
          ok(
            !res.stderr.includes(`${wrongPrefix}${persona.name}:resume`),
            `no ${wrongPrefix}-shaped persona routing may survive a ${host.name} render`,
          );
        });

        it('AC3: fail-closed on a MISSING runtime — completion succeeds, no footer, no fallback', () => {
          const { root, wf } = freshWorkflow(persona, host.name);
          const res = setTerminal(persona, host.name, root, wf, { runtimeRoot: null });
          strictEqual(res.status, 0, `completion must still succeed; stderr:\n${res.stderr}`);
          strictEqual(res.stdout, `${wf}\n`, 'stdout stays path-only on the fail-closed path');
          ok(!res.stderr.includes(FOOTER_HEADER), 'no footer when the runtime is missing');
        });
      });
    }
  }
});

describe('ADR-0039 acceptance — persona plugins reach footer.mjs only by subprocess (ADR-0010 §5)', () => {
  // The L1 runtime footer.mjs must never be imported by an L2/L3 persona plugin;
  // it is reached only via execFile subprocess. Scoped to the persona plugins —
  // the runtime plugin (and its own tests) import footer.mjs legitimately.
  //
  // STATIC-ANALYSIS LIMIT: a fully computed dynamic import
  // (`import(someRuntimeVar)` where the specifier is assembled at runtime)
  // cannot be caught by a source scan. The subprocess-only convention + code
  // review + the per-plugin footer wiring's own tests are the backstop for that
  // residual. This guard catches every LITERAL import/require/export form,
  // including re-exports and template-literal specifiers.
  const PERSONA_DIRS = ['plugins/engineer', 'plugins/orchestrator', 'plugins/founder', 'plugins/designer'];

  // Static import/export forms are anchored at LINE START (^, /m) and their
  // specifiers stay single-line ([^`'"\n]) so a subprocess string arg
  // (join(root, 'scripts', 'footer.mjs') passed to execFile) or a prose/comment
  // mention — e.g. an inline-code `import` in a doc-comment near a later
  // `footer.mjs` — is NOT flagged; only a real statement is. Dynamic import()
  // and require() are matched mid-line (they are calls, not statements). The
  // specifier char class allows ' " and ` (template-literal specifiers).
  // Multiline STATIC forms are covered by the brace/namespace patterns below
  // (their bounded bodies — [^}] / identifier — may span newlines without
  // risking prose false-positives); a fully computed dynamic import remains
  // the documented static-analysis limit above.
  const IMPORT_PATTERNS = [
    /^\s*import\b[^\n]*\bfrom\s*[`'"][^`'"\n]*footer\.mjs/m, // import … from '…footer.mjs'
    /^\s*import\s*[`'"][^`'"\n]*footer\.mjs/m,               // bare import '…footer.mjs'
    /^\s*export\b[^\n]*\bfrom\s*[`'"][^`'"\n]*footer\.mjs/m, // export {x}/ * from '…footer.mjs'
    /^\s*import\s+(?:[\w$]+\s*,\s*)?\{[^}]*\}\s*from\s*[`'"][^`'"\n]*footer\.mjs/m, // multiline named/mixed import { … \n … } from '…footer.mjs'
    /^\s*export\s+\{[^}]*\}\s*from\s*[`'"][^`'"\n]*footer\.mjs/m,                   // multiline re-export { … \n … } from '…footer.mjs'
    /^\s*import\s+\*\s*as\s+[\w$]+\s*\n?\s*from\s*[`'"][^`'"\n]*footer\.mjs/m,      // namespace import * as x from '…footer.mjs' (wrapped from)
    /\bimport\s*\(\s*[`'"][^`'"\n]*footer\.mjs/,             // dynamic import('…footer.mjs')
    /\brequire\s*\(\s*[`'"][^`'"\n]*footer\.mjs/,            // require('…footer.mjs')
  ];

  // Scan source AND markdown: a runbook that INSTRUCTS an import (in a code
  // fence) would be as much a violation of the subprocess-only contract as code.
  async function collectFiles(dir) {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out; // plugin dir absent → nothing to scan
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...await collectFiles(p));
      else if (/\.(mjs|js|cjs|md)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  for (const pdir of PERSONA_DIRS) {
    it(`${pdir} has no static, dynamic, or re-export footer.mjs import`, async () => {
      const files = await collectFiles(resolve(REPO_ROOT, pdir));
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        for (const pattern of IMPORT_PATTERNS) {
          ok(
            !pattern.test(text),
            `${file} imports the L1 runtime footer.mjs (${pattern}) — ADR-0010 §5 forbids the cross-plugin import; reach footer.mjs only via execFile subprocess`,
          );
        }
      }
    });
  }
});
