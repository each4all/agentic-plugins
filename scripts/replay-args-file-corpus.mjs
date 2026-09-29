#!/usr/bin/env node
// Replay this checkout's recorded workflow topics through the ADR-0059 args
// file, and refresh the shape fixture the suite replays.
//
//   node scripts/replay-args-file-corpus.mjs [--write-shapes]
//
// ADR-0059 measured the unquoted runbook splice against the original_request
// values recorded in this repository's workflow state, and asks that the
// same topics be replayed through the args file. That state lives under
// .agentic-plugins/state/, which is gitignored and local to the machine that
// did the work, so the suite cannot read it; the topics also carry local
// paths and host names that do not belong in a public repository. This
// script runs where the state is:
//
//   1. it reads every workflow file of engineer, designer, founder and
//      orchestrator (active and archived) with the owning plugin's own
//      frontmatter parser, and collects each distinct original_request;
//   2. it writes each topic into a real args file outside the repository,
//      reads it back through each package's copy of lib/args-file.mjs, and
//      checks the text is unchanged;
//   3. it runs every topic through tests/_args-file-replay.mjs, the same
//      invariants the suite checks, including each persona's decide parser.
//
// With --write-shapes it then writes tests/fixtures/args-file-topic-shapes.json:
// every topic with its letters and digits replaced by a placeholder of the
// same class, and every whitespace, quote, backslash, operator and flag name
// kept. The suite replays that fixture, so the corpus's shapes — which is
// what a grammar reads — are checked on every run without publishing what the
// topics say.
//
// Exit 0 when every topic passes, 1 when any fails, 2 on a usage error.

import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { replayTopic } from '../tests/_args-file-replay.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'args-file-topic-shapes.json');
const WORKFLOW_PLUGINS = ['engineer', 'designer', 'founder', 'orchestrator'];
const LIB_PACKAGES = ['runtime', 'engineer', 'designer', 'founder'];
const PERSONAS = ['engineer', 'designer', 'founder'];

function markdownFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return acc;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, acc);
    else if (entry.endsWith('.md')) acc.push(path);
  }
  return acc;
}

async function collectTopics() {
  const topics = new Set();
  let files = 0;
  let unreadable = 0;
  for (const plugin of WORKFLOW_PLUGINS) {
    const { parseWorkflowFile } = await import(join(REPO_ROOT, 'plugins', plugin, 'scripts', 'state.mjs'));
    for (const path of markdownFiles(join(REPO_ROOT, '.agentic-plugins', 'state', plugin))) {
      let parsed;
      try {
        parsed = parseWorkflowFile(readFileSync(path, 'utf8'));
      } catch {
        unreadable += 1; // notes kept beside the workflows are not workflow files
        continue;
      }
      const topic = parsed?.frontmatter?.original_request;
      if (typeof topic !== 'string') continue;
      files += 1;
      topics.add(topic);
    }
  }
  return { topics: [...topics], files, unreadable };
}

// Letters and digits carry the content; everything a grammar reads is kept.
// A word that starts with `--` keeps its option name (up to any `=`), since
// `--base-branch` in a topic changes what the start grammar does with it.
const HANGUL = /\p{Script=Hangul}/u;
const LETTER = /\p{L}/u;
export function shapeOf(topic) {
  return topic.replace(/[^ \t\r\n]+/g, (word) => {
    const option = word.match(/^--[A-Za-z][A-Za-z0-9-]*/);
    const kept = option ? option[0] : '';
    return kept + [...word.slice(kept.length)].map((c) => {
      if (/[a-z]/.test(c)) return 'a';
      if (/[A-Z]/.test(c)) return 'A';
      if (/[0-9]/.test(c)) return '0';
      if (HANGUL.test(c)) return '가';
      if (LETTER.test(c)) return 'é';
      return c;
    }).join('');
  });
}

async function main(argv) {
  const write = argv.includes('--write-shapes');
  if (argv.some((a) => a !== '--write-shapes')) {
    process.stderr.write('usage: node scripts/replay-args-file-corpus.mjs [--write-shapes]\n');
    return 2;
  }
  const { topics, files, unreadable } = await collectTopics();
  if (topics.length === 0) {
    process.stderr.write('no recorded topics under .agentic-plugins/state — nothing to replay on this machine\n');
    return 1;
  }
  const libs = {};
  for (const pkg of LIB_PACKAGES) libs[pkg] = await import(join(REPO_ROOT, 'plugins', pkg, 'scripts', 'lib', 'args-file.mjs'));
  const parsers = {};
  for (const persona of PERSONAS) {
    parsers[persona] = (await import(join(REPO_ROOT, 'plugins', persona, 'scripts', 'lib', 'decide-args.mjs'))).parseArgs;
  }

  const failures = [];
  const scratch = mkdtempSync(join(tmpdir(), 'args-file-replay-'));
  try {
    topics.forEach((topic, i) => {
      const file = join(scratch, `${i}.json`);
      writeFileSync(file, libs.runtime.encodeArgsFile(topic));
      for (const [pkg, lib] of Object.entries(libs)) {
        if (lib.readArgsFile(file) !== topic) failures.push(`topic ${i}: ${pkg} readArgsFile changed the text`);
        for (const f of replayTopic(topic, lib, pkg === 'runtime' ? parsers : {})) failures.push(`topic ${i} (${pkg}): ${f}`);
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const shapes = [...new Set(topics.map(shapeOf))].sort();
  process.stdout.write(`${files} workflow files, ${topics.length} distinct topics (${unreadable} unreadable notes skipped)\n`);
  process.stdout.write(`${failures.length === 0 ? 'every topic passed' : `${failures.length} failures`} across ${LIB_PACKAGES.length} library copies and ${PERSONAS.length} persona parsers\n`);
  for (const f of failures.slice(0, 40)) process.stdout.write(`  ${f}\n`);
  if (write) {
    writeFileSync(FIXTURE, `${JSON.stringify({
      about: 'ADR-0059 replay corpus: recorded original_request topics with letters and digits replaced by class placeholders (scripts/replay-args-file-corpus.mjs --write-shapes)',
      topics: topics.length,
      shapes,
    }, null, 1)}\n`);
    process.stdout.write(`wrote ${shapes.length} distinct shapes to ${FIXTURE}\n`);
  }
  return failures.length === 0 ? 0 : 1;
}

// Compared canonically, so a checkout under a symlink or a path that needs URL
// escaping still runs (the engineer state.mjs guard).
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  (async () => { process.exitCode = await main(process.argv.slice(2)); })();
}
