### Surfacing the multi-axis lens from a non-decide verb (ADR-0029 §2)

The size→preset mapping above is not exclusive to `{{persona}}:decide`.
When a **non-decide verb** (`investigate` / `frame` / `compose` /
`critique` / `refine`) reaches a genuine 2+-branch decision point —
two viable readings of the evidence, two artifact structures, two
remediation directions, or a non-neutral Active Next-Action
`selected_next` with 2+ candidates — it surfaces a **compact
multi-axis lens** inline instead of listing the branches flat. This is
the same forward pull the decisive axes give `decide`, made reachable
wherever a real branch appears (the Active Next-Action Proposal section
above already calls for it; this subsection is the mechanism).

Resolve the sized axis set from the {{persona}} plugin's **own registry** —
the single axis source of truth — rather than hand-authoring a second axis
list (`<plugin-root>` is this plugin's installed root):

{{^capability profile_presets}}
```bash
node "<plugin-root>/scripts/decide-registry.mjs" resolve --size=<minor|standard|major>
# stdout: ResolvedDecisionContext JSON. Read axes[] (id, en/ko labels,
# question, role, gate); compare the 2+ branches across the resolved
# DECISIVE axes plus the size-appropriate supporting axes, let the decisive
# axes drive the recommendation, and treat a gate axis as a veto.
```
{{/capability}}
{{#capability profile_presets}}
```bash
PROFILE_VAR={{profile_env}}
env "${PROFILE_VAR}=<profile>" node "<plugin-root>/scripts/decide-registry.mjs" resolve
# <profile> is the active L4 profile; with none, drop the env prefix. No
# --size: an explicit size overrides the profile's preset.
# stdout: ResolvedDecisionContext JSON. Read axes[] (id, en/ko labels,
# question, role, gate); compare the 2+ branches across the resolved
# DECISIVE axes plus the supporting axes, let the decisive axes drive the
# recommendation, and treat a gate axis as a veto.
```
{{/capability}}

Bounding rules — the lens is deliberately not emitted on every
invocation:

- **Only at a genuine 2+-branch point.** A single obvious path emits no
  lens; the verb proceeds and the Active Next-Action Proposal alone
  carries the forward routing.
{{^capability profile_presets}}
- **Sized to the branch — default minor.** An incidental in-verb branch
  uses `--size=minor`. Escalate to `--size=standard` or `--size=major` only
  when the branch's weight justifies it; the decision-sizing subsection
  above says which preset each size resolves to. Never apply the full
  matrix to a trivial reversible step.
{{/capability}}
{{#capability profile_presets}}
- **Sized to the branch — the profile keeps its preset.** The axis set
  follows the active profile here, so an incidental in-verb branch resolves
  with no `--size` and the profile carried inline, as the decision-sizing
  subsection above shows: an explicit `--size` overrides the profile's
  preset (the resolver says so on stderr), so pass one only when the branch
  deliberately leaves the profile. Never apply the full matrix to a trivial
  reversible step.
{{/capability}}
- **The registry is the single axis source.** Read the axes from
  `decide-registry.mjs`; do not duplicate an axis list in the verb or
  this contract. Resolving it on Codex takes one extra step: a Codex
  skill mention runs with no plugin-root variable in its environment. The
  names Codex substitutes into hook commands (`${PLUGIN_ROOT}`,
  `${PLUGIN_DATA}`) are not exported to a skill mention's shell: an agent
  shell reports `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_ROOT`
  and `PLUGIN_DATA` all empty. That is an observation about the shell, not
  a claim about every place Codex may substitute them. So resolve the path
  from the installed plugin root rather than from `$CLAUDE_PLUGIN_ROOT`:
  Codex injects the mentioned skill with its absolute path, and
  `../../checkpoint/SKILL.md` § Claude/Codex command resolution shows how
  to take the root from it without assuming a Codex home, marketplace name
  or version. Three rungs, in order: the root resolves and the CLI runs
  (full fidelity); the root resolves but the CLI does not run (read
  `core/skills/decide/references/decision-axes.yml` under that same root);
  the root cannot be built at all (keep the decisive axes the decisive-axis
  fallback below names, and take the size's supporting axes from the
  decision-sizing subsection above, which is already loaded). The YAML
  stays the single source. What ADR-0013 still owns is the missing Codex
  command file that would run this resolution automatically — not the
  reachability of the script.
- **Pointer-only in state.** Record the lens outcome as a compact
  decisive-axis verdict + pointers, never the full comparison dump
  (ADR-0024 boundary).

If the inline lens reveals the branch genuinely needs the full ritual
(peer ensemble, sensitivity perturbation), the proposal's
`selected_next` should route to `{{persona}}:decide --size=<tier>` rather
than resolving it inline — the inline lens is a compact aid, not a
replacement for the `decide` verb's ensemble.
