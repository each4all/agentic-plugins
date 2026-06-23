# Changelog

## Unreleased

### Features

- Add `runtime:context`, an artifact-only context hygiene scaffold that writes summary, risk, artifact pointers, and next-session handoff files under `.agentic-plugins/runs/context/` without mutating host session context.
- Add `runtime:context check`, a read-only explicit context budget check that computes green/yellow/red risk without creating artifacts or mutating host session context.
- Add `runtime:context status --latest`, a read-only latest handoff lookup with artifact age and stale-state reporting.
- Recognize the `founder` plugin in the hardcoded `PLUGIN_NAMES` inventory so `runtime:doctor` / `runtime:settings` cover it across the install / cache / catalog probes (ADR-0036 RT). Because founder is hook-bearing (it ships a Codex hooks manifest since founder PR2), it is also surfaced in the Codex hook-readiness report — correctly flagging founder's hooks for `/hooks` review/trust. The deliberate non-goal is a founder-*specific* workflow-ledger health check (it would couple runtime to founder's state schema); founder's ledger is iterated generically like every other plugin (an empty ledger reports as empty — no founder-specific health logic).

### Notes

- The `founder` inventory addition changes the `PLUGIN_NAMES` set, which invalidates the freshness of any previously recorded `runtime:doctor` proof (the proof-reuse gate requires the full plugin set + versions to match). Re-record the doctor proof on a host where all five plugins (including founder) are installed; until then `runtime:doctor` re-runs the proof rather than reusing the now-stale record.
- Deferred (pre-existing, out of this RT slice's scope; surfaced by the founder inventory expansion): `cutover-audit.mjs`'s package map still omits `plugins/founder` (the omcc cutover predates founder, so cutover parity over founder is a separate scoped decision); and `resolveCodexInstallState`'s not-installed evidence string is hardcoded to `runtime` for every plugin (a not-installed founder reads "does not report runtime as installed") — a generic-name fix threading the plugin name through that helper.

## [0.68.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.68.0...plugin-runtime-v0.68.1) (2026-06-23)


### Bug Fixes

* **plugin/runtime:** honest unsupported workflow_kind report at session handoff ([#431](https://github.com/each4all/agentic-plugins/issues/431)) ([3384d1d](https://github.com/each4all/agentic-plugins/commit/3384d1d9b3b39b3850e06c3171b12e9202799b17))

## [0.68.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.67.0...plugin-runtime-v0.68.0) (2026-06-15)


### Features

* **plugin/runtime:** recognize founder in the doctor/settings plugin inventory (ADR-0036) ([a526583](https://github.com/each4all/agentic-plugins/commit/a52658303ab80e8201571e699d99abf286e39c4a))

## [0.67.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.66.1...plugin-runtime-v0.67.0) (2026-06-11)


### Features

* **plugin/runtime:** add runtime:consensus ratify for converged-run owner ratification ([#414](https://github.com/each4all/agentic-plugins/issues/414)) ([ca84f16](https://github.com/each4all/agentic-plugins/commit/ca84f16458b5ecd5376904a618ccc7f1028c24aa))

## [0.66.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.66.0...plugin-runtime-v0.66.1) (2026-06-11)


### Bug Fixes

* **plugin/runtime:** make Codex peer-direction hook-gate readiness warning stage-aware (ADR-0030) ([#410](https://github.com/each4all/agentic-plugins/issues/410)) ([741e3dd](https://github.com/each4all/agentic-plugins/commit/741e3ddda963731d6adbf5e84967c22300f817bf))

## [0.66.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.65.1...plugin-runtime-v0.66.0) (2026-06-10)


### ⚠ BREAKING CHANGES

* **plugin/runtime:** runtime:settings no longer writes Codex host config — the --apply-codex-plugin-hooks flag is removed (now an Unknown argument parse error), along with the settings report fields apply_codex_plugin_hooks / hook_settings.host_config / hook_settings.mutation_boundary and the execution-artifact codex_plugin_hooks fields. Plugin hooks gate on generic [features].hooks (default on) + /hooks trust on current Codex; legacy Codex < ~0.134 requires a manual [features].plugin_hooks edit. Doctor no longer emits the legacy-stage enable-codex-plugin-hooks recommendation; the read-only stage diagnosis (ADR-0030), the codex_plugin_hooks_feature_disabled host-parity issue, and the --attest-codex-hook-review artifact path are kept. Schemas: runtime-settings-1.11, runtime-settings-execution-artifact-1.1.

### Features

* **plugin/runtime:** remove --apply-codex-plugin-hooks host-config write executor (ADR-0035 §6) ([0de9f12](https://github.com/each4all/agentic-plugins/commit/0de9f12bf65a3979f7741bfe016b05145fdc4408))
* **plugin/runtime:** wire Codex codex plugin add executor (ADR-0035 §5/§6) ([#403](https://github.com/each4all/agentic-plugins/issues/403)) ([c8b7d1c](https://github.com/each4all/agentic-plugins/commit/c8b7d1cc1695b6f07267fb072974c303817ccfcf))

## [0.65.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.65.0...plugin-runtime-v0.65.1) (2026-06-08)


### Bug Fixes

* **plugin/runtime:** route cross-script Codex install-state consumers through the list-authoritative resolver (ADR-0034) ([#397](https://github.com/each4all/agentic-plugins/issues/397)) ([c9f17d4](https://github.com/each4all/agentic-plugins/commit/c9f17d48229ce3e44560e486f7c8dc9757e82c00))

## [0.65.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.64.0...plugin-runtime-v0.65.0) (2026-06-08)


### Features

* **plugin/runtime:** read codex installed-state from plugin list (ADR-0034) ([#394](https://github.com/each4all/agentic-plugins/issues/394)) ([b32afbe](https://github.com/each4all/agentic-plugins/commit/b32afbe8a92e22b3d95a038685bb0dd00d46f836))

## [0.64.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.63.0...plugin-runtime-v0.64.0) (2026-06-07)


### Features

* **plugin/runtime:** adopt Codex per-plugin command surface (ADR-0032) ([#390](https://github.com/each4all/agentic-plugins/issues/390)) ([4a463bf](https://github.com/each4all/agentic-plugins/commit/4a463bf488c3aec3e2c6d60c38ed9f98f6b91f32))

## [0.63.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.62.0...plugin-runtime-v0.63.0) (2026-06-04)


### Features

* **plugin/runtime:** ADR-0031 session-level continue-vs-fresh seam ([#378](https://github.com/each4all/agentic-plugins/issues/378)) ([f78935a](https://github.com/each4all/agentic-plugins/commit/f78935a110b51212cbbf9122bdd7d63888cfa428))

## [0.62.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.61.0...plugin-runtime-v0.62.0) (2026-06-03)


### Features

* **plugin/runtime:** add host-parity-baseline freshness check to runtime:doctor ([#374](https://github.com/each4all/agentic-plugins/issues/374)) ([327c86f](https://github.com/each4all/agentic-plugins/commit/327c86f2dc2af30a46b77f3a2e7a2383157e1944))


### Bug Fixes

* **plugin/runtime:** make Codex plugin_hooks readiness stage-aware (ADR-0030) ([#370](https://github.com/each4all/agentic-plugins/issues/370)) ([b598b0a](https://github.com/each4all/agentic-plugins/commit/b598b0a5271211c919141343e4e5c67ccb0a9a8a))

## [0.61.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.60.0...plugin-runtime-v0.61.0) (2026-06-01)


### Features

* **plugin/runtime:** add owner_decision_briefing to consensus status ([#360](https://github.com/each4all/agentic-plugins/issues/360)) ([faa9f5b](https://github.com/each4all/agentic-plugins/commit/faa9f5b5a9e9e78ee230ef18da42f27a2a7a1791))

## [0.60.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.59.1...plugin-runtime-v0.60.0) (2026-05-17)


### Features

* **runtime:** add cutover operator verification ([#342](https://github.com/each4all/agentic-plugins/issues/342)) ([5b84e93](https://github.com/each4all/agentic-plugins/commit/5b84e93553fe7380fe7c55b88b4d2ff455dc44f8))

## [0.59.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.59.0...plugin-runtime-v0.59.1) (2026-05-17)


### Bug Fixes

* **runtime:** report disabled Codex hook state ([#339](https://github.com/each4all/agentic-plugins/issues/339)) ([e629aae](https://github.com/each4all/agentic-plugins/commit/e629aae7a74d5609aaa7903c42e347b0211ec195))

## [0.59.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.58.1...plugin-runtime-v0.59.0) (2026-05-17)


### Features

* **runtime:** report consensus round output completeness ([dba7e1a](https://github.com/each4all/agentic-plugins/commit/dba7e1a4a334e4ed5bac75baefde81f732bb8b77))

## [0.58.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.58.0...plugin-runtime-v0.58.1) (2026-05-17)


### Bug Fixes

* resolve Codex hook Node lookup ([b68d17c](https://github.com/each4all/agentic-plugins/commit/b68d17cdc495977719332eb7a3734dfa4dd1c8e9))

## [0.58.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.57.0...plugin-runtime-v0.58.0) (2026-05-17)


### Features

* **plugin/runtime:** add cutover condition advice ([abeb113](https://github.com/each4all/agentic-plugins/commit/abeb113090ffcbbacb046da63755f7e2d4171a20))

## [0.57.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.56.0...plugin-runtime-v0.57.0) (2026-05-17)


### Features

* **plugin/runtime:** add cutover completion audit ([151a78e](https://github.com/each4all/agentic-plugins/commit/151a78ecc1950dbe93b743bed28da364be8ba500))

## [0.56.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.55.0...plugin-runtime-v0.56.0) (2026-05-17)


### Features

* **plugin/runtime:** explain cutover gate blockers ([f19b394](https://github.com/each4all/agentic-plugins/commit/f19b394310363279a76cad6d065e1c9ab3654afc))

## [0.55.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.54.0...plugin-runtime-v0.55.0) (2026-05-17)


### Features

* **plugin/runtime:** link latest open consensus in footer ([cb4f9f2](https://github.com/each4all/agentic-plugins/commit/cb4f9f29d464619a3e63909b4d2aba3930add270))

## [0.54.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.53.0...plugin-runtime-v0.54.0) (2026-05-17)


### Features

* **plugin/runtime:** select latest open consensus runs ([1f0a1a3](https://github.com/each4all/agentic-plugins/commit/1f0a1a33dd79a463e2a3a24d4ae5135a6938cf41))

## [0.53.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.52.0...plugin-runtime-v0.53.0) (2026-05-17)


### Features

* **plugin/runtime:** record consensus cancellations ([0721685](https://github.com/each4all/agentic-plugins/commit/0721685efe324341c4275e2349f4d7d21fa2da87))

## [0.52.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.5...plugin-runtime-v0.52.0) (2026-05-17)


### Features

* **plugin/runtime:** record consensus owner decisions ([e0689ac](https://github.com/each4all/agentic-plugins/commit/e0689ac6fc1ff20f28f3c3a0be341ada3d469f9e))

## [0.51.5](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.4...plugin-runtime-v0.51.5) (2026-05-17)


### Bug Fixes

* **plugin/runtime:** surface consensus round policy ([#309](https://github.com/each4all/agentic-plugins/issues/309)) ([293fdff](https://github.com/each4all/agentic-plugins/commit/293fdff2cf53b69124e063858dfaae3108797e47))

## [0.51.4](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.3...plugin-runtime-v0.51.4) (2026-05-17)


### Bug Fixes

* **plugin/runtime:** show cutover footer reason ([44833f0](https://github.com/each4all/agentic-plugins/commit/44833f03e486b6997dd96defa870b60b2507b55a))

## [0.51.3](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.2...plugin-runtime-v0.51.3) (2026-05-17)


### Bug Fixes

* **plugin/runtime:** show scorecard blocker details ([466981d](https://github.com/each4all/agentic-plugins/commit/466981d21a74926169140ee5a7d6874b16f42872))

## [0.51.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.1...plugin-runtime-v0.51.2) (2026-05-17)


### Bug Fixes

* **plugin/runtime:** show cutover follow-up commands ([83cc652](https://github.com/each4all/agentic-plugins/commit/83cc65235cb5bf41e089f441dbf6bd8bb924c02c))

## [0.51.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.51.0...plugin-runtime-v0.51.1) (2026-05-16)


### Bug Fixes

* **plugin/runtime:** clarify cutover gate proof reuse ([#296](https://github.com/each4all/agentic-plugins/issues/296)) ([0436978](https://github.com/each4all/agentic-plugins/commit/043697857d9b68686ae29c964d5a7af24cb0595d))

## [0.51.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.50.0...plugin-runtime-v0.51.0) (2026-05-16)


### Features

* **plugin/runtime:** show doctor hook review targets ([a30229f](https://github.com/each4all/agentic-plugins/commit/a30229f2e154cb806d9269d2f1e1371dfa38a83e))

## [0.50.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.49.0...plugin-runtime-v0.50.0) (2026-05-16)


### Features

* **plugin/runtime:** show codex hook review targets ([ca4bd32](https://github.com/each4all/agentic-plugins/commit/ca4bd32c6c4a4cac9423b3eee694dba6cb73f7d8))

## [0.49.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.48.1...plugin-runtime-v0.49.0) (2026-05-16)


### Features

* **plugin/runtime:** record reusable doctor proof artifacts ([0835bd3](https://github.com/each4all/agentic-plugins/commit/0835bd37003b19339495341a5de832be25e12bb5))

## [0.48.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.48.0...plugin-runtime-v0.48.1) (2026-05-16)


### Bug Fixes

* **plugin/runtime:** use local date for cutover dogfood ([da42627](https://github.com/each4all/agentic-plugins/commit/da426277eeb619383f45d3da08137ebc079ee7b1))

## [0.48.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.47.0...plugin-runtime-v0.48.0) (2026-05-16)


### Features

* **plugin/runtime:** codify compat policy ADR ([86609de](https://github.com/each4all/agentic-plugins/commit/86609de2fd3560eef4434954a27aad0be532f5ed))

## [0.47.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.46.0...plugin-runtime-v0.47.0) (2026-05-16)


### Features

* **plugin/runtime:** gate cutover on experience parity ([8e74ed6](https://github.com/each4all/agentic-plugins/commit/8e74ed6b463fe54dc8a00a260682dbec9fdd3f0a))

## [0.46.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.45.0...plugin-runtime-v0.46.0) (2026-05-16)


### Features

* **plugin/runtime:** clarify cutover dogfood window ([4e6d6f8](https://github.com/each4all/agentic-plugins/commit/4e6d6f8282c7246878b2a301ad94ce6227119905))

## [0.45.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.44.0...plugin-runtime-v0.45.0) (2026-05-16)


### Features

* **plugin/runtime:** guide cutover evidence from footer ([79a48ad](https://github.com/each4all/agentic-plugins/commit/79a48ad45146a3d2605db59259f7654b6e989d52))

## [0.44.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.43.0...plugin-runtime-v0.44.0) (2026-05-16)


### Features

* **plugin/runtime:** record cutover dogfood evidence ([1484b1a](https://github.com/each4all/agentic-plugins/commit/1484b1ad7f81bde4d477f26d88469140323e8b1d))

## [0.43.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.42.0...plugin-runtime-v0.43.0) (2026-05-16)


### Features

* **plugin/runtime:** add workflow continuation proof ([c71a289](https://github.com/each4all/agentic-plugins/commit/c71a2890c6dd626c3adb58637923cf5297c0029c))

## [0.42.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.41.0...plugin-runtime-v0.42.0) (2026-05-16)


### Features

* **runtime:** report legacy omcc pattern map ([06727b5](https://github.com/each4all/agentic-plugins/commit/06727b54ffdc2fd0b173cb4ad4358515911148d3))

## [0.41.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.40.0...plugin-runtime-v0.41.0) (2026-05-16)


### Features

* **runtime:** require release note coverage for host drift ([e6cd637](https://github.com/each4all/agentic-plugins/commit/e6cd6379ee8caa810eb8a07d950c6b194ae2ea7e))

## [0.40.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.39.0...plugin-runtime-v0.40.0) (2026-05-16)


### Features

* **runtime:** record consensus quality policy ([277d403](https://github.com/each4all/agentic-plugins/commit/277d40347919a7569e8e05da4a0f4bf62c3c6db4))

## [0.39.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.38.0...plugin-runtime-v0.39.0) (2026-05-16)


### Features

* **runtime:** add consensus peer roles ([2e8d151](https://github.com/each4all/agentic-plugins/commit/2e8d15173f70f212d11291c800b95cc301254155))

## [0.38.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.37.0...plugin-runtime-v0.38.0) (2026-05-16)


### Features

* **runtime:** clarify cutover audit gates ([8177812](https://github.com/each4all/agentic-plugins/commit/8177812b686e62ffd92ba4931264c74c96d4a36f))

## [0.37.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.36.0...plugin-runtime-v0.37.0) (2026-05-16)


### Features

* **runtime:** add explicit release-note URL fetch ([a2b7422](https://github.com/each4all/agentic-plugins/commit/a2b7422880cacbeb678eba3b0c86ec82a5616f3f))

## [0.36.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.35.0...plugin-runtime-v0.36.0) (2026-05-16)


### Features

* **runtime:** add cutover readiness audit ([041488c](https://github.com/each4all/agentic-plugins/commit/041488c345e78bfd863f4d29ea60b02389b758ff))

## [0.35.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.34.0...plugin-runtime-v0.35.0) (2026-05-16)


### Features

* **runtime:** add consensus convergence taxonomy ([0a96c06](https://github.com/each4all/agentic-plugins/commit/0a96c066a6bc557526f862a71f67cb64fb2a97d7))

## [0.34.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.33.1...plugin-runtime-v0.34.0) (2026-05-16)


### Features

* **runtime:** add completion-state footer contract ([b210cf5](https://github.com/each4all/agentic-plugins/commit/b210cf5512231165dbcea29fee7531bff51171a6))

## [0.33.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.33.0...plugin-runtime-v0.33.1) (2026-05-16)


### Bug Fixes

* **runtime:** refresh Claude compatibility baseline ([1f7b571](https://github.com/each4all/agentic-plugins/commit/1f7b5712707545cdf0ab4aca73c93401c337ac49))

## [0.33.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.32.0...plugin-runtime-v0.33.0) (2026-05-16)


### Features

* **runtime:** surface compat drift in doctor ([7466812](https://github.com/each4all/agentic-plugins/commit/7466812109e823c5077e577cade4ae25a3e56f94))

## [0.32.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.9...plugin-runtime-v0.32.0) (2026-05-16)


### Features

* **runtime:** add compatibility drift planner ([c1d43b4](https://github.com/each4all/agentic-plugins/commit/c1d43b43730c05fb08e6bd398f25427d305de0e4))

## [0.31.9](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.8...plugin-runtime-v0.31.9) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** align Codex hook alias diagnostics ([bcdd90d](https://github.com/each4all/agentic-plugins/commit/bcdd90d7667905b72142e894dfa33ea75c0e722c))

## [0.31.8](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.7...plugin-runtime-v0.31.8) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** inspect manifest-declared Codex hooks ([d52143b](https://github.com/each4all/agentic-plugins/commit/d52143bbaff6bb46803f999c15a59c0038563d0f))

## [0.31.7](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.6...plugin-runtime-v0.31.7) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface Codex hook review blockers ([5e0d122](https://github.com/each4all/agentic-plugins/commit/5e0d1229528f660f1174bb688b834ab99ae0f408))

## [0.31.6](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.5...plugin-runtime-v0.31.6) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** clarify Codex hook active count boundary ([28b5d87](https://github.com/each4all/agentic-plugins/commit/28b5d87662bdc00beb8f52d3e5f1811fb970556e))

## [0.31.5](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.4...plugin-runtime-v0.31.5) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** show Codex hook attestation limits ([#231](https://github.com/each4all/agentic-plugins/issues/231)) ([d433406](https://github.com/each4all/agentic-plugins/commit/d4334065cdbe84a4ac9ba024e4d82faf3754ad18))

## [0.31.4](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.3...plugin-runtime-v0.31.4) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface hook attestation in next actions ([#229](https://github.com/each4all/agentic-plugins/issues/229)) ([fe17320](https://github.com/each4all/agentic-plugins/commit/fe1732037ec5c6033995a14878242fc1454c5cbd))

## [0.31.3](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.2...plugin-runtime-v0.31.3) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** point parity followup to hook attestation ([#227](https://github.com/each4all/agentic-plugins/issues/227)) ([9e00221](https://github.com/each4all/agentic-plugins/commit/9e002213011bc630d7150a50712d819eaa0fefab))

## [0.31.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.1...plugin-runtime-v0.31.2) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** clarify Codex hook attestation follow-up ([#225](https://github.com/each4all/agentic-plugins/issues/225)) ([ca53aac](https://github.com/each4all/agentic-plugins/commit/ca53aacd56cd584973abfdc0edc762225ec44f30))

## [0.31.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.31.0...plugin-runtime-v0.31.1) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface Codex hook trust boundary ([878ab41](https://github.com/each4all/agentic-plugins/commit/878ab411c4b0e5143e15acae02fdea5b26dc9813))

## [0.31.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.30.0...plugin-runtime-v0.31.0) (2026-05-15)


### Features

* **plugin/runtime:** record Codex hook review attestation ([2cdf964](https://github.com/each4all/agentic-plugins/commit/2cdf964f8cbf488b7b5a819d8549b5102f0aa7e0))

## [0.30.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.29.0...plugin-runtime-v0.30.0) (2026-05-15)


### Features

* **plugin/runtime:** add retired plugin cleanup executor ([f39cec6](https://github.com/each4all/agentic-plugins/commit/f39cec6c9edb5a7dd83e50dc6789f620c598330c))

## [0.29.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.28.0...plugin-runtime-v0.29.0) (2026-05-15)


### Features

* **plugin/runtime:** use Claude plugin CLI management ([#214](https://github.com/each4all/agentic-plugins/issues/214)) ([b3ae47f](https://github.com/each4all/agentic-plugins/commit/b3ae47f3845747ac5ae71a1fe918c3e59352c5cd))

## [0.28.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.7...plugin-runtime-v0.28.0) (2026-05-15)


### Features

* **plugin/runtime:** report experience parity score ([3ade878](https://github.com/each4all/agentic-plugins/commit/3ade878d3e09c92d7426f36fe4647d456f990796))

## [0.27.7](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.6...plugin-runtime-v0.27.7) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface codex hook review followups ([5b2ef2b](https://github.com/each4all/agentic-plugins/commit/5b2ef2b0251ba131b1020a78b82348628633109e))

## [0.27.6](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.5...plugin-runtime-v0.27.6) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** include cleanup in manual followups ([4a76e89](https://github.com/each4all/agentic-plugins/commit/4a76e89b8418137eb38c17db886b9fc80e07d294))

## [0.27.5](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.4...plugin-runtime-v0.27.5) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface doctor manual followups ([29b5250](https://github.com/each4all/agentic-plugins/commit/29b5250f10db628f91fb31fd4583287bc68e70af))

## [0.27.4](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.3...plugin-runtime-v0.27.4) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** surface Claude plugin manual followups ([1bce17c](https://github.com/each4all/agentic-plugins/commit/1bce17c4dc737c72b14cee1ca349bf2ad2cf012e))

## [0.27.3](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.2...plugin-runtime-v0.27.3) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** classify sandboxed peer proof failures ([afdab59](https://github.com/each4all/agentic-plugins/commit/afdab5916d23995ba3fea4f775f1455bd9b2e464))

## [0.27.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.1...plugin-runtime-v0.27.2) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** preflight Claude plugin surface ([b551e0d](https://github.com/each4all/agentic-plugins/commit/b551e0dd07f6938b7f7b1011304f87efc478f946))

## [0.27.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.27.0...plugin-runtime-v0.27.1) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** detect unavailable plugin surfaces ([088750d](https://github.com/each4all/agentic-plugins/commit/088750d1ee5d90df65a9f5cec1fda5efd08860d9))

## [0.27.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.6...plugin-runtime-v0.27.0) (2026-05-15)


### Features

* **plugin/runtime:** apply Codex plugin hook setting ([eb00776](https://github.com/each4all/agentic-plugins/commit/eb0077625e451ff1a78d9f981547f334f642e986))

## [0.26.6](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.5...plugin-runtime-v0.26.6) (2026-05-15)


### Bug Fixes

* **plugin/runtime:** distinguish sandbox-limited auth probes ([bb69cfb](https://github.com/each4all/agentic-plugins/commit/bb69cfb354064ac1ff12f07560502225e629ef8a))

## [0.26.5](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.4...plugin-runtime-v0.26.5) (2026-05-14)


### Bug Fixes

* plan host auth remediation in runtime settings ([568b8a2](https://github.com/each4all/agentic-plugins/commit/568b8a2b00dda0f6c2afa44796ce774dca5a6ac1))

## [0.26.4](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.3...plugin-runtime-v0.26.4) (2026-05-14)


### Bug Fixes

* classify Claude auth JSON failures ([aa31d05](https://github.com/each4all/agentic-plugins/commit/aa31d054eb3fb754f28863367fcc367a1e2a94b5))

## [0.26.3](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.2...plugin-runtime-v0.26.3) (2026-05-14)


### Bug Fixes

* diagnose Codex plugin hook readiness ([e80ed84](https://github.com/each4all/agentic-plugins/commit/e80ed84565fc8326b8baf6c6e401b746de0f26f5))

## [0.26.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.1...plugin-runtime-v0.26.2) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** flag stalled consensus progress ([9f7d54e](https://github.com/each4all/agentic-plugins/commit/9f7d54ee16dfe7b3293d14dba3d0dcb67d6d4d94))

## [0.26.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.26.0...plugin-runtime-v0.26.1) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** report running consensus execution ([e1d8f77](https://github.com/each4all/agentic-plugins/commit/e1d8f7789bba538db058f5607af4076507430033))

## [0.26.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.25.0...plugin-runtime-v0.26.0) (2026-05-14)


### Features

* **plugin/runtime:** add consensus execution remediation ([2fe7158](https://github.com/each4all/agentic-plugins/commit/2fe7158db272339f6c6718ac863490d59c71776a))
* **plugin/runtime:** add context host handoff commands ([f109e6f](https://github.com/each4all/agentic-plugins/commit/f109e6f0bbbca21b79e7248e43a1ff47843987cf))
* **plugin/runtime:** add doctor artifact inventory ([f6775a8](https://github.com/each4all/agentic-plugins/commit/f6775a8b6c2f5d92c03306d64e854366d4b2250e))
* **plugin/runtime:** describe consensus peer lanes ([75b94cb](https://github.com/each4all/agentic-plugins/commit/75b94cbc6b676fd047312d6883f186e9aec15e28))
* **plugin/runtime:** detect dirty context handoffs ([8f1e953](https://github.com/each4all/agentic-plugins/commit/8f1e953fc8abcd7eb438be3966f77ca27268e2d5))
* **plugin/runtime:** link consensus execution prompts ([ad0036f](https://github.com/each4all/agentic-plugins/commit/ad0036f3886763c6decc9d18f495dff7c43caa63))
* **plugin/runtime:** localize footer guidance commands ([451e52e](https://github.com/each4all/agentic-plugins/commit/451e52ef03eb74538d344c15474cf9720e6ab22e))

## [0.25.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.24.0...plugin-runtime-v0.25.0) (2026-05-14)


### Features

* **plugin/runtime:** add host cli install guidance ([c8511b0](https://github.com/each4all/agentic-plugins/commit/c8511b0524035f863a05fc15fe2a7f9a2f8ac147))

## [0.24.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.23.0...plugin-runtime-v0.24.0) (2026-05-14)


### Features

* **plugin/runtime:** add host parity baseline ([a6a3f85](https://github.com/each4all/agentic-plugins/commit/a6a3f850aec48814c4ce8ff71d2ec3368180daae))

## [0.23.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.22.0...plugin-runtime-v0.23.0) (2026-05-14)


### Features

* **plugin/runtime:** add Codex capability baseline ([e9b1a27](https://github.com/each4all/agentic-plugins/commit/e9b1a270d54fc2b3824136416b0fe594937acdcf))

## [0.22.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.21.0...plugin-runtime-v0.22.0) (2026-05-14)


### Features

* **plugin/runtime:** remove fixed consensus peer cap ([3b454ea](https://github.com/each4all/agentic-plugins/commit/3b454ea53113d7bd9b51131d2d52a55fb62bc869))

## [0.21.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.20.0...plugin-runtime-v0.21.0) (2026-05-14)


### Features

* **plugin/runtime:** surface context handoff guidance in footer ([70385f8](https://github.com/each4all/agentic-plugins/commit/70385f864a8bd89486554959515dff5aa8fc723f))

## [0.20.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.19.0...plugin-runtime-v0.20.0) (2026-05-14)


### Features

* **plugin/runtime:** add context handoff guidance ([cdb94e7](https://github.com/each4all/agentic-plugins/commit/cdb94e787214b5694a2b5c966019fcfd77d97a25))

## [0.19.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.18.0...plugin-runtime-v0.19.0) (2026-05-14)


### Features

* **plugin/runtime:** add consensus latest status lookup ([03302d7](https://github.com/each4all/agentic-plugins/commit/03302d75f838b5cfb3a5f1ac02f38803c1b1b644))

## [0.18.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.17.0...plugin-runtime-v0.18.0) (2026-05-14)


### Features

* **plugin/runtime:** add read-only worktree planner ([46c81fb](https://github.com/each4all/agentic-plugins/commit/46c81fb12640bee51f458b8e2e3e81f985b480fc))

## [0.17.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.16.0...plugin-runtime-v0.17.0) (2026-05-14)


### Features

* **plugin/runtime:** support manual consensus peer lanes ([5ad6fb6](https://github.com/each4all/agentic-plugins/commit/5ad6fb6adc04059435970c30e99bf8cf5166394d))

## [0.16.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.15.0...plugin-runtime-v0.16.0) (2026-05-14)


### Features

* **plugin/runtime:** clarify Codex cache materialization ([44ec1b1](https://github.com/each4all/agentic-plugins/commit/44ec1b116839eb1c2ae4236a89b330a935dfad89))

## [0.15.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.14.0...plugin-runtime-v0.15.0) (2026-05-14)


### Features

* **plugin/runtime:** add consensus guidance to footer ([ce9f390](https://github.com/each4all/agentic-plugins/commit/ce9f390df26f8e0fb962ead4d966a2a977a80272))

## [0.14.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.13.1...plugin-runtime-v0.14.0) (2026-05-14)


### Features

* **plugin/runtime:** guide consensus status next actions ([e08146b](https://github.com/each4all/agentic-plugins/commit/e08146bcb22acc517918adebe42608a0e54a3b8f))

## [0.13.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.13.0...plugin-runtime-v0.13.1) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** report Codex marketplace-cache-only state ([bd3ff0e](https://github.com/each4all/agentic-plugins/commit/bd3ff0eab6219235d95b1e384a0d9aedc5435641))

## [0.13.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.2...plugin-runtime-v0.13.0) (2026-05-14)


### Features

* **plugin/runtime:** report context source freshness ([1674294](https://github.com/each4all/agentic-plugins/commit/1674294ae37b1bddddd8154f161fc6b8d9cb2fd9))

## [0.12.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.1...plugin-runtime-v0.12.2) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** classify operator precondition failures ([3d6ffb3](https://github.com/each4all/agentic-plugins/commit/3d6ffb39565efe7821bbeea9665e5c95c7c12541))

## [0.12.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.0...plugin-runtime-v0.12.1) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** harden consensus timeout UX ([0a8733f](https://github.com/each4all/agentic-plugins/commit/0a8733fdba4519de38a7d3e5fd53d864e6b41d85))

## [0.12.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.11.0...plugin-runtime-v0.12.0) (2026-05-13)


### Features

* **plugin/runtime:** execute consensus companions ([29a2e9d](https://github.com/each4all/agentic-plugins/commit/29a2e9d442269fc70075f58ffe5322af2064e1a9))

## [0.11.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.10.0...plugin-runtime-v0.11.0) (2026-05-13)


### Features

* **plugin/runtime:** persist settings execution artifacts ([3c1157f](https://github.com/each4all/agentic-plugins/commit/3c1157f4392d38c42b1dbfab4e0ecf015888cd00))

## [0.10.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.9.0...plugin-runtime-v0.10.0) (2026-05-13)


### Features

* **plugin/runtime:** execute settings plugin management ([0cdb894](https://github.com/each4all/agentic-plugins/commit/0cdb894fa26ce5a83176190e87a1ee7c7d699220))

## [0.9.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.8.0...plugin-runtime-v0.9.0) (2026-05-13)


### Features

* **plugin/runtime:** project effective settings resolution ([c5475a0](https://github.com/each4all/agentic-plugins/commit/c5475a0966d5c1898418f6f69e04e5af8b0bcda3))

## [0.8.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.7.0...plugin-runtime-v0.8.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor readiness matrix ([857ebc7](https://github.com/each4all/agentic-plugins/commit/857ebc788770650888609c73079fe1b7c1b73a4b))
* **plugin/runtime:** add workflow storage migration command ([5d974ed](https://github.com/each4all/agentic-plugins/commit/5d974ed37805e13d66803360338a18003699febf))
* **plugin/runtime:** diagnose workflow storage homes ([6f42f4c](https://github.com/each4all/agentic-plugins/commit/6f42f4c8ae5ca6d9238a1bb28d6c27be02c8ec4c))


### Bug Fixes

* **plugin/runtime:** accept migrate subcommand after flags ([550e93d](https://github.com/each4all/agentic-plugins/commit/550e93d91b0a4dd61f9f99a19cece513a833899b))
* **plugin/runtime:** report codex hook feature parity ([c330698](https://github.com/each4all/agentic-plugins/commit/c330698e0c6183e4c70026631779880710e93857))

## [0.7.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.6.0...plugin-runtime-v0.7.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor permission proof ([eace036](https://github.com/each4all/agentic-plugins/commit/eace036b62622616dd522206ccf2e1ea9ca2d30a))
* **plugin/runtime:** add host parity diagnostics ([6073f30](https://github.com/each4all/agentic-plugins/commit/6073f3099d97b88df08db64f841a603025002af2))
* **plugin/runtime:** add PR handling readiness footer ([7aa2929](https://github.com/each4all/agentic-plugins/commit/7aa292936ec1551f0cf0d272604c8193ae2e416c))
* **plugin/runtime:** validate artifact ignore policy ([dfae3fc](https://github.com/each4all/agentic-plugins/commit/dfae3fcff2b8f4fe9af2f91c79a3fada971bc4d3))

## [0.6.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.5.0...plugin-runtime-v0.6.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor deep peer smoke executor ([0c784c3](https://github.com/each4all/agentic-plugins/commit/0c784c3b2552b336a01dc9e67851e86a0ccd3642))

## [0.5.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.4.0...plugin-runtime-v0.5.0) (2026-05-13)


### Features

* **plugin/runtime:** expand footer context lookup ([b1f620c](https://github.com/each4all/agentic-plugins/commit/b1f620c90610f704e5f06578de086d69a83a4b19))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.3.0...plugin-runtime-v0.4.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor sandbox permission probe ([9576b57](https://github.com/each4all/agentic-plugins/commit/9576b572fe92ba9a0a8892489ae47399be679cb1))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.2.0...plugin-runtime-v0.3.0) (2026-05-13)


### Features

* **plugin/runtime:** add plan-only doctor deep peer smoke preflight ([8ba23f3](https://github.com/each4all/agentic-plugins/commit/8ba23f3a829f6c181acde92e1c0e0b80dfc1bc91))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.1.0...plugin-runtime-v0.2.0) (2026-05-13)


### Features

* **plugin/runtime:** add completion footer helper ([5cc428b](https://github.com/each4all/agentic-plugins/commit/5cc428b574ae67a7a7d09aa493712fe463ef6e84))
* **plugin/runtime:** add consensus artifact scaffold ([46c6b99](https://github.com/each4all/agentic-plugins/commit/46c6b9960d89a93dcd7f8c03df15b159bc446b7f))
* **plugin/runtime:** add context artifact scaffold ([c909f24](https://github.com/each4all/agentic-plugins/commit/c909f2411e234c4766d05899a9e7355469708735))
* **plugin/runtime:** add context budget check ([8908e84](https://github.com/each4all/agentic-plugins/commit/8908e84d940e26ae5717f0d5b77889b551edc503))
* **plugin/runtime:** add latest context status lookup ([fb84276](https://github.com/each4all/agentic-plugins/commit/fb84276299194bd079c9ccbbb418e7f600d2ffec))
* **plugin/runtime:** add read-only doctor ([13fed73](https://github.com/each4all/agentic-plugins/commit/13fed73e0e9a66a08c14710a3a60eb5787044bc4))
* **plugin/runtime:** add settings planner ([cb9bb45](https://github.com/each4all/agentic-plugins/commit/cb9bb458519a1c1fc11b210fd726da5d92861c00))

## 0.1.0

- Initial runtime L1 framework primitive scaffold.
- Add read-only `runtime:doctor` command and Codex skill wrapper.
- Report host CLI/auth state, marketplace/cache discovery, companion contract compatibility, model/effort observation, companion readiness, and workflow/peer-run ledger health.
