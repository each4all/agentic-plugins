import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import {
  parseCodexCliVersion,
  resolveCodexInstalledPluginVersion,
} from '../../plugins/runtime/scripts/lib/codex-attestation-versions.mjs';

// machine-bootstrap-contract.md §8.2 (S8a4) — the version authority shared by the settings
// producer and doctor's currency mirror. These pin the two behaviors the peer flagged as
// unsuitable in the existing helpers: a strict CLI parser that rejects (not guesses) junk,
// and a Codex list-authoritative installed resolver that never falls through to Claude/source.

describe('parseCodexCliVersion — strict, rejects rather than guesses', () => {
  it('accepts the real `codex-cli <semver>` form', () => {
    strictEqual(parseCodexCliVersion('codex-cli 0.144.1'), '0.144.1');
  });

  it('accepts a bare semver', () => {
    strictEqual(parseCodexCliVersion('0.144.1'), '0.144.1');
  });

  it('accepts prerelease and build metadata (the reducer grammar)', () => {
    strictEqual(parseCodexCliVersion('codex-cli 0.145.0-rc.1'), '0.145.0-rc.1');
    strictEqual(parseCodexCliVersion('1.2.3-alpha.1+build.9'), '1.2.3-alpha.1+build.9');
  });

  it('rejects an empty or whitespace string as null', () => {
    strictEqual(parseCodexCliVersion(''), null);
    strictEqual(parseCodexCliVersion('   '), null);
    strictEqual(parseCodexCliVersion(null), null);
    strictEqual(parseCodexCliVersion(undefined), null);
  });

  it('rejects multiple version tokens (ambiguous) rather than taking the first', () => {
    strictEqual(parseCodexCliVersion('0.144.1 0.145.0'), null);
    strictEqual(parseCodexCliVersion('codex-cli 0.144.1 (extra)'), null);
  });

  it('rejects a captured error message even when it contains a semver-shaped substring', () => {
    // This is the exact failure mode: normalizeHostVersion would extract `1.2.3` from junk.
    strictEqual(parseCodexCliVersion('error: could not run codex 1.2.3 not found'), null);
    strictEqual(parseCodexCliVersion('command not found'), null);
  });

  it('rejects a non-semver token (no greedy substring extraction)', () => {
    strictEqual(parseCodexCliVersion('codex-cli v0.144'), null, 'a two-part version is not a semver');
    strictEqual(parseCodexCliVersion('0.144'), null);
  });
});

describe('resolveCodexInstalledPluginVersion — Codex list-authoritative, no Claude/source fallthrough', () => {
  const plugin = (codex_installed) => ({ codex_installed });

  it('binds the list version when the plugin is installed and enabled', () => {
    deepStrictEqual(
      resolveCodexInstalledPluginVersion(plugin({ version: '1.0.0', decision: 'installed', enabled: true })),
      { version: '1.0.0', attestable: true, reason: null },
    );
  });

  it('refuses to attest a DISABLED plugin even though it has a version', () => {
    const r = resolveCodexInstalledPluginVersion(plugin({ version: '1.0.0', decision: 'disabled', enabled: false }));
    strictEqual(r.attestable, false);
    strictEqual(r.version, '1.0.0', 'the version is still reported for diagnostics');
  });

  it('refuses to attest a not_installed plugin and does NOT fall back to any cache', () => {
    const r = resolveCodexInstalledPluginVersion(plugin({ version: null, decision: 'not_installed', enabled: false }));
    strictEqual(r.attestable, false);
    strictEqual(r.version, null);
  });

  it('uses the Codex cache version on a fallback decision (list probe unavailable)', () => {
    const r = resolveCodexInstalledPluginVersion(plugin({ version: '0.9.0', decision: 'fallback', enabled: null }));
    strictEqual(r.attestable, true);
    strictEqual(r.version, '0.9.0');
  });

  it('treats a legacy null decision like fallback — cache version, attestable if present', () => {
    strictEqual(resolveCodexInstalledPluginVersion(plugin({ version: '0.8.0', decision: null, enabled: null })).attestable, true);
    strictEqual(resolveCodexInstalledPluginVersion(plugin({ version: null, decision: null, enabled: null })).attestable, false);
  });

  it('is not attestable when codex_installed is absent entirely', () => {
    strictEqual(resolveCodexInstalledPluginVersion({}).attestable, false);
    strictEqual(resolveCodexInstalledPluginVersion(null).attestable, false);
  });
});
