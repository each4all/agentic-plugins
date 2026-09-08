# Adversarial self-review — `oracle-stage-docs-hand-annotation-1` → `-2`

이 문서는 `input/oracle.json`(내 1차 annotation, artifact_digest `90739b9f…2436c8`)에 대한 적대적 재검토의 기록이다. 결과 아티팩트는 `out/oracle.json`(artifact_id `oracle-stage-docs-hand-annotation-2`, artifact_digest `688a2a1262600a2776f346b389f0554aafff4d904e25f0ad8672e677a6e34c35`, sealed 2026-09-07T23:09:04Z). 사양은 `bundle/docs/assurance/evidence/measurement/measurement-contract.md` 2.2.0이며, 본문에서 §번호는 그 계약의 절이다. 도메인(437 anchor, relation별 145 + 292)은 바뀌지 않았다.

## 1. 범위와 변경 집계

| 항목 | 수 |
|---|---|
| 아티팩트 전체 행 | 437 |
| in-scope (`interpretive:`) 행 | 210 |
| 그중 1차 `not-a-claim` / `bound` / `incomplete` / `ambiguous` | 143 / 37 / 13 / 17 |
| disposition 또는 role이 바뀐 행 | **22** |
| disposition은 유지하고 provenance만 정정·보강한 행 | 13 |
| 공격했으나 살아남은 in-scope 행 | 188 |
| `lexical:` 행 정정 | 0 |

transition별:

| transition | 수 |
|---|---|
| `ambiguous -> bound` | 14 |
| `not-a-claim -> bound` | 5 |
| `not-a-claim -> incomplete` | 2 |
| `incomplete -> ambiguous` | 1 |

변경 후 in-scope 분포: proof-date-binding — not-a-claim 122, bound 40, incomplete 6, ambiguous 3; release-triple — not-a-claim 14, bound 16, incomplete 8, ambiguous 1. 22행 모두 `proof-date-binding`이다. release-triple의 in-scope 39행은 전부 살아남았다(단, 8행은 provenance에 사람이 볼 질문을 추가).

새로 참조한 iso-date occurrence 3개를 `occurrences`에 추가했다(scorecard @60918 `2026-07-11`, scorecard @117566 `2026-07-20`, DEVELOPMENT @92603 `2026-07-11`). 820 → 823이며, 참조되지 않는 occurrence는 0개다.

**왜 이 수인가.** 22건은 적지도 많지도 않다. 변경의 거의 전부(19/22)는 하나의 발견에서 나왔다: 1차 pass가 "the same day"류 조응(anaphora)을 어떤 행에서는 날짜 주장으로 읽어 bound하고, 문법적으로 동일한 다른 행에서는 "행위를 날짜 짓는 것이지 run을 날짜 짓는 것은 아니다"라며 ambiguous나 not-a-claim으로 두었다는 점이다. 그 구분은 텍스트에 있는 것이 아니라 내 습관에 있었다. 이 pass는 그 구분을 바이트 위에서 다시 시험했고, 텍스트가 구분하지 않는 곳에서는 같은 결론으로 맞췄다. 반대 방향(같은 날 조응을 전부 ambiguous로 후퇴)도 검토했으나, "the same day"는 프로즈가 실제로 쓴 단어이고 선행사가 하나뿐일 때 그것은 프로즈가 고른 것이므로 후퇴할 근거가 없었다. 다만 이 원칙 자체는 6절에서 사람에게 넘긴다.

## 2. 변경된 행 전부 (22)

아래 identity는 `(path, blob, start_byte, end_byte)`이며 `@a–b`는 반열림 바이트 구간, 줄 번호는 진단용이다. "결정한 말"은 corpus 바이트에서 그대로 인용한 것이다. 각 그룹의 공격문은 그룹 안 모든 행에 공통이고, 행별로 선행사 occurrence와 개입 토큰 스캔 결과를 적었다. 스캔은 registry의 iso-date 인식 규칙(`<YYYY>-<MM>-<DD>Z?`, 좌측 비단어 경계, 우측 비단어 또는 EOF, proof-run-id 내부 제외)을 원문 바이트에 적용한 것이며, 판단이 아니라 "선행사와 앵커 사이에 어떤 날짜 토큰이 있는가"를 열거하는 데만 썼다.

#### G1. "action the same day: R and R2" — 콜론이 같은 날의 행위의 내용으로 run을 지명

공격: 1차 pass는 같은 구문을 @115310/@118350/@66600/@70051에서는 `bound`, 여기서는 `ambiguous`로 두었다. 공격: "the same day"는 행위(clearing)를 날짜 짓고 run은 그 도구일 뿐이라는 1차 근거는, 이미 bound한 행들("which landed the same day: ... produced attestation R ... and the post-attestation record R2 restored")에도 똑같이 적용되는데 거기서는 적용하지 않았다. 텍스트는 두 구문을 구별하지 않는다. 콜론 뒤에 열거된 run이 곧 그 행위의 내용이므로 행위의 날이 run의 날이다.

- `scorecard:618` @40514–40546 `settings-20260803T091332Z-ec30fe` (blob `99b33d0`): **ambiguous → bound**; date = `2026-08-03Z` @39750–39761 (scorecard:607)
  - 결정한 말: "Cleared the same day: fresh attestation `settings-20260803T091332Z-ec30fe` and post-attestation record ... restore observed parity" — 선행사 "taken earlier that day" → "(2026-08-03Z)" @39750; 사이에 다른 iso-date 없음(스캔).
- `scorecard:619` @40577–40607 `doctor-20260803T091403Z-7f2850` (blob `99b33d0`): **ambiguous → bound**; date = `2026-08-03Z` @39750–39761 (scorecard:607)
  - 결정한 말: 같은 콜론 절의 두 번째 run "and post-attestation record `doctor-20260803T091403Z-7f2850` restore"; 같은 선행사 @39750 (이 run의 첫 출현 @39718에 붙은 날짜와 동일).
- `DEVELOPMENT:466` @54203–54235 `settings-20260803T091332Z-ec30fe` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-08-03Z` @52190–52201 (DEVELOPMENT:466)
  - 결정한 말: "The `codex-hook-review` follow-up was cleared the same day: ... `runtime:settings --attest-codex-hook-review` recorded `settings-20260803T091332Z-ec30fe` binding ..." — 선행사는 앞 문장 "taken earlier the same day"가 가리키는 "(2026-08-03Z)" @52190; 사이에 다른 iso-date 없음.
- `DEVELOPMENT:466` @54374–54404 `doctor-20260803T091403Z-7f2850` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-08-03Z` @52190–52201 (DEVELOPMENT:466)
  - 결정한 말: 같은 콜론 절의 마지막 항목 "and the post-attestation record `doctor-20260803T091403Z-7f2850` restores observed parity"; 같은 선행사 @52190 (이 run의 첫 출현 @52157에 명시된 날짜와 동일).

#### G2. "same-day compat cycle — R1 ingest, R2 re-check" / "closed the same day by the compat cycle — ingest in R1, re-check in R2" — 같은 날의 cycle의 두 단계로 run을 지명

공격: 1차 pass는 "cycle"이라는 명사가 한 겹 더 있다는 이유로 `ambiguous`로 두었다. 공격: em-dash 동격은 cycle이 곧 R1+R2라고 말한다. cycle이 같은 날이면 그 두 단계도 같은 날이다. 역공격("same-day compat cycle"이 단지 ingest와 re-check가 이름 없는 하루에 있었다는 뜻)은 같은 괄호 안 200바이트 뒤의 "restored the same day"가 기록의 날을 가리키는 것, 그리고 R3 셀의 확장형 "the drift the first proof run exposed was closed the same day by the compat cycle"에 의해 무너진다. 대조군: 같은 문장에서 "same-day"가 없는 @77678/@77737("after the dual-drift compat cycle (R1 ingest, ... R2)")은 `not-a-claim`으로 그대로 두었다 — 결정한 것은 단어의 유무다.

- `scorecard:725` @48316–48346 `compat-20260722T011840Z-a3fb14` (blob `99b33d0`): **ambiguous → bound**; date = `2026-07-22Z` @47816–47827 (scorecard:718)
  - 결정한 말: "`host_parity_baseline` `current` after the same-day dual-drift compat cycle — compat-20260722T011840Z-a3fb14 ingest, drift=none re-check ... —" 괄호 첫머리 "(2026-07-22Z;" @47816; 사이에 다른 iso-date 없음.
- `scorecard:726` @48375–48405 `compat-20260722T012840Z-915f54` (blob `99b33d0`): **ambiguous → bound**; date = `2026-07-22Z` @47816–47827 (scorecard:718)
  - 결정한 말: 같은 동격의 두 번째 단계 "drift=none re-check compat-20260722T012840Z-915f54"; 같은 선행사 @47816.
- `scorecard:1288` @114107–114137 `compat-20260722T011840Z-a3fb14` (blob `99b33d0`): **ambiguous → bound**; date = `2026-07-22Z` @112894–112905 (scorecard:1288)
  - 결정한 말: "the dual ... drift the first proof run exposed was closed the same day by the compat cycle — content-backed CHANGELOG + Codex atom ingest in compat-20260722T011840Z-a3fb14, ..." — first proof run = 이 괄호의 기록, "re-recorded under the 0.85.0 install on 2026-07-22Z" @112894.
- `scorecard:1288` @114162–114192 `compat-20260722T012840Z-915f54` (blob `99b33d0`): **ambiguous → bound**; date = `2026-07-22Z` @112894–112905 (scorecard:1288)
  - 결정한 말: "drift=none re-check in compat-20260722T012840Z-915f54" — 같은 cycle의 두 번째 단계; 같은 선행사 @112894.
- `DEVELOPMENT:466` @64843–64873 `compat-20260722T011840Z-a3fb14` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-07-22Z` @63176–63187 (DEVELOPMENT:466)
  - 결정한 말: "(the dual ... drift the first proof run exposed was closed the same day by the compat cycle — content-backed CHANGELOG + Codex atom ingest in `compat-20260722T011840Z-a3fb14`, ..." — 이 괄호의 기록 "(2026-07-22Z;" @63176; 같은 괄호가 "the same-day host-parity baseline refresh"로 같은 사건을 이미 같은 날로 놓음.
- `DEVELOPMENT:466` @64900–64930 `compat-20260722T012840Z-915f54` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-07-22Z` @63176–63187 (DEVELOPMENT:466)
  - 결정한 말: "drift=none re-check in `compat-20260722T012840Z-915f54`"; 같은 선행사 @63176.

#### G3. 형용사 "same-day"가 run 자체(또는 run이 산출물/구성원인 사건)에 붙은 경우

공격: 1차 pass는 동일한 형용사 구문을 @84409("The same-day post-attestation record R")와 DEVELOPMENT @68011("the same-day attention-0.7.0 freshness record R")에서는 bound하고, 아래 행들은 `ambiguous`/`not-a-claim`으로 두었다. 공격: 텍스트가 두 무리를 구별할 근거를 주지 않는다.

- `scorecard:1041` @71275–71305 `doctor-20260803T033236Z-f56d25` (blob `99b33d0`): **ambiguous → bound**; date = `2026-08-03Z` @71203–71214 (scorecard:1040)
  - 결정한 말: "after the same-day install proof `doctor-20260803T033236Z-f56d25` (...) reads experience parity **`partial` `91%`**" — 같은 문장의 "doctor-...7f2850 (2026-08-03Z)" @71203; 사이에 다른 iso-date 없음. (ambiguous → bound)
- `scorecard:1288` @108200–108232 `settings-20260803T091332Z-ec30fe` (blob `99b33d0`): **not-a-claim → bound**; date = `2026-08-03Z` @107506–107517 (scorecard:1288)
  - 결정한 말: "the same-day fresh attestation `settings-20260803T091332Z-ec30fe` and post-attestation record ... restore observed parity" — 1차 pass가 @122816에서 바이트 단위로 같은 구문을 bound했음. 선행사 "the 0.88.1 proof recorded on 2026-08-03Z" @107506. (not-a-claim → bound)
- `scorecard:1288` @108263–108293 `doctor-20260803T091403Z-7f2850` (blob `99b33d0`): **not-a-claim → bound**; date = `2026-08-03Z` @107506–107517 (scorecard:1288)
  - 결정한 말: 같은 한정사·형용사 아래 두 번째 머리명사 "and post-attestation record `doctor-20260803T091403Z-7f2850`"; 1차 pass가 @122879에서 형용사가 두 접속항에 걸친다고 읽은 것과 동일. 선행사 @107506. (not-a-claim → bound)
- `scorecard:1289` @128274–128306 `settings-20260713T030937Z-f50815` (blob `99b33d0`): **not-a-claim → bound**; date = `2026-07-13Z` @127734–127745 (scorecard:1289)
  - 결정한 말: "The operator's same-day `/hooks` confirmation produced the fresh four-plugin attestation `settings-20260713T030937Z-f50815`" — attestation은 같은 날의 confirmation이 산출한 artifact(이 corpus에서 attestation은 confirmation의 기록). 1차 pass가 @115310에서 같은 산출 관계("confirmation produced attestation R")를 bound했음. 선행사는 논의 중인 기록 "the 0.80.0-native 2026-07-13Z ... record" @127734; 앞의 "2026-07-12Z" @127442는 이전 기록의 것. 병렬절 "and the post-attestation record ... restores"에는 시간어가 없어 그 run(@128415)은 `not-a-claim` 유지. (not-a-claim → bound)

#### G4. "the same day as R" — R이 비교 대상인지, "[recorded] as R"인지

공격: 1차 pass는 "landed the same day as R"에서 R이 비교항일 수 있다며 `ambiguous`로 두었다. 공격(성공): 문맥상 "the install proof"는 attention 0.4.1 relocation의 설치 증명이고, 문서가 다른 곳에서 바로 이 run을 "the 2026-07-11Z relocation loop record" / "re-recorded on 2026-07-11Z as R"로 지명한다. 즉 install proof = R이므로 비교 독법은 순환("증명이 자기 자신과 같은 날 landed")이며, 정합적인 독법은 corpus 관용구 "[recorded] as R"이다. 어느 독법이든 R에 날짜를 준다면 그 토큰은 괄호 첫머리의 날짜 하나뿐이다.

- `scorecard:900` @60968–60998 `doctor-20260711T045954Z-731e34` (blob `99b33d0`): **ambiguous → bound**; date = `2026-07-11` @60918–60928 (scorecard:899)
  - 결정한 말: "(2026-07-11; install proof landed the same day as `doctor-20260711T045954Z-731e34` — parity `ready` `100%` restored, see the release/install narrative above)" — "2026-07-11" @60918 (새 occurrence). 사이에 다른 iso-date 없음.
- `DEVELOPMENT:466` @92795–92825 `doctor-20260711T045954Z-731e34` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-07-11` @92603–92613 (DEVELOPMENT:466)
  - 결정한 말: "(resolved 2026-07-11 by **restructure**: ...; the install proof landed the same day as `doctor-20260711T045954Z-731e34` — see the newest record above)" — "2026-07-11" @92603 (새 occurrence).

#### G5. 명시적 날짜가 붙은 사건의 구성원으로 지명된 run

공격: 1차 pass는 "the 2026-07-20 refresh (compat R1 ..., re-check at R2)"에서 날짜가 refresh에 붙었다며 run으로 "옮기지 않았다". 공격: 이 corpus에서 baseline refresh는 compat ingest + re-check 그 자체이고 괄호가 정확히 그렇게 말한다. G2에서 같은 날의 cycle의 단계를 bound했다면 명시 날짜가 붙은 refresh의 단계는 더 강한 경우다. 대조: "the 2026-07-25 baseline was set ... in run R"(@45539)는 사건이 아니라 날짜 라벨이 붙은 artifact(baseline)이므로 `not-a-claim` 유지 — 사람이 볼 문제로 6절에 적음.

- `scorecard:1288` @117594–117624 `compat-20260720T104815Z-9323ec` (blob `99b33d0`): **not-a-claim → bound**; date = `2026-07-20` @117566–117576 (scorecard:1288)
  - 결정한 말: "closed in-slice by the 2026-07-20 refresh (compat `compat-20260720T104815Z-9323ec` with content-backed notes for both drifted hosts, re-check `drift=none` at ...)" — "2026-07-20" @117566 (새 occurrence). 기록의 "2026-07-20Z" @116918이 아니라 refresh에 붙은 이 토큰에 바인딩.
- `scorecard:1288` @117702–117732 `compat-20260720T105414Z-87af5e` (blob `99b33d0`): **not-a-claim → bound**; date = `2026-07-20` @117566–117576 (scorecard:1288)
  - 결정한 말: "re-check `drift=none` at `compat-20260720T105414Z-87af5e`" — 같은 refresh의 두 번째 단계; @117566.

#### G6. 두 번 이어진 "same-day"

공격: 1차 pass는 중간 기록이 날짜가 없다는 이유로 `ambiguous`. 공격: 중간 기록(@68011)은 같은 단어로 이미 @67625에 bound되어 있고, 두 홉 모두 텍스트의 명시적 단어다. 스캔상 @67625와 앵커 사이에 다른 iso-date가 없어 체인이 닿을 수 있는 occurrence는 하나뿐.

- `DEVELOPMENT:466` @70562–70592 `doctor-20260720T052332Z-a0d677` (blob `f5e07a2`): **ambiguous → bound**; date = `2026-07-20Z` @67625–67636 (DEVELOPMENT:466)
  - 결정한 말: "This supersedes the same-day 0.83.0-native re-record `doctor-20260720T052332Z-a0d677`" — "This" = "the same-day attention-0.7.0 freshness record" ← "doctor-20260720T175310Z-a0fd88 (2026-07-20Z;" @67625.

#### G7. 날짜는 주장되었으나 corpus에 채울 occurrence가 없는 경우 (not-a-claim → incomplete)

공격: 1차 pass는 "닿는 iso-date가 없다"는 이유로 `not-a-claim`. 공격: 같은 pass가 DEVELOPMENT @87588/@87752에서 똑같이 날짜 없는 기록을 가리키는 "the same day"를 `incomplete`로 처리했다. 주장은 있고(0.77.2 기록의 날과 같음) 채울 토큰이 없는 것은 §4.3의 `incomplete` 정의 그대로다. 0.77.2 기록 `doctor-20260710T044745Z-1a789e`는 이 파일 어디에도 날짜가 없고, @93700–@94530 구간에 iso-date 토큰이 0개(스캔).

- `DEVELOPMENT:466` @94426–94456 `compat-20260710T054356Z-34315e` (blob `f5e07a2`): **not-a-claim → incomplete**
  - 결정한 말: "whose honest `host_parity_baseline` `stale` caveat was closed the same day by the baseline-refresh slice (`compat-20260710T054356Z-34315e` ingest, ...)" — slice의 ingest 단계.
- `DEVELOPMENT:466` @94494–94524 `compat-20260710T104459Z-67ece6` (blob `f5e07a2`): **not-a-claim → incomplete**
  - 결정한 말: "post-refresh `drift: none` `compat-20260710T104459Z-67ece6`" — 같은 slice의 두 번째 단계.

#### G8. 열거 템플릿의 마지막 항목에서 "on D"가 빠진 경우 (incomplete → ambiguous)

공격: 1차 pass는 12개 항목이 모두 "by R on D"인 열거의 마지막 항목이 템플릿의 날짜 주장을 이어받는다고 `incomplete`. 공격(부분 성공): 바이트상 이 항목은 "by R."로 끝나며 누가 읽었는지만 말한다. 글자 그대로 읽는 lane은 날짜 주장이 없다고 할 것이고, 템플릿을 읽는 lane은 incomplete라 할 것이다. 문장은 둘 중 하나를 고르지 않았다.

- `scorecard:135` @7789–7819 `doctor-20260803T091403Z-7f2850` (blob `99b33d0`): **incomplete → ambiguous**
  - 결정한 말: "..., the 0.90.0 state before it by doctor-20260810T135637Z-d49983 on 2026-08-10Z, and the 0.88.1 state before that by doctor-20260803T091403Z-7f2850." — 다음 iso-date "2026-08-08" @8009는 정정 괄호의 것이라 어느 독법에서도 후보가 아님.
## 3. 공격했으나 살아남은 행 (188)

210행 전부에 대해 1절에서 말한 순서(not-a-claim → bound → 나머지)로 원문을 먼저 읽고, 반대 disposition을 위한 가장 강한 논거를 쓴 뒤 바이트로 판정했다. 살아남은 188행 가운데 가장 어려웠던 것들:

**(a) release-triple의 `squash` 역할에 merge commit을 채운 8행** — `plugin-attention-v0.9.0` / `plugin-runtime-v0.85.0`의 네 출현쌍 (scorecard @47960/@47986, @77288/@77316, @113474/@113500; DEVELOPMENT @63716/@63742), 모두 `bound`.
공격: 문서는 "release PR #616 merge c2bc0f9"라고 쓰고, corpus는 "squash"와 "merge"/"rebase-merged"를 같은 문장 안에서 대조적으로 쓴다("#613 rebase-merged 54f39c0 / 952af14 / 73b88c1, release PR #612 squash d9a8a7d"). 역할 이름은 `squash`다. 문서가 squash가 아니라고 말한 commit을 `squash`에 넣는 것은 문서에 없는 주장이며, 역할 이름을 글자 그대로 읽는 lane은 비워 둘 것이고 그러면 오라클이 그 lane을 `mispaired`로 채점한다.
왜 버텼나: 바이트는 release PR #616이 landed한 commit을 정확히 하나 지명하고, registry는 release PR 옆에 commit 역할을 `squash` 하나만 둔다. 이 역할이 "landing commit"을 뜻한다는 독법 아래서는 바인딩이 참이고, "squash 연산의 commit"을 뜻한다는 독법 아래서는 거짓이다. 이것은 corpus가 아니라 registry의 의도에 대한 질문이므로 corpus 텍스트로는 반증되지 않는다. `ambiguous`로 후퇴하면 이 8행에서 release_pr·marketplace_sync 일치까지 통째로 `not-adjudicated`가 되어 잃는 것이 더 크다. 유지하되 8행 모두 provenance에 질문을 적었고 6절에 올렸다(§7.3의 `mispaired` detail이 역할 단위로 보이므로 사람이 registry 수준에서 한 번에 판정할 수 있다).

**(b) `consensus-20260529T123635Z-8722ee`, DEVELOPMENT:467 @102513 — `bound` → date `2026-05-29` @102440.**
공격: 같은 로그의 이웃 항목(@104982)은 "2026-05-10 per-item omcc-dependency lens audit (workflow `audit-20260509T105532Z-3f0021`)"로, 항목 날짜와 run이 다른 날임을 문서 스스로 보여 준다. 따라서 이 로그의 굵은 날짜는 항목(write-up)의 날짜이지 run의 날짜가 아니며, 이 행도 `ambiguous`여야 한다.
왜 버텼나: 이 항목은 "**2026-05-29 ADR-0024 runtime/operator dogfood datapoint**: consensus run `consensus-…` produced converged aligned outcome"으로, 날짜가 붙은 datapoint의 내용이 run 자체다. @104982에서는 날짜가 "audit"에 붙고 run은 그 audit의 workflow로 괄호 안에 있어 날짜가 옮겨질 다른 사건이 있지만, 여기서는 없다. 그래도 이웃 항목이 주는 의심은 실재하므로 provenance에 적고 6절에 올렸다. 같은 이유로 @102189 `cutover-20260516T140012Z-a8a89e`("2026-05-16 release/install dogfood loop: … runtime cutover records include R")는 run이 loop의 여러 기록 중 하나라서 `ambiguous`를 유지했다.

**(c) `doctor-20260720T151637Z-e2e061` scorecard:1288 @118446 (그리고 @118350 `settings-…3b543f`) — `bound` → `2026-07-20Z` @116918.**
공격: 선행사와 앵커 사이에 같은 달력 날짜의 다른 occurrence "the 2026-07-20 refresh" @117566이 있다. §3.2는 값이 아니라 occurrence로 짝을 맞추므로 후보가 둘이고, 내 policy는 ranking을 하지 않으니 §4.3 정의상 `ambiguous`다. (1차 provenance의 "no intervening iso-date"는 사실과 달랐다.)
왜 버텼나: "which landed the same day"는 이 기록(re-recorded on 2026-07-20Z)의 날을 잇는 절이고, refresh 날짜는 800바이트 앞에서 이미 닫힌 하위절의 라벨이다. 조응이 가리키는 날을 텍스트에 도입한 토큰은 @116918이며, @117566은 같은 날을 다른 사건에 붙인 것이다. 이것은 ranking이 아니라 선행사 식별이다. 그러나 값이 같고 occurrence가 다른 lane 바인딩이 `mispaired`로 채점될 것이므로 provenance를 정정해 사람이 보도록 했다.

**(d) `doctor-20260713T030956Z-20dcc3` scorecard:1289 @128415 — `not-a-claim` 유지 (짝 @128274는 이 pass에서 bound로 바뀜).**
공격: "The operator's same-day `/hooks` confirmation produced the fresh four-plugin attestation R, and the post-attestation record R2 restores observed parity" — R을 same-day confirmation의 산출물로 읽어 bound했다면, 이어지는 post-attestation record도 같은 날의 사건이다; 이 pass가 @122879와 @108263에서는 두 번째 접속항까지 bound했다.
왜 버텼나: @122879/@108263은 한 한정사·형용사 아래의 명사구 접속("the same-day fresh attestation R and post-attestation record R2")이고, 여기는 "…, and the post-attestation record R2 restores …"라는 독립절 접속으로 두 번째 절에 시간어가 없다. 형용사는 첫 절의 "confirmation"에 붙어 있다. 텍스트가 실제로 다르다. 다만 "post-attestation"이라는 이름이 순서를 함의한다는 점은 6절에 적었다.

**(e) `plugin-runtime-v0.78.1` scorecard:1288 @123748 — `not-a-claim` 유지.**
공격: 이웃 7행(@118911…@123174)은 "release tag T — backticks deliberately omitted for the freshness gate — marketplace sync S"로 `incomplete`인데, 이 행도 "tag plugin-runtime-v0.78.1 — backticks deliberately omitted for the freshness gate"를 갖고 같은 종류의 기록 괄호 안에 있다. freshness gate 주석은 저자가 이 토큰을 릴리스 태그로 의도했다는 표지다.
왜 버텼나: 이 괄호는 "(Claude Code `2.1.206`, tag …; hook state `14/14` …; five-plugin re-attestation …)"로, 기록이 관찰한 것들의 목록이다. "release"라는 단어도, sync commit도, PR도 없어 triple의 어느 역할도 채워지지 않는다. 이웃 행들과의 차이는 정확히 "release tag"와 "marketplace sync"의 유무다.

**(f) 살아남은 나머지 큰 무리:** proof-date-binding `not-a-claim` 122행 중 "runtime ships no hooks, so the four-plugin attestation R stays current"(6행), "version-invalidated the attestation R"(9행), executor artifact "installed refresh via the settings executor R … both exit 0"(9행), 구간 끝점 "between the observation snapshot R1 and the post-install verification snapshot R2"(6행), 그리고 기록 괄호 안의 관찰 항목들은 공격이 같은 곳에서 무너졌다: 문장이 run에 대해 말하는 것은 currency·무효화·exit code·구간 길이·읽은 값이지 날짜가 아니고, 근처 날짜는 명시적으로 baseline("the 2026-07-25 baseline")이나 다른 기록의 것이다. release-triple의 hash-location 5행("hashes … in the Claude cache, the Codex cache, the `plugin-runtime-v0.91.2` tag and the repository alike")과 capability-attribution 8행("shipped with `plugin-founder-v0.4.0` (ADR-0043 S3)")도 같은 이유로 버텼다 — "shipped with T"는 릴리스를 전제할 뿐 triple의 어느 역할도 주장하지 않으므로 `incomplete`가 아니라 `not-a-claim`이다.

## 4. `lexical:` 행 정정

없음. 범위 밖이지만 두 가지 기계적 점검을 했다: (i) 227개 lexical provenance에서 조응·추론을 시사하는 어휘(same day / that day / earlier / nearest / infer …)를 검색해 8건을 읽었다 — 모두 "R (D)" 또는 "recorded on D as R"처럼 날짜가 run에 직접 붙은 행이고 "same-day"는 서술어로만 등장한다. (ii) lexical 행의 anchor–role 바이트 거리가 250을 넘는 경우를 찾았으나 0건이었다. 둘 다 위치를 찾는 도구이며 판단은 읽어서 했다.

## 5. disposition은 유지하고 provenance만 고친 13행

- scorecard @54588 / @54752 (`settings-…f50815`, `doctor-…20dcc3`, bound → `2026-07-13Z` @53004): 1차 provenance의 "no other iso-date intervenes"는 틀렸다. "the 2026-07-11 baseline" @53803이 사이에 있다. 그것은 baseline 버전 라벨이지 이 서사에서 무엇이 일어난 날이 아니므로 "the same day"의 선행사가 아니다. 바인딩 유지, 서술 정정.
- scorecard @118350 / @118446: 위 3(c). "the 2026-07-20 refresh" @117566이 개입한다는 사실을 적고 왜 @116918을 유지하는지 썼다.
- DEVELOPMENT @102513 (`consensus-…`): 위 3(b)의 공격과 유지 이유를 적었다.
- release-triple 8행 (3(a)): merge/squash 질문을 적었다.

## 6. 사람이 결정해야 할 것

1. **조응 날짜가 역할을 채우는가.** 이 아티팩트의 proof-date-binding `bound` 중 interpretive 40행 거의 전부(그리고 이 pass의 19건 변경)는 "the same day / same-day / earlier that day"가 유일한 선행사 occurrence로 해소된다는 원칙 위에 있다. 사람이 "문서가 R 옆에 D를 쓰지 않았으면 주장이 아니다"라고 정하면 이 행들은 `ambiguous`(또는 `not-a-claim`)로 일괄 이동해야 한다. 나는 프로즈가 쓴 단어를 프로즈의 선택으로 읽었다.
2. **registry의 `squash` 역할이 merge commit을 받는가** (3(a), 8행). registry 문구로 한 번에 결정할 수 있다.
3. **"the same-day fresh attestation R and post-attestation record R2"에서 형용사가 두 번째 접속항에 걸치는가** — scorecard @108263, @122879 두 행(둘 다 bound).
4. **같은 날짜의 두 occurrence** — scorecard @118350/@118446은 @116918에 묶었으나 @117566도 같은 날이다. lane이 후자에 묶으면 값은 같고 occurrence만 달라 `mispaired`가 된다. 이것이 의도한 엄격함인지 확인이 필요하다.
5. **열거 마지막 항목의 빠진 "on D"** — scorecard @7789, 이제 `ambiguous`. `incomplete`와 `not-a-claim` 중 하나를 골라야 한다.
6. **날짜 라벨이 붙은 artifact의 생성 run** — "that baseline was set one loop earlier by the … ingest in run `compat-20260725T015749Z-387259`"(scorecard @45539)에서 "the 2026-07-25 baseline"의 날짜를 그것을 만든 run에 옮길 것인가. 나는 사건("refresh")과 artifact("baseline")를 구별해 전자만 옮겼다(G5). 그 구별이 지나치게 미세하다고 볼 수 있다.
7. **두 개의 같은 날 기록 사이에 끼인 run** — scorecard @38938 / DEVELOPMENT @51248 `settings-20260808T065145Z-c8409f`는 "doctor-…74647d (2026-08-08Z) … after … R recorded a fresh attestation …, doctor-…2dfe23 (2026-08-08Z)"로 두 같은 날 기록 사이에 순서로만 놓여 있다. 나는 순서 함의를 날짜 주장으로 치지 않아 `not-a-claim`을 유지했다. 주장으로 친다면 후보가 둘이라 `ambiguous`가 된다.
8. **로그 항목의 굵은 날짜가 항목 안의 run을 날짜 짓는가** — DEVELOPMENT @102513(bound 유지)과 @102189(ambiguous 유지)의 차이가 충분한지.
9. **"landed the same day as R"** — scorecard @60968, DEVELOPMENT @92795를 "[recorded] as R"로 읽어 bound했다. 비교 독법을 고집하면 두 행은 날짜 없음이다.
10. `plugin-designer-v0.2.0` scorecard @87713(ambiguous 유지): #529가 릴리스 주장의 release_pr인지, #521인지, 아니면 언급인지.

## 7. `bundle/` 밖에서 읽은 것

- `TASK.md` — 이 pass의 브리프. §11.2의 금지 목록에는 없고 corpus 독해를 담고 있지 않다.
- `input/oracle.json` — 내 1차 아티팩트. 다른 lane의 산출물이 아니며 이 pass의 출발점이다.

둘 다 `attestation.prohibited_inputs_accessed`에 적었다. 그 밖에는 내가 만든 작업 파일(`work/`)과 위 두 파일에서 파생한 덤프만 읽었다. `association-policy.md`, 다른 lane의 아티팩트, comparator 출력, authority snapshot은 존재 여부와 무관하게 읽지 않았다.

## 8. 검증

`work/verify.mjs`(의존성 없음, Node 24)를 작성해 `out/oracle.json`과 대조군 `input/oracle.json`에 각각 실행했다. 검사 항목과 결과:

| 검사 | 근거 | out/oracle.json | input/oracle.json |
|---|---|---|---|
| sealed schema 검증 (type/required/additionalProperties/enum/const/pattern/minLength/minimum/items/$ref) | §3.8 | VALID, 0 errors | VALID |
| `bundle_digest` = §11.3 framing(`path NUL len NUL bytes`, 4 member 고정 순서)으로 재계산 | §11.3 | MATCH `c7e68f04…` | MATCH |
| `manifest_digest` = manifest에서 `digest` 제거 후 §2.1 직렬화(키 정렬·2칸·trailing newline) SHA-256; manifest 자체 `digest` 필드와도 일치 | §2.1 | MATCH `b2f1433a…` | MATCH |
| policy 2건의 `digest` = §4.5 직렬화 재계산; parameters flat | §4.5 | MATCH | MATCH |
| `attestation.artifact_digest` = `attestation` 키 제거 후 §2.1 직렬화 SHA-256; contract_version/bundle/manifest가 본문과 일치; `prohibited_inputs_accessed` 존재 | §11.4 | MATCH `688a2a12…` | MATCH |
| 모든 occurrence: path가 `stage-docs`에 있고 blob이 manifest와 일치, family가 registry에 있음, `blob[start:end]`의 UTF-8 디코딩 == `literal` (fatal decoder) | §2.1, §3.5, §8.2 | 823/823 round-trip | 820/820 |
| 도메인: input의 (relation, anchor identity) 집합과 동일, 누락 0 / 추가 0 / 중복 0, anchor당 정확히 1행 | §4.3, TASK | 437 = 437 | 437 |
| §4.3: anchor role(`tag`/`run_id`)이 `roles`에 없음, 어떤 role도 앵커 자신을 가리키지 않음, role 이름·family가 registry와 일치, disposition–roles 정합(bound=필수 전부, incomplete=필수 하나 이상 비움, not-a-claim=없음) | §4.3, §8.2 | 437/437 | 437/437 |
| 모든 anchor/role identity가 `occurrences`에 존재하고, 참조되지 않는 occurrence 없음 | §4.4 (1) | 823 참조 / 0 미참조 | 820 / 0 |

두 파일 모두 전 항목 통과. 이어서 row-by-row diff로 input 대비 변경이 정확히 22행(disposition/roles) + 13행(provenance만) + `artifact_id` + occurrence 3개 추가뿐임을 확인했다.

## 9. 방법 — §4.4에 대해

도구가 한 일: in-scope 행을 순서대로 덤프(원문 문맥을 provenance보다 먼저 배치), 바이트 오프셋과 줄 번호 계산, 선행사–앵커 구간의 iso-date 토큰 열거, PR 번호의 corpus 내 출현 검색, JSON 조립, digest 계산, 검증. 도구가 하지 않은 일: 어떤 문장이 주장을 하는지, 어느 occurrence에 묶이는지 결정하기. 22건 각각은 위 2절의 인용을 읽고 정했으며, 같은 어휘("same day")를 가진 행이 서로 다른 결론(@77678 not-a-claim 유지, @128415 not-a-claim 유지, @102189 ambiguous 유지)에 이른 것이 규칙이 아니라 독해였다는 증거다. policy 선언(`class: annotation`, `ranking: none`, `tie_policy: ambiguous`)과 그 digest는 변하지 않았다.
