---
name: compose
description: "Generates an image through Codex's integrated gpt-image tool — image's composition (generative core) verb. Use to actually produce an image from a brief or description. On Codex, drives gpt-image in-session via codex exec; on Claude, dispatches through the codex-companion bridge and returns the image by shared-filesystem path. Trigger phrases include 'generate an image', 'make a picture', 'create an illustration', 'render this', 'draw this', '이미지 생성', '그림 만들어', '일러스트 생성'."
---

# Compose (image capability)

The image plugin's composition verb — the generative core (ADR-0010 §2,
ADR-0037 Decision 1). Produces an image through Codex's *integrated*
gpt-image tool. agentic-plugins **never** calls the OpenAI image API
directly (ADR-0037 Alternative 6) — generation always rides Codex's own
tool and auth.

## Cross-host dispatch

| Host | Path |
|------|------|
| **Codex** | native — invoke the in-session gpt-image tool via `codex exec`, save under the run dir, write the manifest |
| **Claude** | dispatch through `scripts/compose-dispatch.mjs`, which routes the prompt to `codex-companion` (`task`), verifies the returned file, and writes the manifest |

## When invoked (Claude host)

1. **Privacy gate** (`docs/contracts.md` §9): genericize the prompt before
   dispatch — only the genericized form leaves the local host.
2. **Cost disclosure** (`docs/contracts.md` §7): surface the estimated
   per-image cost (gpt-image-2 ≈ $0.005 low / $0.04 medium / $0.19 high)
   **before** generating. Default to **one** image; a multi-variant run
   needs an explicit cap + disclosure.
3. **Dispatch** via the helper (it owns discovery, the generate+save
   prompt, and return-validation):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/compose-dispatch.mjs" \
     --prompt-file <genericized-prompt-file> \
     --repo-root "$REPO_ROOT" \
     --format png --quality low|medium|high [--size <WxH>] [--slug <slug>]
   ```

   The dispatcher discovers `codex-companion` (cache-glob /
   `AGENTIC_COMPANIONS_ROOT`), renders the brief's parameters into the
   prompt (prompt-mediated — Codex surfaces only the prompt,
   `docs/contracts.md` §5), spawns `codex-companion task`, then **verifies
   the returned file** (exists / under the run root / non-empty / sniffs
   dimensions off the bytes) before recording success. It never trusts
   Codex stdout.
4. **Result**: the image lands at
   `.agentic-plugins/runs/image/<run-id>/<slug>-1.png` with an
   `ImageResult` manifest (`docs/contracts.md` §4). Return the **path** +
   metadata; never inline raw bytes.
5. **Errors** (`docs/contracts.md` §8): the dispatcher classifies failures
   (`moderation_blocked` / `quota_exhausted` / `peer_cli_not_found` /
   `peer_unauthenticated` / `tool_unavailable` / `write_failed`) — no blind
   retry. On `peer_cli_not_found` this is the **honest-scope failure**:
   Claude has no native image generation and no reachable Codex bridge —
   report the limitation explicitly, do not pretend.

## On the Codex host

Codex invokes gpt-image natively in-session (`codex exec`), saves to the
run dir, and writes the same manifest shape — no dispatcher round-trip.

## Parameter honoring

Codex surfaces only the `prompt`; size/quality/format are prompt-mediated
best-effort (`docs/contracts.md` §5). The measured requested-vs-observed
findings live in `docs/parameter-probe.md` (ADR-0037 item 7).
