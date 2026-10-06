**Detached HEAD is the explicit non-firing case.** With no branch to anchor a
workflow to (ADR-0018 §sub-2), the **owning surface** (not the runtime) emits a
one-line *"no active branch context"* report in place of the preflight and does
**not** auto-recommend a fresh session. It reports; it does not default to
fresh. This is the branch-based preflight's rule: the terminal sidecar is
path-targeted, so it projects the exact workflow it was handed without
consulting the branch, and renders normally on a detached HEAD.

### The three inputs (and their honest availability)

The decision composes exactly three inputs. Each names its source and its
availability limit:

| Input | Source | Availability |
|---|---|---|
| (a) Context-budget risk | Caller-supplied risk level (green / yellow / red) | **Caller-supplied, not host-measured** — the runtime budget check takes `--risk` or `--token-budget` metrics from the caller (`context.mjs`; ADR-0031 §7). The preflight cannot read true token usage and cannot tell whether a supplied risk has gone stale mid-session. When risk is **absent it defaults to `yellow`** (the conservative default `captureContext` already uses), which *fires* the preflight rather than silently assuming green. |
| (b) Workflow projection | The owning plugin's bounded projection (schema below), computed by the owning persona (engineer, orchestrator, founder or designer) from its **own** state | Present only when an active workflow exists on the branch **and** its state reads unambiguously. Absent (no workflow, or fail-closed on ambiguous/corrupt state) → the preflight degrades to inputs (a) + (c). |
| (c) Routing recommendation | The Routing Recommendation table above, resolved by the owning surface | **Always available** — a pure function of the work shape. It travels *inside* the projection (field `routing_recommendation`) when one exists, and is passed to the seam as a standalone field when (b) is absent, so (c) is never lost when there is no active workflow. |
