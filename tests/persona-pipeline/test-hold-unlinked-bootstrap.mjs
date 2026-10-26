// ADR-0068 Decision 2, item 5 (implementation note of 2026-10-25, N3, N4) — a
// bootstrap with no dispatch linkage in a held lane is refused: the driver
// could not resume a workflow it does not know. A linked bootstrap continues
// its own lane's dispatch and is admitted as its operation. Every bootstrap of
// designer and founder is unlinked, so each is refused there. Nothing is
// refused before a hold-aware orchestrator marks the macro (N2, item 9).
//
// /start never writes a macro's child: its bootstrap carries no linkage (so a
// held lane refuses it, as below), and its resume writes a start workflow
// only, refusing any other before it writes.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const OTHER_MACRO = 'macro-plan-20261025T000001Z-fedcba';
const SUBTASK = 'hold-persona';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const HOLD_ID = '0123456789abcdef';
const PERSONAS = ['engineer', 'designer', 'founder'];

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

const scratch = [];
const tempDir = (prefix = 'op-') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};

async function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'op-unlinked-')));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: cleanEnv() }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    // The holds directory is the run's, never the tree's.
    writeFileSync(join(dir, '.git/info/exclude'), '.agentic-plugins/\n');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: base');
    return await fn({ dir, head: git('rev-parse', 'HEAD') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

const holdsPath = (dir, macro, rel = '') => join(dir, '.agentic-plugins/runs/autopilot/holds', macro, rel);
function holdsFile(dir, macro, rel, value) {
  const p = holdsPath(dir, macro, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
const activate = (dir, macro = MACRO) => holdsFile(dir, macro, 'protocol.json', MARKER);
const hold = (overrides = {}) => ({
  schema: 'agentic-hold-1', hold_id: HOLD_ID, subtask_id: SUBTASK, branch: 'main', lane: '/lanes/hold-persona',
  child: null, state: 'held', set_by: 'owner', set_at: '2026-10-25T00:00:00Z', ...overrides,
});
const holdOn = (dir, overrides = {}, macro = MACRO, subtask = SUBTASK) => holdsFile(dir, macro, `holds/${subtask}.json`, hold({ subtask_id: subtask, ...overrides }));
const workflows = (dir, persona) => {
  const home = join(dir, personaInfo(persona).workflowDirRel);
  return existsSync(home) ? readdirSync(home).filter((n) => n.endsWith('.md')) : [];
};

const states = {};
for (const persona of PERSONAS) states[persona] = await import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);
const fm = (state, p) => state.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;

const create = (persona, dir, head, extra = {}) => states[persona].createWorkflow({
  repoRoot: dir, verb: 'investigate', host: 'claude', persona, originalRequest: 'x', env: cleanEnv(),
  gitBaseline: { branch: 'main', head, status_digest: '' }, ...extra,
});
const HELD = /branch 'main' is a held lane of macro-plan-20261025T000000Z-abcdef \(subtask hold-persona: hold 0123456789abcdef is held\).*\(ADR-0068 Decision 2, item 5\)/;
const UNREADABLE = /Cannot create workflow on branch 'main' — .* cannot be read .*whether the branch is a held lane cannot be told/;

for (const persona of PERSONAS) {
  describe(`${persona}: an unlinked bootstrap in a held lane`, () => {
    it('is refused once the macro is marked, writing nothing', () => withRepo(async ({ dir, head }) => {
      activate(dir);
      holdOn(dir);
      await rejects(create(persona, dir, head), HELD);
      deepStrictEqual(workflows(dir, persona), []);
    }));

    it('a /start bootstrap (workflow_type start) is refused alike', () => withRepo(async ({ dir, head }) => {
      activate(dir);
      holdOn(dir);
      await rejects(create(persona, dir, head, { workflowType: 'start' }), HELD);
      deepStrictEqual(workflows(dir, persona), []);
    }));

    it('before a hold-aware orchestrator ran (no marker, the parks of impl-lane-gate only), it writes as today', () => withRepo(async ({ dir, head }) => {
      holdsFile(dir, MACRO, `parks/${SUBTASK}.json`, { state: 'parked' });
      holdOn(dir);
      const { filePath } = await create(persona, dir, head);
      strictEqual(fm(states[persona], filePath).git_baseline.branch, 'main');
    }));

    it('is refused while a holds directory that may hold the branch cannot be read', () => withRepo(async ({ dir, head }) => {
      holdsFile(dir, MACRO, 'protocol.json', '{');
      await rejects(create(persona, dir, head), UNREADABLE);
      deepStrictEqual(workflows(dir, persona), []);
    }));
  });
}

describe('engineer: which holds refuse an unlinked bootstrap', () => {
  for (const [name, overrides] of [
    ['released', { state: 'released' }],
    ['retired', { state: 'retired' }],
    ['orphaned', { orphaned: { at: '2026-10-25T00:00:00Z', why: 'left the plan' } }],
    ['set on another branch', { branch: 'feat/other' }],
  ]) {
    it(`a hold ${name} refuses nothing`, () => withRepo(async ({ dir, head }) => {
      activate(dir);
      holdOn(dir, overrides);
      const { filePath } = await create('engineer', dir, head);
      strictEqual(fm(states.engineer, filePath).git_baseline.branch, 'main');
    }));
  }

  it('a hold set on a child refuses an unlinked bootstrap all the same (it creates no such child)', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdOn(dir, { child: 'compose-20261025T000000Z-abcdef' });
    await rejects(create('engineer', dir, head), HELD);
  }));

  it('a held lane of a second macro is found beside an unmarked first', () => withRepo(async ({ dir, head }) => {
    // Listed first, its hold is not read: no hold-aware orchestrator runs for it.
    holdOn(dir, {}, 'macro-plan-20261024T000000Z-000000');
    activate(dir);
    holdOn(dir);
    await rejects(create('engineer', dir, head), HELD);
  }));

  it("an owner's record that cannot be read refuses it", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdsFile(dir, MACRO, `holds/${SUBTASK}.json`, '{"schema":');
    await rejects(create('engineer', dir, head), UNREADABLE);
  }));

  it('a holds root that cannot be listed refuses it', () => withRepo(async ({ dir, head }) => {
    mkdirSync(join(dir, '.agentic-plugins/runs/autopilot'), { recursive: true });
    writeFileSync(join(dir, '.agentic-plugins/runs/autopilot/holds'), 'not a directory\n');
    await rejects(create('engineer', dir, head), UNREADABLE);
  }));

  it("a temporary file or a lock beside the records is no record, nor an entry of the holds root that names no macro", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    writeFileSync(join(dir, '.agentic-plugins/runs/autopilot/holds/notes.txt'), 'x\n');
    holdsFile(dir, MACRO, 'holds/.lock', '');
    holdsFile(dir, MACRO, `holds/${SUBTASK}.json.tmp-1`, '{');
    const { filePath } = await create('engineer', dir, head);
    ok(existsSync(filePath));
  }));
});

describe('engineer: a linked bootstrap continues its lane', () => {
  it("the dispatch of the held lane's own subtask is not refused as unlinked", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdOn(dir);
    // As its operation's first write (N4): one with none is refused (item 7,
    // test-hold-writer-inventory.mjs).
    const { filePath } = await create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: SUBTASK, operationDir: tempDir() });
    strictEqual(fm(states.engineer, filePath).originating_subtask, SUBTASK);
  }));

  it('a bootstrap linked to another subtask of the macro is refused in the held lane', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdOn(dir);
    await rejects(create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: 'other-subtask' }), HELD);
  }));

  it("its own macro's marker that cannot be read is its operation's to judge, not this check's", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, MACRO, 'protocol.json', '{');
    // Refused by its operation's first write (N2), and with none by the writer
    // rule (item 7), never as unlinked.
    for (const extra of [{ operationDir: tempDir() }, {}]) {
      await rejects(create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: SUBTASK, ...extra }),
        (err) => /holds directory of macro-plan-20261025T000000Z-abcdef cannot be read/.test(err.message) && !UNREADABLE.test(err.message));
      deepStrictEqual(workflows(dir, 'engineer'), []);
    }
    // Linked to another macro, the same marker refuses it.
    rmSync(join(dir, personaInfo('engineer').workflowDirRel), { recursive: true, force: true });
    await rejects(create('engineer', dir, head, { parentWorkflow: OTHER_MACRO, originatingSubtask: SUBTASK }), UNREADABLE);
  }));

  it("its own macro's owner records that cannot be listed are its operation's to judge, not this check's", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdsFile(dir, MACRO, 'holds', 'not a directory\n');
    const { filePath } = await create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: SUBTASK, operationDir: tempDir() });
    strictEqual(fm(states.engineer, filePath).originating_subtask, SUBTASK);
    rmSync(join(dir, personaInfo('engineer').workflowDirRel), { recursive: true, force: true });
    await rejects(create('engineer', dir, head), UNREADABLE);
  }));

  it("a bootstrap linked to another macro's subtask of the same id is refused in the held lane", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdOn(dir);
    await rejects(create('engineer', dir, head, { parentWorkflow: OTHER_MACRO, originatingSubtask: SUBTASK }), HELD);
  }));
});

describe('engineer: a hold set while the bootstrap is written', () => {
  it('a hold set after the first read and before the workflow is published withdraws it', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    let pending;
    // The create reads, finds no hold, and waits for the creation lock; the
    // hold is set before it can write.
    await states.engineer.withDirectoryLock(dir, async () => {
      pending = create('engineer', dir, head);
      await new Promise((r) => { setTimeout(r, 300); });
      holdOn(dir);
    });
    await rejects(pending, HELD);
    deepStrictEqual(workflows(dir, 'engineer'), [], 'withdrawn, not left on the lane');
  }));
});

describe('engineer: a /start lifecycle is never a macro child where holds are honoured', () => {
  const startChild = (dir, head) => create('engineer', dir, head, { workflowType: 'start', parentWorkflow: MACRO, originatingSubtask: SUBTASK });

  it('refused in a macro a hold-aware orchestrator runs for, writing nothing', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    await rejects(startChild(dir, head), /a \/start lifecycle is never a macro's child \(ADR-0020 Sub-decision 6\)/);
    deepStrictEqual(workflows(dir, 'engineer'), []);
  }));

  it("refused while the macro's marker cannot be read", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, MACRO, 'protocol.json', '{');
    await rejects(startChild(dir, head), /a \/start lifecycle is never a macro's child/);
  }));

  it('before a hold-aware orchestrator ran, created as today', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await startChild(dir, head);
    deepStrictEqual([fm(states.engineer, filePath).workflow_type, fm(states.engineer, filePath).originating_subtask], ['start', SUBTASK]);
  }));

  it('a verb-chain child of the same macro is created as before', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: SUBTASK });
    strictEqual(fm(states.engineer, filePath).workflow_type, 'verb-chain');
  }));
});

describe("engineer: the CLI's create", () => {
  it('refuses an unlinked bootstrap in a held lane, exiting 1 and writing nothing', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    holdOn(dir);
    const textDir = tempDir('op-text-');
    writeFileSync(join(textDir, 'request.txt'), 'x\n');
    const r = spawnSync('node', [personaInfo('engineer').path('scripts/state.mjs'), 'create', '--repo-root', dir,
      '--verb', 'investigate', '--host', 'claude', '--persona', 'engineer', '--git-baseline-branch', 'main',
      '--git-baseline-head', head, '--status-digest', '', '--profile', 'default', '--original-request-file', join(textDir, 'request.txt'),
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run investigate skill'], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    strictEqual(r.status, 1, r.stderr);
    ok(HELD.test(r.stderr), r.stderr);
    deepStrictEqual(workflows(dir, 'engineer'), []);
  }));
});

// --- /start's blocks -----------------------------------------------------------

function regionBlocks(persona, dest, id) {
  const text = readFileSync(personaInfo(persona).path(dest), 'utf8');
  const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
  const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
  // Contract: the region this file runs — gone, the case would run nothing.
  ok(begin >= 0 && end > begin, `${persona}/${dest} holds region ${id}`);
  return [...text.slice(begin, end).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => !/^\s*mktemp -d /.test(b));
}
const runBlock = (dir, block, persona) => spawnSync('bash', ['-c', block], {
  cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), [`AGENTIC_${persona.toUpperCase()}_ROOT`]: personaInfo(persona).root },
});

for (const persona of PERSONAS) {
  describe(`${persona}: /start never writes a macro's child`, () => {
    it('its bootstrap block passes no dispatch linkage, and a held lane refuses it before any write', () => withRepo(async ({ dir }) => {
      const blocks = regionBlocks(persona, 'commands/start.md', 'start-bootstrap');
      const bootstrap = blocks.find((b) => b.includes(' create \\'));
      ok(bootstrap, 'the bootstrap block');
      for (const linkage of ['--parent-workflow', '--originating-subtask', 'AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK']) {
        ok(!bootstrap.includes(linkage), `the bootstrap passes no ${linkage}`);
      }
      activate(dir);
      holdOn(dir);
      // engineer's takes its arguments through an args file, designer's and
      // founder's the request through a text file.
      const textDir = tempDir('op-args-');
      writeFileSync(join(textDir, 'args.json'), JSON.stringify({ agentic_args: 1, text: 'a feature' }));
      writeFileSync(join(textDir, 'request.txt'), 'a feature\n');
      const filled = bootstrap.split("ARGS_DIR='<directory from step 1>'").join(`ARGS_DIR='${textDir}'`)
        .split("TEXT_DIR='<directory from step 1>'").join(`TEXT_DIR='${textDir}'`);
      ok(!filled.includes('<directory from step 1>'), 'every directory placeholder filled');
      const r = runBlock(dir, filled, persona);
      strictEqual(r.status, 1, r.stderr);
      ok(HELD.test(r.stderr), r.stderr);
      deepStrictEqual(workflows(dir, persona), []);
    }));
  });
}

describe("engineer: /start's resume leaves a macro's child as it is", () => {
  it('a verb-chain child in an active lane is refused before any write', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await create('engineer', dir, head, { parentWorkflow: MACRO, originatingSubtask: SUBTASK });
    const resume = regionBlocks('engineer', 'commands/start.md', 'start-resume').find((b) => b.includes('WF_TYPE'));
    ok(resume, 'the resume block');
    const before = readFileSync(filePath, 'utf8');
    const r = runBlock(dir, resume, 'engineer');
    strictEqual(r.status, 1, r.stderr);
    ok(r.stderr.includes('is workflow_type=verb-chain, not start'), r.stderr);
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));
});
