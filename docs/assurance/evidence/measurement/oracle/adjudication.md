# 오라클 재정 레코드 — D1a / D1b / D2 / D3

- **재정자**: 리포지터리 소유자 (2026-09-08)
- **입력 아티팩트**: A-v3 `56466de259efd542a4c404b75babbdbe4761e65a651389b830680bb11aa49aae` · B-v3 `688a2a1262600a2776f346b389f0554aafff4d904e25f0ad8672e677a6e34c35`
- **코퍼스 핀**: `d49f74e696bf8eb1fd1c934bd588dde305bed23d` · **계약** 2.2.0 · **번들** `c7e68f04e450fa1e6fa7497fce3ca36e077e2f38fecc34605ee5d79e242c219f`
- **적용 범위**: A-v3와 B-v3가 갈린 39행 **전부**. 산출물 = `oracle-adjudicated/oracle.json`, `artifact_id` `oracle-adjudicated-1`, `artifact_digest` `09071db747185819e7d2f09e8409495cdca4d35c2fb27a1fed569d4a3da97d63`.

## 왜 이것이 재정이고 계약 적용이 아닌가

§4.2와 §13이 association policy를 **free**로 두므로 계약은 "어떤 occurrence가 어느 역할을 채우는가"에 답이 없다.
§4.4는 오라클을 정답 권위로 지정하고 규칙이 아닌 **독립 주석 + 재정**으로 저술하라 한다.
§4.3 기준으로 A·B 두 입장 모두 구조적으로 유효함을 확인했다(측정: D2 8행 전부에서 A의 `incomplete`는 필수역할 미충족을, B의 `not-a-claim`은 역할 0개를 만족).
따라서 아래는 계약 해석이 아니라 **오라클 저자의 판단**이다.

---

## D1a — `squash` 선택 역할, 9행 → **A 채택 (비움)**

**결정**: 산문이 `merge`라 부른 sha는 `squash` 역할을 채우지 않는다.

**근거 (코퍼스 실측, 핀 d49f74e 3 스테이지 문서)**

| 어형 | 출현 |
|---|---:|
| ``squash `<sha>` `` | 105 |
| ``merge `<sha>` `` | 4 — 전부 동일 사건 #616 `c2bc0f9` |
| `rebase-merged` | 19 |

문서군은 머지 전략을 나타내는 **세 용어를 구분해 유지한다**. 저자는 `squash`를 105회 사용할 수 있었고
이 자리에서 `merge`를 택했다. 오라클이 이를 `squash`로 번역하면 저자가 유지한 구분을 지우는 것이며,
§4.4가 요구하는 "읽기로 저술된 권위"가 산문에 없는 것을 단언하게 된다. 리포지터리의 실제 git 관행
(AGENTS.md의 squash 머지 규정)을 끌어와 산문의 단어를 덮지 않는다.

**B의 입장과 그 처리**: B는 "레지스트리의 유일한 비-PR 커밋 역할이므로 릴리스 PR이 착지한 커밋을 담는
슬롯"으로 읽었고, 스스로 provenance에 *"a human should confirm that reading of the registry, since a
literal reader leaves the role unfilled and would be reported `mispaired` here"*라고 적어 이 질문을
사람에게 올렸다. 그 요청에 대한 답이 이 재정이다.

**하위 사례**: 9행 중 8행은 `merge \`c2bc0f9\``(라벨 있음), 1행 `scorecard:55802`는 `release PR #548 \`beb4917\``로
라벨이 없다. 같은 문장이 #546의 sha는 `squash \`ceb2fb9\``로 명시 라벨한다 — 저자가 한 문장 안에서 하나는
라벨하고 하나는 하지 않았으므로, 무라벨 쪽도 squash로 부르고 있지 않다고 읽는다. 두 하위 사례 모두 A.

---

## D1b — `marketplace_sync` 선택 역할, 5행 → **A 채택 (비움)**

**결정**: 한정어 없는 `sync <sha>`는 `marketplace_sync` 역할을 채우지 않는다.

**근거 (코퍼스 실측)**

| 어형 | 출현 |
|---|---:|
| ``marketplace sync `<sha>` `` | 74 |
| ``stage-doc sync `<sha>` `` | **30** |
| ``sync commit `<sha>` `` | 15 |
| 한정어 없는 ``sync `<sha>` `` | **5** — 정확히 이 분쟁 행들 |

`stage-doc sync`가 30회 존재하므로 "sync"는 축약어가 아니라 **미한정어**다. 문서는 어느 sync인지
124회 중 119회(96%) 말해주며, 말하지 않은 5회가 전부 이 분쟁 자리다. `marketplace_sync`는 특정 역할이므로
미한정 sync가 이를 채운다고 볼 근거가 없다.

**구조**: `release_pr`이 채워져 있어 disposition은 `bound`로 유지되고 선택 역할만 빈다 — §4.3상 유효하며 회피가 아니다.

**반대 증거 (기록해 둔다)**: `553ac79`는 다른 문단에서 "marketplace sync"로 명시된다. 그러나 §4.4가
"값 일치는 페어링 일치가 아니다"를 못박으므로, 다른 위치의 같은 값이 이 절의 occurrence가 무엇을
단언하는지를 정하지 않는다고 판단했다.

**최초 판단의 번복**: 초기 검토에서는 "sync = marketplace sync의 축약"으로 보아 B를 지지했으나,
`stage-doc sync` 30회를 실측한 뒤 뒤집었다. 초기의 "bare sync 41회"는 `stage-doc sync`를 포함한 오측이었다.

---

## D2 — `"X shipped with <tag>"`, 9행 → **B 채택 (`not-a-claim`)**, 8행 확정 · 1행 미결

**결정**: `shipped with/via/as <tag>` 구문은 릴리스 기록이 아니라 능력 귀속이다. 앵커는 이 관계를 단언하지 않는다.

**근거 (코퍼스 실측)**: 해당 구문 6문장 중 **5문장에 PR 인용이 없다**. 이 코퍼스에는 확립된 릴리스 기록
구문이 있으며(PR·squash·태그·sync 병렬 나열, squash 인용만 105회), `shipped with`는 그 전부를 체계적으로
결여한다. 다른 역할을 체계적으로 빠뜨리는 구문은 릴리스 기록의 불완전 사례가 아니라 다른 일을 하는 구문이다.
문장의 주어는 기능("the founder and designer sidecar emitters")이고 태그는 어느 버전이 그것을 담았는지
가리키는 좌표다. S0B가 지목한 claim-vs-mention 판별자가 적용된다.

**미결 1행**: `scorecard:87713` (`plugin-designer-v0.2.0`)은 A·B 양쪽 모두 `ambiguous`이므로 이 재정이 다루지 않는다.

**대가를 명시한다**: 이 선택은 오라클 `not-a-claim` 대 레인 S1 `incomplete` → §7.2 row 12 `unexpected`
→ §8.3 row 4 → **`fail`**을 낸다. 세 재정 중 유일하게 발견을 늘리는 방향이며, 결과가 아니라 텍스트를
근거로 택했음을 기록한다. 그 `fail`은 참인 발견으로 판단된다 — 레인이 능력 귀속 문장을 릴리스 주장으로
읽고 있다는 뜻이고, §8.3 주석의 *"An extra claim is a defect regardless of which role carries it"*에 해당한다.

---

## D3 — 날짜 스코프 계열, 17행

D1·D2와 달리 **한 질문으로 접히지 않는다.** 4개 그룹으로 나뉘며 그룹별로 다르게 재정한다.

### 그룹 b — same-day 수식어의 스코프, 10행 → **`ambiguous`**

적대적 패스에서 **두 레인이 이 구문에 대해 반대로 움직였다.** A는 바인딩을 5건 철회했고(수식어가 첫
명사구에 갇힌다), B는 19건을 전진시켰다(산문이 실제로 "same day"라 썼고 선행사가 하나면 산문이 고른
것이다). 둘 다 상대를 보지 못한 채 각자 자기 1차 판단을 공격한 뒤 도달한 결론이다. B는 REVIEW.md에
1차 pass의 비일관을 자백했다 — "그 구분은 텍스트가 아니라 습관에 있었다".

**재정 근거는 계약의 어휘 빈틈이다.** §4.3의 네 disposition 중 셋(`bound`/`ambiguous`/`incomplete`)이
"주장이 있음"을 전제하고, `not-a-claim`은 "전혀 단언하지 않음"을 단언한다. 어휘는 *"주장은 있는데 어느
후보인지 모르겠다"*는 표현할 수 있지만 ***"주장이 있는지 자체를 모르겠다"*는 표현할 수 없다.** 이 10행이
정확히 그 자리다. 확신 없이 `not-a-claim`을 고르면 §4.3이 스스로 "a claim of its own and is checkable"
이라 규정한 것을 근거 없이 단언하게 된다.

`ambiguous`는 §4.3 문구를 약간 늘려 쓰지만(후보 미랭크 → 주장 유무 미결) 실제로 참인 상태를 기록한다.
해당 행은 §7.2 row 1에 따라 `not-adjudicated`가 되어 레인을 채점하지 않으며, 17/437이므로 §8.4
비공허성에는 못 미친다.

> **계약 다음 버전 항목으로 제출**: 다섯 번째 disposition(주장 유무 미결) 또는 §4.3 `ambiguous` 정의의
> 확장. 지금 추가하면 번들 다이제스트가 바뀌어 리베이스라인이고, 17행에 그 값어치는 없다고 판단했다.

### 그룹 c — 동일 날짜 스팬 2개 중 어느 물리 occurrence, 3행 → **A 채택 (`ambiguous`)**

§4.3이 정의하는 `ambiguous`("어느 역할에 후보가 2개 이상이고 정책이 랭크하지 않음")에 정확히 해당한다.
A가 어휘에 맞고 B는 그 경우를 `bound`/`not-a-claim`으로 밀었다.

### 개별 3행

| 행 | 재정 | 근거 |
|---|---|---|
| `scorecard:7789` | `ambiguous` | 12개 열거가 전부 `by R on D`인데 마지막만 `on D` 없이 끝나고, **후보 날짜 occurrence가 없다**. 주장이 있으면 `incomplete`, 없으면 `not-a-claim` — 그룹 b와 같은 어휘 빈틈 |
| `scorecard:130380` | **B** (`not-a-claim`) | 술어가 결과를 보고한다("was recorded `partial` `91%`"). 같은 셀 앞 occurrence(@129803)가 이미 날짜 짓는다. 상호참조로 이후 모든 언급을 `bound`로 하면 claim-vs-mention 구분이 사라진다 |
| `DEVELOPMENT.md:102189` | **B** (`ambiguous`) | B가 **같은 로그 안에서 반증**을 찾았다 — 이웃 항목은 헤딩이 2026-05-10인데 안의 run은 `audit-20260509T…`다. A는 이 행을 `lexical:`로 태깅했으나 반증이 있는 이상 과잉 주장 |

### `scorecard:87713` — 재정 불필요

A·B **양쪽 모두 `ambiguous`**였다. 불일치가 아니라 양쪽이 함께 미결을 기록한 것이므로 그대로 통과시킨다.
(초기 분류에서 D2 미결로 셌던 것은 분류 오류였다.)

---

## 산출물 — `oracle-adjudicated/oracle.json`

| | |
|---|---|
| `artifact_id` | `oracle-adjudicated-1` |
| `artifact_digest` | `09071db747185819e7d2f09e8409495cdca4d35c2fb27a1fed569d4a3da97d63` |
| 번들 / 매니페스트 | `c7e68f04…` / `b2f1433a…` (봉인과 일치) |
| 행 구성 | 합의 398 · D1a 9 · D1b 5 · D2 8 · D3b 10 · D3c 3 · 개별 3 · 양쪽-ambiguous 1 = **437** |
| disposition | `bound` 277 · `not-a-claim` 132 · `ambiguous` 16 · `incomplete` 12 |
| occurrences | 813, 미참조 0 · 누락 0 |

**검증**(전부 통과): 스키마 0 오류 · §4.3 disposition–roles 정합 · 다이제스트 재계산 일치 · 정책 다이제스트 §4.5 ·
도메인 437 대칭차 0 · 앵커역할 반복 0(대조군 확인) · 스팬 934 전수 왕복 0 실패 · occurrence 미참조/누락 0.

**이 아티팩트는 클린룸 레인 산출물이 아니다.** 두 레인 아티팩트를 읽고 만들어졌으며 그 사실을
`attestation.prohibited_inputs_accessed`에 명시했다. §11.2가 금지하는 것은 *레인*이 다른 레인의 산출물을
보는 것이고, 이것은 레인이 아니라 §4.4가 요구하는 재정 층이다. 두 입력 아티팩트는 수정하지 않았다.
