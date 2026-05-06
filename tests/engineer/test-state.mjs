// plugins/engineer/scripts/state.mjs unit tests (Stage 2 Deliverable E,
// Cluster 2 Option B — regression protection for Phase 6 fixes).
//
// Covers:
//   - secret scrubbing (Phase 6 fix #8 — AWS ASIA + GitHub fine-grained PAT
//     + sk-/sk-ant-/sk-proj- + Slack tokens + 32+ hex bearer)
//   - singleLine helper (CR/LF collapse + multi-space collapse)
//   - generateWorkflowId regex shape per ADR-0011 §1
//   - parseWorkflowFile / validateFrontmatter (Phase 6 fix #7 — schema=1
//     closed, required fields, nested key sets, enum values)
//   - createWorkflow + readWorkflow round-trip (special chars preserved,
//     host_history append, frontmatter intact)
//   - single-active invariant enforcement (ADR-0011 §1)
//   - withFileLock serializes concurrent acquirers (Phase 6 fix #1 — lock
//     ownership protocol)
//
// Lock-race / atomic-rename internals (Phase 6 fix #1 detail and fix #2
// ownership-token verify) are exercised through public API behaviors —
// the rename-atomic stale reclaim is not directly observable without
// killing a process mid-lock, which is out of scope for in-process unit
// tests. The serialization assertion proves the public contract.
//
// Run via `node --test tests/engineer/test-state.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  scrubSecrets,
  singleLine,
  generateWorkflowId,
  parseWorkflowFile,
  createWorkflow,
  readWorkflow,
  listWorkflowFiles,
  withFileLock,
  workflowFilePath,
} = await import(STATE_PATH);

async function withTmpRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-state-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

describe('state.mjs — scrubSecrets (Phase 6 fix #8 — extended secret patterns)', () => {
  it('AWS access key (AKIA prefix) is redacted', () => {
    const out = scrubSecrets('aws=AKIAIOSFODNN7EXAMPLE rest');
    strictEqual(out, 'aws=<redacted> rest');
  });

  it('AWS temporary credential (ASIA prefix) is redacted (Phase 6)', () => {
    const out = scrubSecrets('temp=ASIAIOSFODNN7EXAMPLE done');
    strictEqual(out, 'temp=<redacted> done');
  });

  it('GitHub classic token (ghp_) is redacted', () => {
    const out = scrubSecrets('tok=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    strictEqual(out, 'tok=<redacted>');
  });

  it('GitHub fine-grained PAT (github_pat_) is redacted (Phase 6)', () => {
    const out = scrubSecrets(
      'tok=github_pat_11ABCDEFGHIJKLMNOPQRSTU_extralongstring1234567890abcdefgh',
    );
    strictEqual(out, 'tok=<redacted>');
  });

  it('OpenAI/Anthropic API keys (sk-, sk-ant-, sk-proj-) are redacted (Phase 6)', () => {
    strictEqual(
      scrubSecrets('key=sk-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
    strictEqual(
      scrubSecrets('key=sk-ant-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
    strictEqual(
      scrubSecrets('key=sk-proj-abcdefghijklmnopqrstuvwxyz0123'),
      'key=<redacted>',
    );
  });

  it('Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-) are redacted (Phase 6)', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr']) {
      const out = scrubSecrets(`tok=${prefix}-1234567890-abcdef`);
      strictEqual(out, 'tok=<redacted>', `prefix=${prefix} not redacted`);
    }
  });

  it('Generic 32+ hex bearer token is redacted', () => {
    const out = scrubSecrets('bearer=abcdef0123456789abcdef0123456789ab rest');
    strictEqual(out, 'bearer=<redacted> rest');
  });

  it('Plain text without secrets is unchanged', () => {
    const input = 'This is a normal sentence with words and spaces.';
    strictEqual(scrubSecrets(input), input);
  });

  it('Multiple secrets in one input are all redacted', () => {
    const out = scrubSecrets(
      'a=AKIAIOSFODNN7EXAMPLE b=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    strictEqual(out, 'a=<redacted> b=<redacted>');
  });
});

describe('state.mjs — singleLine', () => {
  it('collapses LF to space', () => {
    strictEqual(singleLine('a\nb'), 'a b');
  });

  it('collapses CRLF to space', () => {
    strictEqual(singleLine('a\r\nb'), 'a b');
  });

  it('collapses multiple consecutive spaces to single space', () => {
    strictEqual(singleLine('a    b'), 'a b');
  });

  it('trims leading/trailing whitespace', () => {
    strictEqual(singleLine('  a b  '), 'a b');
  });

  it('mixed CR/LF/multi-space combination is normalized', () => {
    strictEqual(singleLine('  a\n\n  b\r\n  c  '), 'a b c');
  });
});

describe('state.mjs — generateWorkflowId (ADR-0011 §1 format)', () => {
  it('produces id matching <verb>-YYYYMMDDTHHMMSSZ-<6 hex>', () => {
    const id = generateWorkflowId('investigate');
    ok(/^investigate-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id), `unexpected id shape: ${id}`);
  });

  it('honors injected `now` for deterministic timestamp', () => {
    const id = generateWorkflowId('compose', {
      now: new Date('2026-05-06T12:34:56Z'),
    });
    ok(id.startsWith('compose-20260506T123456Z-'), `id="${id}"`);
  });

  it('rejects invalid verbs', () => {
    try {
      generateWorkflowId('invalid-verb');
      ok(false, 'should have thrown for invalid verb');
    } catch (err) {
      ok(/Invalid verb/i.test(err.message), `unexpected error: ${err.message}`);
    }
  });
});

describe('state.mjs — parseWorkflowFile + validateFrontmatter (Phase 6 fix #7)', () => {
  it('round-trips a freshly created workflow', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'test request',
        currentPhase: 'phase-0',
        nextAction: 'do thing',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      ok(filePath, 'no workflow file found');
      const { frontmatter, body } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, 1);
      strictEqual(frontmatter.verb, 'investigate');
      strictEqual(frontmatter.persona, 'engineer');
      strictEqual(frontmatter.original_request, 'test request');
      strictEqual(frontmatter.current_phase, 'phase-0');
      strictEqual(frontmatter.next_action, 'do thing');
      ok(Array.isArray(frontmatter.host_history));
      strictEqual(frontmatter.host_history.length, 1);
      strictEqual(frontmatter.host_history[0].event, 'created');
      strictEqual(frontmatter.host_history[0].host, 'claude');
      ok(body.includes('phase-0'));
    });
  });

  it('rejects schema mismatch (schema=1 closed per ADR-0011 §2)', () => {
    const text = `---
schema: 99
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
next_action: ""
tasks: []
host_history:
  - host: claude
    at: 2026-05-06T00:00:00Z
    event: created
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for schema=99');
    } catch (err) {
      ok(/Unsupported schema/.test(err.message), `unexpected error: ${err.message}`);
    }
  });

  it('rejects missing required field', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
tasks: []
host_history: []
---

# body
`;
    // Missing next_action
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for missing next_action');
    } catch (err) {
      ok(/Missing required.*next_action/.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects unknown nested key in git_baseline', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
  bogus: extra
current_phase: phase-0
next_action: ""
tasks: []
host_history: []
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for unknown nested key');
    } catch (err) {
      ok(/Unknown nested key git_baseline\.bogus/.test(err.message), `err: ${err.message}`);
    }
  });

  it('rejects invalid host in host_history entry', () => {
    const text = `---
schema: 1
workflow_id: x-20260506T000000Z-abcdef
persona: engineer
verb: investigate
profile: ""
original_request: ""
started_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
repo_root: /tmp
git_baseline:
  branch: main
  head: 0000000000000000000000000000000000000000
  status_digest: ""
current_phase: phase-0
next_action: ""
tasks: []
host_history:
  - host: bogus
    at: 2026-05-06T00:00:00Z
    event: created
---

# body
`;
    try {
      parseWorkflowFile(text);
      ok(false, 'should have thrown for invalid host');
    } catch (err) {
      ok(/Invalid host/.test(err.message), `err: ${err.message}`);
    }
  });
});

describe('state.mjs — createWorkflow round-trip with special characters', () => {
  it('preserves UTF-8 / quotes / Korean / control-adjacent chars in original_request', async () => {
    await withTmpRepo(async (repoRoot) => {
      const tricky = '한국어 + "quoted" + symbols #@! and unicode ☕';
      await createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: tricky,
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.original_request, tricky);
    });
  });

  it('scrubs secrets in original_request before persisting', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'lookup AKIAIOSFODNN7EXAMPLE problem',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter } = await readWorkflow(filePath);
      ok(
        !frontmatter.original_request.includes('AKIAIOSFODNN7EXAMPLE'),
        `secret leaked into frontmatter: ${frontmatter.original_request}`,
      );
      ok(frontmatter.original_request.includes('<redacted>'));
    });
  });
});

describe('state.mjs — single-active invariant (ADR-0011 §1)', () => {
  it('rejects second createWorkflow when one already exists', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'first',
      });
      await rejects(
        async () => {
          await createWorkflow({
            repoRoot,
            verb: 'compose',
            host: 'claude',
            gitBaseline: MIN_BASELINE,
            originalRequest: 'second',
          });
        },
        /single-active invariant|already exist/i,
      );
    });
  });
});

describe('state.mjs — withFileLock serialization (Phase 6 fix #1 ownership protocol)', () => {
  it('two concurrent acquirers serialize (one waits for the other)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'lock test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);

      const events = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const a = withFileLock(filePath, async () => {
        events.push('A:enter');
        await sleep(50);
        events.push('A:exit');
      });

      const b = withFileLock(filePath, async () => {
        events.push('B:enter');
        await sleep(10);
        events.push('B:exit');
      });

      await Promise.all([a, b]);

      // Either A then B, or B then A — but never interleaved.
      const sequence = events.join(',');
      const validSequences = ['A:enter,A:exit,B:enter,B:exit', 'B:enter,B:exit,A:enter,A:exit'];
      ok(
        validSequences.includes(sequence),
        `lock did NOT serialize: ${sequence}`,
      );
    });
  });

  it('passes ownership { lockPath, token } to the wrapped fn', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'token test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);

      let received;
      await withFileLock(filePath, async (ownership) => {
        received = ownership;
      });

      ok(received, 'fn was not given ownership object');
      strictEqual(typeof received.lockPath, 'string');
      strictEqual(typeof received.token, 'string');
      ok(received.token.length > 0, 'token is empty');
      ok(received.lockPath.endsWith('.lock'), `lockPath: ${received.lockPath}`);
    });
  });
});
