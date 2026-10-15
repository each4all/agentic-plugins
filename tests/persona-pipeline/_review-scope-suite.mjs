// C120 — the review ledger of a document deliverable and the scope of its
// re-critique: scripts/lib/review-scope.mjs and state.mjs's critique-scope,
// critique-close, refine-record and review-status, for every persona the
// pipeline generates them into (ADR-0063, amendment of 2026-10-14).
//
// The fixtures are real git repositories with fixed commit dates; every git
// selector of the caller is scrubbed, and no AGENTIC_* variable of an
// autopilot worker reaches the commands. The cases:
//   - the cycle: a full critique, a recorded refine, a scoped re-critique of
//     the passages the refine changed and the findings it targeted
//   - an unrelated MAJOR outside the passages is left open and the critique
//     converges; a CRITICAL there is carried
//   - a target the critique leaves unresolved (no verdict, two verdicts,
//     unresolved) is carried, and recurring once a refine targeted it; a prior
//     MAJOR the refine did not target still blocks
//   - a full critique never takes the left-open route
//   - prose mixed with code, a change in a fenced block, an empty artifact set
//     and a profile other than the default are not scoped (nothing recorded
//     for code)
//   - a deletion-only refine is in scope through its anchors
//   - HEAD moved, a path added after the last critique, an edit after the
//     refine record, an operation in progress, no full critique recorded, an
//     unreadable ledger: a full critique, never scoped convergence
//   - a refine target that names no ledger finding and a stale close refuse
//   - a checkout on another branch (a second worktree sharing the state root)
//     records nothing and leaves the ledger alone; a close from there refuses
//   - a profile other than the default is partial: it resolves only what it
//     judges and is never the full baseline
//   - a narrower critique never lowers a blocking severity; an ambiguous
//     judgment keeps the highest
//   - a location spelled `./path`, `path:12:3`, `path#L12`, absolute, or on a
//     path no artifact holds still counts in scope
//   - a target is recurring only after a critique closed since its refine
//   - refine-record says whether Refine-verify may be scoped
//   - a baseline that names no commit, a conflicted checkout and an
//     unreadable ledger fall back to today's critique and refine, never abort

for (const name of Object.keys(process.env)) if (name.startsWith('AGENTIC_')) delete process.env[name];

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, match, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '2026-10-14T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-14T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

// The deliverable: an ADR whose working tree differs from the baseline commit.
const DOC = [
  '# Decision',          // 1
  '',                    // 2
  'Context paragraph.',  // 3
  '',                    // 4
  'Decision paragraph.', // 5
  '',                    // 6
  'Consequences one.',   // 7
  '',                    // 8
  'Alternatives four.',  // 9
  '',
].join('\n');
const DOC_PATH = 'docs/adr/0001-x.md';

// Executable Markdown shapes (the owner's M3 ruling): [name, text, the line a
// change touches, union, reader 1, reader 2], true for code. G3-G7 are the
// peer's counterexamples to earlier classifiers.
const shape = (lines) => `${lines.join('\n')}\n`;
const CODE_SHAPES = [
  ['G3 a quoted fence CommonMark closes early', shape(['# t', '', '   >  ```sh', '>     ```', 'echo old', '>  ```', '', 'prose']), 5, true, true, false],
  ['G4 a rejected closer that desynchronizes later fences', shape(['# t', '', '- ```sh', '  rm -rf x', '   ````', '', '```sh', 'echo hi', '```', '', 'prose']), 8, true, true, true],
  ['an unclosed final fence', shape(['# t', '', '```sh', 'echo a', '```', '', 'more', '', '```', 'echo b']), 10, true, false, true],
  ['G5 indented code behind a quote marker', shape(['# t', '', '>     > output.txt', '', 'prose']), 3, true, true, true],
  ['G6 indented code after a link definition title', shape(['[x]: http://e "title"', '    rm -rf /', '', 'prose']), 2, true, true, false],
  ['G6 indented code after an HTML comment', shape(['<!-- c', 'end -->', '    rm -rf /', '', 'prose']), 3, true, true, true],
  ['G7 a blank line inside indented code', shape(['para', '', "    printf 'a", '', "    b'", '', 'prose']), 4, true, true, true],
  ['a prose line holding three backticks before a final bare fence', shape(['```sh', 'x', '```', 'text with ``` inline', '```', 'rm -rf y']), 6, true, false, true],
  // CommonMark ends a line at a bare CR, git does not: the parser's line 5 is
  // git's line 4 (Refine-verify, 2026-10-15).
  ['a bare CR that shifts the parser\'s line numbers', 'Intro\rcontinued\ragain\n\n```sh\necho old\n', 4, true, false, true],
  // CommonMark reads an explicit HTML code block as an html_block, not a
  // code_block: reader 2 counts every HTML block (owner's ruling, 2026-10-15).
  ['an explicit HTML code block', shape(['# t', '', '<pre><code class="language-sh">', 'rm -rf x', '</code></pre>', '', 'prose']), 4, true, false, true],
  ['plain ADR prose after a closed fence', shape(['# ADR', '', 'Some prose here.', '', '```sh', 'x', '```', '', 'Tail prose.']), 9, false, false, false],
];

function write(top, rel, text) {
  mkdirSync(dirname(join(top, rel)), { recursive: true });
  writeFileSync(join(top, rel), text);
}

function replaceLine(top, rel, n, text) {
  const lines = readFileSync(join(top, rel), 'utf8').split('\n');
  lines[n - 1] = text;
  writeFileSync(join(top, rel), lines.join('\n'));
}

// The suite for one persona; test-review-scope-<persona>.mjs each run one, so
// node --test runs the personas' fixtures in parallel.
export async function reviewScopeSuite(persona) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const state = await import(pathToFileURL(STATE).href);
  const lib = await import(pathToFileURL(P.path('scripts/lib/review-scope.mjs')).href);

  const cli = (args, cwd) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: cleanEnv(), cwd });
  const json = (r) => {
    strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  async function fixture(fn, { extra = {}, head = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), `${persona}-review-scope-`));
    try {
      const top = join(dir, 'repo');
      mkdirSync(top);
      git(top, 'init', '-q', '-b', 'feat/doc');
      write(top, DOC_PATH, '# Decision\n\nDraft.\n');
      write(top, 'scripts/run.mjs', 'export const x = 1;\n');
      write(top, 'docs/runbook.md', '# Runbook\n\n```bash\necho one\n```\n');
      for (const [rel, text] of Object.entries(extra)) write(top, rel, text);
      git(top, 'add', '-A');
      git(top, 'commit', '-q', '-m', 'base');
      const base = git(top, 'rev-parse', 'HEAD').trim();
      write(top, DOC_PATH, DOC);
      const { filePath } = await state.createWorkflow({
        repoRoot: top, verb: 'critique', host: 'claude',
        gitBaseline: { branch: 'feat/doc', head: head === null ? base : head(base), status_digest: '' },
        originalRequest: 'review scope', currentPhase: 'phase-0-bootstrap',
      });
      const tmp = join(dir, 'texts');
      mkdirSync(tmp);
      let n = 0;
      const file = (value) => {
        n += 1;
        const p = join(tmp, `f${n}.json`);
        writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
        return p;
      };
      const ctx = {
        top, wf: filePath, base,
        // The ledger the last recorded scope named, which a close names.
        ledger: null,
        scope: (profile) => {
          const s = json(cli(['critique-scope', '--workflow-path', filePath, '--repo-root', top, ...(profile === undefined ? [] : ['--profile', profile])], top));
          if (s.recorded) ctx.ledger = s.ledger;
          return s;
        },
        close: (generation, findings) => json(ctx.closeRaw(generation, findings)),
        closeRaw: (generation, findings, ledger = ctx.ledger) => cli(['critique-close', '--workflow-path', filePath, '--repo-root', top, '--ledger', String(ledger), '--generation', String(generation), '--findings-file', file({ findings })], top),
        record: (targets) => json(cli(['refine-record', '--workflow-path', filePath, '--repo-root', top, '--targets-file', file(targets.join('\n') + '\n')], top)),
        recordRaw: (targets) => cli(['refine-record', '--workflow-path', filePath, '--repo-root', top, '--targets-file', file(targets)], top),
        status: () => json(cli(['review-status', '--workflow-path', filePath], top)),
        ledgerFile: () => {
          const dirPath = join(dirname(dirname(filePath)), 'reviews');
          return join(dirPath, readdirSync(dirPath).find((f) => f.endsWith('.json')));
        },
      };
      await fn(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // A full critique with a MAJOR in the decision paragraph (line 5), a MAJOR in
  // the context paragraph (line 3) and a MINOR, then a refine of line 5 that
  // targets only the first.
  function fullThenRefine(ctx, { targets = ['G1-F1'], edit = () => replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.') } = {}) {
    const first = ctx.scope();
    strictEqual(first.recorded, true);
    strictEqual(first.mode, 'full');
    strictEqual(first.reason, 'no-full-critique-recorded');
    const closed = ctx.close(first.generation, [
      { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'decision is ambiguous' },
      { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:3`, text: 'context omits the incident' },
      { id: 'NEW', severity: 'MINOR', location: `${DOC_PATH}:7`, text: 'wording' },
    ]);
    deepStrictEqual(closed.carry, ['G1-F1', 'G1-F2']);
    strictEqual(closed.converged, false);
    edit();
    const attempt = ctx.record(targets);
    strictEqual(attempt.recorded, true);
    strictEqual(attempt.attempt, 'R1');
    return attempt;
  }

  describe(`${persona}: document re-critique scope (C120)`, () => {
    it('a full critique, a recorded refine, then a scoped critique of the changed passage and the targeted finding', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        strictEqual(scope.generation, 2);
        deepStrictEqual(scope.targets, ['G1-F1', 'G1-F2']);
        deepStrictEqual(scope.passages.map((p) => [p.path, p.start, p.end]), [[DOC_PATH, 5, 5]]);
        strictEqual(scope.passages[0].text, 'Decision paragraph, revised.');
        strictEqual(scope.passages[0].before, 'Decision paragraph.');
        ok(scope.findings.some((f) => f.id === 'G1-F1' && f.disposition === 'open'));
        // An unrelated MAJOR outside the passage is left open: converged.
        const closed = ctx.close(2, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
          { id: 'NEW', severity: 'MINOR', location: `${DOC_PATH}:5`, text: 'comma' },
        ]);
        strictEqual(closed.mode, 'scoped');
        strictEqual(closed.converged, true);
        deepStrictEqual(closed.carry, []);
        deepStrictEqual(closed.left_open_now, ['G2-F1']);
        deepStrictEqual(closed.new, ['G2-F1', 'G2-F2']);
        deepStrictEqual(ctx.status().left_open, ['G2-F1']);
      });
    });

    it('a new CRITICAL outside the passages is carried, not left open', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped');
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'CRITICAL', location: `${DOC_PATH}:9`, text: 'contradicts ADR-0001', scope: 'outside' },
        ]);
        strictEqual(closed.converged, false);
        deepStrictEqual(closed.carry, ['G2-F1']);
        deepStrictEqual(closed.left_open_now, []);
      });
    });

    it('a finding claimed outside but located in a passage counts in scope', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'new gap in the revision', scope: 'outside' },
        ]);
        deepStrictEqual(closed.carry, ['G2-F1']);
        strictEqual(closed.converged, false);
      });
    });

    it('a target left unresolved is carried and recurring; no verdict and two verdicts count unresolved', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'unresolved' },
        ]);
        deepStrictEqual(closed.carry, ['G1-F1', 'G1-F2']);
        deepStrictEqual(closed.recurring, ['G1-F1', 'G1-F2']);
        deepStrictEqual(ctx.status().recurring, ['G1-F1', 'G1-F2']);
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'unresolved', location: `${DOC_PATH}:5` },
          { id: 'G1-F2', verdict: 'resolved' },
        ]);
        deepStrictEqual(closed.carry, ['G1-F1']);
        deepStrictEqual(closed.recurring, ['G1-F1']);
      });
    });

    it('a prior MAJOR the refine did not target still blocks the scoped critique', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1'] });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped');
        const closed = ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }]);
        deepStrictEqual(closed.carry, ['G1-F2']);
        strictEqual(closed.converged, false);
        deepStrictEqual(closed.recurring, [], 'no refine targeted G1-F2 yet');
      });
    });

    it('a full critique carries every new MAJOR wherever it is, and resolves a prior finding it does not report', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        replaceLine(ctx.top, DOC_PATH, 9, 'Alternatives, edited after the record.');
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        const closed = ctx.close(scope.generation, [
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
        ]);
        strictEqual(closed.mode, 'full');
        deepStrictEqual(closed.carry, ['G2-F1']);
        deepStrictEqual(closed.left_open, []);
        strictEqual(closed.converged, false);
        ok(closed.resolved.includes('G1-F1') && closed.resolved.includes('G1-F2'));
      });
    });

    it('another profile is partial: it resolves nothing it does not judge and is no full baseline', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope('a-narrower-lens');
        strictEqual(scope.recorded, true);
        strictEqual(scope.mode, 'partial');
        strictEqual(scope.reason, 'not-the-default-profile');
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
        ]);
        strictEqual(closed.mode, 'partial');
        deepStrictEqual(closed.resolved, ['G1-F1']);
        deepStrictEqual(closed.carry, ['G1-F2', 'G2-F1'], 'the MAJOR it did not report stays open; its own is carried');
        deepStrictEqual(closed.left_open, []);
        strictEqual(closed.converged, false);
        ctx.record(['G1-F2', 'G2-F1']);
        const next = ctx.scope();
        strictEqual(next.mode, 'full');
        strictEqual(next.reason, 'last-critique-had-another-profile');
      });
      // A partial critique alone is no full baseline either.
      await fixture(async (ctx) => {
        const first = ctx.scope('a-narrower-lens');
        strictEqual(first.mode, 'partial');
        ctx.close(first.generation, []);
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
        ctx.record([]);
        strictEqual(ctx.scope().reason, 'no-full-critique-recorded');
      });
    });

    it('a narrower critique never lowers a blocking severity, and an ambiguous judgment keeps the highest', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped');
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'unresolved', severity: 'MAJOR' },
          { id: 'G1-F1', verdict: 'resolved', severity: 'MINOR' },
          { id: 'G1-F2', verdict: 'unresolved', severity: 'MINOR' },
        ]);
        deepStrictEqual(closed.carry, ['G1-F1', 'G1-F2']);
        strictEqual(closed.converged, false);
        const sev = Object.fromEntries(ctx.status().findings.map((f) => [f.id, f.severity]));
        strictEqual(sev['G1-F1'], 'MAJOR');
        strictEqual(sev['G1-F2'], 'MAJOR');
      });
      // A full critique re-judges: a single, unambiguous MINOR lowers it.
      await fixture(async (ctx) => {
        const first = ctx.scope();
        ctx.close(first.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x' }]);
        replaceLine(ctx.top, DOC_PATH, 9, 'Edited without a refine record.');
        const again = ctx.scope();
        strictEqual(again.mode, 'full');
        const closed = ctx.close(again.generation, [{ id: 'G1-F1', verdict: 'unresolved', severity: 'MINOR' }]);
        deepStrictEqual(closed.carry, []);
        strictEqual(ctx.status().findings[0].severity, 'MINOR');
      });
    });

    it('a location spelled another way still counts in the passage it names; an unknown path counts in scope', async () => {
      for (const location of [`./${DOC_PATH}:5`, `${DOC_PATH}:5:3`, `${DOC_PATH}#L5`, `${DOC_PATH}:L5`, `\`${DOC_PATH}\`:5`, 'ABS', 'docs/adr/other.md:9', `other/${DOC_PATH}:9`, '#L9']) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
          const scope = ctx.scope();
          const closed = ctx.close(scope.generation, [
            { id: 'G1-F1', verdict: 'resolved' },
            { id: 'G1-F2', verdict: 'resolved' },
            { id: 'NEW', severity: 'MAJOR', location: location === 'ABS' ? `${ctx.top}/${DOC_PATH}:5` : location, text: 'a gap', scope: 'outside' },
          ]);
          deepStrictEqual(closed.carry, ['G2-F1'], location);
          strictEqual(closed.converged, false, location);
        });
      }
      // The same spellings outside the passage stay outside.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `./${DOC_PATH}:9`, text: 'a', scope: 'outside' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}#L9`, text: 'b', scope: 'outside' },
          { id: 'NEW', severity: 'MAJOR', location: `${ctx.top}/${DOC_PATH}:9:1`, text: 'c', scope: 'outside' },
        ]);
        deepStrictEqual(closed.left_open_now, ['G2-F1', 'G2-F2', 'G2-F3']);
        strictEqual(closed.converged, true);
      });
    });

    it('a target is recurring only once a critique closed after its refine left it open', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const status = ctx.status();
        deepStrictEqual(status.carry, ['G1-F1', 'G1-F2']);
        deepStrictEqual(status.recurring, [], 'no critique has judged the refine yet');
        // A retried record before the next critique is still not recurring.
        ctx.record(['G1-F1']);
        deepStrictEqual(ctx.status().recurring, []);
        const scope = ctx.scope();
        ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'unresolved' }, { id: 'G1-F2', verdict: 'resolved' }]);
        deepStrictEqual(ctx.status().recurring, ['G1-F1']);
      });
      // A partial critique that does not report a target judged nothing: not
      // recurring. One that reports it unresolved did judge it.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const partial = ctx.scope('a-narrower-lens');
        strictEqual(partial.mode, 'partial');
        ctx.close(partial.generation, [{ id: 'G1-F2', verdict: 'unresolved' }]);
        deepStrictEqual(ctx.status().recurring, ['G1-F2']);
      });
    });

    it('refine-record says whether Refine-verify may be scoped, on the same conditions as the next critique', async () => {
      await fixture(async (ctx) => {
        const attempt = fullThenRefine(ctx, { targets: ['G1-F1'] });
        deepStrictEqual(attempt.verify, { mode: 'scoped', reason: 'scoped' });
      });
      await fixture(async (ctx) => {
        const attempt = fullThenRefine(ctx, {
          edit: () => {
            replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
            write(ctx.top, 'scripts/run.mjs', 'export const x = 2;\n');
          },
        });
        deepStrictEqual(attempt.verify, { mode: 'full', reason: 'not-prose:scripts/run.mjs' });
      });
      await fixture(async (ctx) => {
        const first = ctx.scope();
        ctx.close(first.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x' }]);
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
        git(ctx.top, 'commit', '-q', '--allow-empty', '-m', 'moved');
        deepStrictEqual(ctx.record(['G1-F1']).verify, { mode: 'full', reason: 'head-moved' });
      });
      await fixture(async (ctx) => {
        const first = ctx.scope('a-narrower-lens');
        ctx.close(first.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x' }]);
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
        deepStrictEqual(ctx.record(['G1-F1']).verify, { mode: 'full', reason: 'no-full-critique-recorded' });
      });
    });

    it('a baseline that names no commit records nothing: symbolic, unresolvable, abbreviated', async () => {
      for (const head of [() => 'HEAD', () => 'feat/doc', () => 'f'.repeat(40), (b) => b.slice(0, 12)]) {
        await fixture(async (ctx) => {
          const scope = ctx.scope();
          strictEqual(scope.recorded, false);
          strictEqual(scope.mode, 'full');
          strictEqual(scope.reason, 'no-baseline-commit');
          strictEqual(ctx.status().ledger, false);
        }, { head });
      }
    });

    it('a checkout it cannot read, or an unreadable ledger, falls back instead of failing', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        // A conflicted merge: the index holds unmerged paths.
        git(ctx.top, 'checkout', '-q', '-b', 'side');
        write(ctx.top, 'notes.md', 'side\n');
        git(ctx.top, 'add', 'notes.md');
        git(ctx.top, 'commit', '-q', '-m', 'side');
        git(ctx.top, 'checkout', '-q', 'feat/doc');
        write(ctx.top, 'notes.md', 'main\n');
        git(ctx.top, 'add', 'notes.md');
        git(ctx.top, 'commit', '-q', '-m', 'main');
        strictEqual(spawnSync('git', ['-C', ctx.top, 'merge', '-q', 'side'], { env: cleanEnv() }).status, 1, 'the merge conflicts');
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, 'checkout-unreadable:unmerged-index');
        ok(existsSync(scope.ledger_moved_aside), 'a critique the ledger did not record supersedes it');
        strictEqual(ctx.status().ledger, false);
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        writeFileSync(ctx.ledgerFile(), '{not json');
        deepStrictEqual(ctx.status(), { ledger: false, reason: 'unreadable-ledger' });
        const rec = ctx.record(['G1-F1']);
        strictEqual(rec.recorded, false);
        strictEqual(rec.reason, 'unreadable-ledger');
        strictEqual(rec.verify.mode, 'full');
      });
    });

    it('a deletion-only refine is in scope through the blocks around the deletion', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, {
          targets: ['G1-F1'],
          edit: () => {
            const lines = readFileSync(join(ctx.top, DOC_PATH), 'utf8').split('\n');
            lines.splice(4, 2); // the decision paragraph and the blank after it
            writeFileSync(join(ctx.top, DOC_PATH), lines.join('\n'));
          },
        });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        deepStrictEqual(scope.passages.map((p) => [p.start, p.end]), [[3, 3], [5, 5]]);
        ok(scope.passages.some((p) => p.before.includes('Decision paragraph.')), 'the deleted text is shown');
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'consequences now dangle', scope: 'outside' },
        ]);
        deepStrictEqual(closed.carry, ['G1-F2', 'G2-F1'], 'the anchor block is in scope');
      });
    });

    it('prose mixed with code, a fenced-block change and an empty artifact set record nothing and stay full', async () => {
      await fixture(async (ctx) => {
        write(ctx.top, 'scripts/run.mjs', 'export const x = 2;\n');
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'not-prose:scripts/run.mjs');
        strictEqual(ctx.status().ledger, false, 'no ledger for a code deliverable');
        strictEqual(ctx.record(['G1-F1']).recorded, false, 'refine-record records nothing without a ledger');
      });
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/runbook.md', '# Runbook\n\n```bash\necho two\n```\n');
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, 'code-changed:docs/runbook.md');
      });
      await fixture(async (ctx) => {
        // A fence added (only the new side holds it) and a fence removed
        // (only the old side did) are each a code change.
        write(ctx.top, 'docs/runbook.md', '# Runbook\n\n```bash\necho one\n```\n\n```sh\nrm -rf x\n```\n');
        strictEqual(ctx.scope().reason, 'code-changed:docs/runbook.md');
      });
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/runbook.md', '# Runbook\n');
        strictEqual(ctx.scope().reason, 'code-changed:docs/runbook.md');
      });
      await fixture(async (ctx) => {
        // Prose around a fence may change; the fence may not.
        write(ctx.top, 'docs/runbook.md', '# Runbook\n\nIntro.\n\n```bash\necho one\n```\n');
        strictEqual(ctx.scope().recorded, true);
      });
      await fixture(async (ctx) => {
        git(ctx.top, 'checkout', '--', DOC_PATH);
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, 'empty-artifact-set');
      });
    });

    it('two identical resolved verdicts on a target still count unresolved', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
        ]);
        deepStrictEqual(closed.carry, ['G1-F1']);
      });
    });

    it('a left-open finding reported again outside the passages stays left open; one in a changed passage is carried', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        let scope = ctx.scope();
        ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:7`, text: 'consequences vague', scope: 'outside' },
        ]);
        // A refine with no targets touches the consequences paragraph only.
        replaceLine(ctx.top, DOC_PATH, 7, 'Consequences one, sharpened.');
        ctx.record([]);
        scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        const closed = ctx.close(scope.generation, [
          { id: 'G2-F1', verdict: 'unresolved', location: `${DOC_PATH}:9` },
          { id: 'G2-F2', verdict: 'unresolved', location: `${DOC_PATH}:7` },
        ]);
        deepStrictEqual(closed.left_open, ['G2-F1']);
        deepStrictEqual(closed.carry, ['G2-F2']);
      });
    });

    // A left-open finding re-reported after a refine: the ledger's location is
    // in the coordinates of the text it was found in, which the refine may have
    // shifted, so only this critique's reports can place it outside, all of them.
    it('a re-reported left-open finding stays left open only when every report places it outside now', async () => {
      const leftOpenThenRefine = (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const first = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
        ]);
        deepStrictEqual(first.left_open, ['G2-F1']);
        // The refine inserts a paragraph above it: the alternatives paragraph
        // moves from line 9 to 11, and the new paragraph is line 5.
        replaceLine(ctx.top, DOC_PATH, 3, 'Context paragraph.\n\nA new paragraph.');
        ctx.record([]);
        const next = ctx.scope();
        strictEqual(next.mode, 'scoped', next.reason);
        return next;
      };
      const cases = [
        // Control: reported at its current line, outside the passages.
        { refs: [{ location: `${DOC_PATH}:11` }], left: true },
        // No location: the ledger's line 9 no longer names it, so it is not
        // shown outside.
        { refs: [{}], left: false },
        // Two reports, in then outside, and the reverse: either way one
        // places it in a passage.
        { refs: [{ location: `${DOC_PATH}:5` }, { location: `${DOC_PATH}:11` }], left: false },
        { refs: [{ location: `${DOC_PATH}:11` }, { location: `${DOC_PATH}:5` }], left: false },
      ];
      for (const { refs, left } of cases) {
        await fixture(async (ctx) => {
          const scope = leftOpenThenRefine(ctx);
          ok(scope.passages.some((p) => p.start <= 5 && p.end >= 5), JSON.stringify(scope.passages));
          ok(!scope.passages.some((p) => p.start <= 11 && p.end >= 11), JSON.stringify(scope.passages));
          const closed = ctx.close(scope.generation, refs.map((r) => ({ id: 'G2-F1', verdict: 'unresolved', ...r })));
          deepStrictEqual(closed.left_open, left ? ['G2-F1'] : [], JSON.stringify(refs));
          deepStrictEqual(closed.carry, left ? [] : ['G2-F1'], JSON.stringify(refs));
          strictEqual(closed.converged, left, JSON.stringify(refs));
        });
      }
    });

    it('a resolved finding a refine targets again is carried when the scoped critique gives it no verdict', async () => {
      for (const refs of [[], [{ id: 'G1-F1', verdict: 'resolved' }]]) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
          let scope = ctx.scope();
          const first = ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }, { id: 'G1-F2', verdict: 'resolved' }]);
          strictEqual(first.converged, true);
          // The refine edits the decision paragraph again and targets G1-F1.
          replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised twice.');
          ctx.record(['G1-F1']);
          scope = ctx.scope();
          strictEqual(scope.mode, 'scoped', scope.reason);
          deepStrictEqual(scope.targets, ['G1-F1']);
          ok(scope.findings.some((f) => f.id === 'G1-F1' && f.disposition === 'resolved'), 'the reviewer gets the target to judge');
          const closed = ctx.close(scope.generation, refs);
          const carried = refs.length === 0; // control: one resolved verdict
          deepStrictEqual(closed.carry, carried ? ['G1-F1'] : [], JSON.stringify(refs));
          strictEqual(closed.converged, !carried, JSON.stringify(refs));
        });
      }
    });

    // A resolution of an untargeted finding the scoped critique cannot place
    // in a passage is not taken, but the rest of the report still counts.
    it('a resolution not taken keeps the severity it reports and the left-open placement rule', async () => {
      // A left-open MAJOR reported resolved with no location is carried; with
      // every report outside it stays left open (control).
      for (const [ref, left] of [[{}, false], [{ location: `${DOC_PATH}:9`, scope: 'outside' }, true]]) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
          let scope = ctx.scope();
          ctx.close(scope.generation, [
            { id: 'G1-F1', verdict: 'resolved' },
            { id: 'G1-F2', verdict: 'resolved' },
            { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
          ]);
          replaceLine(ctx.top, DOC_PATH, 7, 'Consequences one, sharpened.');
          ctx.record([]);
          scope = ctx.scope();
          strictEqual(scope.mode, 'scoped', scope.reason);
          const closed = ctx.close(scope.generation, [{ id: 'G2-F1', verdict: 'resolved', ...ref }]);
          deepStrictEqual(closed.left_open, left ? ['G2-F1'] : [], JSON.stringify(ref));
          deepStrictEqual(closed.carry, left ? [] : ['G2-F1'], JSON.stringify(ref));
        });
      }
      // An open MINOR reported resolved at MAJOR outside the passages: the
      // resolution is not taken, the MAJOR is, and it is carried.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'G1-F3', verdict: 'resolved', severity: 'MAJOR', location: `${DOC_PATH}:7` },
        ]);
        deepStrictEqual(closed.carry, ['G1-F3']);
        strictEqual(closed.converged, false);
      });
      // Two resolved reports of an untargeted MAJOR, one in a passage and one
      // outside, in either order: not every report places it, so it stays open.
      for (const order of [[5, 3], [3, 5]]) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1'] });
          const scope = ctx.scope();
          const closed = ctx.close(scope.generation, [
            { id: 'G1-F1', verdict: 'resolved' },
            ...order.map((n) => ({ id: 'G1-F2', verdict: 'resolved', location: `${DOC_PATH}:${n}` })),
          ]);
          deepStrictEqual(closed.carry, ['G1-F2'], JSON.stringify(order));
        });
      }
      // A resolved finding reported resolved again outside the passages stays
      // resolved.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        let scope = ctx.scope();
        ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }, { id: 'G1-F2', verdict: 'resolved' }]);
        replaceLine(ctx.top, DOC_PATH, 7, 'Consequences one, sharpened.');
        ctx.record([]);
        scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        const closed = ctx.close(scope.generation, [{ id: 'G1-F2', verdict: 'resolved', location: `${DOC_PATH}:3` }]);
        deepStrictEqual(closed.carry, []);
        strictEqual(closed.converged, true);
      });
    });

    // A partial critique keeps the refine's targets: one its lens does not
    // judge is carried, and is not recurring for it.
    it('a partial critique carries a target it does not judge, a resolved one targeted again included', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        let scope = ctx.scope();
        ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }, { id: 'G1-F2', verdict: 'resolved' }]);
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised twice.');
        ctx.record(['G1-F1']);
        scope = ctx.scope('a-narrower-lens');
        strictEqual(scope.mode, 'partial');
        deepStrictEqual(scope.targets, ['G1-F1']);
        ok(scope.findings.some((f) => f.id === 'G1-F1'), 'the reviewer gets the target to judge');
        const closed = ctx.close(scope.generation, []);
        deepStrictEqual(closed.carry, ['G1-F1']);
        strictEqual(closed.converged, false);
        deepStrictEqual(closed.recurring, []);
        // A second partial critique, with no refine between, still holds it: two
        // resolved verdicts are no single one.
        scope = ctx.scope('a-narrower-lens');
        deepStrictEqual(scope.targets, ['G1-F1']);
        const again = ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }, { id: 'G1-F1', verdict: 'resolved' }]);
        deepStrictEqual(again.carry, ['G1-F1']);
        deepStrictEqual(again.recurring, ['G1-F1']);
        // One resolved verdict resolves it, and a later partial critique does
        // not take it up again.
        scope = ctx.scope('a-narrower-lens');
        const resolved = ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }]);
        deepStrictEqual(resolved.carry, []);
        scope = ctx.scope('a-narrower-lens');
        deepStrictEqual(scope.targets, []);
        strictEqual(ctx.close(scope.generation, []).converged, true);
      });
    });

    // A full critique judges every target: one it does not report is no
    // target of a later partial critique, even one already resolved.
    it('a full critique retires a target it does not report, a resolved one included', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        let scope = ctx.scope();
        ctx.close(scope.generation, [{ id: 'G1-F1', verdict: 'resolved' }, { id: 'G1-F2', verdict: 'resolved' }]);
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised twice.');
        ctx.record(['G1-F1']);
        // A commit makes the next critique full.
        git(ctx.top, 'add', '-A');
        git(ctx.top, 'commit', '-q', '-m', 'refined');
        scope = ctx.scope();
        strictEqual(scope.mode, 'full', scope.reason);
        strictEqual(ctx.close(scope.generation, []).converged, true);
        scope = ctx.scope('a-narrower-lens');
        strictEqual(scope.mode, 'partial');
        deepStrictEqual(scope.targets, []);
        const closed = ctx.close(scope.generation, []);
        deepStrictEqual(closed.carry, []);
        strictEqual(closed.converged, true);
      });
    });

    // A refine that targets a left-open finding takes it back from the owner:
    // the scoped critique judges it as any target, wherever it lies.
    it('a left-open finding a refine targeted is carried when unresolved, unjudged or judged twice', async () => {
      const cases = [
        // Control: one resolved verdict resolves it.
        { refs: [{ verdict: 'resolved' }], carried: false },
        { refs: [{ verdict: 'unresolved', location: `${DOC_PATH}:9`, scope: 'outside' }], carried: true },
        { refs: [], carried: true },
        { refs: [{ verdict: 'resolved', location: `${DOC_PATH}:9`, scope: 'outside' }, { verdict: 'resolved', location: `${DOC_PATH}:9`, scope: 'outside' }], carried: true },
      ];
      for (const { refs, carried } of cases) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
          let scope = ctx.scope();
          const first = ctx.close(scope.generation, [
            { id: 'G1-F1', verdict: 'resolved' },
            { id: 'G1-F2', verdict: 'resolved' },
            { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'alternatives thin', scope: 'outside' },
          ]);
          deepStrictEqual(first.left_open, ['G2-F1']);
          // The refine targets it but edits another paragraph.
          replaceLine(ctx.top, DOC_PATH, 7, 'Consequences one, sharpened.');
          ctx.record(['G2-F1']);
          scope = ctx.scope();
          strictEqual(scope.mode, 'scoped', scope.reason);
          deepStrictEqual(scope.targets, ['G2-F1']);
          const closed = ctx.close(scope.generation, refs.map((r) => ({ id: 'G2-F1', ...r })));
          const why = JSON.stringify(refs);
          deepStrictEqual(closed.carry, carried ? ['G2-F1'] : [], why);
          deepStrictEqual(closed.left_open, [], why);
          strictEqual(closed.converged, !carried, why);
          deepStrictEqual(closed.recurring, carried ? ['G2-F1'] : [], why);
        });
      }
    });

    it('a new finding with no location cannot be shown outside; a reversed range is refused', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scope = ctx.scope();
        const reversed = ctx.closeRaw(scope.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9-3`, text: 'x' }]);
        strictEqual(reversed.status, 1);
        match(reversed.stderr, /names no line range/);
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', text: 'somewhere', scope: 'outside' },
          { id: 'NEW', severity: 'MAJOR', location: '', text: 'nowhere', scope: 'outside' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'marked in', scope: 'in' },
        ]);
        deepStrictEqual(closed.carry, ['G2-F1', 'G2-F2', 'G2-F3']);
        strictEqual(closed.converged, false);
      });
    });

    it('a refine that leaves the file with no block makes the whole file the passage', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'], edit: () => writeFileSync(join(ctx.top, DOC_PATH), '\n') });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        ok(scope.passages.some((p) => p.whole), 'a whole-file passage');
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
          { id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:1`, text: 'the decision is gone', scope: 'outside' },
        ]);
        deepStrictEqual(closed.carry, ['G2-F1']);
      });
    });

    it('a fence inside a block quote or a list item is code', async () => {
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/runbook.md', '# Runbook\n\n```bash\necho one\n```\n\n> ```sh\n> echo two\n> ```\n');
        strictEqual(ctx.scope().reason, 'code-changed:docs/runbook.md');
      }, { extra: {} });
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/runbook.md', '# Runbook\n\n```bash\necho one\n```\n\n- step\n\n    ```sh\n    echo two\n    ```\n');
        strictEqual(ctx.scope().reason, 'code-changed:docs/runbook.md');
      });
      // A fence that opens on the list marker's own line: a change to the
      // command inside it is code, and its closer closes it.
      const listFence = (cmd) => `# Runbook\n\n- \`\`\`sh\n  ${cmd}\n  \`\`\`\n\nAfter.\n`;
      for (const marker of ['-', '1.']) {
        await fixture(async (ctx) => {
          write(ctx.top, 'docs/runbook.md', listFence('echo two').replace('- ', `${marker} `));
          strictEqual(ctx.scope().reason, 'code-changed:docs/runbook.md', marker);
        }, { extra: { 'docs/runbook.md': listFence('echo one').replace('- ', `${marker} `) } });
      }
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/runbook.md', listFence('echo one').replace('After.', 'After, revised.'));
        strictEqual(ctx.scope().recorded, true, 'prose after the closed fence is prose');
      }, { extra: { 'docs/runbook.md': listFence('echo one') } });
    });

    it('a malformed ledger entry moves the ledger aside', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        const file = ctx.ledgerFile();
        const ledger = JSON.parse(readFileSync(file, 'utf8'));
        ledger.generations.push(null);
        writeFileSync(file, JSON.stringify(ledger));
        const scope = ctx.scope();
        strictEqual(scope.reason, 'no-full-critique-recorded');
        ok(existsSync(scope.ledger_moved_aside));
      });
      // A passage whose range is not one would bound the left-open route
      // wrongly: the ledger is not used.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scoped = ctx.scope();
        strictEqual(scoped.mode, 'scoped');
        const file = ctx.ledgerFile();
        const ledger = JSON.parse(readFileSync(file, 'utf8'));
        // Each malformed passage is refused by the close itself, which reads
        // the open generation (review-status reads no ledger while one is open).
        const closeAgainst = (passage) => {
          const bad = structuredClone(ledger);
          Object.assign(bad.generations.at(-1).passages[0], passage);
          writeFileSync(file, JSON.stringify(bad));
          const r = ctx.closeRaw(scoped.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x', scope: 'outside' }]);
          strictEqual(r.status, 1, `no close against ${JSON.stringify(passage)}`);
          match(r.stderr, /generations\[1\] is malformed/);
        };
        closeAgainst({ start: 9, end: 3 });
        // Nor one on a path the generation's artifact set does not hold.
        closeAgainst({ path: 'docs/not-an-artifact.md' });
        ok(existsSync(ctx.scope().ledger_moved_aside));
      });
      // Generation ids out of order would defeat the unclosed-critique rule.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scoped = ctx.scope();
        const file = ctx.ledgerFile();
        const ledger = JSON.parse(readFileSync(file, 'utf8'));
        ledger.generations.at(-1).id = 1;
        writeFileSync(file, JSON.stringify(ledger));
        strictEqual(ctx.status().ledger, false);
        strictEqual(ctx.record(['G1-F1']).recorded, false);
        strictEqual(ctx.scope().reason, 'no-full-critique-recorded');
        strictEqual(scoped.generation, 2);
      });
    });

    it('a document that turns into code drops its ledger: refine reads no stale findings', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        write(ctx.top, 'scripts/run.mjs', 'export const x = 2;\n');
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        ok(existsSync(scope.ledger_moved_aside), 'the ledger is kept aside, not deleted');
        strictEqual(ctx.status().ledger, false);
        strictEqual(ctx.record(['G1-F1']).recorded, false);
      });
    });

    it('HEAD moved, a path added since the last critique, an edit after the refine record: full', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        git(ctx.top, 'commit', '-q', '--allow-empty', '-m', 'moved');
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'head-moved');
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx, {
          edit: () => {
            replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
            write(ctx.top, 'docs/adr/0002-y.md', '# Another\n');
          },
        });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'artifact-set-changed');
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        replaceLine(ctx.top, DOC_PATH, 9, 'Alternatives, edited after the record.');
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'tree-changed-since-the-refine-record');
        // The full critique that follows never converges by leaving a MAJOR open.
        const closed = ctx.close(scope.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'x', scope: 'outside' }]);
        strictEqual(closed.converged, false);
      });
    });

    it('no refine recorded, an operation in progress, an unreadable ledger: full', async () => {
      await fixture(async (ctx) => {
        const first = ctx.scope();
        ctx.close(first.generation, []);
        replaceLine(ctx.top, DOC_PATH, 5, 'Edited without a refine record.');
        strictEqual(ctx.scope().reason, 'no-refine-recorded-since-the-last-critique');
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        writeFileSync(join(ctx.top, '.git', 'MERGE_HEAD'), `${ctx.base}\n`);
        strictEqual(ctx.scope().reason, 'operation-in-progress:MERGE_HEAD');
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx);
        const ledger = ctx.ledgerFile();
        writeFileSync(ledger, '{not json');
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'no-full-critique-recorded');
        ok(existsSync(scope.ledger_moved_aside), 'the unreadable ledger is kept aside');
      });
    });

    it('a critique whose close refused leaves the ledger vouching for nothing until a critique closes', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const scoped = ctx.scope();
        strictEqual(scoped.mode, 'scoped');
        // The tree changes while the critique runs: its close refuses.
        replaceLine(ctx.top, DOC_PATH, 9, 'Alternatives, changed during the critique.');
        strictEqual(ctx.closeRaw(scoped.generation, [{ id: 'G1-F1', verdict: 'resolved' }]).status, 1);
        deepStrictEqual(ctx.status(), { ledger: false, reason: 'unclosed-critique' });
        const rec = ctx.record(['G1-F1']);
        strictEqual(rec.recorded, false);
        strictEqual(rec.reason, 'unclosed-critique');
        const next = ctx.scope();
        strictEqual(next.mode, 'full');
        strictEqual(next.reason, 'unclosed-critique-since-the-last-close');
        // A full critique that closes restores the ledger.
        ctx.close(next.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:9`, text: 'x' }]);
        strictEqual(ctx.status().ledger, true);
      });
    });

    it('an open critique a run never closed is abandoned by the next one', async () => {
      await fixture(async (ctx) => {
        const first = ctx.scope();
        const second = ctx.scope();
        strictEqual(second.generation, first.generation + 1);
        const r = ctx.closeRaw(first.generation, []);
        strictEqual(r.status, 1);
        match(r.stderr, /not the open critique/);
        strictEqual(ctx.close(second.generation, []).converged, true);
      });
    });

    it('refuses a stale close, an unknown refine target, a finding id not in the ledger and a malformed finding', async () => {
      await fixture(async (ctx) => {
        const first = ctx.scope();
        replaceLine(ctx.top, DOC_PATH, 9, 'changed while the critique ran');
        const stale = ctx.closeRaw(first.generation, []);
        strictEqual(stale.status, 1);
        match(stale.stderr, /the checkout changed since generation 1/);
        const again = ctx.scope();
        ctx.close(again.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:3`, text: 'x' }]);
        const unknown = ctx.recordRaw('G9-F9\n');
        strictEqual(unknown.status, 1);
        match(unknown.stderr, /G9-F9.*not a finding in the review ledger/);
        const scope = ctx.scope();
        const bad = ctx.closeRaw(scope.generation, [{ id: 'G7-F1', verdict: 'resolved' }]);
        strictEqual(bad.status, 1);
        match(bad.stderr, /not in the review ledger/);
        const badSeverity = ctx.closeRaw(scope.generation, [{ id: 'NEW', severity: 'HIGH', text: 'x' }]);
        strictEqual(badSeverity.status, 1);
        match(badSeverity.stderr, /severity must be one of/);
      });
    });

    it('a checkout on another branch (a worktree sharing the state root) records nothing and leaves the ledger alone', async () => {
      await fixture(async (ctx) => {
        const other = join(dirname(ctx.top), 'other');
        git(ctx.top, 'worktree', 'add', '-q', '-b', 'feat/other', other);
        const first = ctx.scope();
        ctx.close(first.generation, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x' }]);
        const before = readFileSync(ctx.ledgerFile(), 'utf8');
        const scope = json(cli(['critique-scope', '--workflow-path', ctx.wf, '--repo-root', other], other));
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, 'other-branch:feat/other');
        match(scope.detail, /not the workflow's branch feat\/doc/);
        // Nor may it record a refine in this workflow's ledger.
        const targets = join(dirname(ctx.top), 'targets.txt');
        writeFileSync(targets, 'G1-F1\n');
        const rec = json(cli(['refine-record', '--workflow-path', ctx.wf, '--repo-root', other, '--targets-file', targets], other));
        strictEqual(rec.recorded, false);
        strictEqual(rec.reason, 'other-branch:feat/other');
        strictEqual(readFileSync(ctx.ledgerFile(), 'utf8'), before, 'the ledger is untouched');
        deepStrictEqual(ctx.status().findings[0].targeted_by, []);
        // A close from there refuses: the findings were held to another tree.
        const reopened = ctx.scope();
        // A conflicted working tree there is still another branch's: the
        // ledger stays.
        write(other, 'notes.md', 'x\n');
        git(other, 'add', 'notes.md');
        git(other, 'commit', '-q', '-m', 'other');
        git(other, 'checkout', '-q', '-b', 'other-side', 'HEAD~1');
        write(other, 'notes.md', 'y\n');
        git(other, 'add', 'notes.md');
        git(other, 'commit', '-q', '-m', 'other side');
        git(other, 'checkout', '-q', 'feat/other');
        strictEqual(spawnSync('git', ['-C', other, 'merge', '-q', 'other-side'], { env: cleanEnv() }).status, 1, 'the merge conflicts');
        const conflicted = json(cli(['critique-scope', '--workflow-path', ctx.wf, '--repo-root', other], other));
        strictEqual(conflicted.recorded, false);
        strictEqual(conflicted.reason, 'other-branch:feat/other');
        ok(existsSync(ctx.ledgerFile()), 'the ledger is not moved aside');
        const findings = join(dirname(ctx.top), 'findings.json');
        writeFileSync(findings, '{"findings": []}\n');
        const close = cli(['critique-close', '--workflow-path', ctx.wf, '--repo-root', other, '--ledger', ctx.ledger, '--generation', String(reopened.generation), '--findings-file', findings], other);
        strictEqual(close.status, 1);
        match(close.stderr, /not the workflow's branch feat\/doc/);
      });
    });

    it('a second refine record after the same critique adds its targets and moves the tree', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1'] });
        replaceLine(ctx.top, DOC_PATH, 3, 'Context paragraph, with the incident.');
        const second = ctx.record(['G1-F2']);
        strictEqual(second.attempt, 'R1');
        deepStrictEqual(second.targets, ['G1-F1', 'G1-F2']);
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped');
        deepStrictEqual(scope.passages.map((p) => p.start), [3, 5]);
      });
    });

    // A critique run the ledger never saw: its critique-scope failed, an
    // older state.mjs ran it, or its checkout could not be vouched for. The
    // workflow file still notes the run, and that is what gives it away.
    const noteCritiqueRun = (ctx) => {
      const r = cli(['append', '--workflow-path', ctx.wf, '--host', 'claude', '--verb', 'critique',
        '--phase-label', 'Phase 0: Resume into critique', '--phase-note', 'Resumed from prior verb.',
        '--current-phase', 'phase-0-resume', '--next-action', 'Run critique skill', '--event', 'resumed'], ctx.top);
      strictEqual(r.status, 0, r.stderr);
    };

    it('a critique the ledger never recorded makes refine read no ledger and the next critique full', async () => {
      // Control: the next critique's own run is noted, and it is scoped.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        strictEqual(ctx.status().ledger, true);
        noteCritiqueRun(ctx);
        strictEqual(ctx.scope().mode, 'scoped');
      });
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const before = ctx.ledger;
        noteCritiqueRun(ctx); // a critique whose critique-scope failed
        deepStrictEqual(ctx.status(), { ledger: false, reason: 'unrecorded-critique' });
        const rec = ctx.record(['G1-F1']);
        strictEqual(rec.recorded, false);
        strictEqual(rec.reason, 'unrecorded-critique');
        noteCritiqueRun(ctx); // the next critique
        const scope = ctx.scope();
        strictEqual(scope.recorded, true);
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'unrecorded-critique');
        strictEqual(scope.generation, 1);
        ok(scope.ledger_moved_aside, 'the stale ledger is moved aside');
        ok(scope.ledger !== before, 'a new ledger, with an id of its own');
      });
    });

    // Every write that names the critique verb notes a run: a /start
    // lifecycle's critique phase writes no resume heading and never reaches
    // critique-scope, and an older release notes the heading alone.
    it('a lifecycle critique phase, which notes no resume heading, is a critique the ledger never recorded', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const r = cli(['append', '--workflow-path', ctx.wf, '--host', 'claude', '--verb', 'critique', '--profile', 'parallel-review',
          '--current-phase', 'phase-5-review', '--next-action', 'Review', '--event', 'updated'], ctx.top);
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual(ctx.status(), { ledger: false, reason: 'unrecorded-critique' });
        strictEqual(ctx.record(['G1-F1']).reason, 'unrecorded-critique');
      });
    });

    it('critiqueEntries counts each marker, and a resume heading only with no marker before it', () => {
      const M = lib.CRITIQUE_RUN_MARKER;
      const H = '### Phase 0: Resume into critique';
      strictEqual(lib.critiqueEntries(''), 0);
      strictEqual(lib.critiqueEntries(`${M}\n${H}\n\nResumed.\n`), 1);
      strictEqual(lib.critiqueEntries(`${H}\n\nResumed.\n`), 1);
      strictEqual(lib.critiqueEntries(`${M}\n\n${M}\n${H}\n\n${H}\r\n\nx\n`), 3);
      strictEqual(lib.critiqueEntries(`### Phase 0: Resume into critique, and more\n`), 0);
    });

    // An index entry marked assume-unchanged or skip-worktree keeps its staged
    // blob in the capture, so an edit to that file is not in the tree the
    // ledger would hold the critique to.
    it('an index entry marked assume-unchanged or skip-worktree makes the checkout one the ledger cannot vouch for', async () => {
      for (const flag of ['--assume-unchanged', '--skip-worktree']) {
        await fixture(async (ctx) => {
          fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
          git(ctx.top, 'add', DOC_PATH);
          git(ctx.top, 'update-index', flag, DOC_PATH);
          replaceLine(ctx.top, DOC_PATH, 9, 'rm -rf ~/work');
          const rec = ctx.record([]);
          strictEqual(rec.recorded, false, flag);
          strictEqual(rec.reason, 'checkout-unreadable:index-flags', flag);
          const scope = ctx.scope();
          strictEqual(scope.recorded, false, flag);
          strictEqual(scope.mode, 'full', flag);
          strictEqual(scope.reason, 'checkout-unreadable:index-flags', flag);
          match(scope.detail, /assume-unchanged or skip-worktree/);
          ok(scope.ledger_moved_aside, 'the ledger is moved aside');
        });
      }
    });

    it('a critique opened again with no close between is full: the open one may have seen findings', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        strictEqual(ctx.scope().mode, 'scoped');
        const again = ctx.scope();
        strictEqual(again.mode, 'full');
        strictEqual(again.reason, 'unclosed-critique-since-the-last-close');
      });
    });

    it('a scoped critique resolves a finding the refine did not target only in a passage', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1'] });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped');
        // G1-F2 sits at line 3, which the refine did not touch.
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved' },
        ]);
        strictEqual(closed.converged, false);
        deepStrictEqual(closed.carry, ['G1-F2']);
        deepStrictEqual(closed.resolved, ['G1-F1']);
        const f2 = JSON.parse(readFileSync(ctx.ledgerFile(), 'utf8')).findings.find((f) => f.id === 'G1-F2');
        strictEqual(f2.disposition, 'open');
        strictEqual(f2.history.at(-1).verdict, 'resolved-outside-passages');
      });
      // Control: placed in the changed passage, the same verdict resolves it.
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1'] });
        const scope = ctx.scope();
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved', location: `${DOC_PATH}:5` },
        ]);
        strictEqual(closed.converged, true);
        deepStrictEqual(closed.resolved, ['G1-F1', 'G1-F2']);
      });
    });

    it('executable text is no document: a .txt build file, an indented code block, content after a deep closer', async () => {
      await fixture(async (ctx) => {
        write(ctx.top, 'CMakeLists.txt', 'add_custom_command(rm -rf build)\n');
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, 'not-prose:CMakeLists.txt');
      });
      await fixture(async (ctx) => {
        write(ctx.top, DOC_PATH, `${DOC}\n    rm -rf build\n`);
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, `code-changed:${DOC_PATH}`);
      });
      await fixture(async (ctx) => {
        write(ctx.top, DOC_PATH, `${DOC}\n\`\`\`sh\necho ok\n    \`\`\`\nrm -rf build\n`);
        const scope = ctx.scope();
        strictEqual(scope.recorded, false);
        strictEqual(scope.reason, `code-changed:${DOC_PATH}`);
      }, { extra: { [DOC_PATH]: `${DOC}\n\`\`\`sh\necho ok\n    \`\`\`\n` } });
    });

    // Each shape driven through critique-scope: the baseline holds the shape
    // with its line edited, the working tree the shape itself, so the change
    // is that one line (a blank line's edit is a space removed).
    for (const [name, text, line, code] of CODE_SHAPES) {
      it(`a change to the line of ${name} is ${code ? 'code: the critique stays full' : 'prose: a document'}`, async () => {
        const old = text.split('\n');
        old[line - 1] = old[line - 1].trim() === '' ? ' ' : `${old[line - 1]} 2`;
        await fixture(async (ctx) => {
          write(ctx.top, 'docs/shape.md', text);
          const scope = ctx.scope();
          strictEqual(scope.recorded, !code);
          strictEqual(scope.reason, code ? 'code-changed:docs/shape.md' : 'no-full-critique-recorded');
        }, { extra: { 'docs/shape.md': old.join('\n') } });
      });
    }

    // The closing critique's M1 (the owner's ruling, 2026-10-15): every changed
    // line is prose, yet dropping the list marker pulls the unchanged
    // `rm -rf ~/work` into the sh fence, so the change is code.
    it('a prose edit that pulls an unchanged command into a fence is code: the critique after the refine stays full', async () => {
      const v0 = shape(['# Runbook', '', 'Intro.', '', '- Run this:', '', '  ```sh', '  echo safe', 'rm -rf ~/work', '```']);
      const v1 = v0.replace('Intro.', 'Intro, reworded.');
      const v2 = v1.replace('- Run this:', 'Run this:');
      await fixture(async (ctx) => {
        write(ctx.top, 'docs/m1.md', v1);
        const first = ctx.scope();
        strictEqual(first.recorded, true, first.reason);
        strictEqual(first.mode, 'full');
        ctx.close(first.generation, [{ id: 'NEW', severity: 'MAJOR', location: 'docs/m1.md:3', text: 'intro vague' }]);
        write(ctx.top, 'docs/m1.md', v2);
        ctx.record(['G1-F1']);
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        strictEqual(scope.reason, 'code-blocks-changed:docs/m1.md');
        deepStrictEqual(scope.passages, []);
      }, { extra: { 'docs/m1.md': v0 } });
    });

    it('a pruned tree of the last critique makes the next critique full, never scoped on a guess', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const tree = JSON.parse(readFileSync(ctx.ledgerFile(), 'utf8')).generations[0].tree;
        const loose = join(ctx.top, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
        ok(existsSync(loose), 'the reviewed tree is a loose object');
        rmSync(loose);
        const scope = ctx.scope();
        strictEqual(scope.mode, 'full');
        match(scope.reason, /^passages-unreadable:/);
        deepStrictEqual(scope.passages, []);
      });
    });

    it('a scoped critique places a finding in the current text, not by the ledger\'s old line', async () => {
      await fixture(async (ctx) => {
        // The refine inserts a paragraph at line 3: G1-F2, found at line 3,
        // moves to line 5 untouched, and its old line now holds new text.
        fullThenRefine(ctx, {
          targets: ['G1-F1'],
          edit: () => replaceLine(ctx.top, DOC_PATH, 3, 'Inserted paragraph.\n\nContext paragraph.'),
        });
        const scope = ctx.scope();
        strictEqual(scope.mode, 'scoped', scope.reason);
        ok(scope.passages.some((p) => p.start <= 3 && p.end >= 3), JSON.stringify(scope.passages));
        ok(!scope.passages.some((p) => p.start <= 5 && p.end >= 5), JSON.stringify(scope.passages));
        // G1-F2 (ledger line 3, inside a passage now) is reported at its
        // current line 5, untouched: the ledger's line does not resolve it.
        const closed = ctx.close(scope.generation, [
          { id: 'G1-F1', verdict: 'resolved' },
          { id: 'G1-F2', verdict: 'resolved', location: `${DOC_PATH}:5` },
        ]);
        strictEqual(closed.converged, false);
        deepStrictEqual(closed.carry, ['G1-F2']);
      });
    });

    it('refine-record holds Refine-verify to the same tree check as the next critique', async () => {
      await fixture(async (ctx) => {
        ctx.scope();
        ctx.close(1, [{ id: 'NEW', severity: 'MAJOR', location: `${DOC_PATH}:5`, text: 'x' }]);
        const tree = JSON.parse(readFileSync(ctx.ledgerFile(), 'utf8')).generations[0].tree;
        rmSync(join(ctx.top, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
        replaceLine(ctx.top, DOC_PATH, 5, 'Decision paragraph, revised.');
        const rec = ctx.record(['G1-F1']);
        strictEqual(rec.recorded, true);
        strictEqual(rec.verify.mode, 'full');
        match(rec.verify.reason, /^passages-unreadable:/);
        strictEqual(ctx.scope().mode, 'full');
      });
    });

    it('a close names its ledger: one from before a reset is refused', async () => {
      await fixture(async (ctx) => {
        fullThenRefine(ctx, { targets: ['G1-F1', 'G1-F2'] });
        const old = ctx.ledger;
        writeFileSync(ctx.ledgerFile(), '{"not": "a ledger"}\n');
        const fresh = ctx.scope();
        strictEqual(fresh.generation, 1);
        ok(fresh.ledger !== old);
        const stale = ctx.closeRaw(1, [], old);
        strictEqual(stale.status, 1);
        match(stale.stderr, /not this workflow's review ledger now/);
        strictEqual(ctx.close(1, []).converged, true, 'the ledger the scope named closes');
      });
    });
  });

  describe(`${persona}: review-scope library (C120)`, () => {
    it('blocks: a code block is one block, a heading its own, blank lines separate', () => {
      const text = '# H\npara a\npara b\n\n```sh\necho\n\necho\n```\n- item\n- item\n';
      deepStrictEqual(lib.markdownBlocks(text), [{ start: 1, end: 1 }, { start: 2, end: 3 }, { start: 5, end: 9 }, { start: 10, end: 11 }]);
      deepStrictEqual([...lib.codeLines(text)].sort((a, b) => a - b), [5, 6, 7, 8, 9]);
      deepStrictEqual(lib.markdownBlocks('para\n```sh\nx\n'), [{ start: 1, end: 1 }, { start: 2, end: 3 }], 'an unclosed fence is one block to the end');
      deepStrictEqual(lib.markdownBlocks('para\n\n    rm -rf x\n    echo\n'), [{ start: 1, end: 1 }, { start: 3, end: 4 }], 'so is an indented code block');
      deepStrictEqual(lib.markdownBlocks('a\rb\n\npara\n'), [{ start: 1, end: 3 }], 'a text with a bare CR is one block: its parser lines are not git\'s');
      deepStrictEqual(lib.markdownBlocks('para\n\n<pre>\na\n\nb\n</pre>\n'), [{ start: 1, end: 1 }, { start: 3, end: 7 }], 'so is an HTML block, blank lines in it included');
    });

    it('code block sequence: what each code or HTML block holds, in order, not where it sits', () => {
      const text = '# t\n\n```sh\necho a\n```\n\n<pre>x</pre>\n\n    rm y\n';
      deepStrictEqual(lib.codeBlockSequence(text), [['code_block', 'sh', 'echo a\n'], ['html_block', '', '<pre>x</pre>'], ['code_block', '', 'rm y\n']]);
      deepStrictEqual(lib.codeBlockSequence(`Intro.\n\n${text}`), lib.codeBlockSequence(text), 'prose above moves the blocks, not what they hold');
      deepStrictEqual(lib.codeBlockSequence(null), []);
      const listed = '- Run this:\n\n  ```sh\n  echo safe\nrm -rf ~/work\n```\n';
      deepStrictEqual(lib.codeBlockSequence(listed), [['code_block', 'sh', 'echo safe\n'], ['code_block', '', '']]);
      deepStrictEqual(lib.codeBlockSequence(listed.slice(2)), [['code_block', 'sh', 'echo safe\nrm -rf ~/work\n']], 'without the list marker the command is in the fence');
    });

    // The owner's shapes (M3, recurring finding): the line each changes, and
    // what each reader says of it. Reader 1 reads without pairing fences or
    // tracking containers; reader 2 is CommonMark. Each covers shapes the
    // other misses, so the union needs both.
    for (const [name, text, line, union, r1, r2] of CODE_SHAPES) {
      it(`code lines, ${name}: union ${union ? 'code' : 'prose'}, reader 1 ${r1 ? 'code' : 'prose'}, reader 2 ${r2 ? 'code' : 'prose'}`, () => {
        strictEqual(lib.codeLines(text).has(line), union, 'union');
        strictEqual(lib.possibleCodeLines(text).has(line), r1, 'reader 1');
        strictEqual(lib.commonmarkCodeLines(text).has(line), r2, 'reader 2');
      });
    }

    it('reader 1: fence range, indentation at the line start and past a marker, blank runs, neighbours', () => {
      const r1 = (text) => [...lib.possibleCodeLines(text)].sort((a, b) => a - b);
      deepStrictEqual(r1('```sh\na\n```\nprose between\n```\nb\n```\ntail\n'), [1, 2, 3, 4, 5, 6, 7], 'every line from the first fence-like line to the last; a pairing CommonMark reads is not needed');
      deepStrictEqual(r1('a\nnot ~~ a fence\nb\n'), [], 'two tildes are no fence');
      deepStrictEqual(r1('    a\n\n\n\n    b\nc\n\nd\n'), [1, 2, 3, 4, 5, 6], 'the blank run between two indented lines, and each one\'s neighbours');
      deepStrictEqual(r1('    a\n\nx\n\n    b\n'), [1, 2, 4, 5], 'a run with text in it is not filled');
      deepStrictEqual(r1('para\n    lazy\n'), [1, 2], 'no paragraph exception: CommonMark joins the line to the paragraph, an agent may run it');
      deepStrictEqual(r1('   three\n'), [], 'three columns is no indented code');
      deepStrictEqual(r1('\tx\n'), [1], 'a tab reaches column 4');
      deepStrictEqual(r1('-     echo\n'), [1], 'five columns past a list marker');
      deepStrictEqual(r1('1)     echo\n'), [1], 'past an ordered marker too');
      deepStrictEqual(r1('>    x\n'), [], 'four columns past a quote marker is its content');
      deepStrictEqual(r1('- item\n  continued\n10. ten\n- - nested\n'), []);
    });

    it('code lines: the cases the earlier readers were held to are still code', () => {
      const code = (text) => [...lib.codeLines(text)];
      for (const [text, line] of [
        ['```\nx\n    ```\nrm -rf y\n', 4],
        ['- > ```sh\n  >     ```\nrm x\n', 2],
        ['> ```\n> x\n```\ny\n', 4],
        ['- a\n\n    ```sh\n    x\n    ```\nprose\n', 4],
        ['> - ```sh\n>   x\n>   ```\ny\n', 2],
        ['Title\n=====\n    rm -rf x\n', 3],
        ['para\n\n***\n    rm -rf x\n', 4],
        ['* * *\n    echo old\n', 2],
        ['- # Heading\n      echo old\n', 2],
        ['[a]: /url\n    rm -rf x\n', 2],
        ['text\n>     rm -rf x\n', 2],
        ['- > x\n  >     rm -rf x\n', 2],
        ['> \t```sh\n>     ```\n> echo old\n> ```\n', 3],
        ['- a\n# H\n    rm -rf x\n', 3],
        ['- item\n\n      code\n  continued\n', 3],
        ['- ```sh\n  rm x\n  ```\nprose\n', 2],
        ['~~~~\nx\n~~~\ny\n', 4],
      ]) ok(code(text).includes(line), `${JSON.stringify(text)}: line ${line}`);
    });

    it('the vendored CommonMark parser is the upstream release, byte for byte', () => {
      const file = readFileSync(P.path('scripts/lib/vendor/commonmark.min.cjs'));
      const text = file.toString('utf8');
      const recorded = /^ \* upstream-sha256: ([0-9a-f]{64})$/m.exec(text);
      ok(recorded, 'the copy notice records the upstream hash');
      const end = text.indexOf('\n */\n');
      ok(end > 0, 'the copy notice is one comment');
      const body = file.subarray(Buffer.byteLength(text.slice(0, end + '\n */\n'.length), 'utf8'));
      strictEqual(createHash('sha256').update(body).digest('hex'), recorded[1]);
      match(text.slice(0, end), /Copyright \(c\) 2014, John MacFarlane/, 'its licence travels with it');
    });

    it('locations: a line range on a passage path, a bare path, an unknown path', () => {
      const passages = [{ path: 'a.md', start: 5, end: 7, deleted: false }];
      strictEqual(lib.inPassages('a.md:6', passages), true);
      strictEqual(lib.inPassages('a.md:8-9', passages), false);
      strictEqual(lib.inPassages('a.md:1-5', passages), true);
      strictEqual(lib.inPassages('a.md', passages), null);
      strictEqual(lib.inPassages('b.md:6', passages), true, 'a path no artifact holds cannot be placed: in scope');
      strictEqual(lib.inPassages('b.md:6', passages, ['a.md', 'b.md']), false, 'an artifact path with no passage is outside');
      strictEqual(lib.inPassages('./a.md:6', passages), true);
      strictEqual(lib.inPassages('a.md:6:2', passages), true);
      strictEqual(lib.inPassages('a.md#L6-L9', passages), true);
      strictEqual(lib.inPassages('/abs/repo/a.md:8', passages, ['a.md']), false);
      strictEqual(lib.inPassages('/abs/repo/a.md:7', passages, ['a.md']), true);
      deepStrictEqual(lib.parseLocation('x.md#L3-L4'), { path: 'x.md', start: 3, end: 4 });
      deepStrictEqual(lib.parseLocation('x.md:L3'), { path: 'x.md', start: 3, end: 3 });
      strictEqual(lib.currentBranch(tmpdir()), null, 'git cannot name a branch outside a checkout');
      strictEqual(lib.inPassages('b.md:1', [{ path: 'b.md', start: 0, end: 0, deleted: true }]), true);
    });

    it('decideScope names the first condition that fails, in order', () => {
      const ledger = {
        ...lib.emptyLedger('w'),
        generations: [{ id: 1, mode: 'full', state: 'closed', tree: 't1', head: 'h', base: 'b', artifact: ['a.md'] }],
        findings: [{ id: 'G1-F1' }],
        refines: [{ attempt: 'R1', after_generation: 1, targets: ['G1-F1'], tree_after: 't2' }],
      };
      const current = { defaultProfile: true, operation: null, artifact: ['a.md'], document: true, documentReason: 'document', tree: 't2', head: 'h', base: 'b' };
      strictEqual(lib.decideScope(ledger, current).mode, 'scoped');
      strictEqual(lib.decideScope(ledger, { ...current, base: 'c' }).reason, 'baseline-changed');
      strictEqual(lib.decideScope({ ...ledger, refines: [{ ...ledger.refines[0], targets: ['G5-F1'] }] }, current).reason, 'unknown-target:G5-F1');
      strictEqual(lib.decideScope({ ...ledger, generations: [{ ...ledger.generations[0], mode: 'scoped' }] }, current).reason, 'no-full-critique-recorded');
      deepStrictEqual(lib.decideScope(ledger, { ...current, defaultProfile: false }), { mode: 'partial', reason: 'not-the-default-profile', from: null, targets: ['G1-F1'] });
      strictEqual(lib.decideScope({ ...ledger, generations: [...ledger.generations, { ...ledger.generations[0], id: 2, mode: 'partial' }] }, current).reason, 'last-critique-had-another-profile');
      throws(() => lib.validateLedger({ ...ledger, workflow_id: 'other' }, 'w'), /names workflow/);
    });
  });
}
