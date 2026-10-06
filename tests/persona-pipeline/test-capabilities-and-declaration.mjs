// Cross-cutting behavior of the generated pipeline (ADR-0066 Decisions 2 and 3):
//   - a capability that is off behaves as the trimmed copy did, on every
//     surface (CLI, readers, imports, hooks, environment);
//   - a missing or broken declaration refuses every state write before a lock
//     or a byte changes, and every hook does nothing and exits 0;
//   - a generated plugin works on its own: copied out of the repository, under
//     an awkward path, through a symlink, from an unrelated working directory,
//     reading its own declaration.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { MANIFEST, personaInfo, personasFor, pluginRoot } from './_personas.mjs';

const STATE_PERSONAS = personasFor('scripts/state.mjs');
const HOOKS = [
  'adapters/claude/hooks/session-start.mjs', 'adapters/claude/hooks/pre-compact.mjs', 'adapters/claude/hooks/stop.mjs',
  'adapters/codex/hooks/session-start.mjs', 'adapters/codex/hooks/pre-compact.mjs', 'adapters/codex/hooks/stop.mjs',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTIC_') || key.startsWith('NODE_TEST')) delete env[key];
  return { ...env, ...extra };
}

function scratchRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'pp-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'scratch\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: init');
  return { repo, git, head: git('rev-parse', 'HEAD') };
}

function copyPlugin(persona, parent = mkdtempSync(join(tmpdir(), 'pp-plugin-'))) {
  const dest = join(parent, persona);
  mkdirSync(parent, { recursive: true });
  cpSync(pluginRoot(persona), dest, { recursive: true });
  return dest;
}

function node(script, args, { cwd, env, input = '' } = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: cleanEnv(env), encoding: 'utf8', input });
}

function treeDigest(dir) {
  if (!existsSync(dir)) return '(absent)';
  const hash = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      hash.update(relative(dir, full));
      if (e.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function createWorkflow(root, repo, head, extra = []) {
  const r = node(join(root, 'scripts/state.mjs'), ['create', '--repo-root', repo, '--verb', 'investigate', '--host', 'claude',
    '--git-baseline-branch', 'main', '--git-baseline-head', head, '--current-phase', 'phase-1', '--next-action', 'next', ...extra], { cwd: repo });
  strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// ---- capabilities that are off (Decision 3) ------------------------------------

// The off-surface cases run for every state persona that has all three off;
// engineer, which has them on, holds the on paths in its own contract tests.
const ALL_OFF_PERSONAS = STATE_PERSONAS.filter((p) => {
  const c = personaInfo(p).capabilities;
  return !c.dispatch_target && !c.commit_surface && !c.legacy_homes;
});
for (const persona of ALL_OFF_PERSONAS) {
  const P = personaInfo(persona);
  describe(`${persona}: dispatch_target, commit_surface and legacy_homes are off, on every surface`, () => {
    it('the declaration says so (the negative tests below are data-driven from it)', () => {
      strictEqual(P.capabilities.dispatch_target, false);
      strictEqual(P.capabilities.commit_surface, false);
      strictEqual(P.capabilities.legacy_homes, false);
    });

    it('CLI: parent-linkage flags and the capability subcommands are refused', () => {
      const { repo, head } = scratchRepo();
      const state = P.path('scripts/state.mjs');
      const r = node(state, ['create', '--repo-root', repo, '--verb', 'frame', '--host', 'claude', '--git-baseline-branch', 'main',
        '--git-baseline-head', head, '--parent-workflow', '/x/macro.md', '--originating-subtask', 'S1'], { cwd: repo });
      strictEqual(r.status, 1);
      match(r.stderr, new RegExp(`${persona} state\\.mjs create does not accept --parent-workflow/--originating-subtask: ${persona} is no orchestrator dispatch target \\(dispatch_target off, ADR-0066 Decision 3\\)`));
      for (const sub of ['detach-archive', 'set-parent-writeback-marker', 'clear-parent-writeback-marker']) {
        const s = node(state, [sub, '--workflow-path', '/nonexistent.md', '--host', 'claude'], { cwd: repo });
        strictEqual(s.status, 2, `${sub} must not exist here`);
        match(s.stderr, new RegExp(`unknown subcommand: ${sub}`));
      }
      // PC2b: the verb's Phase 0 check and final write exist, on their off
      // path (tests/persona-pipeline/test-state-schema-14.mjs).
      for (const sub of ['autopilot-preflight', 'finish-verb']) {
        const s = node(state, [sub, '--workflow-path', '/nonexistent.md', '--host', 'claude'], { cwd: repo });
        ok(!/unknown subcommand/.test(s.stderr), `${sub} exists: ${s.stderr}`);
      }
      ok(!existsSync(join(repo, P.stateDirRel)), 'a refused create writes nothing');
    });

    it('environment: inherited parent-linkage variables change nothing', () => {
      const { repo, head } = scratchRepo();
      const path = createWorkflow(P.root, repo, head);
      const env = { AGENTIC_PARENT_WORKFLOW: '/x/macro.md', AGENTIC_ORIGINATING_SUBTASK: 'S1' };
      const r = node(P.path('scripts/state.mjs'), ['append', '--workflow-path', path, '--host', 'claude', '--phase-note', 'n'], { cwd: repo, env });
      strictEqual(r.status, 0, r.stderr);
      const text = readFileSync(path, 'utf8');
      ok(!/parent_workflow|originating_subtask/.test(text), 'no parent linkage is written');
    });

    it('readers: parent-linkage keys stay opaque data through read → append → archive', () => {
      const { repo, git, head } = scratchRepo();
      const path = createWorkflow(P.root, repo, head);
      const parent = join(repo, 'macro.md');
      writeFileSync(parent, '---\nschema: "1.2"\n---\nparent macro\n');
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, original.replace(/\nprofile: /, `\nparent_workflow: "${parent}"\noriginating_subtask: "S1"\nparent_writeback_at: "2026-01-01T00:00:00Z"\nprofile: `));
      const state = P.path('scripts/state.mjs');
      strictEqual(node(state, ['read', '--workflow-path', path], { cwd: repo }).status, 0);
      strictEqual(node(state, ['append', '--workflow-path', path, '--host', 'claude', '--phase-note', 'kept'], { cwd: repo }).status, 0);
      const afterAppend = readFileSync(path, 'utf8');
      match(afterAppend, new RegExp(`parent_workflow: "${parent.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
      match(afterAppend, /originating_subtask: "S1"/);
      // Terminal, HEAD moved: the Stop hook archives it as a plain workflow and writes nothing to the parent.
      strictEqual(node(state, ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete'], { cwd: repo }).status, 0);
      writeFileSync(join(repo, 'deliverable.md'), 'done\n');
      git('add', '.');
      git('commit', '-q', '-m', 'docs: deliverable');
      const parentBefore = readFileSync(parent, 'utf8');
      const hook = node(P.path('adapters/claude/hooks/stop.mjs'), [], { cwd: repo, input: JSON.stringify({ cwd: repo }) });
      strictEqual(hook.status, 0, hook.stderr);
      ok(!existsSync(path), 'archived');
      const archived = readdirSync(join(repo, P.archiveDirRel)).filter((f) => f.endsWith('.md'));
      strictEqual(archived.length, 1);
      match(readFileSync(join(repo, P.archiveDirRel, archived[0]), 'utf8'), /originating_subtask: "S1"/);
      strictEqual(readFileSync(parent, 'utf8'), parentBefore, 'no parent write-back');
    });

    // PC2b (ADR-0066 Decision 3, RV13): with dispatch_target off, an inherited
    // AGENTIC_AUTOPILOT is still passed down to subprocesses, but no generated
    // surface acts on it. state.mjs is the one reader: its preflight says the
    // variable is ignored (tests/persona-pipeline/test-state-schema-14.mjs).
    // profile_presets off: tests/persona-pipeline/test-decide-registry.mjs.
    if (!P.capabilities.dispatch_target) {
      it('dispatch_target off: no generated surface but state.mjs reads AGENTIC_AUTOPILOT, and no runbook line expands it', () => {
        const readers = [];
        let runbookMentions = 0;
        const walk = (dir) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            const rel = relative(P.root, full).split('\\').join('/');
            const text = readFileSync(full, 'utf8');
            if (!text.includes('AGENTIC_AUTOPILOT')) continue;
            if (/\.(mjs|js|sh|json)$/.test(e.name)) readers.push(rel);
            if (e.name.endsWith('.md')) {
              runbookMentions += 1;
              for (const line of text.split('\n').filter((l) => l.includes('AGENTIC_AUTOPILOT'))) {
                ok(!/\$\{?AGENTIC_AUTOPILOT|printenv\s+'?AGENTIC_AUTOPILOT/.test(line), `${rel}: a line expands AGENTIC_AUTOPILOT: ${line.trim()}`);
              }
            }
          }
        };
        for (const sub of ['commands', 'core', 'scripts', 'adapters', 'hooks']) if (existsSync(P.path(sub))) walk(P.path(sub));
        deepStrictEqual(readers, ['scripts/state.mjs'], 'only state.mjs reads the variable');
        ok(runbookMentions >= 7, `only ${runbookMentions} documents mention the variable (the runbooks say it changes nothing)`);
      });

      it('dispatch_target off: the Stop hook archives the same with and without an inherited AGENTIC_AUTOPILOT', () => {
        for (const env of [{}, { AGENTIC_AUTOPILOT: 'autopilot-20260101T000000Z-abcdef', AGENTIC_HOST: 'claude' }]) {
          const { repo, git, head } = scratchRepo();
          const path = createWorkflow(P.root, repo, head);
          const fin = node(P.path('scripts/state.mjs'), ['finish-verb', '--workflow-path', path, '--host', 'claude', '--next-action', 'n',
            '--next-step-kind', 'done', '--next-step-confidence', 'HIGH'], { cwd: repo, env });
          strictEqual(fin.status, 0, fin.stderr);
          match(readFileSync(path, 'utf8'), /terminal_marker: true/);
          writeFileSync(join(repo, 'deliverable.md'), 'done\n');
          git('add', '.');
          git('commit', '-q', '-m', 'docs: deliverable');
          const hook = node(P.path('adapters/claude/hooks/stop.mjs'), [], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
          strictEqual(hook.status, 0, hook.stderr);
          ok(!existsSync(path), `archived with env ${JSON.stringify(env)}`);
        }
      });
    }

    if (!P.capabilities.commit_surface) {
      it('commit_surface off: no commit command, skill or Phase 7 script, so commit and done in a proposal are the owner\'s', () => {
        ok(!existsSync(P.path('commands/commit.md')), 'no /commit command');
        ok(!existsSync(P.path('core/skills/commit')), 'no commit skill');
        for (const f of readdirSync(P.path('scripts'))) ok(!/phase7|commit-driver/.test(f), `no commit driver: scripts/${f}`);
        const state = P.path('scripts/state.mjs');
        const { repo } = scratchRepo();
        for (const sub of ['phase7-commit', 'commit', 'staging-set']) {
          const s = node(state, [sub, '--workflow-path', '/nonexistent.md', '--host', 'claude'], { cwd: repo });
          strictEqual(s.status, 2, `${sub} must not exist here`);
        }
      });
    }

    it('hooks and readers: a legacy-shaped home is never read', () => {
      const { repo, head } = scratchRepo();
      const legacy = join(repo, `.claude/agentic-${persona}/workflows`);
      mkdirSync(legacy, { recursive: true });
      const other = createWorkflow(P.root, repo, head);
      cpSync(other, join(legacy, 'legacy-20260101T000000Z-aaaaaa.md'));
      // Remove the canonical one by archiving it: only the legacy copy remains.
      strictEqual(node(P.path('scripts/state.mjs'), ['archive', '--workflow-path', other, '--host', 'claude', '--repo-root', repo], { cwd: repo }).status, 0);
      const find = node(P.path('scripts/state.mjs'), ['find-active', '--repo-root', repo, '--branch', 'main'], { cwd: repo });
      strictEqual(find.status, 0);
      strictEqual(find.stdout, '', 'the legacy home is invisible');
      const hook = node(P.path('adapters/claude/hooks/session-start.mjs'), [], { cwd: repo, input: JSON.stringify({ cwd: repo }) });
      strictEqual(hook.status, 0);
      ok(!hook.stdout.includes(P.metadataTag), 'SessionStart re-injects nothing from a legacy home');
    });
  });
}

describe('imports: no generated file reaches a capability module statically', () => {
  for (const persona of MANIFEST.personas) {
    it(`${persona}`, () => {
      for (const unit of MANIFEST.units.filter((u) => u.personas.includes(persona) && u.dest.endsWith('.mjs'))) {
        const text = readFileSync(join(pluginRoot(persona), unit.dest), 'utf8');
        ok(!/from ['"][^'"]*(parent-writeback|phase7-commit|start-args)\.mjs['"]/.test(text),
          `${persona}/${unit.dest} imports a capability module`);
      }
    });
  }
});

// ---- a broken declaration (Decision 2) -------------------------------------------

const BROKEN = {
  missing: null,
  malformed: '{"schema": "persona-declaration-1.0", ',
  'an unknown format': (d) => ({ ...d, schema: 'persona-declaration-9.0' }),
  'a mismatched name': (d) => ({ ...d, name: 'someone-else' }),
};

function breakDeclaration(root, how) {
  const path = join(root, 'persona.json');
  const good = JSON.parse(readFileSync(path, 'utf8'));
  const variant = BROKEN[how];
  if (variant === null) {
    rmSync(path);
  } else {
    writeFileSync(path, typeof variant === 'string' ? variant : JSON.stringify(variant(good)));
  }
}

for (const persona of STATE_PERSONAS) {
  describe(`${persona}: a broken declaration refuses every state write before a lock or a byte changes`, () => {
    for (const how of Object.keys(BROKEN)) {
      it(`${how}`, () => {
        const { repo, head } = scratchRepo();
        const root = copyPlugin(persona);
        const path = createWorkflow(root, repo, head);
        const projection = join(repo, `.agentic-plugins/state/${persona}/last-session-handoff.json`);
        writeFileSync(projection, '{"workflow_kind":"x"}\n');
        breakDeclaration(root, how);
        const stateDir = join(repo, '.agentic-plugins');
        const before = treeDigest(stateDir);
        const state = join(root, 'scripts/state.mjs');
        const calls = [
          ['create', '--repo-root', repo, '--verb', 'frame', '--host', 'claude', '--git-baseline-branch', 'main', '--git-baseline-head', head],
          ['append', '--workflow-path', path, '--host', 'claude', '--phase-note', 'x'],
          ['snapshot', '--workflow-path', path, '--host', 'claude', '--trigger', 'stop'],
          ['checkpoint-set', '--workflow-path', path, '--host', 'claude', '--summary', 'x'],
          ['ensemble-pending', '--workflow-path', path, '--phase', 'p', '--ensemble-type', 'review', '--run-id', 'r1'],
          ['ensemble-commit', '--workflow-path', path, '--host', 'claude', '--phase', 'p', '--ensemble-type', 'review', '--run-id', 'r1', '--verdict', 'agree', '--summary', 's', '--completed-at', '2026-01-01T00:00:00Z'],
          ['record-composed-file', '--workflow-path', path, '--path', 'a.md', '--op', 'create'],
          ['record-refine-file', '--workflow-path', path, '--path', 'a.md', '--op', 'edit'],
          ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete'],
          ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo],
          ['stop-archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo],
        ];
        for (const args of calls) {
          const r = node(state, args, { cwd: repo });
          strictEqual(r.status, 1, `${args[0]} must refuse`);
          match(r.stderr, /✗ state\.mjs: persona declaration/);
        }
        const runner = node(join(root, 'scripts/peer-runner.mjs'), ['run', '--repo-root', repo, '--kind', 'ensemble', '--peer', 'codex',
          '--prompt-file', '/nonexistent.xml', '--workflow-path', path, '--phase', 'p', '--ensemble-type', 'review', '--run-id', 'r2'], { cwd: repo });
        strictEqual(runner.status, 1);
        match(runner.stderr, /✗ peer-runner: persona declaration/);
        const dispatch = node(join(root, 'scripts/dispatch-peer.mjs'), ['--peer', 'codex', '--prompt-text', 'x'], { cwd: repo });
        strictEqual(dispatch.status, 1);
        strictEqual(treeDigest(stateDir), before, 'no byte of the persona state changed');
      });
    }
  });
}

for (const persona of MANIFEST.personas) {
  describe(`${persona}: with a broken declaration every hook does nothing and exits 0`, () => {
    for (const how of Object.keys(BROKEN)) {
      it(`${how}: all six hooks, with an orphan-eligible workflow and a pending handoff present`, () => {
        const { repo, git, head } = scratchRepo();
        const root = copyPlugin(persona);
        // A terminal workflow on a branch that is then deleted (orphan-eligible), and a pending handoff.
        git('checkout', '-q', '-b', 'feature');
        const path = createWorkflow(root, repo, head);
        strictEqual(node(join(root, 'scripts/state.mjs'), ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete'], { cwd: repo }).status, 0);
        git('checkout', '-q', 'main');
        git('branch', '-q', '-D', 'feature');
        writeFileSync(join(repo, `.agentic-plugins/state/${persona}/last-session-handoff.json`), JSON.stringify({ workflow_kind: persona, workflow_id: 'x' }));
        breakDeclaration(root, how);
        const before = treeDigest(join(repo, '.agentic-plugins'));
        for (const hook of HOOKS) {
          const r = node(join(root, hook), [], { cwd: repo, input: JSON.stringify({ cwd: repo }) });
          strictEqual(r.status, 0, `${hook} exit`);
          strictEqual(r.stdout, '', `${hook} stdout`);
          strictEqual(r.stderr, '', `${hook} stderr`);
        }
        strictEqual(treeDigest(join(repo, '.agentic-plugins')), before, 'artifacts byte-identical');
        ok(existsSync(path), 'the orphan was not swept');
      });
    }
  });
}

// ---- isolation (Decision 2, "The tests run a generated plugin directory on its own") ----

for (const persona of STATE_PERSONAS) {
  describe(`${persona}: a generated plugin copy runs on its own and reads its own declaration`, () => {
    const placements = {
      'a plain temp directory': () => copyPlugin(persona),
      "a directory named 'a b#ç한'": () => copyPlugin(persona, join(mkdtempSync(join(tmpdir(), 'pp-iso-')), 'a b#ç한')),
      'a symlink to a copy': () => {
        const real = copyPlugin(persona);
        const link = join(mkdtempSync(join(tmpdir(), 'pp-link-')), 'linked');
        symlinkSync(real, link, 'dir');
        return link;
      },
    };
    for (const [where, place] of Object.entries(placements)) {
      it(`from ${where}, with an unrelated working directory`, () => {
        const root = place();
        const { repo, head } = scratchRepo();
        const path = createWorkflow(root, repo, head);
        ok(path.includes(`/.agentic-plugins/state/${persona}/workflows/`), path);
        match(readFileSync(path, 'utf8'), new RegExp(`persona: "${persona}"`));
        const regs = node(join(root, 'scripts/decide-registry.mjs'), ['resolve'], { cwd: repo });
        strictEqual(regs.status, 0, regs.stderr);
        strictEqual(JSON.parse(regs.stdout).preset_id, personaInfo(persona).declaration.decide.fallback.preset_id);
      });
    }

    it('a copy renamed to another persona writes to that persona\'s home: the identity is the copy\'s own declaration', () => {
      const root = copyPlugin(persona);
      for (const rel of ['persona.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
        if (!existsSync(join(root, rel))) continue;
        const d = JSON.parse(readFileSync(join(root, rel), 'utf8'));
        d.name = 'venture';
        writeFileSync(join(root, rel), JSON.stringify(d));
      }
      const { repo, head } = scratchRepo();
      const path = createWorkflow(root, repo, head);
      ok(path.includes('/.agentic-plugins/state/venture/workflows/'), path);
      ok(!existsSync(join(repo, `.agentic-plugins/state/${persona}`)));
      ok(statSync(path).isFile());
      deepStrictEqual(readdirSync(join(repo, '.agentic-plugins/state')), ['venture']);
    });
  });
}
