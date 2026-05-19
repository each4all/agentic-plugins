// Vendor minimal YAML parser for the engineer:decide registry.
//
// Scope: the closed subset documented in
// docs/adr/0027-decide-skill-multi-axis-evolution.md §1.1 and §5.4:
//
//   - Block-style maps with `key: value` entries
//   - Block-style sequences (`- item`) where each item is a map
//   - Scalar values: double-quoted "..." or single-quoted '...' or unquoted
//   - Nested maps and lists
//   - Line comments (`# ...` to end of line, honoring quotes)
//   - UTF-8 in string VALUES (e.g. labels.ko Korean text)
//   - ASCII-only in map keys (the schema treats keys as axis/preset ids
//     which are constrained to `[a-z][a-z0-9-]*` per §1.6)
//
// Explicit rejects (each with line number):
//
//   - Tab characters anywhere in indent
//   - Flow-style markers `{ } [ ]` outside quoted strings
//   - Anchors (`&x`), aliases (`*x`), tags (`!x`)
//   - Multi-line scalar markers `|` or `>`
//   - Duplicate map keys (NOT last-wins — §1.6 row 16 requires error)
//   - Non-ASCII characters in map keys
//
// Numbers, booleans, and null in scalar position are coerced to their
// string form — the registry only stores strings.

export class YamlParseError extends Error {
  constructor(message, line) {
    super(`Line ${line}: ${message}`);
    this.line = line;
    this.name = "YamlParseError";
  }
}

const ASCII_KEY_RE = /^[\x20-\x7E]+$/;
// Keys that would mutate `Object.prototype` if assigned naively via
// `map[key] = value` on a plain `{}` object. We reject these names at
// parse time so they can never reach the assignment site — the result
// maps stay plain `{}` (preserving deepEqual / JSON.stringify
// ergonomics for callers and tests) and the explicit rejection above
// provides the prototype-pollution defense.
const RESERVED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Strip a trailing line comment, respecting double/single-quoted spans.
// Returns the body without the comment (and without trailing whitespace).
function stripComment(body) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (!inSingle && c === '"' && body[i - 1] !== "\\") inDouble = !inDouble;
    else if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inDouble && !inSingle && c === "#") {
      return body.slice(0, i).replace(/\s+$/, "");
    }
  }
  return body.replace(/\s+$/, "");
}

// Split raw text into normalized line records:
//   { indent, body, lineNum }
// Blank lines and comment-only lines are dropped.
function tokenizeLines(text) {
  const out = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNum = i + 1;
    if (/^\s*$/.test(raw)) continue;

    // Measure leading whitespace; reject tabs in indent.
    const indentMatch = raw.match(/^( *)(\t?)/);
    if (indentMatch[2]) {
      throw new YamlParseError(
        "tab character in indent — use spaces only",
        lineNum,
      );
    }
    const indent = indentMatch[1].length;

    // Reject any tab in the rest of the line that is structural
    // (tabs inside quoted scalars are not validated by the parser; the
    // schema's quoted strings are short and unlikely to contain tabs).
    const tail = raw.slice(indent);
    if (/^\t/.test(tail)) {
      throw new YamlParseError(
        "tab character in indent — use spaces only",
        lineNum,
      );
    }

    const body = stripComment(tail);
    if (!body) continue; // comment-only line

    out.push({ indent, body, lineNum });
  }
  return out;
}

// Reject obvious unsupported YAML features in any scalar position.
function rejectUnsupported(body, lineNum) {
  // Multi-line scalar indicators when they appear as the value half.
  if (/:\s*[|>][+\-]?(\s*$|\s+#)/.test(body)) {
    throw new YamlParseError(
      "multi-line scalar marker `|` or `>` not supported",
      lineNum,
    );
  }
  // Anchor / alias / tag in value position.
  if (/:\s*[&*!]\S/.test(body)) {
    throw new YamlParseError(
      "anchors / aliases / tags (&x, *x, !x) not supported",
      lineNum,
    );
  }
}

// Parse a scalar token (the right-hand side of a `key:` or a list-item
// scalar). Handles quoted strings and unquoted "plain" strings.
// Quoted strings preserve their interior verbatim except for the standard
// escape `\"` (in double-quoted) and `''` (in single-quoted).
function parseScalar(raw, lineNum) {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new YamlParseError("unterminated double-quoted string", lineNum);
    }
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new YamlParseError("unterminated single-quoted string", lineNum);
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  // Reject flow-style markers in unquoted scalars only.
  if (/^[{[]/.test(trimmed)) {
    throw new YamlParseError(
      "flow-style markers `{` `[` not supported — use block style",
      lineNum,
    );
  }

  // Coerce numbers / booleans / null to their string form.
  return trimmed;
}

// Recursive descent: parse a block-style map at the given column.
// Returns [object, nextIndex]. Stops when the next line's indent drops
// below `column` or the line is a sequence item (handled by parseList).
function parseMap(lines, startIdx, column) {
  // Prototype-pollution defense: RESERVED_KEY_NAMES are rejected at
  // write time (see check below) so `__proto__` / `constructor` /
  // `prototype` can never reach `result[key] = ...`. Keeping the map
  // with a regular prototype (vs Object.create(null)) preserves
  // deepEqual / JSON.stringify ergonomics for callers and tests.
  const result = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < column) break;
    if (line.indent > column) {
      throw new YamlParseError(
        `unexpected indent ${line.indent} (expected ${column} for map entry)`,
        line.lineNum,
      );
    }
    if (line.body.startsWith("- ")) {
      // Caller should have routed this to parseList; bail out so the
      // parent does.
      break;
    }

    rejectUnsupported(line.body, line.lineNum);

    // Match `key: value` or `key:`. Key may be quoted or unquoted.
    const m = line.body.match(/^([^:#]+?)\s*:(\s+(.*)|\s*$)/);
    if (!m) {
      throw new YamlParseError(
        `invalid map entry — expected "key: value" or "key:"`,
        line.lineNum,
      );
    }
    let key = m[1].trim();
    // Strip optional surrounding quotes on the key.
    if (
      (key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'"))
    ) {
      key = key.slice(1, -1);
    }
    if (!ASCII_KEY_RE.test(key)) {
      throw new YamlParseError(
        `non-ASCII or unsupported character in map key`,
        line.lineNum,
      );
    }
    if (RESERVED_KEY_NAMES.has(key)) {
      throw new YamlParseError(
        `reserved map key name "${key}" — would mutate Object.prototype`,
        line.lineNum,
      );
    }
    // Use Object.hasOwn so we don't pick up entries from the prototype
    // chain even though `result` is null-prototype today.
    if (Object.hasOwn(result, key)) {
      throw new YamlParseError(
        `duplicate map key: "${key}"`,
        line.lineNum,
      );
    }

    const inlineValue = m[3];
    i++;

    if (inlineValue !== undefined && inlineValue !== "") {
      // Scalar value on the same line.
      result[key] = parseScalar(inlineValue, line.lineNum);
      continue;
    }

    // Value is on subsequent indented lines (or is null/empty).
    if (i >= lines.length || lines[i].indent <= column) {
      result[key] = null;
      continue;
    }

    const childCol = lines[i].indent;
    if (lines[i].body.startsWith("- ")) {
      const [list, nextIdx] = parseList(lines, i, childCol);
      result[key] = list;
      i = nextIdx;
    } else {
      const [map, nextIdx] = parseMap(lines, i, childCol);
      result[key] = map;
      i = nextIdx;
    }
  }

  return [result, i];
}

// Parse a block sequence of map items at the given indent column.
// Sequences of scalars are not used by the registry schema; they are
// supported here only as a `parseScalar` fall-through for completeness.
function parseList(lines, startIdx, column) {
  const result = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < column) break;
    if (line.indent > column) {
      throw new YamlParseError(
        `unexpected indent ${line.indent} (expected ${column} for list item)`,
        line.lineNum,
      );
    }
    if (!line.body.startsWith("- ")) break;

    rejectUnsupported(line.body, line.lineNum);

    // The body after "- " is either a scalar or the FIRST key of a map.
    const afterDash = line.body.slice(2);
    const itemCol = column + 2;

    // Map start? Match `key: ...` directly.
    const keyMatch = afterDash.match(/^([^:#]+?)\s*:(\s+(.*)|\s*$)/);
    if (keyMatch) {
      // Construct a synthetic "first line of map" record and let parseMap
      // continue reading further map keys at itemCol.
      const synthFirstKey = keyMatch[1].trim();
      let stripped = synthFirstKey;
      if (
        (stripped.startsWith('"') && stripped.endsWith('"')) ||
        (stripped.startsWith("'") && stripped.endsWith("'"))
      ) {
        stripped = stripped.slice(1, -1);
      }
      if (!ASCII_KEY_RE.test(stripped)) {
        throw new YamlParseError(
          `non-ASCII or unsupported character in map key`,
          line.lineNum,
        );
      }
      if (RESERVED_KEY_NAMES.has(stripped)) {
        throw new YamlParseError(
          `reserved map key name "${stripped}" — would mutate Object.prototype`,
          line.lineNum,
        );
      }
      const map = {};
      const inlineValue = keyMatch[3];

      let nextIdx = i + 1;
      if (inlineValue !== undefined && inlineValue !== "") {
        map[stripped] = parseScalar(inlineValue, line.lineNum);
      } else if (
        nextIdx < lines.length &&
        lines[nextIdx].indent > itemCol
      ) {
        const childCol = lines[nextIdx].indent;
        if (lines[nextIdx].body.startsWith("- ")) {
          const [child, ni] = parseList(lines, nextIdx, childCol);
          map[stripped] = child;
          nextIdx = ni;
        } else {
          const [child, ni] = parseMap(lines, nextIdx, childCol);
          map[stripped] = child;
          nextIdx = ni;
        }
      } else {
        map[stripped] = null;
      }

      // Continue collecting further map keys for this list item at
      // exactly itemCol.
      while (
        nextIdx < lines.length &&
        lines[nextIdx].indent === itemCol &&
        !lines[nextIdx].body.startsWith("- ")
      ) {
        const sub = parseMap([lines[nextIdx]], 0, itemCol);
        const onlyEntry = Object.entries(sub[0])[0];
        if (!onlyEntry) {
          nextIdx++;
          continue;
        }
        const [k, vSentinel] = onlyEntry;
        if (RESERVED_KEY_NAMES.has(k)) {
          throw new YamlParseError(
            `reserved map key name "${k}" — would mutate Object.prototype`,
            lines[nextIdx].lineNum,
          );
        }
        if (Object.hasOwn(map, k)) {
          throw new YamlParseError(
            `duplicate map key: "${k}"`,
            lines[nextIdx].lineNum,
          );
        }
        // vSentinel may be `null` if the key has no inline value AND
        // subsequent lines indent further to provide it.
        if (vSentinel === null) {
          const lookahead = nextIdx + 1;
          if (lookahead < lines.length && lines[lookahead].indent > itemCol) {
            const childCol = lines[lookahead].indent;
            if (lines[lookahead].body.startsWith("- ")) {
              const [child, ni] = parseList(lines, lookahead, childCol);
              map[k] = child;
              nextIdx = ni;
              continue;
            } else {
              const [child, ni] = parseMap(lines, lookahead, childCol);
              map[k] = child;
              nextIdx = ni;
              continue;
            }
          }
          map[k] = null;
        } else {
          map[k] = vSentinel;
        }
        nextIdx++;
      }

      result.push(map);
      i = nextIdx;
      continue;
    }

    // Scalar list item — not used by the registry schema but supported
    // for completeness.
    result.push(parseScalar(afterDash, line.lineNum));
    i++;
  }

  return [result, i];
}

export function parse(text) {
  if (typeof text !== "string") {
    throw new TypeError("yaml-mini parse() expects a string");
  }
  text = normalizeNewlines(stripBom(text));
  const lines = tokenizeLines(text);
  if (lines.length === 0) return null;

  const startCol = lines[0].indent;
  // Top-level must be a map for the registry schema.
  if (lines[0].body.startsWith("- ")) {
    const [list] = parseList(lines, 0, startCol);
    return list;
  }
  const [map, nextIdx] = parseMap(lines, 0, startCol);
  if (nextIdx !== lines.length) {
    throw new YamlParseError(
      `unexpected content after top-level map (lines remain)`,
      lines[nextIdx].lineNum,
    );
  }
  return map;
}
