# skills/ — tombstone (the directory is the mechanism, not this text)

This plugin's skills live at [`../core/skills/`](../core/skills/). They were
moved there by the
[2026-09-18 Amendment to ADR-0006](../../../docs/adr/0006-directory-layout-install-pattern.md#amendments),
and `.codex-plugin/plugin.json` points its `skills` key at the new root, which
is the path Codex already resolves. The Claude manifest stays silent, so
Claude Code's convention-based discovery finds nothing here and registers the
six commands only — measured with Claude Code 2.1.276's own accounting
(`claude --plugin-dir plugins/image plugin details image`) as `Skills (12)` /
`~1,183 tok` before the move and `Skills (6)` / `~232 tok` after it, the six
survivors being the commands.

**Do not delete this directory, and do not put anything else in it.** Its
emptiness is load-bearing, and all three clauses were measured on a relocated
copy of this plugin:

1. **It must exist.** With it deleted, a plugin-root `SKILL.md` becomes
   discoverable again (`Skills` 6 → 7). With this README-only directory
   present, the same file is not registered.
2. **No `SKILL.md` may be reachable from here**, including through a symlink.
   A per-skill link such as `skills/frame -> ../core/skills/frame`
   re-registers the skill (6 → 7, ~232 → ~389 always-on tok). A
   container-level link did not re-register at that version and is rejected
   anyway — the conventional root has to be inert without anyone tracking
   which link depths a given host release follows.
3. **No `SKILL.md` at the plugin root.** Clause 1 suppresses it today; it is
   stated separately so a future relaxation of clause 1 cannot silently
   re-open the path.

All three are enforced by `kit/lint/check-plugin-shape.mjs`, which applies
them to any plugin whose declared skills root is not the conventional one.
This is a different rule from the empty-`skills/` placeholders in
`plugins/companions` and `plugins/attention`: those plugins have no skills at
all and still declare the conventional root
([ADR-0008 §(a)](../../../docs/adr/0008-companion-distribution-model.md)
Codex spec-compliance carve-out). This one has six skills and declares a
relocated root.
