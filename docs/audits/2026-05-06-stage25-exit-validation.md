---
title: "Stage 2.5+ Exit Validation Audit"
date: 2026-05-06
audit_type: cross-cutting structural + runtime
scope: agentic-plugins (each4all/agentic-plugins) full repo + external comparison targets
git_baseline: 3f44364 / main / clean
methodology:
  - 4 parallel general-purpose agents (Q5 companions parity / Q6 engineer parity / Q1+Q2+Q3 marketplace+sustainability / Q4 runtime smoke)
  - Codex plan-verify ensemble (agentic-plugins/companions/codex-companion.mjs dogfood, effort=high)
  - 정적 비교 + runtime smoke (`COMPANIONS_SMOKE=1`, plugin-shape, validate-marketplace, validate-versions, sync-companion-bundles)
related:
  - "ADR-0010 (4-layer composition + 6 cognitive verbs)"
  - "ADR-0011 (workflow continuity Option III storage)"
  - "ADR-0012 (omcc + codex-plugin-cc removal preconditions, 4-condition rubric)"
  - "ADR-0014 / ADR-0015 (plugins/research deprecation cascade)"
  - "ADR-0016 (cross-package commit splitting)"
  - "ADR-0017 (Stage 2.5+ continuity + schema roadmap, planned PR2)"
workflow_id: start-20260506T120325Z-49c5e8fe
---

# Stage 2.5+ Exit Validation Audit

## Executive Summary

agentic-plugins는 **Stage 2 exit gate 달성 + omcc/codex-plugin-cc 제거 산출물 레벨 차단요인 0** 상태이다. 즉시 user 환경에서 omcc 제거를 권고하기에는 ADR-0012 condition 3·4가 partial(Stage 2 자체가 omcc-dev로 개발됨)이어서 Stage 3 cushion까지 유지 권장. 보완해야 할 핵심은 engineer의 메타 인프라(`/engineer:resume`, `/engineer:checkpoint`, Stop hook auto-archive, `ensemble_results` frontmatter 영속화) — ADR-0017로 통합 ROADMAP 채택 후 단계 구현.

| 차원 | Verdict | 한 줄 요약 |
|------|---------|-----------|
| Q1 omcc/codex 제거 가능 | **PASS** | 산출물 코드/CI/scripts 의존 0; ADR-0012 progress matrix는 partial |
| Q2 마켓플레이스 자립 개발 | **PARTIAL** | Codex commands schema(ADR-0013) + Stage 3 designer 미진입 + meta commands non-goal |
| Q3 지속 개발 인프라 | **PASS** | release-please cascade + 3-way validate + drift detection + 16 ADR |
| Q4 companions 양방향 동작 | **PASS** | 128 unit + 4 smoke (양방향 실 LLM round-trip) + 127 plugin-shape green |
| Q5 companions parity (vs codex-plugin-cc) | **PASS** (우월) | agentic-plugins가 양방향, wire-spec 문서화, SRP, 자체 테스트, signal-safe 등에서 우월 |
| Q6 engineer parity (vs omcc-dev) | **PARTIAL** | cited-brief 흡수 PASS; 메타 인프라(meta commands / schema-2 / auto-archive) 의도적 deferral |

---

## Methodology

본 audit은 사용자 6 질문을 4 parallel general-purpose agent로 분해 후 각 agent가 정적 + runtime evidence를 수집했다. 결과 plan을 agentic-plugins 자체 `companions/codex-companion.mjs`로 도그푸드 형태의 Codex plan-verify ensemble에 넣어 외부 시각으로 검증했다(verdict: modify, run_id `plan-verify-20260506T123637Z-8e2c504b`, duration 93s).

비교 대상:
- **codex-plugin-cc** v1.0.4 — `~/.claude/plugins/cache/omcc/codex/1.0.4/`
- **omcc-dev** v2.10.0 — `~/.claude/plugins/cache/omcc/omcc-dev/2.10.0/`
- **omcc-research** v2.10.0 — `~/.claude/plugins/cache/omcc/omcc-research/2.10.0/`

검증 도구:
- `node --test companions/tests/*.test.mjs` (128 unit / 78ms / 20 suites)
- `COMPANIONS_SMOKE=1 node --test companions/tests/*.smoke.test.mjs` (4 round-trip / ~15.4s — Claude→Codex와 Codex→Claude 양방향, text + JSON envelope)
- `node --test tests/plugin-shape/*.mjs` (127 / 96ms / 50 suites)
- `node scripts/{validate-marketplace,validate-versions,sync-companion-bundles}.mjs` (모두 OK, drift 0)

---

## Q1 — omcc / codex@omcc 제거 가능?

**Verdict: PASS** (산출물 레벨)

### Evidence

- `companions/claude-companion.mjs:7` `import { spawn } from 'node:child_process'` — 직접 `claude` CLI, omcc 우회 없음
- `companions/codex-companion.mjs:151-165` `buildCodexArgs` (`codex exec --skip-git-repo-check --ephemeral` + `-c model_reasoning_effort=`) — public CLI surface only
- `plugins/companions/scripts/discover-peer.mjs:54-72` cache base = `~/.claude/plugins/cache/agentic-plugins/companions` 또는 `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions` — 자체 marketplace 경로만 스캔 (omcc fallback 없음)
- `plugins/engineer/scripts/dispatch-peer.mjs:41-44` CACHE_BASES도 동일하게 agentic-plugins 경로만
- `.github/workflows/{claude-tests,codex-tests,marketplace-validate,release-please}.yml` — 4 workflow 모두 omcc 미언급
- `package.json:17-25` npm scripts 어디에도 omcc shell-out 없음
- 잔존 `omcc` 토큰 = `plugins/engineer/skills/decide/SKILL.md:91` 같은 lesson-source attribution 한정 (실행 경로 아님)
- `tests/plugin-shape/test-engineer-plugin.mjs:69-85` STALE_TOKENS — `omcc-research` 금지 / `omcc-dev` lesson-source 의도 허용

### 그러나 progress matrix는 partial

ADR-0012 §"Progress tracking layer"(line 97-98)에 따라 progress는 ADR이 아닌 `docs/DEVELOPMENT.md`에서 추적된다. Stage 2 exit evidence 기준:
- C1 (산출물 omcc 의존 부재): **satisfied** (이 audit이 evidence)
- C2 (companions parity): **satisfied** (Q5 PASS)
- C3 (engineer 단독 자체 개발 가능): **partial** — Stage 2 자체가 omcc-dev로 개발됨. Stage 3 designer 첫 non-trivial workflow가 engineer 단독 완료 시 satisfied 처리
- C4 (self-contained scaffolding per-item audit): **partial** — Stage 3 cushion 진입 후 dev infra per-item lens audit 후 갱신

**권고 시기**: 4-condition 모두 satisfied 시 ADR-0012 §Removal trigger fire. 현 시점에서는 user 환경에서 omcc/codex@omcc uninstall 권고하지 않음.

---

## Q2 — agentic-plugins 마켓플레이스만으로 개발 가능?

**Verdict: PARTIAL**

agentic-plugins 카탈로그(`companions@0.4.0`, `engineer@0.4.0`)만으로 6 cognitive verbs 풀 사이클(코드 작성/리뷰/계획/리서치 등) 가능. 그러나 3가지 갭:

### G1 — Codex 측 commands/<verb>.md 자동-trigger 부재 (외부 제약)

Codex CLI 0.128.0이 plugin-commands schema를 노출하지 않아 Phase 0/1/2 contract 자동 trigger가 Codex 쪽에서 동작하지 않는다. 현재 Codex 호스트 사용 시 `state.mjs` invocation을 사용자가 manual로 처리. 이는 upstream blocker — agentic-plugins 자체 무력화는 아니다. ADR-0013으로 reserved (trigger 도래 시 채택).

근거: `docs/DEVELOPMENT.md:241-265`, `plugins/engineer/README.md:194-212`

### G2 — Stage 3 designer 미진입

design 작업(poster / social-graphics / frontend)은 `engineer:compose` profile만으론 부족. omcc-designer는 별도 plugin을 갖고 있다. Stage 3에서 `plugins/designer`가 cited-brief precedent(ADR-0014/0015) 따라 진입 예정. 현재는 명시된 Stage 갭.

근거: `AGENTS.md:298-300`, `docs/ARCHITECTURE.md:236-237`

### G3 — meta commands (resume/checkpoint/audit 분리) Stage 2 non-goal

`/engineer:resume`, `/engineer:checkpoint`을 별도 명령으로 두지 않음. 현재 verb의 Phase 0가 implicit-resume(append-on-resume) 형태. ADR-0011 §Stage 2 Non-Goals item 6에 명시된 의도. ADR-0017로 ROADMAP 채택 + 후속 구현 예정.

근거: `docs/DEVELOPMENT.md:135`, `docs/adr/0011-workflow-continuity-storage.md:373` (non-goals)

---

## Q3 — 지속 개발 / 확장 / 보완 / 유지보수 인프라

**Verdict: PASS**

### Evidence

| 인프라 | 위치 | 검증 |
|-------|------|------|
| Multi-package release | `release-please-config.json:8-47` (3 packages: companions, plugins/companions, plugins/engineer) | ✓ `extra-files` mapping으로 plugin.json 자동 갱신 |
| Manifest sync | `.release-please-manifest.json` | ✓ 3-way validate-versions가 manifest ↔ plugin.json ↔ marketplace 동기화 검증 |
| 양 카탈로그 sync | `scripts/sync-marketplace-versions.mjs:45-70` | ✓ release-please follow-up auto-trigger |
| 양 카탈로그 정합 | `scripts/validate-marketplace.mjs:81-156` | ✓ Claude/Codex marketplace + plugin.json 양방향 cross-check |
| Companion bundle drift | `scripts/sync-companion-bundles.mjs:25-92` | ✓ 3 scripts byte-identical (drift=0) |
| Plugin shape lint | `kit/lint/check-plugin-shape.mjs:84-163` | ✓ manifest fields + skills path + scripts executable + adapters traversal |
| Per-host CI | `.github/workflows/{claude,codex}-tests.yml:30-42` | ✓ 5-stage matrix 양 호스트 |
| 마켓플레이스 검증 CI | `.github/workflows/marketplace-validate.yml:43-48` | ✓ validate:marketplace + validate:versions |
| ADR governance | `docs/adr/0001..0016` + `template.md` + `README.md:34-58` | ✓ 16 ADR + Amendment vs Supersede discriminator |
| Cross-package commit policy | `AGENTS.md:158-220` + `docs/adr/0016-cross-package-commit-splitting.md` | ✓ release-please path-routing 인시던트(28b5eb8) postmortem |

테스트 카운트: `npm test` 354/354 pass, `lint:plugin-shape` OK 2 plugins, `validate:marketplace` OK 2 plugins, `validate:versions` OK 3-way, `sync-companion-bundles` drift=0.

### 발견된 약점 (모두 본 audit으로 해소 예정)

- **G3-a: kit/README ↔ 실체 drift** (영향: 중간) — `kit/README.md:7-25`은 "Stub. No implementation"이라 선언하지만 `kit/lint/check-plugin-shape.mjs`는 fully implemented + CI active gate. 외부 contributor 오인 위험 → PR3-c2 fix
- **G3-b: ARCHITECTURE.md kit/ phantom tree** (영향: 중간) — `docs/ARCHITECTURE.md:128-138`이 `adapter-generator/`, `manifest-templates/` 묘사하지만 둘 다 부재 → PR3-c2 fix
- **G3-c: AGENTS.md "Stage 2 exit met" ↔ DEVELOPMENT.md "developed using omcc-dev" tone drift** (영향: 중간) — partial framework 안에서는 모순 아니지만 cross-reference 부재 → PR3-c2 fix (AGENTS.md 한 줄 cross-reference)
- **G3-d: research@agentic-plugins 0.1.0 cache 잔존** (영향: 낮음) — Stage 2.5+ archive 이후 user 환경 cleanup 필요 → PR3-c2 release notes/AGENTS.md 한 줄 안내

---

## Q4 — companions 양방향 동작 검증

**Verdict: PASS** — 모든 layer 그린, 결함 없음.

### Runtime 결과

| Layer | 명령 | 결과 |
|-------|------|------|
| companions unit | `node --test companions/tests/*.test.mjs` | 128/128 pass, 78ms, 20 suites |
| companions smoke | `COMPANIONS_SMOKE=1 node --test companions/tests/*.smoke.test.mjs` | 4/4 pass, ~15.4s, 양방향 실 LLM round-trip + JSON envelope wire 검증 |
| plugin-shape | `node --test tests/plugin-shape/*.mjs` | 127/127 pass, 96ms, 50 suites |
| marketplace validation | `node scripts/validate-marketplace.mjs` | OK 2 plugins both catalogs |
| validate versions | `node scripts/validate-versions.mjs` | OK 3-way sync |
| sync-companion-bundles | `node scripts/sync-companion-bundles.mjs` | identical 3 scripts |
| dispatch-peer dry | `node plugins/engineer/scripts/dispatch-peer.mjs --help` | exit 0 + usage banner |

smoke test가 실제 `claude 2.1.131` + `codex-cli 0.128.0` CLI를 호출해 contract.md §4.2 envelope 스키마(status / peer_host / peer_model / stdout / exit_code / metadata / error)를 wire 레벨에서 검증.

### 관찰 사항 (영향 정보)

- **O-1**: `sync-companion-bundles.mjs --check` unknown flag silent ignore (default verify로 fall-through, exit 0). cosmetic 개선 가능
- **O-2**: validate scripts 종료 코드 명시 출력 부재 — set -e CI 컨벤션이면 OK

---

## Q5 — companions parity (vs codex-plugin-cc)

**Verdict: PASS** — agentic-plugins/companions가 codex-plugin-cc 대비 **구조적 우위**.

### 핵심 우월점

1. **양방향 first-party** — codex-plugin-cc는 단방향(Claude → Codex)만. agentic-plugins는 `claude-companion.mjs` + `codex-companion.mjs` 대칭 구현 (ADR-0001 COMPANION layer 원칙)
2. **Wire-spec 문서화** — `companions/contract.md` 615 LOC, ADR-0009 governance, version policy(SemVer + ADR gate), conformance hooks(§7), 비목표 명시(§6). 원본은 wire spec 문서 부재
3. **단일 책임 원칙(SRP)** — companion = 1-shot peer agent invocation. job 관리/review prompt/setup wizard는 모두 상위 layer. 원본은 모놀리식 7 subcommand
4. **자체 테스트** — `companions/tests/codex-companion.test.mjs` 767 LOC + `claude-companion.test.mjs` 757 LOC. 원본 cache tree에는 자체 unit/smoke 테스트 0개
5. **Strict v0.1.1 precedence** — `--prompt-file` + non-TTY stdin을 적법한 입력으로 다룸 (ADR-0009)
6. **Signal-safe lifecycle** — SIGINT 130 / SIGTERM 143이 EXIT_PEER_RUN_ERROR(1)와 충돌 회피
7. **JSON 모드 misuse envelope 보장** — `--output-format json` 파싱 후 prompt misuse 시에도 minimal envelope 출력
8. **공개 CLI surface only** — ADR-0004/0007 준수. 원본은 `codex app-server` 비공개 RPC 의존 (`lib/app-server.mjs:188-225`)
9. **Discovery library 분리** — `discover-peer.mjs` 261 LOC, env override → cache-glob → manifest verify → preflight 4단

### 누락 항목 (모두 contract.md §6 의도적 비목표)

- Background job + state.json 영속 (`§6.4`) — Bash run_in_background + ADR-0011 continuity로 상위 layer가 해결
- review-output.schema.json + adversarial-review prompt template (`§6.5`) — `engineer:critique`가 자체 schema 보유
- Stop-time review-gate hook + SessionStart/SessionEnd (`hooks/hooks.json`) — L3 plugin 또는 host adapter 책임
- `codex app-server` JSON-RPC + broker socket (`§6.7`) — 향후 streaming UX 필요 시 ADR-0008+ amendment

### 권고

omcc/codex@1.0.4 의존 완전 제거 가능. 누락 기능 다시 들여올 필요 없음 (SRP 위반).

---

## Q6 — engineer parity (vs omcc-dev / omcc-research)

**Verdict: PARTIAL**

- **omcc-dev parity**: PARTIAL — 6 verb skill body + 단일 워크플로우는 완비. 메타 명령 + schema-2 hierarchy + auto-archive 의도적 deferral
- **omcc-research → engineer:investigate cited-brief**: PASS — 4-tier 출처, audit checklist, citation remapping, Path A/B Independence 흡수 + Conflict Handling 강화 + RESEARCH_OUTPUT_ROOT env 추가
- **종합**: PARTIAL

### 우월점 (engineer 의도적 개선 11점)

1. **4-layer composition** (ADR-0010) — L1/L2/L3/L4 분리. omcc-dev는 평면 plugin
2. **6 universal cognitive verbs** — Bloom/Miller/OODA/PDCA/Double Diamond/Design Thinking 합집합. `frame` verb로 omcc-dev의 evidence→decision 직행 실패 모드 차단
3. **Bidirectional companion contract** — orchestrator/peer 추상화 + host-neutral synthesis label `[Local]`/`[Peer]`
4. **Always-max policy** — 모든 phase boundary에 peer dispatch (사용자 가치 "최상" 정합)
5. **Profile system** — 단일 verb + sub-mode (`--profile=cited-brief` 등)로 trigger 어휘 simplification
6. **자체 companions plugin** — codex-plugin-cc 의존 차단 (ADR-0008/0009 contract 명세화)
7. **Envelope shape validation** — `dispatch-peer.mjs:288-374` joint-triple status × exit_code × error.kind, backtick/CR/LF reject, --prompt-file 강제
8. **Cited-brief Conflict Handling 추가** — omcc-research에 없던 강화
9. **`RESEARCH_OUTPUT_ROOT` env** — 절대경로 + sandbox enforcement
10. **Prompt-injection 방어** — SessionStart hook의 `[engineer-active-metadata]` marker pair + JSON.stringify
11. **Stage 2 honest scope** — ADR-0011 §Non-Goals 명시 deferral (dogfood)

### Gap (10건)

| Gap | 영향 | 출처 | 처리 |
|-----|------|------|------|
| G-1 메타 명령 부재 (resume / checkpoint / codex-now) | 높음 | omcc-dev | ADR-0017 통합 ROADMAP (PR2) |
| G-2 schema-2 hierarchy / sharded deliverable mode 부재 | 중간 | omcc-dev | ADR-0017 통합 (or Stage 3+ defer) |
| G-3 ensemble_results frontmatter 영속화 부재 | 중간 | omcc-dev | ADR-0017 통합 (PR2) |
| G-4 drift classification ladder 부재 | 중간 | omcc-dev | Stage 3 defer |
| G-5 Stop auto-archive 4-조건 부재 | 중간 | omcc-dev | ADR-0017 채택 후 PR4로 (terminal marker / lock semantics 정의 후) |
| G-6 cross-workflow handoff 부재 | 낮음~중간 | omcc-dev | Stage 3+ defer |
| G-7 Ensemble Affinity LOW/MEDIUM/HIGH gating 부재 | 낮음 (의도) | omcc-dev | always-max policy 유지 권고 |
| G-8 static Claude `adapters/claude/agents/<name>.md` 부재 | 중간 | omcc-dev | PR3-c1 fix-now (Claude adapter ergonomics — cross-host parity 증거 아님) |
| G-9 presentation_mode persisted 부재 | 낮음 | omcc-dev | ADR-0017 후속 검토 |
| G-10 Artifact intake 부재 | 낮음~중간 | omcc-dev | `frame` profile에 path 인식 후 ADR 검토 |

### 권고 (Tier 1 = 사용자 회귀 직접 차단)

- ADR-0017 ROADMAP 채택 (PR2) → Tier 1 항목별 acceptance trigger / impl owner PR / validation command 명시
- Stop auto-archive(α-5)는 ADR-0017 정의 완료 후 PR4 별도 spawn (Codex plan-verify catch: ADR-0011:335 명시 non-goal이라 단순 fix-now 위험)

---

## 종합 결론 + omcc 제거 권고

### 산출물 코드 레벨

agentic-plugins/{companions, plugins/engineer, scripts, tests, CI}는 **omcc/codex-plugin-cc 의존 0**. Stage 2 exit gate 산출물 레벨 통과.

### 사용자 환경 권고

> **표기법 참고 (Phase 5 self-review F2 명시)**: 아래의 `C1`~`C4`는 본 audit의 **audit-internal sub-condition** framing이며, [ADR-0012](../adr/0012-omcc-removal-preconditions.md)의 official 4-condition matrix(condition 1~4, 모두 `partial` 상태로 [docs/DEVELOPMENT.md](../DEVELOPMENT.md) §"ADR-0012 condition progress matrix at Stage 2 exit"에서 추적)와는 다른 layer를 가진다. 매핑:
>
> - audit `C1` ("산출물 omcc 의존 부재") = ADR-0012 condition 1 ("engineer reaches omcc-dev parity")의 산출물 sub-element. audit "C1 satisfied"는 "ADR-0012 condition 1 overall partial이지만 산출물 sub-element는 satisfied" 의미.
> - audit `C2` ("companions parity") = ADR-0012 condition 2 ("engineer guarantees bidirectional companion round-trip")의 wire-spec sub-element. audit "C2 satisfied"는 "ADR-0012 condition 2 overall partial이지만 wire-spec parity sub-element는 satisfied" 의미. ADR-0012 condition 2 overall satisfied는 Codex auto-trigger path(ADR-0013) 충족 후.
> - audit `C3` / `C4` (partial) = ADR-0012 condition 3 / 4와 매칭 (둘 다 partial 유지).

ADR-0012 4-condition matrix (audit-internal sub-condition framing):
- **C1** (산출물 omcc 의존 부재): **satisfied** (본 audit evidence)
- **C2** (companions parity): **satisfied** (Q5 PASS, agentic-plugins가 우월)
- **C3** (engineer 단독 자체 개발 가능): **partial** — Stage 2 자체가 omcc-dev로 개발됨. Stage 3 designer 첫 non-trivial workflow가 engineer 단독 완료 시 satisfied 처리 (이번 audit이 evidence 1회)
- **C4** (self-contained scaffolding per-item audit): **partial** — Stage 3 cushion 진입 전 per-item dev infra omcc-dependency lens audit 수행 후 갱신

**ADR-0012 4-condition (overall) 모두 satisfied 시 user 환경에서 omcc/codex@omcc uninstall 권고**. 현 시점은 Stage 3 cushion 진입 전이라 보류. DEVELOPMENT.md progress matrix는 본 audit으로 condition 1/2의 sub-element evidence 갱신 (overall status는 partial 유지).

### 권고 시기 결정 매트릭스

| 시기 | 조건 | 비고 |
|------|------|------|
| 즉시 | (불가) — C3·C4 partial | 산출물 PASS여도 사용자 회귀 위험 |
| Tier 1 메타 명령 추가 후 | ADR-0017 핵심 항목 구현 완료 | 절반 보호, dogfood 데이터 부족 |
| **Stage 3 cushion 이후** | **C3·C4 satisfied + ADR-0017 구현 완료** | **권고 시점** ✓ |

---

## 후속 Action Items

| 분류 | 항목 | PR/처리 |
|------|------|---------|
| **PR2 ADR** | ADR-0017 stage25 continuity + schema roadmap (meta commands + ensemble_results frontmatter + auto-archive semantics 통합) | new, Proposed |
| **PR2 docs** | DEVELOPMENT.md ADR-0012 condition matrix progress (C1·C2 satisfied, C3·C4 partial trigger 명시) | modify |
| **PR3-c1** | static Claude adapter subagent 4 file (architecture-mapper / flow-tracer / hypothesis-tracer / reviewer) — Claude adapter ergonomics, cross-host parity 증거 아님 | new |
| **PR3-c2** | kit/README truth + ARCHITECTURE.md kit/ tree + AGENTS.md ADR-0012 cross-reference + parity footnotes | modify |
| **PR4** (defer) | Stop auto-archive 구현 — ADR-0017 Accepted 후 별도 fix 워크플로우로 spawn | blocked_by PR2 |
| **γ defer** | ADR-0013 (Codex CLI plugin-commands schema upstream trigger) | trigger 도래 시 |
| **γ defer** | drift classification ladder 4-tier (Stage 3 cross-host transitioning 패턴 발견 시) | Stage 3+ |
| **γ defer** | sharded deliverable mode + multi-active (Stage 3 designer 누적 후) | Stage 3+ |
| **γ defer** | kit/lint adapter-contract conformance (3rd-party adapter 시도 시) | trigger |

---

## Appendix A — Codex plan-verify ensemble verdict

run_id: `plan-verify-20260506T123637Z-8e2c504b`
duration: 93s, exit_code 0
transport: `agentic-plugins/companions/codex-companion.mjs` (도그푸드)

**Verdict**: modify

**핵심 catch 4건** (모두 ADR 인용 검증 완료):
1. **ADR-0012 amend 부정확** — ADR-0012:97-98 명시 "ADR records the decision and rubric (immutable). The progress is tracked in docs/DEVELOPMENT.md (mutable)". → 본 audit은 DEVELOPMENT.md 갱신으로 처리
2. **Stop auto-archive는 ADR-0011 non-goal** — ADR-0011:335 "The Stop hook does NOT auto-archive". → PR3에서 빼고 ADR-0017 채택 후 PR4로
3. **ADR 0017+0018 과분할** — 둘 다 workflow continuity/schema 문제 → 통합 0017로
4. **Static Claude subagents는 cross-host parity 증거 아님** — Claude adapter ergonomics 표현으로

추가 risk: Proposed ADR drift, Stop auto-archive false-positive, PR 순서 의존성, host asymmetry. 모두 plan에 반영.

---

## Appendix B — 4 parallel agent 호출 메타

| Agent | 미션 | duration | tool_uses |
|-------|------|----------|-----------|
| A (Q5 Companions parity) | codex-plugin-cc 1.0.4 ↔ agentic-plugins/companions | 234s | 49 |
| B (Q6 Engineer parity) | omcc-dev 2.10.0 + omcc-research 2.10.0 ↔ engineer | 339s | 68 |
| C (Q1+Q2+Q3 Marketplace + Sustainability) | 양 카탈로그 + release infra + ADR cascade | 286s | 76 |
| D (Q4 Runtime smoke) | unit + smoke + plugin-shape + validate + dispatch | 191s | 20 |

병렬 호출 wall clock: ~339s (Agent B 가장 오래 걸림).

---

## Workflow Provenance

- workflow_id: `start-20260506T120325Z-49c5e8fe`
- 워크플로우 파일: `<repo>/.claude/omcc-dev/workflows/start-20260506T120325Z-49c5e8fe.md` (gitignored)
- git baseline: `3f44364` / `main` / clean
- 작업 호스트: `omcc-dev` (Stage 2 exit gate 미달성 의도적 — 가장 성숙한 도구로 검토하는 게 산출물 품질 우선)
