// Mutation spec — do the image plugin's exit-after-flush tests catch the
// defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/image-exit-flush.mjs
//
// C93: each image CLI printed its result and called process.exit at once, so
// a pipe got only the first 64 KiB (critique-dispatch's result carries Codex's
// whole assessment). Each CLI now returns its code to one exitAfterFlush at its
// entry tail, and every refusal returns before any later work.
//
// Groups: T the exit restored at each CLI's tail (the defect itself, at the
// CLI under test; the fixture companion is never mutated); R a refusal that
// falls through; H the helper's own behaviour.

const T_FLUSH = 'tests/image/test-exit-flush.mjs';

export const TESTS = [T_FLUSH];

const HELPER = 'plugins/image/scripts/exit-after-flush.mjs';
const BRIEF = 'plugins/image/scripts/brief-validate.mjs';
const COMPOSE = 'plugins/image/scripts/compose-dispatch.mjs';
const CRITIQUE = 'plugins/image/scripts/critique-dispatch.mjs';
const REFINE = 'plugins/image/scripts/refine-dispatch.mjs';
const VARIANT = 'plugins/image/scripts/variant-select.mjs';

const TAIL = '  runCli().then((code) => exitAfterFlush(code), (err) => {\n';
const EXIT_AT_ONCE = '  runCli().then((code) => process.exit(code), (err) => {\n';
const stderrWhole = (name) => new RegExp(`${name.replace('.', '\\.')}: the whole diagnostic arrives, exit 2`);

export const MUTATIONS = [
  // ── T: the exit restored at a CLI's tail ─────────────────────────────────
  {
    id: 'T1', killed_by: /critique-dispatch — a result past 64 KiB reaches a pipe whole/,
    file: CRITIQUE, from: TAIL, to: EXIT_AT_ONCE,
    why: 'critique exits at once again, so its assessment past 64 KiB is cut on a pipe',
  },
  {
    id: 'T2', killed_by: stderrWhole('brief-validate.mjs'),
    file: BRIEF, from: TAIL, to: EXIT_AT_ONCE,
    why: 'brief-validate exits at once again, so its output past 64 KiB is cut on a pipe',
  },
  {
    id: 'T3', killed_by: stderrWhole('compose-dispatch.mjs'),
    file: COMPOSE, from: TAIL, to: EXIT_AT_ONCE,
    why: 'compose-dispatch exits at once again, so its output past 64 KiB is cut on a pipe',
  },
  {
    id: 'T4', killed_by: stderrWhole('refine-dispatch.mjs'),
    file: REFINE, from: TAIL, to: EXIT_AT_ONCE,
    why: 'refine-dispatch exits at once again, so its output past 64 KiB is cut on a pipe',
  },
  {
    id: 'T5', killed_by: stderrWhole('variant-select.mjs'),
    file: VARIANT, from: TAIL, to: EXIT_AT_ONCE,
    why: 'variant-select exits at once again, so its output past 64 KiB is cut on a pipe',
  },

  // ── R: a refusal that falls through ──────────────────────────────────────
  {
    id: 'R1', killed_by: /variant-select: a malformed --select exits 2/,
    file: VARIANT,
    from: "{ console.error('variant-select: --select must be a non-negative integer'); return 2; }",
    to: "{ console.error('variant-select: --select must be a non-negative integer'); }",
    why: 'a malformed --select goes on to the selection (the mechanical exit swap)',
  },
  {
    id: 'R2', killed_by: /variant-select: an out-of-range --select exits 1 before it prunes or rewrites/,
    file: VARIANT,
    from: 'catch (err) { console.error(`variant-select: ${err.message}`); return 1; }',
    to: 'catch (err) { console.error(`variant-select: ${err.message}`); }',
    why: 'a failed selection goes on to prune the rejected variant and rewrite the manifest',
  },
  {
    id: 'R3', killed_by: /refine-dispatch: --estimate-only reads no prompt file/,
    file: REFINE,
    from: 'estimate_only: true, cost: estimateCost({ quality: v.quality }) }, null, 2));\n    return 0;\n',
    to: 'estimate_only: true, cost: estimateCost({ quality: v.quality }) }, null, 2));\n',
    why: 'the estimate goes on to read the prompt files and generate',
  },
  {
    id: 'R4', killed_by: /refine-dispatch: an unreadable --base-prompt-file exits 2/,
    file: REFINE,
    from: "basePrompt = readFileSync(v['base-prompt-file'], 'utf8'); } catch (e) { console.error(`refine-dispatch: ${e.message}`); return 2; }",
    to: "basePrompt = readFileSync(v['base-prompt-file'], 'utf8'); } catch (e) { console.error(`refine-dispatch: ${e.message}`); }",
    why: 'an unreadable base prompt file falls back to the inline prompt and generates',
  },
  {
    id: 'R5', killed_by: /refine-dispatch: an unreadable --feedback-file exits 2/,
    file: REFINE,
    from: "feedback = readFileSync(v['feedback-file'], 'utf8'); } catch (e) { console.error(`refine-dispatch: ${e.message}`); return 2; }",
    to: "feedback = readFileSync(v['feedback-file'], 'utf8'); } catch (e) { console.error(`refine-dispatch: ${e.message}`); }",
    why: 'an unreadable feedback file falls back to the inline feedback and generates',
  },
  {
    id: 'R6', killed_by: /compose-dispatch: an unreadable --prompt-file exits 2/,
    file: COMPOSE,
    from: '    console.error(`compose-dispatch: cannot read --prompt-file: ${err.message}`);\n      return 2;\n',
    to: '    console.error(`compose-dispatch: cannot read --prompt-file: ${err.message}`);\n',
    why: 'an unreadable prompt file falls back to the inline prompt and generates',
  },
  {
    id: 'R7', killed_by: /compose-dispatch: --format gif exits 2/,
    file: COMPOSE,
    from: "    console.error(`compose-dispatch: --format must be one of ${FORMATS.join('|')}`);\n    return 2;\n",
    to: "    console.error(`compose-dispatch: --format must be one of ${FORMATS.join('|')}`);\n",
    why: 'a refused format goes on to dispatch',
  },
  {
    id: 'R8', killed_by: /critique-dispatch: an unreadable --criteria-file exits 2/,
    file: CRITIQUE,
    from: 'console.error(`critique-dispatch: cannot read --criteria-file: ${err.message}`); return 2; }',
    to: 'console.error(`critique-dispatch: cannot read --criteria-file: ${err.message}`); }',
    why: 'an unreadable criteria file goes on to a critique with no criteria',
  },
  {
    id: 'R9', killed_by: /critique-dispatch: no --image exits 2/,
    file: CRITIQUE,
    from: "{ console.error('critique-dispatch: --image <path> is required'); return 2; }",
    to: "{ console.error('critique-dispatch: --image <path> is required'); }",
    why: 'a missing --image goes on to the critique',
  },
  {
    id: 'R10', killed_by: /brief-validate: no --brief-file exits 2/,
    file: BRIEF,
    from: "{ console.error('brief-validate: --brief-file <path> is required'); return 2; }",
    to: "{ console.error('brief-validate: --brief-file <path> is required'); }",
    why: 'a missing --brief-file goes on to read a file it was never given',
  },
  {
    id: 'R11', killed_by: /compose-dispatch: an unexpected rejection prints one line and exits 1/,
    file: COMPOSE,
    from: '    process.stderr.write(`compose-dispatch: ${err?.message ?? err}\\n`);\n    exitAfterFlush(1);\n',
    to: '    exitAfterFlush(1);\n',
    why: 'an unexpected rejection exits 1 without saying why',
  },
  {
    id: 'R12', killed_by: /refine-dispatch: --iteration x exits 2/,
    file: REFINE,
    from: "{ console.error('refine-dispatch: --iteration must be a non-negative integer'); return 2; }",
    to: "{ console.error('refine-dispatch: --iteration must be a non-negative integer'); }",
    why: 'a malformed --iteration goes on to generate',
  },
  {
    id: 'R13', killed_by: /refine-dispatch: --max-iterations x exits 2/,
    file: REFINE,
    from: "{ console.error('refine-dispatch: --max-iterations must be a non-negative integer'); return 2; }",
    to: "{ console.error('refine-dispatch: --max-iterations must be a non-negative integer'); }",
    why: 'a malformed --max-iterations goes on to generate under the default cap',
  },
  {
    id: 'R14', killed_by: /brief-validate: exits 0 for a valid brief and 1 for one with issues/,
    file: BRIEF,
    from: '  return result.valid ? 0 : 1;\n',
    to: '  return 0;\n',
    why: 'a brief with issues exits 0',
  },
  {
    id: 'R15', killed_by: /refine-dispatch: an unexpected rejection prints one line and exits 1/,
    file: REFINE,
    from: '    process.stderr.write(`refine-dispatch: ${err?.message ?? err}\\n`);\n    exitAfterFlush(1);\n',
    to: '    exitAfterFlush(1);\n',
    why: 'an unexpected rejection exits 1 without saying why',
  },
  {
    id: 'R16', killed_by: /critique-dispatch: an unexpected rejection prints one line and exits 1/,
    file: CRITIQUE,
    from: '    process.stderr.write(`critique-dispatch: ${err?.message ?? err}\\n`);\n    exitAfterFlush(1);\n',
    to: '    exitAfterFlush(1);\n',
    why: 'an unexpected rejection exits 1 without saying why',
  },
  {
    id: 'R17', killed_by: /variant-select: an unexpected rejection prints one line and exits 1/,
    file: VARIANT,
    from: '    process.stderr.write(`variant-select: ${err?.message ?? err}\\n`);\n    exitAfterFlush(1);\n',
    to: '    exitAfterFlush(1);\n',
    why: 'an unexpected rejection exits 1 without saying why',
  },

  // ── H: the helper ────────────────────────────────────────────────────────
  {
    id: 'H1', killed_by: /a reader that never drains: exits with the code by the fallback/,
    file: HELPER, from: '  setTimeout(exit, fallbackMs);\n', to: '',
    why: 'no fallback: a reader that never drains hangs the process',
  },
  {
    id: 'H2', killed_by: /a reader of stdout that went away/,
    file: HELPER,
    from: "    stream.once('error', exit);\n",
    to: "    if (stream !== process.stdout) stream.once('error', exit);\n",
    why: 'no error listener on stdout: a reader that went away is an uncaught error',
  },
  {
    id: 'H3', killed_by: /a second call while flushing is ignored/,
    file: HELPER, from: '  if (started) return;\n', to: '',
    why: 'a second call arms its own fallback and exits with its own code',
  },
  {
    id: 'H4', killed_by: /stdout and stderr past 64 KiB both arrive whole/,
    file: HELPER,
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '  setTimeout(exit, fallbackMs);\n  exit();\n',
    why: 'the helper exits at once instead of waiting for the flush',
  },
  {
    id: 'H5', killed_by: /stderr held behind stdout still arrives whole/,
    file: HELPER, from: '  let pending = 2;\n', to: '  let pending = 1;\n',
    why: 'the helper exits once one stream has flushed, so stderr held behind stdout is cut',
  },
  {
    id: 'H6', killed_by: /a write that throws exits with the code/,
    file: HELPER,
    from: "    try {\n      stream.write('', settle);\n    } catch {\n      exit();\n      return;\n    }\n",
    to: "    stream.write('', settle);\n",
    why: 'a write that throws escapes as an uncaught error, exit 1',
  },
  {
    id: 'H7', killed_by: /a reader of stderr that went away/,
    file: HELPER,
    from: "    stream.once('error', exit);\n",
    to: "    if (stream !== process.stderr) stream.once('error', exit);\n",
    why: 'no error listener on stderr: a reader that went away is an uncaught error',
  },
  {
    id: 'H8', killed_by: /the default fallback is EXIT_FLUSH_FALLBACK_MS, 10 s/,
    file: HELPER,
    from: 'fallbackMs = EXIT_FLUSH_FALLBACK_MS)',
    to: 'fallbackMs = 1000)',
    why: 'the default fallback is not the contracted 10 s',
  },
  {
    id: 'H9', killed_by: /the fallback timer is ref'd/,
    file: HELPER,
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '  setTimeout(exit, fallbackMs).unref();\n',
    why: 'an unref\'d fallback lets a process whose write never calls back end at once with code 0',
  },
];
