# S3 — precondition-1 verdict against the oracle

- **판정**: `fail` — missed on required relation proof-date-binding (§8.3 row 4)
- **오라클**: `oracle-adjudicated-1` `09071db747185819e7d2f09e8409495cdca4d35c2fb27a1fed569d4a3da97d63`
- **레인**: `lane-s1-markdown-lexical-grammar-v1` (`docs/…/lanes/s1-typed-exporter/artifact.json`, `e01c0040…`)
- **번들** `c7e68f04…` · **코퍼스 핀** `d49f74e` · **계약** 2.2.0
- **§11.5 준수**: 대조 중 어떤 수리도 하지 않았다. 아래는 전부 발견이다.

## 판정이 도달 가능한 상태에서 나왔다

계약 1.0과 2.1.0이 각기 다른 이유로 판정을 원리적으로 불가능하게 만들었던 것과 대비된다.

| 선행 검사 | 결과 |
|---|---|
| structural (§8.2) | 0 |
| occurrence containment (§7.1) | 0 |
| quote findings | 0 |
| authority drift (§9) | `drifted: false` — head 전진은 성장이지 드리프트 아님 |
| artifact_only scope (§2.3) | `out-of-scope` — 2.2.0이 고친 것이 작동 |
| policy declaration (§7.4) | 불일치 2건 — annotation 대 rule. §7.4상 **판정을 바꾸지 않는 진단** |

## 행 상태

```
agreeing        240   (54.9%)
missed           60
unexpected       96
mispaired         5
unresolved       20   (레인이 ambiguous)
not-adjudicated  16   (오라클이 ambiguous)
                437
```

관계별: proof-date-binding {agreeing 146, unexpected 87, missed 40, not-adjudicated 15, unresolved 4} ·
release-triple {agreeing 94, missed 20, unexpected 9, unresolved 16, mispaired 5, not-adjudicated 1}

## 발견 1 — 페어링 자체는 깨끗하다

`mispaired` **5건 전부가 선택 역할 단독**(`marketplace_sync` 4, `squash` 1)이다.
**필수 역할 오페어링은 0건** — 양쪽이 bound한 곳에서 레인은 언제나 같은 물리 occurrence를 골랐다.

즉 "값이 아니라 occurrence로 채점한다"는 §4.4의 장치가 겨냥한 오류를 이 레인은 범하지 않는다.
D1 재정(선택 역할을 비움) 이후에도 5건이 남은 것은 레인이 그 역할들을 채우기 때문이다.

## 발견 2 — 실패는 전부 "주장이 있는가"에서 난다

`missed` 60 + `unexpected` 96 = **156건(35.7%)이 disposition 불일치**이고
그중 어느 것도 "어느 occurrence냐"가 아니다.

```
78  oracle not-a-claim → lane incomplete   proof-date-binding
26  oracle bound       → lane incomplete   proof-date-binding
14  oracle bound       → lane incomplete   release-triple
13  oracle bound       → lane not-a-claim  proof-date-binding
 9  oracle not-a-claim → lane bound        proof-date-binding
 9  oracle not-a-claim → lane incomplete   release-triple
 5  oracle bound       → lane not-a-claim  release-triple
 2  oracle incomplete  → lane not-a-claim
```

지배적 패턴(87건)은 **레인이 `incomplete`, 오라클이 `not-a-claim`** — 레인은 "주장은 있는데 역할을
못 채웠다"고 하고 오라클은 "주장 자체가 없다"고 한다. S0B가 "세 번의 시도 모두 결여했다"고 지목한
**claim-versus-mention 판별자**가 정확히 여기서 갈린다. 규칙은 올바른 occurrence를 찾을 수 있지만
문장이 주장을 하는지 언급을 하는지는 판별하지 못한다.

D2 재정 8건은 전부 이 `unexpected` 안에 있다(8/8 확인). 재정 당시 예고한 대가가 실현된 것이며,
§8.3 주석의 *"An extra claim is a defect regardless of which role carries it"*에 해당한다.

## 이 판정이 기대는 미측정 전제

정직하게 기록한다. 오라클의 **자체 오차범위는 측정되지 않았다.** A·B가 합의했고 양쪽이 스스로
`interpretive`라 태깅한 156행이 상관 오류 구역으로 남아 있고, 적대적 패스는 그 구역을 줄이지 못했다
(144 → 156). 위 `fail`은 그 156행이 옳다는 전제 위에 서 있다. 표본 검토로 오차범위를 선언하는 방안이
제안됐으나 아직 실행되지 않았다.

또한 36행(8.2%)은 채점되지 않았다 — 오라클 `ambiguous` 16(`not-adjudicated`) + 레인 `ambiguous` 20(`unresolved`).
