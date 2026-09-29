// The invariants one recorded topic must satisfy on its way through the
// ADR-0059 args file.
//
// Shared by tests/plugin-shape/test-args-file-transport.mjs, which replays
// the committed shape fixture, and scripts/replay-args-file-corpus.mjs, which
// replays the live topics on a machine that has them. Not discovered by
// `node --test` (the leading underscore matches none of its patterns).
//
// Every check compares text at the transport/parser boundary — what the codec
// hands back, what a grammar yields, what the persona parser puts in its body
// — never an exit status: the failure ADR-0059 exists for exited zero.

const SEPARATORS = /^[ \t\r\n]*/;
const TRAILING = /[ \t\r\n]+$/;
const FIRST_WORD = /^[^ \t\r\n]*/;

const singleQuoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const doubleQuoted = (text) => `"${text.replace(/["\\$`]/g, '\\$&')}"`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The failures of `topic` against the args-file library `lib` and the
 * persona `decide` parsers in `personaParsers` (`{ name: parseArgs }`).
 * An empty array is a pass.
 */
export function replayTopic(topic, lib, personaParsers = {}) {
  const failures = [];
  const check = (ok, what) => { if (!ok) failures.push(what); };
  const attempt = (fn) => { try { return { value: fn() }; } catch (error) { return { error }; } };

  // 1. The file carries the text back byte for byte.
  const decoded = attempt(() => lib.decodeArgsFile(Buffer.from(lib.encodeArgsFile(topic), 'utf8')));
  check(!decoded.error && decoded.value === topic, 'codec: the text did not come back byte for byte');

  const lead = topic.match(SEPARATORS)[0].length;
  const rest = topic.slice(lead);
  const flagLed = rest.match(FIRST_WORD)[0].startsWith('--');

  // 2. Persona decide: an unflagged text is its own body, leading whitespace
  //    included; after flags, the body follows their separating whitespace.
  if (!flagLed) {
    const bare = attempt(() => lib.splitPersonaArguments(topic));
    check(!bare.error && same(bare.value, { flags: [], body: topic }), 'persona: an unflagged topic is not its own body');
    const flagged = attempt(() => lib.splitPersonaArguments(`--size=minor ${topic}`));
    check(!flagged.error && same(flagged.value, { flags: ['--size=minor'], body: rest }), 'persona: a leading flag changed the body');
  }
  const separated = attempt(() => lib.splitPersonaArguments(`--size=minor -- ${topic}`));
  check(!separated.error && same(separated.value, { flags: ['--size=minor'], body: rest }), 'persona: the body after `--` is not the topic');
  for (const [name, parseArgs] of Object.entries(personaParsers)) {
    const parsed = attempt(() => parseArgs(lib.personaArgv(`--size=minor -- ${topic}`)));
    check(!parsed.error && parsed.value.errors.length === 0 && parsed.value.flags.size === 'minor' && parsed.value.body === rest,
      `persona: ${name} parseArgs did not receive the topic as its body`);
  }

  // 3. engineer:start: without the option the description is the topic; with
  //    it, before or after, only the option and its separating whitespace go.
  const mentionsOption = /(^|[ \t\r\n])--base-branch([ \t\r\n=]|$)/.test(topic);
  if (!mentionsOption) {
    const plain = attempt(() => lib.extractStartArguments(topic));
    if (rest === '') check(Boolean(plain.error), 'start: an empty description was accepted');
    else check(!plain.error && plain.value.feature === rest && plain.value.baseBranch === 'origin/main' && !plain.value.baseBranchExplicit,
      'start: the description is not the topic');
    if (rest !== '') {
      const before = attempt(() => lib.extractStartArguments(`--base-branch origin/dev ${topic}`));
      check(!before.error && before.value.feature === rest && before.value.baseBranch === 'origin/dev',
        'start: a leading --base-branch changed the description');
      const after = attempt(() => lib.extractStartArguments(`${topic} --base-branch origin/dev`));
      const expected = rest.replace(TRAILING, '');
      if (expected !== '') {
        check(!after.error && after.value.feature === expected && after.value.baseBranch === 'origin/dev',
          'start: a trailing --base-branch changed the description');
      }
    }
  }

  // 4. Runtime: the topic as a quoted option value comes back as one word,
  //    in either quoting.
  for (const [label, quoted] of [['single', singleQuoted(topic)], ['double', doubleQuoted(topic)]]) {
    const words = attempt(() => lib.tokenizeRuntimeArguments(`note --text ${quoted}`));
    check(!words.error && same(words.value, ['note', '--text', topic]), `runtime: the ${label}-quoted topic did not come back as one word`);
  }
  return failures;
}
