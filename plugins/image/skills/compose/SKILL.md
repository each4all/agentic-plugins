---
name: compose
description: "Generates an image through Codex's integrated gpt-image tool — image's composition (generative core) verb. Use to actually produce an image from a brief or description. On Codex, drives gpt-image in-session via codex exec; on Claude, dispatches through the codex-companion bridge and returns the image by shared-filesystem path. Trigger phrases include 'generate an image', 'make a picture', 'create an illustration', 'render this', 'draw this', '이미지 생성', '그림 만들어', '일러스트 생성'."
---

# Compose (image capability)

The image plugin's composition verb — the generative core (ADR-0010 §2,
ADR-0037 Decision 1). Produces an image through Codex's *integrated*
gpt-image tool; agentic-plugins never calls the OpenAI image API directly
(ADR-0037 Alternative 6).

| Host | Path |
|------|------|
| Codex | native — drives the in-session gpt-image tool via `codex exec` |
| Claude | dispatch through `companions/codex-companion.mjs` (`task` subcommand); image written to the shared filesystem, path returned as text |

Output lands under `.agentic-plugins/runs/image/<run-id>/` with an
`ImageResult` run manifest (`docs/contracts.md` §4). Parameters are
prompt-mediated best-effort (`docs/contracts.md` §5); the verb does **not**
trust Codex stdout — it verifies the returned path (exists / under the
output root / non-empty / sniffed dimensions). Cost is surfaced; failures
are typed (`docs/contracts.md` §8); the privacy gate genericizes the prompt
before dispatch (`docs/contracts.md` §9).

> **Scaffold stub.** The full generative implementation + companion
> dispatch glue + the ADR-0037 item 3/7 non-bypass re-confirm land in the
> `compose-core` PR. This scaffold establishes the verb surface + the
> contract it consumes (`docs/contracts.md`).
