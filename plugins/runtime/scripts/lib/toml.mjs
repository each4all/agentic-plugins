// plugins/runtime/scripts/lib/toml.mjs
//
// TOML rendering primitives shared by the runtime planners that emit config.toml
// fragments (notification, egress launcher, permission).
//
// This leaf exists because the escaper had drifted into two byte-identical copies —
// one private to scripts/settings.mjs, one exported from lib/notification-plan.mjs with
// no importers. Lifting the permission planner (machine-bootstrap-contract.md §1.3)
// forced the question of where its copy should live, and a third home in lib/ would
// have made a duplicate permanent rather than fixed it. Escaping rules are the kind of
// thing that gets patched in one place and not the other, so there is one place.

// Render a TOML basic string, fully escaped: backslash, quote, the named control
// escapes (\b\t\n\f\r), and any other C0 control / DEL as \uXXXX.
//
// The full escape set is load-bearing for QUOTED KEYS, not just values: a project path
// stamped into a [projects."..."] header carries the operator's real path, and a
// backslash (Windows) or a control character (theoretically legal on POSIX) would
// otherwise corrupt the header. A Plan-verify peer found exactly that hole in a
// narrower escaper that handled only \ and ".
export function tomlBasicString(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

// ---------------------------------------------------------------------------
// The ONE Codex `[tui]` table composer (ADR-0048 statusline slice)
// ---------------------------------------------------------------------------

// Render a SINGLE `[tui]` table carrying whichever of the two runtime-planned
// keys are present. This composer exists because two planners each emitting
// their own `[tui]` header (notifications — the notification plan;
// status_line — the statusline plan) handed the operator two headers for one
// table: merged naively that is a TOML table redefinition (invalid), and
// merged carelessly one key clobbers the other. Every fragment that touches
// `[tui]` renders through here, so what the operator merges is always one
// well-formed table containing exactly the planned keys.
export function renderCodexTuiTableToml({ notifications = null, statusLine = null } = {}) {
  const lines = ['[tui]'];
  if (Array.isArray(notifications)) {
    lines.push(`notifications = [${notifications.map((item) => tomlBasicString(item)).join(', ')}]`);
  }
  if (Array.isArray(statusLine)) {
    lines.push(`status_line = [${statusLine.map((item) => tomlBasicString(item)).join(', ')}]`);
  }
  if (lines.length === 1) throw new Error('renderCodexTuiTableToml requires at least one of notifications/statusLine');
  return `${lines.join('\n')}\n`;
}
