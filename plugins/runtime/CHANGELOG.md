# Changelog

## Unreleased

### Features

- Add `runtime:context`, an artifact-only context hygiene scaffold that writes summary, risk, artifact pointers, and next-session handoff files under `.agentic-plugins/runs/context/` without mutating host session context.
- Add `runtime:context check`, a read-only explicit context budget check that computes green/yellow/red risk without creating artifacts or mutating host session context.
- Add `runtime:context status --latest`, a read-only latest handoff lookup with artifact age and stale-state reporting.
- Recognize the `founder` plugin in the hardcoded `PLUGIN_NAMES` inventory so `runtime:doctor` / `runtime:settings` cover it across the install / cache / catalog probes (ADR-0036 RT). Because founder is hook-bearing (it ships a Codex hooks manifest since founder PR2), it is also surfaced in the Codex hook-readiness report — correctly flagging founder's hooks for `/hooks` review/trust. The deliberate non-goal is a founder-*specific* workflow-ledger health check (it would couple runtime to founder's state schema); founder's ledger is iterated generically like every other plugin (an empty ledger reports as empty — no founder-specific health logic).
- Recognize the `designer` plugin in the hardcoded `PLUGIN_NAMES` inventory so `runtime:doctor` / `runtime:settings` cover it across the install / cache / catalog probes (ADR-0042 RT). Because designer is hook-bearing (it ships a Codex hooks manifest since designer PR2), it is also surfaced in the Codex hook-readiness report — packaged hooks are enumerated as `/hooks` review targets, and runtime never claims they are trusted or active (that stays a manual attestation it cannot observe). Deliberate non-goals at that point, pinned by tests then: the runtime `workflow_kind` projection enum was **not** extended (designer reached the session-handoff seam as an honest unsupported kind, like founder), and designer stays out of the `runtime:dashboard` Tier-1 persona set. Within this same unreleased window, ADR-0043 S2 (entry below) discharged the projection-enum non-goal — the seam now models all four personas — while the dashboard Tier-1 exclusion stands on its own ADR-0040 §6 scoping (ADR-0043 §3).
- Fix the Codex not-installed evidence string, which hardcoded `runtime` for every plugin — a not-installed `designer` reported "codex plugin list does not report runtime as installed". `resolveCodexInstallState` now threads the plugin name through. This closes the generic-name fix the founder RT slice recorded as deferred; the designer inventory addition is what surfaced the wrong name to an operator.
- Fix `runtime:cutover`'s operator hook-review checklist, which hardcoded "review and enable/trust bundled engineer and orchestrator hooks". It now names the plugins doctor actually reports as Codex hook review targets. Failure scenario this closes: with a fourth hook-bearing plugin in the inventory, an operator following the literal checklist reviews the wrong set, leaves the newcomer's hooks untrusted, and the cutover gate can never satisfy while the checklist claims it should.
- Extend the ADR-0031 workflow-projection seam to all four personas (ADR-0043 §1): `VALID_WORKFLOW_KINDS` gains `founder` and `designer`, so their bounded 8-field projections are accepted at the session-handoff seam instead of degrading as unsupported kinds. The unsupported-kind degradation path stays as the permanent honest-scope defense for typo'd kinds and not-yet-onboarded personas; the regression suite now exercises it across both the context and footer paths with a genuinely unsupported kind (`image` — a lean L2 with no workflow state machine by design, ADR-0037), and the former founder/designer reject-tests flipped to four-persona acceptance coverage. `footer.mjs`'s persona command host-localization regex additionally gains `designer` — a latent omission on the same contract surface (a `/designer:<verb>` command flowing through a footer was not rewritten to the render host's prefix) — with a dedicated designer-localization regression. `footer-contract.md` and the README widen to the four-persona seam with rollout-neutral code-emit wording (ADR-0043 §5 tracks which personas have onboarded — no hardcoded today-list), and the runtime limits strings plus the context/consensus command and skill boundary lines become persona-generic ("persona workflow state") instead of naming engineer/orchestrator. One degradation-path refinement rides along: a whitespace-padded but otherwise supported `workflow_kind` (e.g. `" founder "`) is now classified as a plain malformed projection rather than reported as an unsupported kind — the old report contradicted its own supported-kind list.

### Notes

- The `founder` inventory addition changes the `PLUGIN_NAMES` set, which invalidates the freshness of any previously recorded `runtime:doctor` proof (the proof-reuse gate requires the full plugin set + versions to match). Re-record the doctor proof on a host where all five plugins (including founder) are installed; until then `runtime:doctor` re-runs the proof rather than reusing the now-stale record.
- Deferred (pre-existing, out of this RT slice's scope; surfaced by the founder inventory expansion): `cutover-audit.mjs`'s package map still omits `plugins/founder` (the omcc cutover predates founder, so cutover parity over founder is a separate scoped decision). The second deferral in this line — `resolveCodexInstallState`'s hardcoded `runtime` evidence string — is **closed** by the designer RT slice above.
- The `designer` inventory addition affects `runtime:doctor` proof reuse. The reuse gate does not compare plugin-set membership; it compares a per-plugin `{source, claude_cache, codex_installed}` version triple for every name in `PLUGIN_NAMES`. A proof recorded before designer joined has no designer entry, so its triple reads all-null: reuse is invalidated exactly when designer is observable (its source manifest is present in the repo, or it is installed/cached on the host) and remains valid when designer is absent everywhere. In the normal dogfood case — running doctor inside this repo — the source manifest is present, so re-record the proof.
- `cutover-audit.mjs`'s package map also omits `plugins/designer` (same reason as founder: the omcc cutover predates both personas). Unchanged here.

## [0.83.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.82.0...plugin-runtime-v0.83.0) (2026-07-20)


### Features

* **plugin/runtime:** S7a — ADR-0045 entry-brief bounded read layer (versioned tolerant parsers + bounded scans) ([#598](https://github.com/each4all/agentic-plugins/issues/598)) ([5c6dae8](https://github.com/each4all/agentic-plugins/commit/5c6dae8f93d3254a97bfdd41246032260c986e55))
* **plugin/runtime:** S7b — ADR-0045 entry-brief arbiter (§16 lattice + pointer-only brief + user-scope-only session keys + context CLI) ([#599](https://github.com/each4all/agentic-plugins/issues/599)) ([45624bf](https://github.com/each4all/agentic-plugins/commit/45624bf2254a591fa676f3fc6ca404a99ae46e8d))
* **plugin/runtime:** S8 — ADR-0045 dashboard entry advisory + entry-brief readiness diagnosis (§7 snapshot-only advisory + §18 half-enabled states + trusted-host threading) ([#600](https://github.com/each4all/agentic-plugins/issues/600)) ([de20853](https://github.com/each4all/agentic-plugins/commit/de20853d591f887a96e1c0826dca2002c95f0ca8))

## [0.82.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.81.0...plugin-runtime-v0.82.0) (2026-07-19)


### Features

* **runtime:** S2 — session-capture foundation: contract, schemas, session config family ([#588](https://github.com/each4all/agentic-plugins/issues/588)) ([9dc3eff](https://github.com/each4all/agentic-plugins/commit/9dc3eff21d8b4bf45d8759043a93f12aa3252817))
* **runtime:** S3a — session-capture staging executors: note (--text/--file/--clear) + status --slot, explicit hook-grade output-mode split ([#590](https://github.com/each4all/agentic-plugins/issues/590)) ([8b7d887](https://github.com/each4all/agentic-plugins/commit/8b7d887f94d116993f2f18ee7b52356b7e8c6ef6))
* **runtime:** S3b — session-capture publisher: publish-session transaction, fs-mutation guard modeling, mutation-verified suite ([#591](https://github.com/each4all/agentic-plugins/issues/591)) ([7f5710a](https://github.com/each4all/agentic-plugins/commit/7f5710a5274c1fd9a46fafe4a1ef7779e5593454))
* **runtime:** S4 — session-capture readiness: shared half-enabled-chain diagnosis in doctor/settings, dynamic publisher-floor declaration, ADR-0044 §10 operator docs + ADR pointers ([#592](https://github.com/each4all/agentic-plugins/issues/592)) ([417bee6](https://github.com/each4all/agentic-plugins/commit/417bee682deb9d35120d1b8754d78fedb02b697c))

## [0.81.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.80.1...plugin-runtime-v0.81.0) (2026-07-18)


### Features

* **runtime:** S8a1 — harden existing doctor/settings production surfaces ([#576](https://github.com/each4all/agentic-plugins/issues/576)) ([267cd33](https://github.com/each4all/agentic-plugins/commit/267cd336ecc5f40518fd54ba089bb5ae951da875))
* **runtime:** S8a2 — machine-bootstrap core + schemas ([5af386e](https://github.com/each4all/agentic-plugins/commit/5af386ef9acd8f01fcbcc89812d192047df253dc))
* **runtime:** S8a4 — repair the §8.2 Codex /hooks attestation dead pipe end-to-end ([29bb5b1](https://github.com/each4all/agentic-plugins/commit/29bb5b10d52783a192ab805239bae2062a3eb5c3))
* **runtime:** S8a5 — per-handler Codex hook-disabled evidence ([#581](https://github.com/each4all/agentic-plugins/issues/581)) ([8712eb9](https://github.com/each4all/agentic-plugins/commit/8712eb9b647fe76a4303b94434efbc3f419338b3))
* **runtime:** S8b — wire the runtime:bootstrap public surface (tenth runtime command) ([#582](https://github.com/each4all/agentic-plugins/issues/582)) ([960c8bc](https://github.com/each4all/agentic-plugins/commit/960c8bc0c4e9a073e7df93e269c8a4e7286c2956))

## [0.80.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.80.0...plugin-runtime-v0.80.1) (2026-07-14)


### Bug Fixes

* **runtime:** close the permission-advisor defect class — secret leak, danger-rule bypass, cross-bucket governance, and their two mirrors (S1) ([89c16ad](https://github.com/each4all/agentic-plugins/commit/89c16ad85cb5d2b01217b82c04e4437ba1a0e675))

## [0.80.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.79.0...plugin-runtime-v0.80.0) (2026-07-13)


### Features

* **plugin/runtime:** completion-output contract with per-field provenance and visible generic fallback ([00dbc80](https://github.com/each4all/agentic-plugins/commit/00dbc800d04037e9f3178d4c3a0a51f8a802c3be))

## [0.79.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.78.1...plugin-runtime-v0.79.0) (2026-07-12)


### Features

* **plugin/runtime:** extend workflow-projection seam to four personas (ADR-0043 S2) ([#555](https://github.com/each4all/agentic-plugins/issues/555)) ([cb720e7](https://github.com/each4all/agentic-plugins/commit/cb720e795945a972432843ad9aebd3837d09b863))

## [0.78.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.78.0...plugin-runtime-v0.78.1) (2026-07-10)


### Bug Fixes

* **plugin/runtime:** fold attention into doctor's expected Codex hook sets ([#543](https://github.com/each4all/agentic-plugins/issues/543)) ([aaf376d](https://github.com/each4all/agentic-plugins/commit/aaf376d12573c36f74a699c8f4ba1f4ad64344a8))

## [0.78.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.77.2...plugin-runtime-v0.78.0) (2026-07-10)


### Features

* **plugin/runtime:** add probe-free --skip-host-cli-probes settings mode (S2B) ([#540](https://github.com/each4all/agentic-plugins/issues/540)) ([4833198](https://github.com/each4all/agentic-plugins/commit/4833198ebc8464deadec964161c93834164c8727))

## [0.77.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.77.1...plugin-runtime-v0.77.2) (2026-07-10)


### Bug Fixes

* **plugin/runtime:** resolve peer context without host-CLI probes ([#534](https://github.com/each4all/agentic-plugins/issues/534)) ([28ee42b](https://github.com/each4all/agentic-plugins/commit/28ee42b7a54414dab7b1c5b2b430d6490b77a754))

## [0.77.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.77.0...plugin-runtime-v0.77.1) (2026-07-09)


### Bug Fixes

* **plugin/runtime:** read an absent Codex hook `enabled` key as enabled, not disabled ([#530](https://github.com/each4all/agentic-plugins/issues/530)) ([a90bfdf](https://github.com/each4all/agentic-plugins/commit/a90bfdf039ca71394c14c491a142bf302022204d))

## [0.77.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.76.0...plugin-runtime-v0.77.0) (2026-07-09)


### Features

* **plugin/runtime:** recognize designer in the doctor/settings plugin inventory (ADR-0042 RT) ([#528](https://github.com/each4all/agentic-plugins/issues/528)) ([1db108e](https://github.com/each4all/agentic-plugins/commit/1db108e13b1a5b4ea52dbe331d8a0eee9bf6a657))

## [0.76.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.75.0...plugin-runtime-v0.76.0) (2026-07-07)


### Features

* **runtime:** add artifact-only egress-launcher activation plan to settings (ADR-0041 §12) ([#516](https://github.com/each4all/agentic-plugins/issues/516)) ([b99f7da](https://github.com/each4all/agentic-plugins/commit/b99f7da6959ded6f58d8c3b20775bb6e795551d2))

## [0.75.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.74.1...plugin-runtime-v0.75.0) (2026-07-07)


### Features

* **runtime:** add opt-in closed-vocabulary headline egress field (ADR-0041 §3a) ([#511](https://github.com/each4all/agentic-plugins/issues/511)) ([6ad5d4b](https://github.com/each4all/agentic-plugins/commit/6ad5d4bd8f39201e739b5b89df6507a38d134e3e))

## [0.74.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.74.0...plugin-runtime-v0.74.1) (2026-07-06)


### Bug Fixes

* **runtime:** harden ADR-0041 §2d egress transport for IPv6-broken hosts ([11db53a](https://github.com/each4all/agentic-plugins/commit/11db53a0da4a7108a3dc482c65575efb61da6079))

## [0.74.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.73.0...plugin-runtime-v0.74.0) (2026-07-06)


### Features

* **runtime:** ADR-0041 §2d fetch→node:https E1 egress transport (impl-transport) ([#501](https://github.com/each4all/agentic-plugins/issues/501)) ([ed14d23](https://github.com/each4all/agentic-plugins/commit/ed14d23c5d3036fc90b9fff79e5ad0c9c7e5e8d3))

## [0.73.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.72.1...plugin-runtime-v0.73.0) (2026-07-05)


### Features

* **runtime:** ADR-0041 §2c E1 egress config layer (verified-local reader + activation loader) ([#491](https://github.com/each4all/agentic-plugins/issues/491)) ([e425479](https://github.com/each4all/agentic-plugins/commit/e4254791c9122c1f7d90e5951544db85eeb96b23))
* **runtime:** ADR-0041 §4 optional cross-machine routing fields in the event schema ([5fa0c9e](https://github.com/each4all/agentic-plugins/commit/5fa0c9e5b49acafebf6c4085212f35867da4d764))
* **runtime:** ADR-0041 §6/§7 egress semantics (taxonomy + claim-finalization + attempt-mirror + dashboard) ([#495](https://github.com/each4all/agentic-plugins/issues/495)) ([8e48e14](https://github.com/each4all/agentic-plugins/commit/8e48e1412031d821a07061212419a6a5a1f48648))
* **runtime:** ADR-0041 channel — Telegram E1 egress (pinned fetch + buildEgressPayload + egress secret-scrub) ([#496](https://github.com/each4all/agentic-plugins/issues/496)) ([552e634](https://github.com/each4all/agentic-plugins/commit/552e634f6c925def2381e792017cfe60f8e38925))


### Bug Fixes

* **runtime:** ADR-0041 E1 acceptance gate — scrub-before-cap + cross-host egress acceptance ([#497](https://github.com/each4all/agentic-plugins/issues/497)) ([4bf4ed9](https://github.com/each4all/agentic-plugins/commit/4bf4ed90a03b42fa0a1ae80347d999c64a95b128))

## [0.72.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.72.0...plugin-runtime-v0.72.1) (2026-07-04)


### Bug Fixes

* **plugin/runtime:** classify Claude-hook-only plugins as claude_adapter_only in the Codex hook check ([67c2e1f](https://github.com/each4all/agentic-plugins/commit/67c2e1f4279ad820db106503964af9e54163a39a))

## [0.72.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.71.0...plugin-runtime-v0.72.0) (2026-07-04)


### Features

* **plugin/runtime:** recognize attention in the plugin inventory (ADR-0040 §3) ([fe52ab8](https://github.com/each4all/agentic-plugins/commit/fe52ab828caaf9f270be9444d6d63a7a515fceaa))

## [0.71.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.70.1...plugin-runtime-v0.71.0) (2026-07-04)


### Features

* **plugin/runtime:** add ADR-0040 §1 notify-schema contract lib (event schema + atomic TTL dedupe) ([#473](https://github.com/each4all/agentic-plugins/issues/473)) ([af36d83](https://github.com/each4all/agentic-plugins/commit/af36d83f19078159c54a7c4b5d13fa885bb74094))
* **plugin/runtime:** add ADR-0040 §2 notify_* settings keys via generic key-family differ ([#475](https://github.com/each4all/agentic-plugins/issues/475)) ([86f75e9](https://github.com/each4all/agentic-plugins/commit/86f75e99631ed1a385ce18188f9366f320ea2669))
* **plugin/runtime:** add ADR-0040 §2 notify.mjs emitter with built-in channels and §4 registry pinning ([#476](https://github.com/each4all/agentic-plugins/issues/476)) ([89a9ea9](https://github.com/each4all/agentic-plugins/commit/89a9ea93933923129e34bd362fbf3cde5f0d6a18))
* **plugin/runtime:** add ADR-0040 §4 runtime:settings --notification-plan Codex M1 fragment plan ([#478](https://github.com/each4all/agentic-plugins/issues/478)) ([2fac66f](https://github.com/each4all/agentic-plugins/commit/2fac66fad01e3b99948e36690ed13ae4324df3f0))
* **plugin/runtime:** add ADR-0040 §6 runtime:dashboard Tier 1+2 aggregate operator view ([#479](https://github.com/each4all/agentic-plugins/issues/479)) ([421a836](https://github.com/each4all/agentic-plugins/commit/421a8364873973a5b89e375c12e60a1704c17d37))

## [0.70.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.70.0...plugin-runtime-v0.70.1) (2026-07-02)


### Bug Fixes

* **runtime:** host-localize persona plugin commands in the completion footer ([#469](https://github.com/each4all/agentic-plugins/issues/469)) ([f48d6ef](https://github.com/each4all/agentic-plugins/commit/f48d6efb78e92f3a5ce1df977af28c7be1f0ba72))

## [0.70.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.69.0...plugin-runtime-v0.70.0) (2026-06-30)


### Features

* **plugin/runtime:** doctor R0 permission diagnosis (ADR-0038 doctor-diagnose) ([#457](https://github.com/each4all/agentic-plugins/issues/457)) ([a25d6bc](https://github.com/each4all/agentic-plugins/commit/a25d6bc13dafc657b428e98b9e5f12b3247c8f66))
* **plugin/runtime:** host-neutral permission-advisor core (ADR-0038 advisor-core) ([#453](https://github.com/each4all/agentic-plugins/issues/453)) ([e00fb1c](https://github.com/each4all/agentic-plugins/commit/e00fb1c0bcf868820fe64c38aa9f3d94deda3f5a))
* **plugin/runtime:** permission advisory artifact slice (ADR-0038 permission-artifacts) ([#456](https://github.com/each4all/agentic-plugins/issues/456)) ([037a7fa](https://github.com/each4all/agentic-plugins/commit/037a7fa3cb9f222c04508a627a929f649665e353))
* **plugin/runtime:** settings M1 Claude permission plan (ADR-0038 settings-claude) ([#458](https://github.com/each4all/agentic-plugins/issues/458)) ([c3e636e](https://github.com/each4all/agentic-plugins/commit/c3e636eda28d1ea7cf4d2069d5abd4b0ca56f078))
* **plugin/runtime:** settings M1 Codex permission plan + cross-host artifact (ADR-0038 settings-codex) ([#459](https://github.com/each4all/agentic-plugins/issues/459)) ([ee0a40b](https://github.com/each4all/agentic-plugins/commit/ee0a40bc947a786de0f096529d754d06fea06f46))
* **plugin/runtime:** unify permission-advisor sanitize helpers (ADR-0038 sanitize-util) ([#451](https://github.com/each4all/agentic-plugins/issues/451)) ([c2a8413](https://github.com/each4all/agentic-plugins/commit/c2a84134803a7e6ccd057217f99527b389a4bb77))
* **plugin/runtime:** usage-record learner C engine (ADR-0038 usage-learner) ([#455](https://github.com/each4all/agentic-plugins/issues/455)) ([a94edda](https://github.com/each4all/agentic-plugins/commit/a94edda166334021d79cde0468d86f7ac62614dd))

## [0.69.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.68.1...plugin-runtime-v0.69.0) (2026-06-27)


### Features

* **plugin/runtime:** add image to PLUGIN_NAMES so doctor/settings diagnose it ([#447](https://github.com/each4all/agentic-plugins/issues/447)) ([e6cdcab](https://github.com/each4all/agentic-plugins/commit/e6cdcab78789bd2f345013c282f22b6faa0ca40d))

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
