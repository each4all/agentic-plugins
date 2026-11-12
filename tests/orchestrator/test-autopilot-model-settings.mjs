// tests/orchestrator/test-autopilot-model-settings.mjs
//
// ADR-0071 — the autopilot's reader of the `autopilot_*` settings
// (plugins/orchestrator/adapters/claude/autopilot/model-settings.mjs): its
// two layers and the flat-key rules it copies from the runtime, and the copy
// held equal to the runtime's contract (plugins/runtime/scripts/lib/
// runtime-config.mjs): the same keys, and validators that accept and refuse
// the same values.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const M = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/model-settings.mjs'));
const R = await import(resolve(REPO_ROOT, 'plugins/runtime/scripts/lib/runtime-config.mjs'));

function layers(t, { repo = null, user = null } = {}) {
  const base = tmpDir(t, 'ap-model-settings-');
  const repoRoot = join(base, 'repo');
  const homeDir = join(base, 'home');
  for (const [dir, text] of [[repoRoot, repo], [homeDir, user]]) {
    mkdirSync(join(dir, '.agentic-plugins'), { recursive: true });
    if (text !== null) writeFileSync(join(dir, '.agentic-plugins', 'config.toml'), text);
  }
  return { repoRoot, homeDir };
}

describe('readModelSettings', () => {
  it('reads the repository over the user, per key, and nothing else', (t) => {
    const r = M.readModelSettings(layers(t, {
      repo: 'autopilot_model = "opus"  # repo\nmodel = "peer-only"\n',
      user: 'autopilot_model = "haiku"\nautopilot-commit.effort = "low"\nautopilot_effort = "high"\n',
    }));
    deepStrictEqual(r, {
      ok: true,
      values: {
        autopilot_model: { value: 'opus', layer: 'repo' },
        autopilot_effort: { value: 'high', layer: 'user' },
        autopilot_commit_effort: { value: 'low', layer: 'user' },
      },
    });
  });

  it('a [table] ends the read, a later line wins, and no file reads as no keys', (t) => {
    const r = M.readModelSettings(layers(t, { repo: 'autopilot_model = "a1"\nautopilot_model = "a2"\n[other]\nautopilot_effort = "max"\n' }));
    deepStrictEqual(r.values, { autopilot_model: { value: 'a2', layer: 'repo' } });
    deepStrictEqual(M.readModelSettings(layers(t)), { ok: true, values: {} });
  });

  it('the winning value is validated: an empty or invalid one refuses; a shadowed invalid user value is not read', (t) => {
    const empty = M.readModelSettings(layers(t, { repo: 'autopilot_effort = ""\n', user: 'autopilot_effort = "low"\n' }));
    strictEqual(empty.ok, false);
    match(empty.errors[0], /autopilot_effort .* must be one of low, medium, high, xhigh, max/);
    const model = M.readModelSettings(layers(t, { user: 'autopilot_refine_model = "a b"\n' }));
    strictEqual(model.ok, false);
    match(model.errors[0], /autopilot_refine_model .* "a b" is not a model name/);
    const shadowed = M.readModelSettings(layers(t, { repo: 'autopilot_effort = "low"\n', user: 'autopilot_effort = "huge"\n' }));
    deepStrictEqual(shadowed, { ok: true, values: { autopilot_effort: { value: 'low', layer: 'repo' } } });
    // The same as the runtime's loader, which validates the winning value only.
    strictEqual(R.loadEffectiveConfig({ ...layers(t, { repo: 'autopilot_effort = "low"\n', user: 'autopilot_effort = "huge"\n' }), keys: ['autopilot_effort'] }).ok, true);
    strictEqual(R.loadEffectiveConfig({ ...layers(t, { repo: 'autopilot_effort = ""\n' }), keys: ['autopilot_effort'] }).ok, false);
  });

  it('only an absent layer reads as empty; one that cannot be read refuses', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, (t) => {
    const l = layers(t, { user: 'autopilot_model = "opus"\n' });
    const file = join(l.homeDir, '.agentic-plugins', 'config.toml');
    chmodSync(file, 0o000);
    try {
      const r = M.readModelSettings(l);
      strictEqual(r.ok, false);
      match(r.errors[0], /config layer unreadable: .*EACCES/);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe('the copy equals the runtime contract (ADR-0010 §5: copied, not imported)', () => {
  it('the same keys and steps', () => {
    deepStrictEqual([...M.AUTOPILOT_KEYS], [...R.CONFIG_KEY_FAMILIES.autopilot]);
    deepStrictEqual([...M.MODEL_STEPS], [...R.AUTOPILOT_MODEL_STEPS]);
    deepStrictEqual([...M.EFFORTS], [...R.AUTOPILOT_EFFORTS]);
    strictEqual(M.MODEL_RE.source, R.AUTOPILOT_MODEL_RE.source);
  });

  it('both validators accept and refuse the same values', () => {
    const samples = {
      model: ['sonnet', 'claude-opus-5-5', 'opus[1m]', 'a:b.c_d', '', ' sonnet', 'a b', '-x', 'x'.repeat(65), 'x'.repeat(64)],
      effort: ['low', 'medium', 'high', 'xhigh', 'max', '', 'none', 'HIGH', ' low'],
    };
    let checked = 0;
    for (const key of M.AUTOPILOT_KEYS) {
      const coord = key.endsWith('_effort') ? 'effort' : 'model';
      for (const v of samples[coord]) {
        const orch = M.modelValueProblem(coord, v, key) === null;
        let runtime = true;
        try { R.validateConfigValue(key, v); } catch { runtime = false; }
        strictEqual(orch, runtime, `${key} = ${JSON.stringify(v)}: orchestrator ${orch}, runtime ${runtime}`);
        checked += 1;
      }
    }
    // Non-vacuous: both sides accept some values and refuse others.
    ok(M.modelValueProblem('effort', 'low', 'k') === null && M.modelValueProblem('effort', 'none', 'k') !== null);
    ok(checked >= 20 * 9, `${checked} pairs checked`);
  });
});
