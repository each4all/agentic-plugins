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

// Sentinel: a command that is a registered command-variable (doctor `name`,
// compat `host`) — known to range over the host CLIs {claude, codex}. Literal
// argv at such a call is validated against the UNION of host-CLI allowlists.
const HOST_UNION = '*host-cli*';

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

// Find member calls `obj.method(` (e.g. a namespace import `cp.spawn(` or
// `doctor.runCommand(`). Returns [{ openParen, inner }].
export function findMemberCalls(code, obj, method) {
  const results = [];
  const re = new RegExp(`(?<![.\\w$])${obj}\\s*\\.\\s*${method}\\s*\\(`, 'g');
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
// a token scanner cannot follow arbitrary nesting; the SOUND check is §2b.
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

// FAIL-CLOSED analysis of `fetch` use (ADR-0041 §2d). `fetch` is a global with
// no import to anchor on and JS offers unbounded indirection, so this flags
// EVERY reference to fetch and permits ONLY a direct `fetch(` call (which the
// gate then validates against the pinned spec). Returns:
//   directCalls: [{inner}] — bare `fetch(` calls (the only permitted form);
//   indirect: bool         — ANY other fetch reference (a bare `fetch` used as a
//                            value, a member `.fetch`, computed `['fetch']`,
//                            `Reflect.get(...,'fetch')`, or a local shadow
//                            `const/let/var/function fetch`);
//   anyUse: bool           — directCalls.length > 0 || indirect.
// Residual (documented, out of scope for a token scanner): string-concatenated
// obfuscation like `globalThis['fet'+'ch']`. The SOUND behavioral check is the
// channel slice's fetchImpl-injection unit test (ADR-0041 §2b).
export function analyzeFetchUse(code) {
  const codeNoStr = blankStrings(code);
  // Count REAL bare `fetch(` calls on the BLANKED code so a `fetch(` written
  // inside a string literal is never mistaken for a call (nor lets a decoy
  // string cancel a real reference in the arithmetic below — Codex re-review
  // CRITICAL). blankStrings preserves length, so a call's open-paren index is
  // identical in `code` and `codeNoStr`; the real inner (with real string
  // values) is re-extracted from the UNBLANKED `code` for validation.
  const blankedCalls = findBareCalls(codeNoStr, ['fetch']);
  const directCalls = blankedCalls.map((c) => {
    const close = matchDelimiter(code, c.openParen);
    return { inner: close === -1 ? '' : code.slice(c.openParen + 1, close) };
  });
  // A bare `fetch` identifier count above the direct-call count means fetch is
  // referenced as a value (alias / `.call` receiver / argument / return /
  // destructure target).
  const bareTokens = (codeNoStr.match(/(?<![.\w$])fetch\b/g) || []).length;
  const bareNonCall = Math.max(0, bareTokens - blankedCalls.length);
  const memberFetch = /\.\s*fetch\b/.test(codeNoStr);   // x.fetch / globalThis.fetch / o.fetch
  // A name-based reference to the global fetch via a string key: computed member
  // access `['fetch']`, or a 'fetch' string passed as the LAST argument of a call
  // — the reflective shape `Reflect.get(obj, 'fetch')`,
  // `Object.getOwnPropertyDescriptor(obj, 'fetch')`, `Reflect['get'](obj,'fetch')`
  // (`, 'fetch')` regardless of the object or padding). Keyed on `, 'fetch')` (not
  // proximity to a global-object token — Codex round-3 evaded a fixed window with
  // padding) and NOT on any 'fetch' string, so a legitimate DATA string (a git
  // subcommand 'fetch' in an allowlist array — `, 'fetch',` / `, 'fetch']`) is not
  // over-flagged. Residual (documented): deeper indirection (a helper returning
  // the global, string-concat obfuscation) is out of scope for a token scanner —
  // the SOUND check is the channel slice's fetchImpl test (§2b).
  const computedFetch = /\[\s*(['"`])fetch\1\s*\]/.test(code);
  const reflectiveFetch = /,\s*(['"`])fetch\1\s*\)/.test(code);
  const shadowFetch = /\b(?:const|let|var|function\s*\*?)\s+fetch\b/.test(codeNoStr);
  const indirect = bareNonCall > 0 || memberFetch || computedFetch || reflectiveFetch || shadowFetch;
  return { directCalls, indirect, anyUse: directCalls.length > 0 || indirect };
}

// Validate ONE direct pinned `fetch(url, init)` call. Returns a violation detail
// string, or null when conformant. Precise (not text-substring): exactly two
// args; the URL a LONE literal (no `&&`/`||`/ternary/concatenation — so the
// value equals the text) matching endpointPrefix..endpointSuffix; the init an
// inline object whose TOP-LEVEL method/redirect/timeout properties are the pinned
// literals (a token buried in a nested string is not a property, so it fails).
export function validatePinnedFetch(inner, spec) {
  const args = splitTopLevel(inner);
  if (args.length !== 2) {
    return `pinned fetch must take exactly (url, init) — got ${args.length} arg(s)`;
  }
  const urlText = (args[0] || '').trim();
  const q = urlText[0];
  if (q !== "'" && q !== '"' && q !== '`') {
    return 'pinned fetch URL must be a lone string/template literal (got a non-literal expression)';
  }
  const litEnd = skipString(urlText, 0); // index just past the closing quote/backtick
  if (urlText.slice(litEnd).trim() !== '') {
    return `pinned fetch URL must be a lone literal — no operator/concatenation after it (${truncate(urlText)})`;
  }
  const litBody = urlText.slice(1, litEnd - 1);
  if (!litBody.startsWith(spec.endpointPrefix)) {
    return `pinned fetch URL must begin with ${spec.endpointPrefix} (host+path pinned)`;
  }
  if (spec.endpointSuffix && !litBody.endsWith(spec.endpointSuffix)) {
    return `pinned fetch URL must end with ${spec.endpointSuffix} (endpoint pinned)`;
  }
  const opts = (args[1] || '').trim();
  if (opts[0] !== '{') {
    return `pinned fetch init must be an inline object literal { … } (${truncate(opts)})`;
  }
  const oClose = matchDelimiter(opts, 0);
  if (oClose === -1) return 'pinned fetch init object is unterminated';
  // Parse the TOP-LEVEL properties ourselves (not first-match extractObjectProp)
  // so a later duplicate key, a spread, or a computed key that would OVERRIDE the
  // pinned method/redirect/signal at runtime is rejected (Codex re-review
  // CRITICAL). A token buried in a nested string is not a top-level property, so
  // it never satisfies a pinned key.
  const PINNED_KEYS = new Set(['method', 'redirect', 'signal', 'timeout']);
  const seen = {};
  for (const prop of splitTopLevel(opts.slice(1, oClose))) {
    const t = prop.trim();
    if (t === '') continue;
    if (t.startsWith('...')) {
      return 'pinned fetch init must not use spread (…) — it can override the pinned method/redirect/timeout';
    }
    if (t.startsWith('[')) {
      return 'pinned fetch init must not use a computed key — it can inject a pinned property dynamically';
    }
    const m = t.match(/^([\w$]+|'[^']*'|"[^"]*")\s*:\s*([\s\S]+)$/);
    if (!m) {
      const short = t.match(/^([\w$]+)$/);
      if (short) {
        // plain shorthand: reject a pinned key (value hidden); ignore others
        // (e.g. `body`).
        if (PINNED_KEYS.has(short[1])) {
          return `pinned fetch init '${short[1]}' must be an explicit key: value (no shorthand)`;
        }
        continue;
      }
      // getter/setter/method-shorthand/other non-`key: value` form — a getter or
      // method named like a pinned key overrides it at runtime while a static
      // scan reads only the earlier literal (Codex round-3 HIGH). Fail closed.
      return `pinned fetch init has a non-literal property (${truncate(t)}) — getters/setters/methods/computed keys can override the pinned request`;
    }
    const key = m[1].replace(/['"]/g, '');
    if (PINNED_KEYS.has(key)) {
      if (seen[key] !== undefined) return `pinned fetch init has a duplicate '${key}' key — cannot statically pin`;
      seen[key] = m[2].trim();
    }
  }
  if (spec.method && normalizeElement(seen.method || '') !== spec.method) {
    return `pinned fetch init.method must be the literal '${spec.method}'`;
  }
  if (spec.redirect && normalizeElement(seen.redirect || '') !== spec.redirect) {
    return `pinned fetch init.redirect must be the literal '${spec.redirect}'`;
  }
  if (spec.requireTimeout) {
    // Node's global fetch has NO `timeout` option — only an AbortSignal bounds
    // the request. Require signal to be EXACTLY AbortSignal.timeout(<arg>) with
    // no surrounding operator that could resolve to an unbounded signal (Codex
    // re-review MAJOR: `signal: never || AbortSignal.timeout(5)` and a bare
    // `timeout:` both slipped the substring check).
    const sig = (seen.signal || '').trim();
    if (!/^AbortSignal\s*\.\s*timeout\s*\([^)]*\)$/.test(sig)) {
      return 'pinned fetch init.signal must be exactly AbortSignal.timeout(<ms>) (Node fetch ignores a `timeout` option; an operator-guarded signal is not bounded)';
    }
  }
  return null;
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
  const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*(?:,\s*\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;
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
    if (!isImporter || !importerSpec.modules.includes(canonicalModule(imp.module))) {
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
  // used (compat allows GET only). A non-`get` network primitive is flagged when
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

  // --- Global-fetch-gate (non-import-anchored, ADR-0041 §2d) ----------------
  // FAIL-CLOSED: `fetch` is a global with no import to anchor on and JS offers
  // unbounded indirection, so this flags EVERY fetch reference and permits ONLY a
  // direct pinned `fetch(url, init)` call in a GLOBAL_FETCH_USERS file. A fetch
  // reference in a non-registered file, or any indirect/member/computed/aliased/
  // `.call`/shadowed fetch anywhere, is a violation. The ADR-0041 §11 keystone
  // that must land before any fetch use. The SOUND behavioral check of the pinned
  // request is the channel slice's fetchImpl unit test (ADR-0041 §2b); this gate
  // is the fail-closed CI tripwire + defense-in-depth (see registry header).
  {
    const fetchUse = analyzeFetchUse(code);
    if (fetchUse.anyUse) {
      const spec = (registry.GLOBAL_FETCH_USERS || {})[fileName];
      if (!spec) {
        violations.push({
          rule: 'global-fetch-gate', file: fileName,
          detail: 'global fetch referenced in a file not registered as a GLOBAL_FETCH_USERS entry (ADR-0041 §2d)',
        });
      } else {
        if (fetchUse.indirect) {
          violations.push({
            rule: 'global-fetch-gate', file: fileName,
            detail: 'only a DIRECT pinned fetch(url, init) call is allowed — no member/computed/aliased/.call/shadowed fetch reference (it would evade static pinned-request validation)',
          });
        }
        // Cap the number of direct calls (Codex re-review MAJOR): a second
        // pinned-shape send could egress to a different token/recipient.
        const maxCalls = spec.maxCalls ?? 1;
        if (fetchUse.directCalls.length > maxCalls) {
          violations.push({
            rule: 'global-fetch-gate', file: fileName,
            detail: `at most ${maxCalls} direct pinned fetch call permitted (found ${fetchUse.directCalls.length}) — a second call could egress to a different token/recipient`,
          });
        }
        for (const call of fetchUse.directCalls) {
          const v = validatePinnedFetch(call.inner, spec);
          if (v) violations.push({ rule: 'global-fetch-gate', file: fileName, detail: v });
        }
      }
    }
  }

  // --- Kill-gate -------------------------------------------------------------
  // Only the exact registered own-child timeout kill is allowed:
  // child.kill('SIGTERM') in a kill-site file. process.kill / SIGKILL / any other
  // receiver or signal fails — even inside doctor.mjs (Codex review MAJOR #3).
  if (/\bprocess\.kill\s*\(/.test(code)) {
    violations.push({ rule: 'kill-gate', file: fileName, detail: 'process.kill(...) is forbidden (external-process kill)' });
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

  return { violations };
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
