// plugins/attention plugin-shape conformance test (ADR-0040 §3).
//
// The attention plugin is the repo's first HOOK-ONLY plugin — hooks + sensor
// scripts only, the hook-bearing sibling of the ADR-0008 script-only shape.
// This test holds four gates:
//   1. shape — both host manifests, the hook registration, sensor scripts
//      with exec bits, and the deliberate ABSENCE of skills/commands/state;
//   2. contract parity — the §1 event-contract copies in lib/sensor.mjs
//      (repo-ident, event_id composition, subjects) stay behaviorally
//      identical to the canonical runtime lib (notify-schema.mjs), and the
//      events the sensors build pass the canonical validateEvent;
//   3. discovery gate — the copied discover-runtime.mjs pins
//      MIN_RUNTIME_VERSION to the release-gate value and gates on
//      scripts/notify.mjs (missing/too-old ⇒ null, no stale fallback);
//   4. fail-closed black-box — each sensor, spawned as Claude would spawn
//      it, exits 0 with EMPTY stdout on garbage/missing input AND on the
//      happy path, and the Stop sensor's freshness gate routes
//      workflow-terminal vs bare turn-complete correctly end-to-end
//      against a stub runtime.
//
// Run via `node --test tests/plugin-shape/test-attention-plugin.mjs`.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual, throws, doesNotThrow } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/attention');

const sensorLib = await import(resolve(PLUGIN_ROOT, 'scripts/lib/sensor.mjs'));
const discoverLib = await import(resolve(PLUGIN_ROOT, 'scripts/discover-runtime.mjs'));
const canonical = await import(resolve(REPO_ROOT, 'plugins/runtime/scripts/lib/notify-schema.mjs'));

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('plugins/attention — manifests', () => {
  it('Claude manifest has required scalar fields', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'attention');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    ok(json.description.length > 0);
    strictEqual(json.author.name, 'each4all');
  });

  it('Codex manifest has required fields and the skills placeholder', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(json.name, 'attention');
    for (const field of ['version', 'description', 'homepage', 'license']) {
      ok(typeof json[field] === 'string' && json[field].length > 0, `${field} missing`);
    }
    // Codex vendored spec requires `skills` to point at a real directory;
    // hook-only plugins satisfy it with the ADR-0008 carve-out placeholder.
    strictEqual(json.skills, './skills/');
    const st = await stat(resolve(PLUGIN_ROOT, 'skills'));
    ok(st.isDirectory());
    ok(existsSync(resolve(PLUGIN_ROOT, 'skills/README.md')), 'skills/README.md placeholder missing');
    const i = json.interface;
    ok(i, 'interface block missing');
    strictEqual(typeof i.displayName, 'string');
    ok(Array.isArray(i.capabilities) && i.capabilities.length > 0);
    ok(Array.isArray(i.defaultPrompt) && i.defaultPrompt.length <= 3);
  });

  it('manifest versions agree across hosts', async () => {
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    const codex = await readJSON(resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json'));
    strictEqual(claude.version, codex.version);
  });
});

describe('plugins/attention — hook-only shape (ADR-0040 §3)', () => {
  it('ships NO functional skills, NO commands, NO state machinery, NO Codex hooks', async () => {
    // The shape qualifier prohibits functional skills content — a
    // SKILL.md directory under skills/<name>/ — not the placeholder README.
    const { readdir } = await import('node:fs/promises');
    const skillEntries = await readdir(resolve(PLUGIN_ROOT, 'skills'), { withFileTypes: true });
    deepStrictEqual(
      skillEntries.filter((e) => e.isDirectory()).map((e) => e.name),
      [],
      'skills/ must contain no skill directories',
    );
    ok(!existsSync(resolve(PLUGIN_ROOT, 'commands')), 'commands/ must not exist');
    ok(!existsSync(resolve(PLUGIN_ROOT, 'scripts/state.mjs')), 'state machinery must not exist');
    ok(!existsSync(resolve(PLUGIN_ROOT, 'adapters/codex')), 'no Codex adapter surface at v1');
  });

  it('hooks/hooks.json registers exactly Notification(permission_prompt, idle_prompt), Stop, SubagentStop', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    deepStrictEqual(Object.keys(json.hooks).sort(), ['Notification', 'Stop', 'SubagentStop']);
    deepStrictEqual(
      json.hooks.Notification.map((group) => group.matcher),
      ['permission_prompt', 'idle_prompt'],
    );
    // Stop has no matcher by design (none exists for Stop); SubagentStop
    // ships unmatched at v1 (agent_type matcher stays available for tuning).
    strictEqual(json.hooks.Stop.length, 1);
    strictEqual(json.hooks.Stop[0].matcher, undefined);
    strictEqual(json.hooks.SubagentStop.length, 1);
    strictEqual(json.hooks.SubagentStop[0].matcher, undefined);
  });

  it('every hook command target exists with the executable bit set', async () => {
    const json = await readJSON(resolve(PLUGIN_ROOT, 'hooks/hooks.json'));
    const targets = new Set();
    for (const groups of Object.values(json.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          strictEqual(hook.type, 'command');
          for (const match of hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/g)) {
            targets.add(match[1]);
          }
        }
      }
    }
    deepStrictEqual(
      [...targets].sort(),
      [
        'adapters/claude/hooks/notification.mjs',
        'adapters/claude/hooks/stop.mjs',
        'adapters/claude/hooks/subagent-stop.mjs',
      ],
    );
    for (const target of targets) {
      const st = await stat(resolve(PLUGIN_ROOT, target));
      ok(st.isFile(), `${target} missing`);
      ok((st.mode & 0o111) !== 0, `${target} executable bit not set`);
    }
  });

  it('ships the discover-runtime copy and the sensor lib', async () => {
    for (const rel of ['scripts/discover-runtime.mjs', 'scripts/lib/sensor.mjs']) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.isFile(), `${rel} missing`);
    }
  });
});

describe('plugins/attention — §1 contract parity vs canonical runtime lib', () => {
  it('deriveRepoIdent is behaviorally identical', () => {
    for (const root of [REPO_ROOT, tmpdir(), '/nonexistent/fixture/repo']) {
      strictEqual(sensorLib.deriveRepoIdent(root), canonical.deriveRepoIdent(root));
    }
  });

  it('buildEventId is behaviorally identical (incl. the default status token + ADR-0041 hostname weaving)', () => {
    const cases = [
      { repoIdent: 'repo-abc', kind: 'approval', subject: 'session:s1:aaaabbbbcccc' },
      { repoIdent: 'repo-abc', kind: 'idle', subject: 'session:s1' },
      { repoIdent: 'repo-abc', kind: 'turn-complete', subject: 'session:s1:p1' },
      { repoIdent: 'repo-abc', kind: 'workflow-terminal', subject: 'compose-x', status: 'terminal' },
      { repoIdent: 'repo-abc', kind: 'subagent-complete', subject: 'agent-9', status: 'completed' },
      { repoIdent: 'repo-abc', kind: 'peer-run-terminal', subject: 'run-1', status: 'failed' },
      // ADR-0041 §4 — the woven-hostname path (incl. sanitization) must be
      // identical across the copy-not-import copies.
      { repoIdent: 'repo-abc', kind: 'turn-complete', subject: 'session:s1:p1', hostname: 'mba.local' },
      { repoIdent: 'repo-abc', kind: 'workflow-terminal', subject: 'compose-x', status: 'terminal', hostname: 'a:b c/d' },
    ];
    for (const c of cases) {
      strictEqual(sensorLib.buildEventId(c), canonical.buildEventId(c));
    }
    strictEqual(sensorLib.DEFAULT_STATUS_TOKEN, canonical.DEFAULT_STATUS_TOKEN);
    deepStrictEqual([...sensorLib.KINDS_WITH_DEFAULT_STATUS], [...canonical.KINDS_WITH_DEFAULT_STATUS]);
    deepStrictEqual([...sensorLib.NOTIFY_KINDS], [...canonical.NOTIFY_KINDS]);
    // ADR-0041 §4 — the routing-field contract copies stay identical.
    deepStrictEqual([...sensorLib.OPTIONAL_ROUTING_FIELDS], [...canonical.OPTIONAL_ROUTING_FIELDS]);
    deepStrictEqual({ ...sensorLib.ROUTING_FIELD_CAPS }, { ...canonical.ROUTING_FIELD_CAPS });
  });

  it('ADR-0041 §3a — the copied headline vocab/field/cap + predicate are identical (copy-not-import parity)', () => {
    // The producer copy MUST match the canonical runtime lib byte-for-byte, or a
    // token this producer borns would be dropped runtime-side (Guard 2) as
    // out-of-vocab — the exact drift this parity gate exists to catch.
    strictEqual(sensorLib.OPTIONAL_HEADLINE_FIELD, canonical.OPTIONAL_HEADLINE_FIELD);
    deepStrictEqual([...sensorLib.HEADLINE_VOCAB], [...canonical.HEADLINE_VOCAB]);
    strictEqual(sensorLib.HEADLINE_FIELD_CAP, canonical.HEADLINE_FIELD_CAP);
    ok(Object.isFrozen(sensorLib.HEADLINE_VOCAB));
    // The copied membership predicate mirrors the canonical Guard-2 predicate.
    for (const token of sensorLib.HEADLINE_VOCAB) {
      strictEqual(sensorLib.isHeadlineToken(token), true);
      strictEqual(canonical.isHeadlineToken(token), true);
    }
    for (const bad of ['COMPLETE', ' complete ', 'not-a-token', '', 42, null, undefined]) {
      strictEqual(sensorLib.isHeadlineToken(bad), false);
      // Assert the canonical Guard-2 predicate agrees, so a broadened runtime
      // predicate cannot drift away from the copied one unnoticed (Codex peer).
      strictEqual(canonical.isHeadlineToken(bad), false);
    }
  });

  it('both libs reject an absent status for status-bearing kinds', () => {
    for (const lib of [sensorLib, canonical]) {
      throws(() => lib.buildEventId({ repoIdent: 'r', kind: 'workflow-terminal', subject: 's' }));
      throws(() => lib.buildEventId({ repoIdent: 'r', kind: 'subagent-complete', subject: 's' }));
    }
  });

  it('subject builders are behaviorally identical', () => {
    strictEqual(
      sensorLib.approvalSubject({ sessionId: 's1', message: 'Allow Bash?' }),
      canonical.approvalSubject({ sessionId: 's1', message: 'Allow Bash?' }),
    );
    // Two different approval prompts in one session must NOT share a subject.
    ok(
      sensorLib.approvalSubject({ sessionId: 's1', message: 'Allow Bash?' })
        !== sensorLib.approvalSubject({ sessionId: 's1', message: 'Allow Edit?' }),
    );
    strictEqual(
      sensorLib.idleSubject({ sessionId: 's1' }),
      canonical.idleSubject({ sessionId: 's1' }),
    );
    strictEqual(
      sensorLib.turnCompleteSubject({ sessionId: 's1', promptId: 'p1' }),
      canonical.turnCompleteSubject({ sessionId: 's1', promptId: 'p1' }),
    );
    strictEqual(
      sensorLib.workflowTerminalSubject({ workflowId: 'compose-x' }),
      canonical.workflowTerminalSubject({ workflowId: 'compose-x' }),
    );
    strictEqual(
      sensorLib.subagentCompleteSubject({ agentId: 'agent-9' }),
      canonical.subagentCompleteSubject({ agentId: 'agent-9' }),
    );
  });

  it('every sensor-built event passes the canonical validateEvent', () => {
    const repoIdent = sensorLib.deriveRepoIdent(REPO_ROOT);
    const events = [
      sensorLib.buildEvent({
        repoIdent,
        kind: 'approval',
        subject: sensorLib.approvalSubject({ sessionId: 's1', message: 'Allow?' }),
        title: 'Approval needed — repo',
        body: 'Allow?',
        urgency: 'urgent',
      }),
      sensorLib.buildEvent({
        repoIdent,
        kind: 'idle',
        subject: sensorLib.idleSubject({ sessionId: 's1' }),
        title: 'Idle — repo',
        body: 'Session is waiting for input',
        urgency: 'normal',
      }),
      sensorLib.buildEvent({
        repoIdent,
        kind: 'turn-complete',
        subject: sensorLib.turnCompleteSubject({ sessionId: 's1', promptId: 'p1' }),
        title: 'Turn complete — repo',
        urgency: 'normal',
      }),
      sensorLib.buildEvent({
        repoIdent,
        kind: 'workflow-terminal',
        subject: 'compose-20260704T000000Z-abcdef',
        status: sensorLib.WORKFLOW_TERMINAL_STATUS,
        title: 'engineer workflow terminal — repo',
        body: 'compose-20260704T000000Z-abcdef · phase summary-complete',
        urgency: 'normal',
        refs: { workflow_id: 'compose-20260704T000000Z-abcdef', path: '.agentic-plugins/state/engineer/workflows/x.md' },
      }),
      sensorLib.buildEvent({
        repoIdent,
        kind: 'subagent-complete',
        subject: 'agent-9',
        status: sensorLib.SUBAGENT_COMPLETE_STATUS,
        title: 'Subagent complete — repo',
        body: 'agent agent-9',
        urgency: 'normal',
      }),
      // ADR-0041 §4 — an event carrying the optional routing fields (woven host
      // token in the id + top-level hostname/topic/session_hint) must ALSO pass
      // the canonical validateEvent.
      sensorLib.buildEvent({
        repoIdent,
        kind: 'turn-complete',
        subject: sensorLib.turnCompleteSubject({ sessionId: 's1', promptId: 'p1' }),
        title: 'Turn complete — repo',
        urgency: 'normal',
        hostname: sensorLib.resolveHostname({ env: { AGENTIC_NOTIFY_HOSTNAME: 'test-box' } }),
        topic: 'repo:main',
        sessionHint: sensorLib.buildSessionHint({ sessionId: 's1' }),
      }),
    ];
    for (const event of events) {
      const verdict = canonical.validateEvent(event);
      deepStrictEqual(verdict, { ok: true, errors: [] }, JSON.stringify(event));
      strictEqual(event.source, 'attention-claude');
    }
    // ADR-0041 §4 — the routing-field event actually carries the woven id + the
    // top-level fields (born capped; not silently dropped by buildEvent).
    const routed = events[events.length - 1];
    strictEqual(routed.hostname, 'test-box');
    strictEqual(routed.topic, 'repo:main');
    ok(/:host-[0-9a-f]{16}:/.test(routed.event_id), 'event_id must weave the bounded host-hash token');
    ok(typeof routed.session_hint === 'string' && routed.session_hint.length > 0);
  });
});

describe('plugins/attention — resolveGitBranch (ADR-0041 §3 topic; pure fs, no git exec)', () => {
  let base;
  before(async () => { base = await mkdtemp(join(tmpdir(), 'attention-branch-')); });
  after(async () => { await rm(base, { recursive: true, force: true }); });

  it('reads the branch from a normal .git/HEAD', async () => {
    const repo = join(base, 'normal');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/my-branch\n');
    strictEqual(sensorLib.resolveGitBranch(repo), 'feat/my-branch');
    strictEqual(sensorLib.resolveTopic({ repoRoot: repo }), `${basename(repo)}:feat/my-branch`);
  });

  it('follows a .git FILE pointer (worktree/submodule) to the real gitdir HEAD', async () => {
    const repo = join(base, 'worktree');
    const gitdir = join(base, 'real-gitdir');
    await mkdir(gitdir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    await writeFile(join(repo, '.git'), `gitdir: ${gitdir}\n`);
    strictEqual(sensorLib.resolveGitBranch(repo), 'wt-branch');
  });

  it('returns null on detached HEAD (raw sha) → topic degrades to repo label only', async () => {
    const repo = join(base, 'detached');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    strictEqual(sensorLib.resolveGitBranch(repo), null);
    strictEqual(sensorLib.resolveTopic({ repoRoot: repo }), basename(repo));
  });

  it('returns null when HEAD / the repo is missing (fail-closed)', async () => {
    const repo = join(base, 'nohead');
    await mkdir(join(repo, '.git'), { recursive: true });
    strictEqual(sensorLib.resolveGitBranch(repo), null);
    strictEqual(sensorLib.resolveGitBranch(join(base, 'does-not-exist')), null);
    strictEqual(sensorLib.resolveGitBranch(''), null);
  });

  it('refuses a NON-REGULAR HEAD (dir/FIFO/device) → null, never blocks the hook (Codex peer MAJOR)', async () => {
    // readFileSync on a FIFO/device would block the hook indefinitely; the
    // regular-file gate must reject it. A directory HEAD is the portable proxy
    // for a non-regular target (mkfifo is not available everywhere).
    const repo = join(base, 'special-head');
    await mkdir(join(repo, '.git', 'HEAD'), { recursive: true });
    strictEqual(sensorLib.resolveGitBranch(repo), null);
  });
});

describe('plugins/attention — buildEvent routing-field sanitization (ADR-0041 §5 defense-in-depth)', () => {
  it('control-strips + caps routing fields at the build boundary (any caller, not just pre-sanitized ones)', () => {
    const dirty = `repo:main${String.fromCharCode(9)}${String.fromCharCode(1)}branch`;
    const ev = sensorLib.buildEvent({
      repoIdent: 'repo-a', kind: 'idle', subject: 'session:s1', title: 't', urgency: 'normal',
      hostname: 'mba', topic: dirty, sessionHint: 'abc123',
    });
    for (const field of ['hostname', 'topic', 'session_hint']) {
      for (const ch of ev[field] ?? '') {
        const c = ch.charCodeAt(0);
        ok(!(c < 0x20 || (c >= 0x7f && c <= 0x9f)), `${field} carries a control char`);
      }
    }
    ok(ev.topic.startsWith('repo:main'), 'topic content preserved after control-strip');
    strictEqual(canonical.validateEvent(ev).ok, true);
  });

  it('caps an over-long routing field to its ROUTING_FIELD_CAPS bound', () => {
    const ev = sensorLib.buildEvent({
      repoIdent: 'repo-a', kind: 'idle', subject: 'session:s1', title: 't', urgency: 'normal',
      topic: 'x'.repeat(sensorLib.ROUTING_FIELD_CAPS.topic + 100),
    });
    strictEqual(ev.topic.length, sensorLib.ROUTING_FIELD_CAPS.topic);
  });
});

describe('plugins/attention — deriveHeadlineToken (ADR-0041 §3a Guard 1 map-or-omit)', () => {
  it('maps workflow-terminal × the real archive_gate values to the closed vocab', () => {
    // The three values engineer/orchestrator mapArchiveGate actually emit.
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: 'ready_to_archive' }), 'complete');
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: 'not_terminal' }), 'in-progress');
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: 'blocked' }), 'blocked');
  });

  it('omits (null) for an unknown/absent gate or a non-workflow-terminal kind — never a guess', () => {
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: 'ready' }), null, 'a stale/unknown gate omits');
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: '' }), null);
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: undefined }), null);
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal' }), null);
    // ADR-0041 §3a — the bare turn-complete deliberately carries no token (a
    // kind-only token would overstate a single turn as workflow status). Every
    // non-workflow-terminal kind omits.
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'turn-complete', archiveGate: 'ready_to_archive' }), null);
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'subagent-complete', archiveGate: 'ready_to_archive' }), null);
    strictEqual(sensorLib.deriveHeadlineToken({ kind: 'approval' }), null);
    strictEqual(sensorLib.deriveHeadlineToken({}), null);
    strictEqual(sensorLib.deriveHeadlineToken(), null);
  });

  it('every mapping value is a canonical closed-vocab member (no silent drift out of vocab)', () => {
    // Whatever the table maps to must pass the canonical Guard-2 predicate; a value
    // drifting out of vocab would be dropped runtime-side, silently losing the token.
    for (const gate of ['ready_to_archive', 'not_terminal', 'blocked']) {
      const token = sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: gate });
      ok(token, `${gate} must map to a token`);
      strictEqual(canonical.isHeadlineToken(token), true, `${gate} → ${token} must be a canonical vocab member`);
    }
  });

  it('never throws + omits for a non-string, prototype-key, or coercion-hostile gate (fail-closed — Codex peer MAJOR)', () => {
    // archive_gate comes from a parsed projection JSON and can be ANY type. None may
    // throw: a throw escapes to the Stop sensor's outer catch and suppresses the WHOLE
    // notification instead of omitting only headline. Two nasty shapes: an object with
    // a NON-CALLABLE toString ({toString:'x'}) makes a bracket-lookup String() throw;
    // an object with a CALLABLE toString returning a gate name would coerce to a real
    // token — both must be refused. Inherited string keys must not resolve either.
    const hostileGates = [
      42, null, {}, [], true,
      { toString: 'ready_to_archive' },       // non-callable toString → String() throws
      { toString: () => 'ready_to_archive' },  // callable → would coerce to 'complete' without the guard
      'constructor', '__proto__', 'toString', 'hasOwnProperty',
    ];
    for (const gate of hostileGates) {
      let result;
      doesNotThrow(
        () => { result = sensorLib.deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: gate }); },
        `archiveGate=${JSON.stringify(gate)} must not throw`,
      );
      strictEqual(result, null, `archiveGate=${JSON.stringify(gate)} must omit (null)`);
    }
  });
});

describe('plugins/attention — buildEvent borns the opt-in headline (ADR-0041 §3a Guard 1)', () => {
  it('sets a valid token; the event still passes canonical validateEvent + Guard 2', () => {
    const ev = sensorLib.buildEvent({
      repoIdent: 'repo-a', kind: 'workflow-terminal', subject: 'compose-x',
      status: sensorLib.WORKFLOW_TERMINAL_STATUS, title: 't', urgency: 'normal', headline: 'complete',
    });
    strictEqual(ev.headline, 'complete');
    // headline is set VERBATIM (not truncated) so the runtime Guard-2 sees the same
    // full value — validating the exact token the producer borns.
    strictEqual(canonical.validateEvent(ev).ok, true);
    strictEqual(canonical.isHeadlineToken(ev.headline), true);
  });

  it('omits headline for a null/omitted or out-of-vocab value — never coerced onto the event', () => {
    for (const bad of [null, undefined, 'not-a-token', ' complete ', 'COMPLETE', 42, {}]) {
      const ev = sensorLib.buildEvent({
        repoIdent: 'repo-a', kind: 'turn-complete', subject: 'session:s1:p1',
        title: 't', urgency: 'normal', headline: bad,
      });
      strictEqual('headline' in ev, false, `headline must be absent for ${JSON.stringify(bad)}`);
      strictEqual(canonical.validateEvent(ev).ok, true, 'a dropped headline never fails the base validation');
    }
  });
});

describe('plugins/attention — discover-runtime copy (ADR-0039 §5 ladder)', () => {
  it('pins MIN_RUNTIME_VERSION to the release-gate value (first runtime shipping notify.mjs)', () => {
    strictEqual(discoverLib.MIN_RUNTIME_VERSION, '0.71.0');
  });

  let stubHome;
  before(async () => {
    stubHome = await mkdtemp(join(tmpdir(), 'attention-discover-'));
  });
  after(async () => {
    await rm(stubHome, { recursive: true, force: true });
  });

  async function makeRuntimeStub(name, version, { withNotify = true } = {}) {
    const root = join(stubHome, name);
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(
      join(root, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'runtime', version, description: 'stub' }),
    );
    if (withNotify) {
      await writeFile(join(root, 'scripts/notify.mjs'), '// stub\n');
    }
    return root;
  }

  it('env override resolves only when scripts/notify.mjs exists AND version >= floor', async () => {
    const okRoot = await makeRuntimeStub('ok', '0.71.0');
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: okRoot }, home: stubHome }),
      okRoot,
    );

    const tooOld = await makeRuntimeStub('too-old', '0.70.9');
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: tooOld }, home: stubHome }),
      null,
    );

    const prerelease = await makeRuntimeStub('prerelease', '0.71.0-beta.1');
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: prerelease }, home: stubHome }),
      null,
    );

    // A prerelease of a HIGHER core postdates the floor release and therefore
    // carries notify.mjs — it passes deliberately (SemVer ordering; same
    // semantics as the engineer sibling copy). Peer-review-pinned contract.
    const newerPrerelease = await makeRuntimeStub('newer-prerelease', '0.72.0-beta.1');
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: newerPrerelease }, home: stubHome }),
      newerPrerelease,
    );

    const noNotify = await makeRuntimeStub('no-notify', '0.71.0', { withNotify: false });
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: noNotify }, home: stubHome }),
      null,
    );
  });

  it('no resolvable runtime returns null (fail-closed, no stale fallback)', async () => {
    strictEqual(
      await discoverLib.discoverRuntimePluginRoot({
        env: { AGENTIC_RUNTIME_ROOT: join(stubHome, 'does-not-exist') },
        home: stubHome,
      }),
      null,
    );
  });
});

describe('plugins/attention — Stop freshness gate (readFreshProjection)', () => {
  let repoRoot;
  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'attention-projection-'));
    await mkdir(join(repoRoot, '.git'), { recursive: true });
  });
  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const WF_ID = 'compose-20260704T000000Z-abcdef';
  const projection = {
    workflow_kind: 'engineer',
    workflow_id: WF_ID,
    workflow_path: '.agentic-plugins/state/engineer/workflows/x.md',
    phase: 'summary-complete',
    next_action: 'Commit the change',
    archive_gate: 'ready',
    routing_recommendation: 'continue',
  };

  async function seed(persona, { marker, markerName, projectionBody } = {}) {
    const dir = join(repoRoot, '.agentic-plugins', 'state', persona);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'last-session-handoff.json');
    await writeFile(file, JSON.stringify(projectionBody ?? { ...projection, workflow_kind: persona }));
    if (marker) {
      await writeFile(join(dir, markerName), JSON.stringify(marker));
    }
    return file;
  }

  it('accepts a fresh engineer projection with a rendered marker (engineer marker shape)', async () => {
    await seed('engineer', {
      marker: { workflow_id: WF_ID, status: 'rendered', at: new Date().toISOString() },
      markerName: 'last-session-handoff.json.footer-rendered',
    });
    const fresh = sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' });
    ok(fresh, 'expected a fresh projection');
    strictEqual(fresh.workflowId, WF_ID);
    strictEqual(fresh.projection.phase, 'summary-complete');
  });

  it('uses the workflow-id-scoped marker shape for orchestrator', async () => {
    const macroId = 'macro-plan-20260704T000000Z-aaaaaa';
    await seed('orchestrator', {
      projectionBody: { ...projection, workflow_kind: 'orchestrator', workflow_id: macroId },
      marker: { workflow_id: macroId, status: 'rendered', at: new Date().toISOString() },
      markerName: `last-session-handoff.json.${macroId}.footer-rendered`,
    });
    const fresh = sensorLib.readFreshProjection({ repoRoot, persona: 'orchestrator' });
    ok(fresh, 'expected a fresh orchestrator projection');
    strictEqual(fresh.workflowId, macroId);
    // The engineer-shaped (unscoped) marker alone must NOT satisfy orchestrator.
    await rm(join(repoRoot, '.agentic-plugins/state/orchestrator', `last-session-handoff.json.${macroId}.footer-rendered`));
    await writeFile(
      join(repoRoot, '.agentic-plugins/state/orchestrator', 'last-session-handoff.json.footer-rendered'),
      JSON.stringify({ workflow_id: macroId, status: 'rendered' }),
    );
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'orchestrator' }), null);
  });

  it('rejects: claimed marker, id mismatch, stale mtime, kind mismatch, missing marker', async () => {
    // claimed (render in flight) — not a completed terminal presentation.
    await seed('engineer', {
      marker: { workflow_id: WF_ID, status: 'claimed' },
      markerName: 'last-session-handoff.json.footer-rendered',
    });
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' }), null);

    // marker for a DIFFERENT workflow.
    await seed('engineer', {
      marker: { workflow_id: 'compose-other', status: 'rendered' },
      markerName: 'last-session-handoff.json.footer-rendered',
    });
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' }), null);

    // stale mtime (beyond HANDOFF_FRESHNESS_MS).
    const file = await seed('engineer', {
      marker: { workflow_id: WF_ID, status: 'rendered' },
      markerName: 'last-session-handoff.json.footer-rendered',
    });
    const old = new Date(Date.now() - sensorLib.HANDOFF_FRESHNESS_MS - 60_000);
    await utimes(file, old, old);
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' }), null);

    // workflow_kind disagrees with the persona directory.
    await seed('engineer', {
      projectionBody: { ...projection, workflow_kind: 'orchestrator' },
      marker: { workflow_id: WF_ID, status: 'rendered' },
      markerName: 'last-session-handoff.json.footer-rendered',
    });
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' }), null);

    // marker missing entirely.
    await rm(join(repoRoot, '.agentic-plugins/state/engineer', 'last-session-handoff.json.footer-rendered'));
    await seed('engineer', {});
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'engineer' }), null);
  });

  it('reads the legacy home when the canonical home is absent', async () => {
    const legacyRepo = await mkdtemp(join(tmpdir(), 'attention-legacy-'));
    try {
      await mkdir(join(legacyRepo, '.git'), { recursive: true });
      const dir = join(legacyRepo, '.claude', 'agentic-engineer');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'last-session-handoff.json'), JSON.stringify(projection));
      await writeFile(
        join(dir, 'last-session-handoff.json.footer-rendered'),
        JSON.stringify({ workflow_id: WF_ID, status: 'rendered' }),
      );
      const fresh = sensorLib.readFreshProjection({ repoRoot: legacyRepo, persona: 'engineer' });
      ok(fresh, 'expected the legacy-home projection to be read');
      strictEqual(fresh.workflowId, WF_ID);
    } finally {
      await rm(legacyRepo, { recursive: true, force: true });
    }
  });

  it('founder is not a sensor persona at v1 (bare-Stop-only)', () => {
    deepStrictEqual([...sensorLib.SENSOR_PERSONAS], ['engineer', 'orchestrator']);
    strictEqual(sensorLib.readFreshProjection({ repoRoot, persona: 'founder' }), null);
  });

  it('mixed homes fail-close: a stale canonical candidate shadows a valid legacy one', async () => {
    // Both homes existing is an inconsistent state (persona writes block it);
    // the sensor deliberately evaluates ONLY the first existing candidate and
    // degrades to a bare notification. Peer-review-pinned contract.
    const mixedRepo = await mkdtemp(join(tmpdir(), 'attention-mixed-'));
    try {
      await mkdir(join(mixedRepo, '.git'), { recursive: true });
      const canonicalDir = join(mixedRepo, '.agentic-plugins', 'state', 'engineer');
      await mkdir(canonicalDir, { recursive: true });
      // Canonical: valid content but NO rendered marker → not fresh.
      await writeFile(join(canonicalDir, 'last-session-handoff.json'), JSON.stringify(projection));
      // Legacy: fully valid projection + rendered marker.
      const legacyDir = join(mixedRepo, '.claude', 'agentic-engineer');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, 'last-session-handoff.json'), JSON.stringify(projection));
      await writeFile(
        join(legacyDir, 'last-session-handoff.json.footer-rendered'),
        JSON.stringify({ workflow_id: WF_ID, status: 'rendered' }),
      );
      strictEqual(sensorLib.readFreshProjection({ repoRoot: mixedRepo, persona: 'engineer' }), null);
    } finally {
      await rm(mixedRepo, { recursive: true, force: true });
    }
  });
});

describe('plugins/attention — sensors are fail-closed silent observers (black-box)', () => {
  const SENSORS = ['notification.mjs', 'stop.mjs', 'subagent-stop.mjs'];

  function runSensor(name, { input = '', env = {} } = {}) {
    return spawnSync(
      process.execPath,
      [resolve(PLUGIN_ROOT, 'adapters/claude/hooks', name)],
      { input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 },
    );
  }

  it('exit 0 + empty stdout on empty stdin, malformed JSON, and no-repo cwd', () => {
    for (const name of SENSORS) {
      for (const input of ['', '{not json', JSON.stringify({ cwd: tmpdir() })]) {
        const result = runSensor(name, { input });
        strictEqual(result.status, 0, `${name} exited ${result.status} on ${JSON.stringify(input)}`);
        strictEqual(result.stdout, '', `${name} wrote stdout: ${result.stdout}`);
      }
    }
  });

  it('exit 0 + empty stdout when the runtime is unresolvable (env override to a void)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'attention-noruntime-'));
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      const payload = JSON.stringify({
        cwd: repo,
        session_id: 'sess-1',
        prompt_id: 'prompt-1',
        notification_type: 'permission_prompt',
        message: 'Allow?',
        agent_id: 'agent-1',
      });
      for (const name of SENSORS) {
        const result = runSensor(name, {
          input: payload,
          env: { AGENTIC_RUNTIME_ROOT: join(repo, 'nowhere') },
        });
        strictEqual(result.status, 0, `${name} exited ${result.status}`);
        strictEqual(result.stdout, '', `${name} wrote stdout: ${result.stdout}`);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  describe('end-to-end against a stub runtime', () => {
    let repo;
    let runtimeStub;
    let captureFile;

    before(async () => {
      repo = await mkdtemp(join(tmpdir(), 'attention-e2e-'));
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'subdir'), { recursive: true });
      runtimeStub = join(repo, 'runtime-stub');
      captureFile = join(repo, 'capture.json');
      await mkdir(join(runtimeStub, '.claude-plugin'), { recursive: true });
      await mkdir(join(runtimeStub, 'scripts'), { recursive: true });
      await writeFile(
        join(runtimeStub, '.claude-plugin/plugin.json'),
        JSON.stringify({ name: 'runtime', version: '0.71.0', description: 'stub' }),
      );
      // The stub emitter records argv + stdin (appending, one JSON line per
      // call) so the test can assert exactly what the sensor handed over.
      await writeFile(
        join(runtimeStub, 'scripts/notify.mjs'),
        [
          '#!/usr/bin/env node',
          "import fs from 'node:fs';",
          'const chunks = [];',
          'for await (const chunk of process.stdin) chunks.push(chunk);',
          'fs.appendFileSync(process.env.ATTENTION_TEST_CAPTURE, JSON.stringify({',
          '  argv: process.argv.slice(2),',
          "  event: JSON.parse(Buffer.concat(chunks).toString('utf8')),",
          "}) + '\\n');",
        ].join('\n'),
      );
    });
    after(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    // ADR-0041 §4 — pin the machine label so the woven event_id is
    // deterministic regardless of the CI host's real hostname.
    const E2E_HOSTNAME = 'e2e-host';

    function runSensorE2E(name, payload) {
      return spawnSync(
        process.execPath,
        [resolve(PLUGIN_ROOT, 'adapters/claude/hooks', name)],
        {
          input: JSON.stringify(payload),
          env: {
            ...process.env,
            AGENTIC_RUNTIME_ROOT: runtimeStub,
            ATTENTION_TEST_CAPTURE: captureFile,
            AGENTIC_NOTIFY_HOSTNAME: E2E_HOSTNAME,
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
    }

    async function takeCaptures() {
      let text = '';
      try {
        text = await readFile(captureFile, 'utf8');
      } catch {
        return [];
      }
      await rm(captureFile, { force: true });
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    }

    it('permission_prompt → approval event with content-hash subject, urgent', async () => {
      const result = runSensorE2E('notification.mjs', {
        cwd: join(repo, 'subdir'),
        session_id: 'sess-1',
        notification_type: 'permission_prompt',
        message: 'Allow Bash?',
      });
      strictEqual(result.status, 0);
      strictEqual(result.stdout, '');
      const captures = await takeCaptures();
      strictEqual(captures.length, 1);
      const { argv, event } = captures[0];
      const expectedRepoRoot = sensorLib.resolveRepoRoot(join(repo, 'subdir'));
      deepStrictEqual(argv, ['emit', '--repo-root', expectedRepoRoot]);
      strictEqual(event.kind, 'approval');
      strictEqual(event.urgency, 'urgent');
      strictEqual(event.source, 'attention-claude');
      strictEqual(
        event.event_id,
        canonical.buildEventId({
          repoIdent: canonical.deriveRepoIdent(expectedRepoRoot),
          kind: 'approval',
          subject: canonical.approvalSubject({ sessionId: 'sess-1', message: 'Allow Bash?' }),
          hostname: E2E_HOSTNAME,
        }),
      );
      // ADR-0041 §4 — routing/display fields populated (hostname woven + top-level).
      strictEqual(event.hostname, E2E_HOSTNAME);
      strictEqual(event.topic, basename(expectedRepoRoot));
      ok(typeof event.session_hint === 'string' && event.session_hint.length > 0);
    });

    it('other notification types are ignored', async () => {
      const result = runSensorE2E('notification.mjs', {
        cwd: repo,
        session_id: 'sess-1',
        notification_type: 'auth_success',
        message: 'ok',
      });
      strictEqual(result.status, 0);
      strictEqual(result.stdout, '');
      deepStrictEqual(await takeCaptures(), []);
    });

    it('bare Stop → turn-complete from common fields only', async () => {
      const result = runSensorE2E('stop.mjs', {
        cwd: repo,
        session_id: 'sess-1',
        prompt_id: 'prompt-7',
      });
      strictEqual(result.status, 0);
      strictEqual(result.stdout, '');
      const captures = await takeCaptures();
      strictEqual(captures.length, 1);
      const { event } = captures[0];
      strictEqual(event.kind, 'turn-complete');
      strictEqual(
        event.event_id,
        canonical.buildEventId({
          repoIdent: canonical.deriveRepoIdent(repo),
          kind: 'turn-complete',
          subject: canonical.turnCompleteSubject({ sessionId: 'sess-1', promptId: 'prompt-7' }),
          hostname: E2E_HOSTNAME,
        }),
      );
      // ADR-0041 §4 — the bare turn-complete still carries the routing fields.
      strictEqual(event.hostname, E2E_HOSTNAME);
      ok(typeof event.topic === 'string' && event.topic.length > 0);
      ok(typeof event.session_hint === 'string' && event.session_hint.length > 0);
      // ADR-0041 §3a — a bare turn-complete (no fresh projection) borns NO headline
      // (a kind-only token would overstate a single turn as workflow status).
      strictEqual('headline' in event, false);
    });

    it('Stop with a fresh rendered projection → workflow-terminal (and NO bare turn-complete)', async () => {
      const dir = join(repo, '.agentic-plugins', 'state', 'engineer');
      await mkdir(dir, { recursive: true });
      const wfId = 'compose-20260704T112944Z-8f2b89';
      await writeFile(join(dir, 'last-session-handoff.json'), JSON.stringify({
        workflow_kind: 'engineer',
        workflow_id: wfId,
        workflow_path: '.agentic-plugins/state/engineer/workflows/x.md',
        phase: 'summary-complete',
        next_action: 'Commit the change',
        // A real mapArchiveGate output (engineer/orchestrator emit
        // ready_to_archive / not_terminal / blocked); ready_to_archive → the
        // headline token `complete` below (ADR-0041 §3a).
        archive_gate: 'ready_to_archive',
        routing_recommendation: 'continue',
      }));
      await writeFile(
        join(dir, 'last-session-handoff.json.footer-rendered'),
        JSON.stringify({ workflow_id: wfId, status: 'rendered', at: new Date().toISOString() }),
      );
      try {
        const result = runSensorE2E('stop.mjs', {
          cwd: repo,
          session_id: 'sess-1',
          prompt_id: 'prompt-8',
        });
        strictEqual(result.status, 0);
        strictEqual(result.stdout, '');
        const captures = await takeCaptures();
        strictEqual(captures.length, 1, 'workflow-terminal must SUPPRESS the bare turn-complete');
        const { event } = captures[0];
        strictEqual(event.kind, 'workflow-terminal');
        strictEqual(event.refs.workflow_id, wfId);
        strictEqual(event.refs.path, '.agentic-plugins/state/engineer/workflows/x.md');
        // ADR-0041 §3 — phase rides in refs when a fresh projection exists.
        strictEqual(event.refs.phase, 'summary-complete');
        // ADR-0041 §3a — the workflow-terminal event borns the opt-in headline from
        // the projection's archive_gate (ready_to_archive → complete), end-to-end
        // through the real Stop sensor. The runtime opt-in + Guard 2 decide egress;
        // the producer's job — proven here — is to born the correct closed-vocab token.
        strictEqual(event.headline, 'complete');
        strictEqual(
          event.event_id,
          canonical.buildEventId({
            repoIdent: canonical.deriveRepoIdent(repo),
            kind: 'workflow-terminal',
            subject: wfId,
            status: 'terminal',
            hostname: E2E_HOSTNAME,
          }),
        );
        // ADR-0041 §4 — routing/display fields on the workflow-terminal event.
        strictEqual(event.hostname, E2E_HOSTNAME);
        ok(typeof event.topic === 'string' && event.topic.length > 0);
        ok(typeof event.session_hint === 'string' && event.session_hint.length > 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('two fresh projections (engineer + orchestrator) → two workflow-terminal events with per-persona headline, no bare turn-complete (Codex peer)', async () => {
      // Both personas can be terminal in one turn (a macro closes with its last
      // engineer child). Each workflow-terminal event borns its OWN headline from
      // its OWN projection's archive_gate — engineer blocked → blocked, orchestrator
      // not_terminal → in-progress — and the bare turn-complete is suppressed.
      const engDir = join(repo, '.agentic-plugins', 'state', 'engineer');
      const orcDir = join(repo, '.agentic-plugins', 'state', 'orchestrator');
      await mkdir(engDir, { recursive: true });
      await mkdir(orcDir, { recursive: true });
      const engId = 'compose-20260704T112944Z-eeeeee';
      const macroId = 'macro-plan-20260704T112944Z-aaaaaa';
      // engineer: archive_gate blocked → 'blocked'; UNSCOPED rendered marker shape.
      await writeFile(join(engDir, 'last-session-handoff.json'), JSON.stringify({
        workflow_kind: 'engineer', workflow_id: engId,
        workflow_path: '.agentic-plugins/state/engineer/workflows/e.md',
        phase: 'plan', next_action: 'n', archive_gate: 'blocked', routing_recommendation: 'continue',
      }));
      await writeFile(
        join(engDir, 'last-session-handoff.json.footer-rendered'),
        JSON.stringify({ workflow_id: engId, status: 'rendered', at: new Date().toISOString() }),
      );
      // orchestrator: archive_gate not_terminal → 'in-progress'; WORKFLOW-ID-SCOPED marker shape.
      await writeFile(join(orcDir, 'last-session-handoff.json'), JSON.stringify({
        workflow_kind: 'orchestrator', workflow_id: macroId,
        workflow_path: '.agentic-plugins/state/orchestrator/workflows/m.md',
        phase: 'phase-3-dispatch', next_action: 'n', archive_gate: 'not_terminal', routing_recommendation: 'continue',
      }));
      await writeFile(
        join(orcDir, `last-session-handoff.json.${macroId}.footer-rendered`),
        JSON.stringify({ workflow_id: macroId, status: 'rendered', at: new Date().toISOString() }),
      );
      try {
        const result = runSensorE2E('stop.mjs', { cwd: repo, session_id: 'sess-1', prompt_id: 'prompt-9' });
        strictEqual(result.status, 0);
        strictEqual(result.stdout, '');
        const captures = await takeCaptures();
        strictEqual(captures.length, 2, 'one workflow-terminal per fresh persona projection; the bare turn-complete is suppressed');
        const byWfId = Object.fromEntries(captures.map((c) => [c.event.refs.workflow_id, c.event]));
        strictEqual(byWfId[engId].kind, 'workflow-terminal');
        strictEqual(byWfId[engId].headline, 'blocked', 'engineer archive_gate=blocked → headline blocked');
        strictEqual(byWfId[macroId].kind, 'workflow-terminal');
        strictEqual(byWfId[macroId].headline, 'in-progress', 'orchestrator archive_gate=not_terminal → headline in-progress');
        for (const { event } of captures) {
          strictEqual(event.kind === 'turn-complete', false, 'no bare turn-complete when a terminal event fired');
        }
      } finally {
        await rm(engDir, { recursive: true, force: true });
        await rm(orcDir, { recursive: true, force: true });
      }
    });

    it('SubagentStop → subagent-complete keyed on agent_id', async () => {
      const result = runSensorE2E('subagent-stop.mjs', {
        cwd: repo,
        session_id: 'sess-1',
        agent_id: 'agent-42',
        agent_type: 'Explore',
      });
      strictEqual(result.status, 0);
      strictEqual(result.stdout, '');
      const captures = await takeCaptures();
      strictEqual(captures.length, 1);
      const { event } = captures[0];
      strictEqual(event.kind, 'subagent-complete');
      strictEqual(
        event.event_id,
        canonical.buildEventId({
          repoIdent: canonical.deriveRepoIdent(repo),
          kind: 'subagent-complete',
          subject: 'agent-42',
          status: 'completed',
          hostname: E2E_HOSTNAME,
        }),
      );
      // ADR-0041 §4 — routing/display fields on the subagent-complete event.
      strictEqual(event.hostname, E2E_HOSTNAME);
      ok(typeof event.session_hint === 'string' && event.session_hint.length > 0);
    });
  });
});
