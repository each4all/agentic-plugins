// Zero-dependency structured scanner for the ADR-0035 §4 active-execution
// boundary guard. Reads `runtime-executor-registry.mjs`; consumed by
// `test-runtime-executor-guard.mjs`.
//
// This is NOT a raw grep (ADR-0035 §4) and NOT an AST/acorn parse (the repo is
// zero-dependency by policy). It is a token-aware structured scan: a
// comment-stripping / string-preserving tokenizer feeds import-anchored
// capability detection, command-origin call analysis, and a per-host-CLI argv
// verb-path allowlist. Comments are removed so `// shell: true` cannot trigger
// a finding; string literals are KEPT because the argv hazards (`'-c'`,
// `'login'`, `'@agentic-plugins'`) live inside them (the plan-verify correction).
//
// Pure functions, no I/O — the test supplies file sources.

// Sentinel: a command that is a registered command-variable (machine-probe
// `name`) — known to range over the host CLIs {claude, codex}. Literal
// argv at such a call is validated against the UNION of host-CLI allowlists.
const HOST_UNION = '*host-cli*';

const RECURSIVE_TRUE_RE = /\brecursive\s*:\s*true\b/;

// ---------------------------------------------------------------------------
// Tokenizer: strip comments, preserve strings/templates/regex
// ---------------------------------------------------------------------------

// `/` begins a regex (not division) when the previous significant char is one
// of these, or the previous word is an expression-context keyword.
const REGEX_PREV_PUNCT = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '}',
  '+', '-', '*', '%', '^', '~', '<', '>',
]);
const REGEX_PREV_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'case',
]);

// Replace every comment with equal-length whitespace (newlines preserved so
// line numbers and offsets are stable); keep string/template/regex bodies
// verbatim. Returns code-only text safe to pattern-match.
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSig = '';            // last non-whitespace significant char
  let prevWord = '';           // last COMPLETED identifier (preserved across whitespace)
  let prevWordDotted = false;  // was prevWord a `.member` access?
  let curWord = '';            // identifier currently being read
  let curWordDotted = false;
  const flushWord = () => { if (curWord) { prevWord = curWord; prevWordDotted = curWordDotted; curWord = ''; } };
  const resetWords = () => { curWord = ''; prevWord = ''; prevWordDotted = false; };
  // The identifier immediately preceding the current position (across whitespace).
  const preceding = () => (curWord ? { word: curWord, dotted: curWordDotted } : { word: prevWord, dotted: prevWordDotted });

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      prevSig = ''; resetWords();
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      prevSig = ''; resetWords();
      continue;
    }
    // single/double-quoted string
    if (c === "'" || c === '"') {
      out += c; i += 1;
      while (i < n) {
        const d = src[i];
        if (d === '\\' && i + 1 < n) { out += d + src[i + 1]; i += 2; continue; }
        out += d; i += 1;
        if (d === c) break;
      }
      prevSig = c; resetWords();
      continue;
    }
    // template literal (treated opaquely — nested ${} not re-scanned)
    if (c === '`') {
      out += c; i += 1;
      while (i < n) {
        const d = src[i];
        if (d === '\\' && i + 1 < n) { out += d + src[i + 1]; i += 2; continue; }
        out += d; i += 1;
        if (d === '`') break;
      }
      prevSig = '`'; resetWords();
      continue;
    }
    // regex literal — a `/` after regex-context punctuation, or after an
    // expression keyword (`return /re/`) that is NOT a `.member` access.
    const prec = preceding();
    if (c === '/' && (REGEX_PREV_PUNCT.has(prevSig) || (REGEX_PREV_KEYWORDS.has(prec.word) && !prec.dotted))) {
      out += c; i += 1;
      let inClass = false;
      let terminated = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\' && i + 1 < n) { out += d + src[i + 1]; i += 2; continue; }
        if (d === '\n') break; // unterminated — bail, treat rest normally
        out += d; i += 1;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { terminated = true; break; }
      }
      prevSig = '/'; resetWords();
      continue;
    }

    out += c;
    const isWordChar = /[A-Za-z0-9_$]/.test(c);
    if (isWordChar) {
      if (curWord === '') curWordDotted = (prevSig === '.');
      curWord += c;
    } else {
      flushWord();
    }
    if (!/\s/.test(c)) prevSig = c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small structural helpers (operate on comment-stripped code)
// ---------------------------------------------------------------------------

// From an open-paren/bracket/brace index, return the matching close index,
// skipping string/template bodies. Returns -1 if unbalanced.
export function matchDelimiter(code, openIdx) {
  const open = code[openIdx];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  let i = openIdx;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(code, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipString(code, i) {
  const quote = code[i];
  i += 1;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    i += 1;
  }
  return n;
}

// Split a comma-separated argument list (the inner text of a call's parens)
// into top-level argument strings, respecting nesting and strings.
export function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = inner[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(inner, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    i += 1;
  }
  const tail = inner.slice(start);
  if (tail.trim() !== '' || parts.length > 0) parts.push(tail);
  return parts.map((p) => p.trim());
}

// Find every bare call `name(` (not a property access `.name(`) of any name in
// `names`. Returns [{ name, openParen, inner }].
export function findBareCalls(code, names) {
  const results = [];
  const set = new Set(names);
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (!set.has(name)) continue;
    // Skip a function/method DEFINITION (`function name(`, `async function name(`,
    // `function* name(`) — that is not a call of `name`.
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*\*?\s*$/.test(before)) continue;
    const openParen = code.indexOf('(', m.index + m[1].length);
    if (openParen === -1) continue;
    const closeParen = matchDelimiter(code, openParen);
    if (closeParen === -1) continue;
    results.push({ name, openParen, inner: code.slice(openParen + 1, closeParen) });
  }
  return results;
}

// Escape a string for safe interpolation into a RegExp. Import bindings and namespace
// names may legitimately contain `$` (a regex metacharacter — `h$` would otherwise become
// an end-anchor and match nothing, silently voiding the binding's analysis — Codex round-2
// CRITICAL); this escapes every RegExp metacharacter so the binding is matched literally.
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find member calls `obj.method(` (e.g. a namespace import `cp.spawn(` or
// `doctor.runCommand(`). Returns [{ openParen, inner }].
export function findMemberCalls(code, obj, method) {
  const results = [];
  const re = new RegExp(`(?<![.\\w$])${escapeRegExp(obj)}\\s*\\.\\s*${escapeRegExp(method)}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    const openParen = code.indexOf('(', m.index);
    if (openParen === -1) continue;
    const closeParen = matchDelimiter(code, openParen);
    if (closeParen === -1) continue;
    results.push({ openParen, inner: code.slice(openParen + 1, closeParen) });
  }
  return results;
}

// Blank the literal TEXT of string/template literals (keep delimiters,
// structure, newlines, and positions) so identifier-position scans don't match a
// `fetch` token inside a string. Template `${…}` interpolations are EXECUTABLE
// CODE (they can hold a real `fetch(...)`), so they are copied verbatim, not
// blanked (Codex round-3 CRITICAL). Comments are already stripped upstream.
// Residual (documented): a `fetch(` nested inside a further template literal
// *inside* an interpolation is skipped opaquely by matchDelimiter's string skip —
// a token scanner cannot follow arbitrary nesting (registry: Network egress).
function blankStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "'" || c === '"') {
      out += c; i += 1;
      while (i < n) {
        const d = code[i];
        if (d === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        if (d === c) { out += d; i += 1; break; }
        out += d === '\n' ? '\n' : ' '; i += 1;
      }
      continue;
    }
    if (c === '`') {
      out += c; i += 1;
      while (i < n) {
        const d = code[i];
        if (d === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        if (d === '`') { out += d; i += 1; break; }
        if (d === '$' && code[i + 1] === '{') {
          const close = matchDelimiter(code, i + 1); // matches `}`, skipping strings
          if (close === -1) { out += ' '; i += 1; continue; }
          out += code.slice(i, close + 1); // copy ${…} interpolation verbatim (code)
          i = close + 1;
          continue;
        }
        out += d === '\n' ? '\n' : ' '; i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

// Does the code reference the global `fetch` at all (ADR-0035 §4 network line)?
// `fetch` is a global with no import to anchor on, and JS offers unbounded
// indirection, so every form counts, and no runtime script may use any of them
// (registry: Network egress):
//   - the bare identifier, on string-blanked code: a call, an optional call
//     `fetch?.(`, a tagged template, `fetch.call(`, an alias `= fetch`, a
//     destructure `{ fetch } =`, a shadowing `const/let/var/function fetch`;
//   - a member `.fetch` (`globalThis.fetch`, `g.fetch` after `const g = globalThis`);
//   - a computed `['fetch']`;
//   - a 'fetch' string passed as the LAST argument of a call — the reflective
//     shape `Reflect.get(obj, 'fetch')`, `Object.getOwnPropertyDescriptor(obj,
//     'fetch')`, `Reflect['get'](obj, 'fetch')`, however padded. Keyed on
//     `, 'fetch')`, not on any 'fetch' string, so a DATA string such as a git
//     subcommand in an argv array (`, 'fetch',` / `, 'fetch']`) is not flagged.
// Strings are blanked for the identifier and member forms so a mention inside a
// string literal is not flagged, while a `${…}` interpolation (executable code)
// is still scanned. Residual (documented, out of scope for a token scanner):
// string-concatenated obfuscation like `globalThis['fet'+'ch']`, a helper that
// returns the global, `eval`.
function referencesFetch(code) {
  const codeNoStr = blankStrings(code);
  return /(?<![.\w$])fetch\b/.test(codeNoStr)
    || /\.\s*fetch\b/.test(codeNoStr)
    || /\[\s*(['"`])fetch\1\s*\]/.test(code)
    || /,\s*(['"`])fetch\1\s*\)/.test(code);
}

// Find ALL command-origin calls in a file, closing the aliasing/member/namespace
// gaps (Codex review MAJOR #1): base EXEC_CALL_NAMES, plus
//   - imported aliases of exec functions / capability primitives
//     (`import { runCommand as rc }`, `import { spawn as run }`);
//   - local aliases (`const r = runCommand`, `runner = options.runner ?? runCommand`);
//   - namespace member calls (`cp.spawn(`, `doctor.runCommand(`).
// Each result carries `name` (the underlying exec/primitive name, for
// hardcoding/passthrough lookups) and `callee` (the surface form, for evidence).
export function findExecCalls(code, fileName, registry, staticImports) {
  const execNameSet = new Set([
    ...registry.EXEC_CALL_NAMES,
    ...registry.RAW_PROCESS_PRIMITIVES,
    // NOTE: network primitives are deliberately NOT here — `.get(` on an
    // arbitrary namespace (`cache.get(key)`) must not be mistaken for an exec
    // call (Codex re-review false-positive). Network is handled by network-gate.
  ]);
  const bare = new Map(); // local name -> underlying exec name
  for (const name of registry.EXEC_CALL_NAMES) bare.set(name, name);
  const namespaceImports = [];
  for (const imp of staticImports) {
    if (imp.namespace) namespaceImports.push(imp.namespace);
    for (const nm of imp.names) {
      if (execNameSet.has(nm.imported)) bare.set(nm.local, nm.imported);
      if (registry.WATCHED_CAPABILITY_MODULES.includes(imp.module)
        && registry.RAW_PROCESS_PRIMITIVES.includes(nm.imported)) {
        bare.set(nm.local, nm.imported);
      }
    }
  }
  // Destructuring aliases from a namespace: `const { runCommand: r } = doctor`,
  // `const { spawn } = cp`.
  const destrRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([\w$]+)/g;
  let dm;
  while ((dm = destrRe.exec(code))) {
    if (!namespaceImports.includes(dm[2])) continue;
    for (const piece of dm[1].split(',')) {
      const mm = piece.trim().match(/^([\w$]+)(?:\s*:\s*([\w$]+))?$/);
      if (mm && execNameSet.has(mm[1])) bare.set(mm[2] || mm[1], mm[1]);
    }
  }
  // Local aliases: `[const] X = <execName>` used as a VALUE (not a call), incl.
  // `?? execName`, ternary forms, and bare reassignment. Excludes `X = execName(...)`
  // (a call result) and comparisons (`==`/`===`/`!=`/`<=`/`>=`/`=>`).
  const aliasRe = /(?:(?:const|let|var)\s+)?([\w$]+)\s*(?<![=!<>])=(?![=>])\s*([^;\n]+)/g;
  for (let pass = 0; pass < 3; pass += 1) {
    let added = false;
    let am;
    aliasRe.lastIndex = 0;
    while ((am = aliasRe.exec(code))) {
      const lhs = am[1];
      if (bare.has(lhs)) continue;
      const parts = am[2].split(/\?\?|\?|:/).map((p) => p.trim()
        .replace(/^await\s+/, '').replace(/^\(+/, '').replace(/\)+$/, '').trim());
      for (const p of parts) {
        const dot = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1) : p;
        const candidate = bare.has(p) ? p : (namespaceImports.includes(p.split('.')[0]) && execNameSet.has(dot) ? dot : null);
        if (candidate) { bare.set(lhs, bare.get(candidate) || candidate); added = true; break; }
      }
    }
    if (!added) break;
  }
  const calls = [];
  for (const c of findBareCalls(code, [...bare.keys()])) {
    calls.push({ name: bare.get(c.name) || c.name, callee: c.name, openParen: c.openParen, inner: c.inner });
  }
  // Namespace member calls of any watched exec/primitive name.
  for (const ns of namespaceImports) {
    for (const e of execNameSet) {
      for (const c of findMemberCalls(code, ns, e)) {
        calls.push({ name: e, callee: `${ns}.${e}`, openParen: c.openParen, inner: c.inner });
      }
    }
  }
  return calls;
}

// Normalize a single argv element literal to a token, or null if it is not a
// static string/template literal. `${...}` collapses to '*' (one variable
// target token); a fully variable element returns null (dynamic).
export function normalizeElement(raw) {
  const t = raw.trim();
  if (t === '') return null;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('`') && t.endsWith('`')) {
    return collapseTemplate(t.slice(1, -1));
  }
  return null; // identifier, spread, call, concat — not a static literal
}

function collapseTemplate(body) {
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body[i] === '$' && body[i + 1] === '{') {
      // skip balanced ${...}
      let depth = 0;
      let j = i + 1;
      while (j < n) {
        if (body[j] === '{') depth += 1;
        else if (body[j] === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
        j += 1;
      }
      out += '*';
      i = j;
      continue;
    }
    out += body[i];
    i += 1;
  }
  return out;
}

// Parse an argument expression that should be an array literal of string
// elements. Returns { kind: 'literal', tokens } | { kind: 'dynamic' } |
// { kind: 'not-array' }.
export function parseArgvArray(argText) {
  const t = argText.trim();
  if (!t.startsWith('[')) return { kind: 'not-array' };
  const close = matchDelimiter(t, 0);
  if (close === -1) return { kind: 'dynamic' };
  const inner = t.slice(1, close);
  const elements = splitTopLevel(inner).filter((e) => e !== '');
  const tokens = [];
  for (const el of elements) {
    if (el.startsWith('...')) return { kind: 'dynamic' }; // spread changes arity — cannot bound
    const norm = normalizeElement(el);
    // A string/template literal keeps its value; any other single element
    // (identifier, member, call) is a variable TARGET token → '*'. This keeps a
    // "literal verb + variable target" argv checkable (e.g. ['init','-q','-b',branch]
    // → ['init','-q','-b','*']) while a variable VERB (['plugin', action]) fails the
    // allowlist because '*' never equals a required literal verb token.
    tokens.push(norm === null ? '*' : norm);
  }
  return { kind: 'literal', tokens };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// Return { staticImports: [{ module, names, namespace }], dynamic: [module|null] }.
export function findImports(code) {
  const staticImports = [];
  const dynamic = [];
  // The default-import clause's trailing comma is OPTIONAL so a LONE default import
  // (`import https from 'node:https'`) is parsed, not only `import def, { named }`.
  // Before this, a lone-default import of a capability module (e.g. the removed
  // compat.mjs's `import https from 'node:https'`, and the node:https E1 transport notify.mjs carried,
  // ADR-0041 §2d) was INVISIBLE to the import-gate — a fail-open hole for every
  // watched module. `[\w$]+` never matches a leading `{`/`*`, so a named/namespace
  // import still skips this group.
  const importRe = /import\s+(?:([\w$]+)\s*(?:,\s*)?)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*(?:,\s*\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(code))) {
    const def = m[1];
    const ns = m[2] || m[4] || null;
    const named = m[3] || '';
    const module = m[5];
    const names = [];
    if (def) names.push({ imported: 'default', local: def });
    for (const piece of named.split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const asMatch = p.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] });
      else names.push({ imported: p, local: p });
    }
    staticImports.push({ module, names, namespace: ns });
  }
  // dynamic import() / require() — the argument must be a SINGLE clean string
  // literal (no concatenation/template/variable). `import('node:' + 'child_process')`
  // is non-literal and fail-closed (Codex re-review MAJOR #5).
  const dynRe = /(?<![.\w$])(?:import|require)\s*\(/g;
  let d;
  while ((d = dynRe.exec(code))) {
    const open = code.indexOf('(', d.index);
    const close = matchDelimiter(code, open);
    if (close === -1) { dynamic.push({ module: null, nonLiteral: true }); continue; }
    const argText = (splitTopLevel(code.slice(open + 1, close))[0] || '').trim();
    const norm = normalizeElement(argText);
    if (norm !== null && !argText.includes('+') && !argText.includes('${')) {
      dynamic.push({ module: norm, nonLiteral: false });
    } else {
      dynamic.push({ module: null, nonLiteral: true });
    }
  }
  // re-exports: `export { spawn as run } from 'node:child_process'`, `export * from …`
  const reExports = [];
  const reExportRe = /export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g;
  let r;
  while ((r = reExportRe.exec(code))) reExports.push(r[1]);
  return { staticImports, dynamic, reExports };
}

// ---------------------------------------------------------------------------
// Verb-path matching
// ---------------------------------------------------------------------------

// Match a concrete argv token list against one allowlist verb-path entry.
// Entry tokens: a literal equals; '*' matches one token; '...' (final only)
// matches the remaining tokens with no DANGEROUS_ARGV_TOKENS among them.
export function matchVerbPath(argv, entry, dangerousTokens) {
  let ai = 0;
  for (let ei = 0; ei < entry.length; ei += 1) {
    const tok = entry[ei];
    if (tok === '...') {
      const rest = argv.slice(ai);
      return rest.every((r) => !dangerousTokens.includes(r));
    }
    if (ai >= argv.length) return false;
    if (tok === '*') { ai += 1; continue; }
    if (tok !== argv[ai]) return false;
    ai += 1;
  }
  return ai === argv.length;
}

// Expand a command (or the HOST_UNION sentinel) to the concrete host CLIs it
// may resolve to.
function commandsFor(command) {
  if (command === HOST_UNION) return ['claude', 'codex'];
  return [command];
}

function argvAllowedForCommand(argv, command, registry) {
  return commandsFor(command).some((cmd) => (registry.ARGV_VERB_ALLOWLIST[cmd] || [])
    .some((e) => matchVerbPath(argv, e, registry.DANGEROUS_ARGV_TOKENS)));
}

function dangerousTokenViolation(argv, command, registry) {
  const offenders = argv.filter((tok) => registry.DANGEROUS_ARGV_TOKENS.includes(tok));
  if (offenders.length === 0) return null;
  const cmds = commandsFor(command);
  const excepted = (registry.DANGEROUS_ARGV_EXCEPTIONS || []).some(
    (ex) => cmds.includes(ex.command) && arraysEqual(ex.verbPath, argv),
  );
  if (excepted) return null;
  return offenders;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

// Validate one collected (command, argvTokens) pair. Returns a violation string
// or null.
function validateArgv({ command, tokens, file, registry, evidence }) {
  // Destructive verbs are governed solely by ALLOWED_DESTRUCTIVE_TEMPLATES.
  const destructiveVerbs = ['uninstall', 'remove', 'prune'];
  const hit = tokens.find((t) => destructiveVerbs.includes(t));
  if (hit) {
    const idx = tokens.indexOf(hit);
    const target = tokens[idx + 1] || '';
    const ok = (registry.ALLOWED_DESTRUCTIVE_TEMPLATES || []).some(
      (tpl) => tpl.file === file && tpl.command === command && tpl.verb === hit
        && target.endsWith(tpl.targetSuffix),
    );
    if (!ok) {
      return `destructive verb '${hit}' not an allowed retired-cleanup template (${evidence})`;
    }
    return null;
  }
  const danger = dangerousTokenViolation(tokens, command, registry);
  if (danger) return `forbidden argv token(s) [${danger.join(', ')}] (${evidence})`;
  if (!argvAllowedForCommand(tokens, command, registry)) {
    return `argv verb-path not in ${command} allowlist: [${tokens.join(' ')}] (${evidence})`;
  }
  return null;
}

export function scanFile({ fileName, source, registry }) {
  const violations = [];
  const code = stripComments(source);
  const isImporter = Object.prototype.hasOwnProperty.call(registry.CAPABILITY_IMPORTERS, fileName);
  const importerSpec = registry.CAPABILITY_IMPORTERS[fileName];

  // --- Import-gate -----------------------------------------------------------
  const { staticImports, dynamic, reExports } = findImports(code);
  for (const imp of staticImports) {
    if (!registry.WATCHED_CAPABILITY_MODULES.includes(imp.module)) continue;
    if (!(isImporter && importerSpec.modules.includes(canonicalModule(imp.module)))) {
      violations.push({
        rule: 'import-gate', file: fileName,
        detail: `imports capability module '${imp.module}' but is not a registered CAPABILITY_IMPORTERS entry for it`,
      });
    }
  }
  for (const mod of reExports) {
    if (registry.WATCHED_CAPABILITY_MODULES.includes(mod)) {
      violations.push({ rule: 'import-gate', file: fileName, detail: `re-exports from capability module '${mod}' is not allowed` });
    }
  }
  for (const dyn of dynamic) {
    if (dyn.module && registry.WATCHED_CAPABILITY_MODULES.includes(dyn.module)) {
      violations.push({ rule: 'import-gate', file: fileName, detail: `dynamic import of capability module '${dyn.module}' is not allowed` });
    } else if (dyn.nonLiteral) {
      // a dynamic import()/require() of a non-literal module is fail-closed in
      // runtime scripts (could resolve to a capability module at runtime).
      violations.push({ rule: 'import-gate', file: fileName, detail: 'dynamic import()/require() with a non-literal module specifier is not allowed in runtime scripts' });
    }
  }
  // process.getBuiltinModule (Node ≥22.3) loads a builtin with NO import/require/node:module
  // — a THIRD capability-load path past the gates above (createRequire is covered by watching
  // node:module). Flag the identifier form (`getBuiltinModule(` — tested on string-blanked
  // code so a mere prose mention is not over-flagged) AND the computed-string form
  // (`process['getBuiltinModule']` — a lone 'getBuiltinModule' string literal, Codex round-3
  // CRITICAL). It can obtain any watched capability module.
  if (/\bgetBuiltinModule\b/.test(blankStrings(code)) || /(['"])getBuiltinModule\1/.test(code)) {
    violations.push({ rule: 'import-gate', file: fileName, detail: 'getBuiltinModule(...) loads a builtin without an import — forbidden (it can obtain any watched capability module, evading the import gate)' });
  }
  // Escaped module specifiers: `import x from 'node:https'` (and dynamic import()/require()
  // forms) resolve to a watched builtin at runtime while the RAW literal text does not match
  // the ASCII watch list, so the checks above miss it. No legitimate import specifier contains
  // a backslash escape, so a backslash in ANY resolved module specifier fails closed (Codex
  // round-3 CRITICAL).
  for (const mod of [...staticImports.map((i) => i.module), ...reExports, ...dynamic.map((d) => d.module).filter(Boolean)]) {
    if (mod.includes('\\')) {
      violations.push({ rule: 'import-gate', file: fileName, detail: `import module specifier '${mod}' uses an escape sequence — forbidden (an escaped specifier can resolve to a watched capability module while evading the literal watch list)` });
    }
  }
  // Fail closed on a watched-module import whose BINDING the ASCII structured parser cannot
  // resolve — a non-ASCII (`import η from …`) or \u-escaped (`import https …`) binding
  // evades findImports' `[\w$]` grammar, so the import-gate above silently misses it
  // (Codex round-2/3 CRITICAL). A statement-anchored scan (so an import-looking DECOY inside a
  // string literal — preceded by `"`, not a statement boundary — is not matched) captures the
  // binding CLAUSE + module specifier of each real import; if the module is watched (or its
  // specifier is escaped) and the binding clause contains anything outside the ASCII import
  // grammar (identifier chars, `* { } , as`, whitespace), a binding was unparsed → reject,
  // honoring the guard's "fail closed on anything it cannot recognize" stance.
  {
    const looseImportRe = /(?:^|[\n;{}()])\s*import\b([^;'"]*?)from\s*(['"])([^'"]+)\2/g;
    let li;
    while ((li = looseImportRe.exec(code))) {
      const bindingClause = li[1];
      const mod = li[3];
      if (mod.includes('\\')) {
        violations.push({ rule: 'import-gate', file: fileName, detail: `import module specifier '${mod}' uses an escape sequence — forbidden (escaped specifier can resolve to a watched capability module)` });
        continue;
      }
      if (!registry.WATCHED_CAPABILITY_MODULES.includes(mod)) continue;
      if (!/^[\sA-Za-z0-9_$*{},]*$/.test(bindingClause)) {
        violations.push({ rule: 'import-gate', file: fileName, detail: `capability module '${mod}' is imported with a binding the scanner cannot parse (non-ASCII / \\u-escaped identifier) — use a plain ASCII binding so the gates can anchor on it` });
      }
    }
  }

  // --- Raw-primitive-gate ----------------------------------------------------
  // Anchor on the child_process import (named / aliased / namespace) so a
  // registered importer cannot reach an UNregistered primitive — including via a
  // namespace member call like `cp.execFile(...)` (Codex re-review hole #4).
  for (const imp of staticImports) {
    if (canonicalModule(imp.module) !== 'node:child_process') continue;
    for (const nm of imp.names) {
      if (!registry.RAW_PROCESS_PRIMITIVES.includes(nm.imported)) continue;
      if (findBareCalls(code, [nm.local]).length === 0) continue;
      if (!(isImporter && importerSpec.primitives.includes(nm.imported))) {
        violations.push({ rule: 'primitive-gate', file: fileName, detail: `uses child_process primitive '${nm.imported}'${nm.local !== nm.imported ? ` (as ${nm.local})` : ''} not registered for this file` });
      }
    }
    if (imp.namespace) {
      for (const prim of registry.RAW_PROCESS_PRIMITIVES) {
        if (findMemberCalls(code, imp.namespace, prim).length === 0) continue;
        if (!(isImporter && importerSpec.primitives.includes(prim))) {
          violations.push({ rule: 'primitive-gate', file: fileName, detail: `uses child_process primitive '${imp.namespace}.${prim}' not registered for this file` });
        }
      }
    }
  }

  // --- Command-origin + argv (Layer A3 + Layer B) ---------------------------
  const passthroughParams = new Set(
    (registry.EXEC_PASSTHROUGH_FNS[fileName] || []).map((e) => e.param),
  );
  const commandVars = new Set(registry.ALLOWED_COMMAND_VARIABLES[fileName] || []);
  const projections = (registry.ALLOWED_DYNAMIC_PROJECTIONS || []).filter((p) => p.file === fileName);

  const execCalls = findExecCalls(code, fileName, registry, staticImports);
  for (const call of execCalls) {
    const args = splitTopLevel(call.inner);
    const hardcoded = registry.COMMAND_HARDCODING_WRAPPERS[call.name];
    let command = null;
    let argvArgText = null;

    if (hardcoded) {
      command = hardcoded;
      argvArgText = wrapperArgvArg(call.name, args);
    } else {
      const cmdArg = (args[0] || '').trim();
      argvArgText = args[1] !== undefined ? args[1] : null;
      const resolved = resolveCommand(cmdArg, { commandVars, passthroughParams, projections, registry });
      if (resolved.violation) {
        violations.push({ rule: 'command-gate', file: fileName, detail: `${resolved.violation}: ${truncate(cmdArg)} (${call.callee}(…))` });
        continue;
      }
      command = resolved.command; // host-CLI literal, or null for node/variable/projection (skip argv)
    }

    if (!command) continue; // process.execPath (Node) / passthrough param / projection — argv validated elsewhere

    // A site that forwards a validated wrapper param — its argv is checked at the
    // wrapper's call sites. Exempt ONLY when (a) argv matches the registered
    // forward shape EXACTLY and (b) the forwarded identifier is the parameter, not
    // a local `const args = [...]` (which would be a literal we must validate).
    const argvNorm = (argvArgText || '').replace(/\s+/g, '');
    const forwarding = (registry.ARGV_FORWARDING_SITES || []).some(
      (s) => s.file === fileName && s.callee === call.name
        && (s.forwardsArgv || []).some((shape) => shape.replace(/\s+/g, '') === argvNorm)
        && withinSpan(call.openParen, functionBodySpan(code, s.wrapper)),
    );
    if (forwarding) continue;

    // Layer B: validate argv for a host-CLI command.
    const evidence = `${call.callee}(${command === HOST_UNION ? '<host>' : `'${command}'`}, …)`;
    if (argvArgText === null) {
      if (command !== HOST_UNION) {
        violations.push({ rule: 'argv-unresolved', file: fileName, detail: `'${command}' invoked without an argv array (${evidence})` });
      }
      continue;
    }
    // Resolve a bare-identifier argv to a local literal array if one exists, so
    // `const argv = ['plugin','remove',name]; runner(plan.argv.command, argv)` is
    // verb-checked instead of skipped (Codex re-review projection slip).
    if (/^[\w$]+$/.test((argvArgText || '').trim())) {
      const lit = localLiteralArray(code, argvArgText.trim());
      if (lit) {
        const v = validateArgv({ command, tokens: lit, file: fileName, registry, evidence });
        if (v) violations.push({ rule: 'argv-verb-gate', file: fileName, detail: v });
        continue;
      }
    }
    const parsed = parseArgvArray(argvArgText);
    if (parsed.kind === 'not-array') {
      // HOST_UNION: argv is a probe-fed identifier (e.g. versionArgs) validated via
      // PROBE_CONFIGS — skip. A host-CLI literal whose 2nd arg is not an array
      // literal is unresolved → fail closed.
      if (command !== HOST_UNION) {
        violations.push({ rule: 'argv-unresolved', file: fileName, detail: `host-CLI '${command}' argv is not a literal array (${evidence})` });
      }
      continue;
    }
    if (parsed.kind === 'dynamic') {
      if (command !== HOST_UNION) {
        violations.push({ rule: 'argv-unresolved', file: fileName, detail: `host-CLI '${command}' invoked with non-literal argv (${evidence}); register a projection/forwarding site or use a literal argv` });
      }
      continue;
    }
    const v = validateArgv({ command, tokens: parsed.tokens, file: fileName, registry, evidence });
    if (v) violations.push({ rule: 'argv-verb-gate', file: fileName, detail: v });
  }

  // --- Probe-config argv (doctor inspectCli inline object) ------------------
  for (const { command, tokens, evidence } of extractProbeArgv(code, fileName, registry)) {
    const v = validateArgv({ command, tokens, file: fileName, registry, evidence });
    if (v) violations.push({ rule: 'argv-verb-gate', file: fileName, detail: v });
  }

  // --- Shell-gate ------------------------------------------------------------
  for (const ev of findShellViolations(code)) {
    violations.push({ rule: 'shell-gate', file: fileName, detail: ev });
  }

  // --- Network-gate ----------------------------------------------------------
  // In a network-importer file, only the registered network primitive(s) may be
  // used (a GET-only importer allows `get` alone). A non-`get` network primitive is flagged when
  // it is (a) a member CALL `.request(`, (b) a member ALIAS `= x.request`, or (c)
  // DESTRUCTURED `const { request } = …`. A bare unrelated `.request` property
  // read is NOT flagged (Codex re-review false-positive), and `map.get` is fine
  // because 'get' is allowed.
  if (isImporter && importerSpec.modules.some((m) => m === 'node:http' || m === 'node:https' || m === 'node:net' || m === 'node:http2')) {
    const allowedNet = new Set(importerSpec.primitives);
    const reported = new Set();
    const flag = (method, how) => {
      if (registry.NETWORK_PRIMITIVES.includes(method) && !allowedNet.has(method) && !reported.has(method)) {
        reported.add(method);
        violations.push({ rule: 'network-gate', file: fileName, detail: `network method '${method}' (${how}) is not allowed (only ${[...allowedNet].join(', ')})` });
      }
    };
    let nm;
    const callRe = /(?<![.\w$])[\w$]+\s*\.\s*([\w$]+)\s*\(/g; // member call
    while ((nm = callRe.exec(code))) flag(nm[1], 'call');
    const aliasRe = /=\s*[\w$]+\s*\.\s*([\w$]+)\b/g;          // alias `= x.request`
    while ((nm = aliasRe.exec(code))) flag(nm[1], 'alias');
    const destrRe = /\{([^}]*)\}\s*=\s*[\w$]+/g;              // `const { request } = https`
    while ((nm = destrRe.exec(code))) {
      for (const piece of nm[1].split(',')) {
        const key = piece.trim().split(/\s*:\s*/)[0].trim();
        if (/^[\w$]+$/.test(key)) flag(key, 'destructure');
      }
    }
  }

  // --- Global-fetch-gate (non-import-anchored) -------------------------------
  // `fetch` is a global, so no import-anchored gate above sees it: every
  // reference fails, in every runtime script (referencesFetch lists the forms).
  // No table can permit one; a future network user needs its own ADR and its own
  // behavioral test of the request it sends (registry: Network egress).
  if (referencesFetch(code)) {
    violations.push({
      rule: 'global-fetch-gate', file: fileName,
      detail: 'references the global fetch, an outbound-network primitive not permitted in any runtime script (no runtime script reaches the network since ADR-0064 retired tier E1)',
    });
  }

  // --- Global-WebSocket-gate (non-import-anchored egress) --------------------
  // Node ≥22 exposes a global `WebSocket` — a second import-less outbound-network primitive
  // beside `fetch` (Codex round-4 CRITICAL, a plain non-obfuscated egress API). No runtime
  // script legitimately opens a WebSocket, so ANY reference (tested on string-blanked code so
  // a prose mention is not over-flagged) fails closed, as a `fetch` reference does.
  if (/(?<![.\w$])WebSocket\b/.test(blankStrings(code))) {
    violations.push({ rule: 'global-websocket-gate', file: fileName, detail: 'the global WebSocket is an outbound-network primitive not permitted in any runtime script (no runtime script reaches the network since ADR-0064 retired tier E1)' });
  }

  // --- Kill-gate -------------------------------------------------------------
  // Only the exact registered own-child timeout kill is allowed:
  // child.kill('SIGTERM') in a kill-site file. process.kill / SIGKILL / any other
  // receiver or signal fails — even inside doctor.mjs (Codex review MAJOR #3).
  // process.kill is forbidden — EXCEPT the registered signal-0 liveness probe,
  // which sends no signal (see ALLOWED_PID_LIVENESS_SITES). The exemption is
  // form-pinned to a literal `0`: every OTHER process.kill in the file still fails,
  // including one whose signal is a variable, since a variable could hold 'SIGKILL'.
  const livenessSite = (registry.ALLOWED_PID_LIVENESS_SITES || []).find((s) => s.file === fileName);
  const processKillRe = /\bprocess\.kill\s*\(([^)]*)\)/g;
  let pkm;
  while ((pkm = processKillRe.exec(code))) {
    const args = pkm[1].split(',').map((a) => a.trim());
    const isLivenessProbe = args.length === 2 && /^[\w$]+$/.test(args[0]) && args[1] === '0';
    if (livenessSite && isLivenessProbe) continue;
    violations.push({
      rule: 'kill-gate',
      file: fileName,
      detail: isLivenessProbe
        ? `process.kill(${truncate(pkm[1], 24)}) is a signal-0 liveness probe, but ${fileName} is not in ALLOWED_PID_LIVENESS_SITES`
        : 'process.kill(...) is forbidden (external-process kill)',
    });
  }
  if (/\bSIGKILL\b/.test(code)) {
    violations.push({ rule: 'kill-gate', file: fileName, detail: 'SIGKILL is forbidden' });
  }
  const killSite = (registry.ALLOWED_KILL_SITES || []).find((s) => s.file === fileName);
  const killRe = /(?<![.\w$])([\w$]+)\s*\.\s*kill\s*\(([^)]*)\)/g;
  let km;
  while ((km = killRe.exec(code))) {
    const recv = km[1];
    if (recv === 'process') continue; // handled above
    const firstArg = (km[2].split(',')[0] || '').trim();
    const ok = killSite && recv === killSite.receiver
      && new RegExp(`^['"]${killSite.signal}['"]$`).test(firstArg);
    if (!ok) {
      violations.push({ rule: 'kill-gate', file: fileName, detail: `${recv}.kill(${truncate(km[2], 24)}) is not the registered own-child ${killSite ? killSite.signal : 'SIGTERM'} kill` });
    }
  }

  // --- FS-mutation gates (ADR-0044 S3b — the ADR-0035 §5 fs-modeling
  // extension) --------------------------------------------------------------
  // Three layers over the registry's FS model:
  //   fs-mutation-gate — which file may import/call which mutating primitive
  //     (named imports gate on the import itself; default/namespace bindings
  //     gate on member CALLS, so a read-only `import fs from 'node:fs'` stays
  //     quiet);
  //   fs-open-gate — every open/openSync site must be read-only or
  //     O_EXCL-create ('wx'/'ax'), never an overwrite/append open that would
  //     bypass the temp+rename atomicity discipline;
  //   fs-delete-gate — a recursive:true removal must be a registered
  //     ALLOWED_RECURSIVE_REMOVALS site pinned to its exact target identifier.
  // Detection runs on string-blanked code (an `open(` inside an error-message
  // string must not count — the same discipline as referencesFetch); each
  // call's real inner is re-extracted from the unblanked source, which is
  // position-identical because blankStrings preserves length.
  {
    const fsModules = registry.WATCHED_FS_MODULES || [];
    const fsPrimitives = registry.FS_MUTATION_PRIMITIVES || [];
    const fsSpec = (registry.FS_MUTATION_USERS || {})[fileName] || null;
    const codeNoStr = blankStrings(code);
    const openLike = new Set(['open', 'openSync']);
    const removeLike = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync']);
    const openSites = [];
    const removeSites = [];
    const reExtract = (openParen) => {
      const close = matchDelimiter(code, openParen);
      return close === -1 ? '' : code.slice(openParen + 1, close);
    };
    // Dynamic import()/require() or a re-export of an fs module defeats the
    // import-anchored model outright — fail closed regardless of
    // registration (plan-verify peer: `await import('node:fs/promises')`
    // scanned clean before this).
    for (const dyn of dynamic) {
      if (dyn.module && fsModules.includes(dyn.module)) {
        violations.push({ rule: 'fs-mutation-gate', file: fileName, detail: `dynamic import of fs module '${dyn.module}' is not allowed (it defeats the import-anchored mutation model)` });
      }
    }
    for (const mod of reExports) {
      if (fsModules.includes(mod)) {
        violations.push({ rule: 'fs-mutation-gate', file: fileName, detail: `re-export from fs module '${mod}' is not allowed` });
      }
    }
    const mutationSites = [];
    for (const imp of staticImports) {
      if (!fsModules.includes(imp.module)) continue;
      for (const nm of imp.names) {
        if (nm.imported === 'default') continue; // handled as a namespace below
        if (!fsPrimitives.includes(nm.imported)) continue;
        if (!fsSpec || !(fsSpec.primitives || []).includes(nm.imported)) {
          violations.push({
            rule: 'fs-mutation-gate', file: fileName,
            detail: `imports fs mutation primitive '${nm.imported}'${nm.local !== nm.imported ? ` (as ${nm.local})` : ''} but is not registered for it in FS_MUTATION_USERS`,
          });
        }
        const calls = findBareCalls(codeNoStr, [nm.local]);
        for (const call of calls) {
          const site = { prim: nm.imported, callee: nm.imported, inner: reExtract(call.openParen) };
          mutationSites.push(site);
          if (openLike.has(nm.imported)) openSites.push(site);
          if (removeLike.has(nm.imported)) removeSites.push(site);
        }
        // The open/remove primitives carry SITE-shape gates below, so their
        // bindings may only appear as direct calls — a value use (alias,
        // argument, destructure source) would evade the site validation
        // (plan-verify peer). One extra reference is the import clause.
        if (openLike.has(nm.imported) || removeLike.has(nm.imported)) {
          const bareTokens = (codeNoStr.match(new RegExp(`(?<![.\\w$])${escapeRegExp(nm.local)}(?![\\w$])`, 'g')) || []).length;
          if (bareTokens - calls.length - 1 > 0) {
            violations.push({
              rule: 'fs-mutation-gate', file: fileName,
              detail: `fs primitive '${nm.local}' is referenced as a value (alias/argument) — open/remove primitives may only be called directly, else their site-shape gates are evaded`,
            });
          }
        }
      }
      const nsBindings = [
        ...(imp.namespace ? [imp.namespace] : []),
        ...imp.names.filter((nm) => nm.imported === 'default').map((nm) => nm.local),
      ];
      for (const ns of nsBindings) {
        // Computed access (`fs['writeFileSync']`) and the `.promises`
        // sub-namespace hop (`fs.promises.writeFile`) both evade
        // member-anchored primitive detection — fail closed on the form
        // (plan-verify peer bypasses, both reproduced).
        if (new RegExp(`(?<![.\\w$])${escapeRegExp(ns)}\\s*\\[`).test(codeNoStr)) {
          violations.push({ rule: 'fs-mutation-gate', file: fileName, detail: `computed member access on fs binding '${ns}' is not allowed (it evades primitive detection)` });
        }
        if (new RegExp(`(?<![.\\w$])${escapeRegExp(ns)}\\s*\\.\\s*promises(?![\\w$])`).test(codeNoStr)) {
          violations.push({ rule: 'fs-mutation-gate', file: fileName, detail: `'${ns}.promises' sub-namespace access is not allowed (it evades primitive detection)` });
        }
        for (const prim of fsPrimitives) {
          const memberCalls = findMemberCalls(codeNoStr, ns, prim);
          if (memberCalls.length === 0) continue;
          if (!fsSpec || !(fsSpec.primitives || []).includes(prim)) {
            violations.push({
              rule: 'fs-mutation-gate', file: fileName,
              detail: `calls fs mutation primitive '${ns}.${prim}' but is not registered for it in FS_MUTATION_USERS`,
            });
          }
          for (const call of memberCalls) {
            const site = { prim, callee: prim, inner: reExtract(call.openParen) };
            mutationSites.push(site);
            if (openLike.has(prim)) openSites.push(site);
            if (removeLike.has(prim)) removeSites.push(site);
          }
        }
      }
    }
    // A mutating call whose first argument is a LITERAL absolute path can
    // never be a repo/home-scoped computed root — refuse outright; computed
    // paths stay owned by each executor's behavioral tests plus the
    // stateRoots drift check (plan-verify peer: the declaration alone was
    // purely documentary).
    for (const site of mutationSites) {
      const first = (splitTopLevel(site.inner)[0] || '').trim();
      const lit = normalizeElement(first);
      if (lit !== null && (lit.startsWith('/') || lit.startsWith('~') || /^[A-Za-z]:[\\/]/.test(lit))) {
        violations.push({
          rule: 'fs-mutation-gate', file: fileName,
          detail: `mutating fs primitive '${site.prim}' targets a literal absolute path (${truncate(lit, 40)}) — runtime mutates only computed repo/home-scoped roots`,
        });
      }
    }
    for (const site of openSites) {
      const v = validateOpenFlags(site.inner, code);
      if (v) violations.push({ rule: 'fs-open-gate', file: fileName, detail: `${site.prim}(${truncate(site.inner, 60)}): ${v}` });
    }
    const recursiveSites = (registry.ALLOWED_RECURSIVE_REMOVALS || {})[fileName] || [];
    for (const site of removeSites) {
      const args = splitTopLevel(site.inner);
      const optsText = (args[1] || '').trim();
      if (optsText !== '') {
        // Options must be an INLINE object literal with no spread and no
        // computed/bracket forms — a variable, spread, or computed key can
        // smuggle recursive:true past the token check (plan-verify peer).
        const inlineObject = optsText.startsWith('{') && matchDelimiter(optsText, 0) === optsText.length - 1;
        if (!inlineObject || optsText.includes('...') || optsText.includes('[')) {
          violations.push({
            rule: 'fs-delete-gate', file: fileName,
            detail: `removal options for ${site.callee}(${truncate(site.inner, 50)}) must be an inline object literal without spread/computed keys (a variable can hide recursive:true)`,
          });
          continue;
        }
      }
      if (!RECURSIVE_TRUE_RE.test(optsText)) continue;
      const target = (args[0] || '').trim();
      const ok = recursiveSites.some((s) => s.callee === site.callee && s.target === target);
      if (!ok) {
        violations.push({
          rule: 'fs-delete-gate', file: fileName,
          detail: `recursive removal ${site.callee}(${truncate(site.inner, 60)}) is not a registered ALLOWED_RECURSIVE_REMOVALS site (callee + first-arg identifier pinned)`,
        });
      }
    }
  }

  return { violations };
}

// open/openSync write-shape validation (fs-open-gate): a runtime script may
// open for READ (no write flags) or for EXCLUSIVE CREATE ('wx'/'ax' /
// O_CREAT|O_EXCL) — never an overwrite/append open, which would bypass the
// temp+rename atomicity discipline every runtime writer follows. The flags
// argument may be a string literal, an inline constants expression, or a
// local const/let identifier — resolved by folding its definition plus every
// `|=` augmentation in the file (the egress-config read-open shape). Anything
// the scanner cannot recognize fails closed. Returns a violation string or
// null.
export function validateOpenFlags(inner, code) {
  const args = splitTopLevel(inner);
  if (args.length < 2) return null; // fs default 'r' — read-only
  let flagText = (args[1] || '').trim();
  if (/^[\w$]+$/.test(flagText)) {
    // Resolve a flag identifier by folding its declaration AND every later
    // assignment (`flags = …` as well as `flags |= …`) — resolving only the
    // initializer let a later `flags = O_WRONLY | O_CREAT` smuggle a write
    // open past a read-only declaration (plan-verify peer). No resolvable
    // assignment (e.g. a bare parameter) fails closed.
    const ident = flagText;
    let assembled = '';
    const assignRe = new RegExp(`(?<![.\\w$])${escapeRegExp(ident)}\\s*(?:\\|=|(?<![=!<>])=(?![=>]))\\s*([^;\\n]+)`, 'g');
    let am;
    while ((am = assignRe.exec(code))) assembled += ` | ${am[1]}`;
    if (assembled === '') {
      return `flags identifier '${ident}' has no local assignment the scanner can resolve — use a literal or a locally-assigned flag expression`;
    }
    flagText = assembled;
  }
  const literal = normalizeElement(flagText);
  if (literal !== null) {
    if (literal === 'r' || literal === 'rs') return null;
    if (/^(?:wx|ax)\+?$/.test(literal)) return null;
    return `flag string '${literal}' is neither read-only ('r') nor exclusive-create ('wx'/'ax')`;
  }
  // Arithmetic on flag constants can zero a token the text scan still sees
  // (`0 * O_EXCL` — plan-verify peer); only |, ??, ?:, and member access are
  // recognizably pure flag composition.
  if (/[+*%-]|<<|>>/.test(flagText)) {
    return `flags expression uses arithmetic — cannot be statically trusted: ${truncate(flagText, 60)}`;
  }
  const hasWrite = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(flagText);
  const hasExcl = /O_EXCL/.test(flagText);
  const hasCreat = /O_CREAT/.test(flagText);
  const hasRead = /O_RDONLY/.test(flagText);
  if (!hasWrite && hasRead) return null;
  // O_EXCL is meaningful only WITH O_CREAT — `O_WRONLY|O_EXCL` alone opens
  // an existing file for overwrite (plan-verify peer).
  if (hasWrite && hasExcl && hasCreat) return null;
  return `flags expression is not recognizably read-only or O_CREAT|O_EXCL-create: ${truncate(flagText, 60)}`;
}

// ---------------------------------------------------------------------------
// Helpers for the scan
// ---------------------------------------------------------------------------

function canonicalModule(mod) {
  return mod.startsWith('node:') ? mod : `node:${mod}`;
}

// If the file declares `const/let/var <ident> = [ <clean string literals> ]`,
// return those tokens; else null. Used to resolve a local literal argv variable.
function localLiteralArray(code, ident) {
  if (!ident || !/^[\w$]+$/.test(ident)) return null;
  const m = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*\\[`).exec(code);
  if (!m) return null;
  const open = code.indexOf('[', m.index);
  const close = matchDelimiter(code, open);
  if (close === -1) return null;
  const parsed = parseArgvArray(code.slice(open, close + 1));
  return parsed.kind === 'literal' ? parsed.tokens : null;
}

// [braceStart, braceEnd] of `function <name>(…) { … }`, or null. Used to
// scope-anchor a forwarding exemption to the wrapper's own body.
function functionBodySpan(code, name) {
  if (!name) return null;
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
  if (!m) return null;
  const paramOpen = code.indexOf('(', m.index);
  const paramClose = matchDelimiter(code, paramOpen);
  if (paramClose === -1) return null;
  const braceIdx = code.indexOf('{', paramClose);
  if (braceIdx === -1) return null;
  const braceClose = matchDelimiter(code, braceIdx);
  if (braceClose === -1) return null;
  return [braceIdx, braceClose];
}

function withinSpan(idx, span) {
  return Boolean(span) && idx >= span[0] && idx <= span[1];
}

function resolveCommand(cmdArg, { commandVars, passthroughParams, projections, registry }) {
  const norm = normalizeElement(cmdArg);
  if (norm !== null) {
    if (registry.ALLOWED_COMMAND_LITERALS.includes(norm)) return { command: norm };
    return { violation: `command literal not allowlisted` };
  }
  if (cmdArg === registry.NODE_COMMAND_SENTINEL) return { command: null }; // Node — skip argv verb check
  // Member-expression projection (settings `plan.argv.command`): the command is a
  // {claude,codex} value from a validated commandSpec → HOST_UNION, NOT null, so an
  // INLINE literal argv at the projection site is still verb-checked (Codex
  // re-review: `runner(plan.argv.command, ['plugin','remove',name])` must fail).
  // The real `plan.argv.args` is a member expr (not-array) → skipped as before.
  if (projections.some((p) => p.commandExpr === cmdArg)) return { command: HOST_UNION };
  // bare identifier?
  if (/^[\w$]+$/.test(cmdArg)) {
    if (commandVars.has(cmdArg)) return { command: HOST_UNION }; // {claude,codex} probe variable
    if (passthroughParams.has(cmdArg)) return { command: null }; // passthrough param inside an exec wrapper
    return { violation: `bare identifier command is not a registered command-variable` };
  }
  return { violation: `non-literal command expression` };
}

// For a wrapper that hardcodes its command, locate the argv argument text.
function wrapperArgvArg(name, args) {
  if (name === 'runGit') {
    // runGit({ ..., args: [...] }) — extract the args: property value
    const objText = args[0] || '';
    return extractObjectProp(objText, 'args');
  }
  if (name === 'execGit') {
    // execGit(repoRoot, [...]) — second positional
    return args[1] !== undefined ? args[1] : null;
  }
  return null;
}

function extractObjectProp(objText, prop) {
  const t = objText.trim();
  if (!t.startsWith('{')) return null;
  const close = matchDelimiter(t, 0);
  if (close === -1) return null;
  const inner = t.slice(1, close);
  for (const part of splitTopLevel(inner)) {
    const m = part.match(/^([\w$]+|'[^']*'|"[^"]*")\s*:\s*([\s\S]+)$/);
    if (m) {
      const key = m[1].replace(/['"]/g, '');
      if (key === prop) return m[2].trim();
    }
    // shorthand { args } — value is the identifier itself (dynamic)
    if (part.trim() === prop) return prop;
  }
  return null;
}

// Extract host-CLI argv passed as inline object properties at a probe call site,
// e.g. inspectCli('codex', { versionArgs: ['--version'], authArgs: ['login','status'], … }).
// Command = the positional command literal; argv = every array-literal property
// of the options object. (Validates the doctor probe surface that would otherwise
// be invisible — a tampered `authArgs: ['login']` must be caught.)
function extractProbeArgv(code, fileName, registry) {
  const out = [];
  const specs = registry.PROBE_CONFIGS[fileName] || [];
  for (const spec of specs) {
    for (const call of findBareCalls(code, [spec.callee])) {
      const args = splitTopLevel(call.inner);
      const command = normalizeElement((args[spec.commandArgIndex] || '').trim());
      if (!command || !registry.ALLOWED_COMMAND_LITERALS.includes(command)) continue;
      const objText = (args[spec.optionsArgIndex] || '').trim();
      if (!objText.startsWith('{')) continue;
      const oClose = matchDelimiter(objText, 0);
      if (oClose === -1) continue;
      for (const prop of splitTopLevel(objText.slice(1, oClose))) {
        const pm = prop.match(/^([\w$]+|'[^']*'|"[^"]*")\s*:\s*([\s\S]+)$/);
        if (!pm) continue;
        const parsed = parseArgvArray(pm[2].trim());
        if (parsed.kind === 'literal') {
          out.push({
            command,
            tokens: parsed.tokens,
            evidence: `${spec.callee}('${command}', { ${pm[1].replace(/['"]/g, '')}: … })`,
          });
        }
      }
    }
  }
  return out;
}

function findShellViolations(code) {
  const out = [];
  // shell property with a truthy value: { shell: true }, 'shell': true,
  // .shell = true, { shell: '/bin/sh' }. Excludes shell: false.
  const shellProp = /(?<![\w$])(['"]?)shell\1\s*[:=]\s*(true|'[^']+'|"[^"]+"|`[^`]+`)/g;
  let m;
  while ((m = shellProp.exec(code))) {
    out.push(`shell option set truthy: ${truncate(m[0])}`);
  }
  // computed shell key: { ['shell']: true }, opts['shell'] = true (Codex review MINOR #7)
  const computedShell = /\[\s*(['"])shell\1\s*\]\s*[:=]\s*(true|'[^']+'|"[^"]+"|`[^`]+`)/g;
  let cm;
  while ((cm = computedShell.exec(code))) {
    out.push(`computed shell option set truthy: ${truncate(cm[0])}`);
  }
  // shell binary + -c inside an argv array
  if (/['"](?:\/bin\/)?(?:sh|bash|zsh|dash|ksh)['"]\s*,\s*['"]-c['"]/.test(code)) {
    out.push('shell binary invoked with -c');
  }
  if (/\bsh\s+-c\b|\bbash\s+-c\b/.test(code)) {
    out.push('sh -c / bash -c invocation');
  }
  return out;
}

function truncate(s, n = 80) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------------------
// Aggregate audit
// ---------------------------------------------------------------------------

export function auditScripts({ files, registry }) {
  const violations = [];
  for (const f of files) {
    const r = scanFile({ fileName: f.fileName, source: f.source, registry });
    violations.push(...r.violations);
  }
  return { violations, scannedCount: files.length };
}
