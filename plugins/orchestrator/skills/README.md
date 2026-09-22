# skills/ — tombstone (the directory is the mechanism, not this text)

This plugin's skills live at [`../core/skills/`](../core/skills/). They were
moved there by the
[2026-09-18 Amendment to ADR-0006](../../../docs/adr/0006-directory-layout-install-pattern.md#amendments),
and `.codex-plugin/plugin.json` points its `skills` key at the new root, which
is the path Codex already resolves. The Claude manifest stays silent, so
Claude Code's convention-based discovery finds nothing here and registers the
nine commands only — measured with Claude Code 2.1.278's own accounting
(`claude --plugin-dir plugins/orchestrator plugin details orchestrator`) as
`Skills (17)` / `~1,274 tok` before the move and `Skills (9)` / `~448 tok`
after it. The token figure is that release's own estimate and does not travel
between environments; the counts and the controls below do.

Orchestrator needs no fixture to say which set survived, because its names do
not fully overlap: `audit` is a command with **no skill of its own**, and it is
in the post-move list. The commands are what Claude registers. The two
fixtures were measured anyway, and agree: with `commands/` removed the plugin
reads `Skills (0)` / `~0 tok`, and with `core/skills/` removed instead it reads
the same `Skills (9)` / `~448 tok` as the real tree.

**Do not delete this directory, and do not put anything else in it.** Its
emptiness is load-bearing, and the four clauses below were measured on a
relocated plugin when they were written
([`plugins/designer/skills/README.md`](../../designer/skills/README.md) records
those measurements):

1. **It must exist.** With it deleted, a plugin-root `SKILL.md` becomes
   discoverable again (`Skills` +1). With this README-only directory present,
   the same file is not registered.
2. **No `SKILL.md` may be reachable from here**, including through a symlink.
   A per-skill link such as `skills/next -> ../core/skills/next` re-registers
   the skill. A container-level link did not re-register at that version and is
   rejected anyway — the conventional root has to be inert without anyone
   tracking which link depths a given host release follows.
3. **No `SKILL.md` at the plugin root.** Clause 1 suppresses it today; it is
   stated separately so a future relaxation of clause 1 cannot silently
   re-open the path.
4. **`.claude-plugin/plugin.json` must not declare a `skills` key.** Adding one
   reads like finishing the job and silently restores every duplicate
   registration.

All four are enforced by `kit/lint/check-plugin-shape.mjs`. It resolves
references too, but not every shape of one, and the limit is worth knowing
before leaning on it: it checks command pointers written as an explicit
`$CLAUDE_PLUGIN_ROOT/<root>/<skill>/SKILL.md`, and, inside the relocated tree,
the plugin-root-relative (`core/skills/…`) and repo-relative
(`plugins/<name>/…`) forms. Three shapes were measured passing it unnoticed on
the persona plugins: a command's SUPPORTING-document pointer reverted to the
pre-move root, a sibling-relative `./…` reference, and a bare `references/…`
reference. Nothing here is broken in those shapes — what is missing is
regression detection, not a fix.

This is a different rule from the empty-`skills/` placeholders in
`plugins/companions` and `plugins/attention`: those plugins have no skills at
all and still declare the conventional root
([ADR-0008 §(a)](../../../docs/adr/0008-companion-distribution-model.md) Codex
spec-compliance carve-out). This one has eight skills and declares a relocated
root.
