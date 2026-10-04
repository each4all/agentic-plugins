// plugins/runtime/scripts/lib/codex-config.mjs
//
// READ-ONLY Codex host-config TOML reading and parsing (machine-bootstrap-contract.md
// §1.3 extraction 4). This module never writes host config.
//
// `readCodexConfigToml` and `parseCodexConfigToml` moved here from the
// notification plan (ADR-0064 Decision 2, item 6): bootstrap's Codex
// statusline judge reads the same file and the same `[tui]` table, and outlived
// the plan, which ADR-0064 Decision 1 removed together with the `notify =`
// read.
//
// The module first held the generic half of `lib/permission-config.mjs` (ADR-0057
// §Decision 4): `parseCodexPermissionConfigToml`, the approval-policy /
// sandbox-mode / project-trust scan. Its only consumer was the portable machine
// profile's permission reader, and it went with the profile (ADR-0064
// Decision 3).

import { join, resolve } from 'node:path';

import { readTextIfExists } from './state-readers.mjs';

// The ONE read of $CODEX_HOME/config.toml (default ~/.codex): the read result
// (text, or the reason it failed) and where the home came from. A probe that
// judges this file several ways shares this one read, so an atomic replacement
// between two reads cannot split one probe across two versions of the file.
export async function readCodexConfigToml({ homeDir, env = {} }) {
  const codexHome = env && env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
  const codexHomeSource = env && env.CODEX_HOME ? 'CODEX_HOME env override' : 'default ~/.codex';
  const read = await readTextIfExists(join(codexHome, 'config.toml'));
  return { read, codexHomeSource };
}


// Scan a raw capture for basic ("...") / literal ('...') TOML string elements.
// Returns null when any non-string, non-separator token appears — a value that
// is not a flat string array is never trusted.
//
// Decode fidelity is a safety requirement (Plan-verify peer MAJOR, raised when
// the notification plan's wrapper chain EXECUTED a parsed argv): a string form
// this scanner cannot decode faithfully must return null, never a
// silently-different value. Basic strings decode the full TOML escape set
// (\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX); any other escape and the
// triple-quoted multi-line forms are rejected as unparseable.
function extractStringElements(arrayText) {
  const inner = arrayText.trim().replace(/^\[/, '').replace(/\]$/, '');
  const values = [];
  let i = 0;
  // Separator discipline (Refine-verify peer MEDIUM): after a closed string,
  // the ONLY tokens allowed before the next string are whitespace/comments and
  // exactly one comma. `["a" "b"]` is not TOML — treating whitespace as a
  // separator parsed it into two elements and let a malformed config judge
  // `satisfied` against §6.1's "unparseable → pending" rule.
  let expectSeparator = false;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if (ch === ',') {
      if (!expectSeparator) return null; // leading/double comma — not a flat string array
      expectSeparator = false;
      i += 1;
      continue;
    }
    if (ch === '#') {
      // Comment inside a multi-line array — skip to end of line.
      const nl = inner.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === '"') {
      if (expectSeparator) return null; // two strings with no comma between
      // Triple-quoted multi-line basic string — not supported; fail safe.
      if (inner.startsWith('"""', i)) return null;
      let out = '';
      i += 1;
      let closed = false;
      while (i < inner.length) {
        const c = inner[i];
        if (c === '\\') {
          const next = inner[i + 1];
          if (next === undefined) return null;
          if (next === 'b') { out += '\b'; i += 2; continue; }
          if (next === 't') { out += '\t'; i += 2; continue; }
          if (next === 'n') { out += '\n'; i += 2; continue; }
          if (next === 'f') { out += '\f'; i += 2; continue; }
          if (next === 'r') { out += '\r'; i += 2; continue; }
          if (next === '"') { out += '"'; i += 2; continue; }
          if (next === '\\') { out += '\\'; i += 2; continue; }
          if (next === 'u' || next === 'U') {
            const width = next === 'u' ? 4 : 8;
            const hex = inner.slice(i + 2, i + 2 + width);
            if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
            let decoded;
            try {
              decoded = String.fromCodePoint(Number.parseInt(hex, 16));
            } catch {
              return null; // out-of-range code point
            }
            out += decoded;
            i += 2 + width;
            continue;
          }
          // Unknown escape — decoding it as anything would risk trusting a
          // DIFFERENT value than the one configured.
          return null;
        }
        if (c === '"') { closed = true; i += 1; break; }
        out += c;
        i += 1;
      }
      if (!closed) return null;
      values.push(out);
      expectSeparator = true;
      continue;
    }
    if (ch === "'") {
      if (expectSeparator) return null; // two strings with no comma between
      // Triple-quoted multi-line literal string — not supported; fail safe.
      if (inner.startsWith("'''", i)) return null;
      const end = inner.indexOf("'", i + 1);
      if (end === -1) return null;
      values.push(inner.slice(i + 1, end));
      expectSeparator = true;
      i = end + 1;
      continue;
    }
    // Any other token (number, bool, nested table…) — not a flat string array.
    return null;
  }
  return values;
}

// Capture a TOML array value starting at lines[startIndex] whose text after
// `=` is firstRemainder. String-state + bracket-depth aware, so `#` and `]`
// INSIDE quoted elements never terminate the capture, and a trailing comment
// after the closing bracket is never captured. Multi-line arrays accumulate
// until the depth returns to zero (an unclosed array captures to EOF and
// parses as non-array).
function captureTomlArray(lines, startIndex, firstRemainder) {
  let raw = '';
  let depth = 0;
  let sawOpen = false;
  let inString = null; // '"' | "'" | null
  let escaped = false;
  let lineIndex = startIndex;
  let text = firstRemainder;
  for (;;) {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        raw += ch;
        if (escaped) { escaped = false; continue; }
        if (inString === '"' && ch === '\\') { escaped = true; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '#') break; // comment — rest of this physical line ignored
      raw += ch;
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === '[') { depth += 1; sawOpen = true; continue; }
      if (ch === ']') {
        depth -= 1;
        if (sawOpen && depth === 0) {
          // The remainder of the closing physical line rides back so the
          // caller can refuse trailing non-comment junk (`= ["a"] garbage`)
          // instead of silently accepting a line no TOML parser would.
          return { raw: raw.trim(), nextIndex: lineIndex + 1, closed: true, trailing: text.slice(i + 1) };
        }
      }
    }
    lineIndex += 1;
    if (!sawOpen || lineIndex >= lines.length) {
      return { raw: raw.trim(), nextIndex: lineIndex, closed: !sawOpen, trailing: '' };
    }
    raw += '\n';
    text = lines[lineIndex];
  }
}

// Minimal READ-ONLY scan of ~/.codex/config.toml for exactly the key runtime
// judges: the `[tui]` table's `status_line`. Top-level keys are honored only
// before the first section header (TOML ordering). A duplicate assignment is
// invalid TOML and resolves `invalid`, never last-value-wins.
//
// ADR-0064 Decision 1 removed the `notify` read and the `[tui] notifications`
// read with the notification plan. The scan still STEPS OVER both values as
// one value each, without reading them: an operator's Codex config keeps its
// `notify =` line until the owner's cleanup (ADR-0064 Decision 9), and
// `[tui] notifications` is Codex's own key. Scanning a multi-line array's
// lines one by one would see them as headers and keys, and the `status_line`
// answer could change.
export function parseCodexConfigToml(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let inTopLevel = true;
  let inTui = false;
  let tuiHeaderSeen = false;
  // A dotted top-level `tui.<key> = …` IMPLICITLY creates the [tui] table, and
  // TOML 1.0 forbids redefining such a table with a later [tui] header. The
  // scan recognized the dotted form but never recorded that it had created the
  // table, so `tui.notifications = [canonical]` followed by `[tui]` resolved to
  // a trusted canonical value out of a config Codex cannot load. The same hole
  // applied to `tui.status_line`, whose EXACT probe ships — `tuiRedefined`
  // gates the [tui] key.
  let tuiDottedSeen = false;
  let tuiRedefined = false;
  // Per-key capture state: raw text + the strictness facts an EXACT probe
  // needs (Plan-verify peer BLOCKER — the earlier scan discarded them):
  // unclosed arrays, duplicate keys (invalid TOML, previously last-wins),
  // a redefined [tui] table, and trailing non-comment junk all resolve to
  // values:null (unparseable), never to a confidently wrong argv/item list.
  const states = { tuiStatusLine: null };
  // Keys whose IDENTITY or table scope this scan cannot pin down: the name was
  // claimed as a sub-table, a deeper dotted path defined it as a table, or the
  // whole [tui] table arrived as an inline assignment. Poisoned keys resolve
  // `invalid` — never `absent`, which would read as "nothing configured" and
  // send the operator a merge instruction that breaks a working config.
  const poisoned = new Set();
  // A TOML bare/quoted key token → its bare name.
  const keyName = (token) => String(token ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  // A TOML bare/quoted key token → the state name it addresses, or null.
  const tuiStateKey = (token) => (keyName(token) === 'status_line' ? 'tuiStatusLine' : null);
  const record = (key, captured) => {
    if (states[key] !== null) {
      states[key] = { ...states[key], duplicate: true };
      return;
    }
    states[key] = {
      raw: captured.raw,
      closed: captured.closed === true,
      trailingOk: /^\s*(#.*)?$/.test(captured.trailing ?? ''),
      duplicate: false,
    };
  };
  let i = 0;
  // Multi-line-string state (Review peer BLOCKER): a line INSIDE a custom
  // triple-quoted value under [tui] can look exactly like `status_line = [...]`
  // and the line scanner certified it as the real key. Track open
  // basic/literal multi-line strings and skip every line inside one. The
  // tracking is conservative: an odd delimiter count toggles, and anything it
  // cannot follow leaves keys uncaptured (fail-closed: unparseable → null,
  // never a confidently wrong value).
  let openTriple = null; // '"""' | "'''" | null
  // A `#` OUTSIDE a string starts a comment, and a triple delimiter inside that
  // comment is not a delimiter (Review peer BLOCKER 2): `# """` followed by
  // `[tui.child] # """` made the scanner swallow the real section transition
  // and read a nested value as if it sat under [tui]. Comment detection has to
  // respect single-quoted/double-quoted spans on the same line, or a `#` inside
  // an ordinary string value would truncate a line it has no business ending.
  const commentIndexOutsideStrings = (line, from) => {
    let inStr = null;
    let escaped = false;
    for (let k = from; k < line.length; k += 1) {
      const ch = line[k];
      if (inStr) {
        if (escaped) { escaped = false; continue; }
        if (inStr === '"' && ch === '\\') { escaped = true; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '#') return k;
    }
    return -1;
  };
  const toggleTriples = (line) => {
    let idx = 0;
    for (;;) {
      if (openTriple) {
        const close = line.indexOf(openTriple, idx);
        if (close === -1) return true; // still inside — whole line consumed
        idx = close + 3;
        openTriple = null;
        continue;
      }
      const b = line.indexOf('"""', idx);
      const l = line.indexOf("'''", idx);
      const next = b === -1 ? l : l === -1 ? b : Math.min(b, l);
      if (next === -1) return false;
      const comment = commentIndexOutsideStrings(line, idx);
      if (comment !== -1 && comment < next) return false; // the delimiter is commented out
      openTriple = line.slice(next, next + 3);
      idx = next + 3;
    }
  };
  while (i < lines.length) {
    const raw = lines[i];
    if (openTriple) {
      toggleTriples(raw);
      i += 1;
      continue;
    }
    const consumedByTriple = toggleTriples(raw);
    if (consumedByTriple) { i += 1; continue; }
    const commentAt = commentIndexOutsideStrings(raw, 0);
    const stripped = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
    if (stripped.startsWith('[')) {
      inTopLevel = false;
      const isTui = /^\[tui\]$/.test(stripped);
      // Two explicit [tui] headers, or an explicit header after the table was
      // implicitly created by a dotted key — both are TOML redefinitions.
      if (isTui && (tuiHeaderSeen || tuiDottedSeen)) tuiRedefined = true;
      if (isTui) tuiHeaderSeen = true;
      // A `[tui.<key>]` header claims one of OUR key names as a sub-TABLE, so a
      // later `<key> = …` under [tui] redefines it. `[tui.other]` is ordinary
      // and must not poison anything (defining a super-table afterwards is
      // legal TOML), which is why only a NAME COLLISION poisons.
      const subTable = stripped.match(/^\[\s*tui\s*\.\s*(.+?)\s*\]$/);
      if (subTable) {
        const claimed = tuiStateKey(subTable[1].split('.')[0]);
        if (claimed) poisoned.add(claimed);
      }
      inTui = isTui;
      i += 1;
      continue;
    }
    if (inTopLevel) {
      // Stepped over, not read (see the header comment).
      const m = raw.match(/^\s*(?:"notify"|'notify'|notify)\s*=\s*(.*)$/);
      if (m) {
        i = captureTomlArray(lines, i, m[1]).nextIndex;
        continue;
      }
      // `tui = …` defines the whole table in one assignment — an inline table
      // this line scanner cannot read. Refusing to interpret it is honest;
      // reporting the keys ABSENT is not, because the recovery then tells the
      // operator to merge a `[tui]` block that would redefine a closed inline
      // table and break a config Codex accepts today.
      if (/^\s*(?:"tui"|'tui'|tui)\s*=/.test(raw)) {
        poisoned.add('tuiStatusLine');
        tuiDottedSeen = true;
        i += 1;
        continue;
      }
      // Dotted top-level forms. ANY `tui.<…>` assignment implicitly creates the
      // table — not just the key this scan reads — so the redefinition flag is
      // set for all of them (the first fix covered only the keys it read, which
      // left `tui.color = "blue"` + `[tui]` certifying).
      const dotted = raw.match(/^\s*(?:"tui"|'tui'|tui)\s*\.\s*(.*)$/);
      if (dotted) {
        tuiDottedSeen = true;
        const assign = dotted[1].match(/^(.+?)\s*=\s*(.*)$/);
        const path = assign ? assign[1].split('.').map((seg) => seg.trim()) : [];
        const stateKey = path.length > 0 ? tuiStateKey(path[0]) : null;
        // Codex's own `tui.notifications`, in the dotted form: stepped over as
        // one value, not read (see the header comment), like `[tui] notifications`.
        if (!stateKey && path.length === 1 && keyName(path[0]) === 'notifications') {
          i = captureTomlArray(lines, i, assign[2]).nextIndex;
          continue;
        }
        if (stateKey && path.length === 1) {
          const captured = captureTomlArray(lines, i, assign[2]);
          record(stateKey, captured);
          i = captured.nextIndex;
          continue;
        }
        // `tui.status_line.enabled = …` defines OUR key as a table.
        if (stateKey) poisoned.add(stateKey);
        i += 1;
        continue;
      }
    } else if (inTui) {
      // A dotted key under [tui] whose head collides with one of ours defines
      // that key as a table, so any sibling `<key> = …` is a redefinition.
      const dottedInTui = raw.match(/^\s*(.+?)\s*=\s*.*$/);
      if (dottedInTui && dottedInTui[1].includes('.')) {
        const head = tuiStateKey(dottedInTui[1].split('.')[0]);
        if (head) { poisoned.add(head); i += 1; continue; }
      }
      // Codex's own `notifications` key: stepped over, not read (see the
      // header comment).
      const mN = raw.match(/^\s*(?:"notifications"|'notifications'|notifications)\s*=\s*(.*)$/);
      if (mN) {
        i = captureTomlArray(lines, i, mN[1]).nextIndex;
        continue;
      }
      // Quoted key forms are the SAME key. Matching only the bare and
      // double-quoted spellings once let `'notifications' = false` slip past
      // the duplicate check beside a canonical bare assignment.
      const mS = raw.match(/^\s*(?:"status_line"|'status_line'|status_line)\s*=\s*(.*)$/);
      if (mS) {
        const captured = captureTomlArray(lines, i, mS[1]);
        record('tuiStatusLine', captured);
        i = captured.nextIndex;
        continue;
      }
    }
    i += 1;
  }
  // `form` is the TYPED classification a judge needs; `values` keeps its exact
  // prior meaning (a trusted flat string array, else null) so existing callers
  // are unaffected. A boolean flag was tried first and does not work: the
  // structural facts alone say `["a" "b"]` and `true junk` are "clean" — the
  // capture closed with no trailing junk — while neither is a value any probe
  // may trust. So the classification is exhaustive and FAILS CLOSED to
  // `invalid` (the classifyWireDisposition precedent: an unrecognized shape is
  // never silently benign), and `raw` must never be interpreted except through
  // `form`.
  //
  //   absent  — the key was not observed at all
  //   true    — exactly `true`
  //   false   — exactly `false`
  //   array   — a trusted flat string array; `values` carries it
  //   invalid — everything else: duplicate key, redefined table, unclosed
  //             array, trailing junk, a non-flat-string array, or any scalar
  //             this zero-dependency scanner cannot classify
  const resolve = (key, state, { tuiKey = false } = {}) => {
    if (poisoned.has(key)) return { present: true, raw: state?.raw ?? null, values: null, form: 'invalid' };
    if (state === null) return { present: false, raw: null, values: null, form: 'absent' };
    const structural = !state.duplicate && state.closed && state.trailingOk && !(tuiKey && tuiRedefined);
    if (!structural) return { present: true, raw: state.raw, values: null, form: 'invalid' };
    if (state.raw.startsWith('[')) {
      const values = extractStringElements(state.raw);
      return values === null
        ? { present: true, raw: state.raw, values: null, form: 'invalid' }
        : { present: true, raw: state.raw, values, form: 'array' };
    }
    if (state.raw === 'true') return { present: true, raw: state.raw, values: null, form: 'true' };
    if (state.raw === 'false') return { present: true, raw: state.raw, values: null, form: 'false' };
    return { present: true, raw: state.raw, values: null, form: 'invalid' };
  };
  return {
    tuiStatusLine: resolve('tuiStatusLine', states.tuiStatusLine, { tuiKey: true }),
  };
}
