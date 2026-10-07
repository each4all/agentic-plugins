// plugins/engineer/commands/start.md and core/skills/start/SKILL.md — what
// engineer authors around the generated start regions: the command's
// frontmatter, the in-place verb rule, the Codex Phase 7 call order, and every
// route the start surfaces name (each must be a command the plugin ships, a
// runtime:worktree subcommand the CLI accepts, or a --size= value decide accepts).
//
// Phase 0's blocks, the phase-boundary rules and Phase 7 are generated (the
// start-* regions): tests/persona-pipeline/test-runbook-contracts.mjs runs
// them for every persona, and test-skill-contracts.mjs holds the skill's
// generated "When invoked by command" intro.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ENGINEER_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
const COMMAND_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/commands/start.md',
);
const SKILL_PATH = resolve(
  REPO_ROOT,
  skillsPath(ENGINEER_ROOT, 'start/SKILL.md'),
);
const ROUTING_CONTRACT_PATH = resolve(
  REPO_ROOT,
  skillsPath(ENGINEER_ROOT, '_shared/references/entry-routing-contract.md'),
);
// The argv parser the runtime:worktree CLI runs on its arguments.
const { parseArgs: parseWorktreeArgs } = await import(
  resolve(REPO_ROOT, 'plugins/runtime/scripts/worktree.mjs')
);
// The argv parser decide-registry.mjs runs on /engineer:decide's arguments.
const { parseArgs: parseDecideArgs } = await import(
  resolve(REPO_ROOT, 'plugins/engineer/scripts/lib/decide-args.mjs')
);

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

async function routeSurfaces() {
  return {
    'commands/start.md': await readFile(COMMAND_PATH, 'utf8'),
    'start/SKILL.md': await readFile(SKILL_PATH, 'utf8'),
    'entry-routing-contract.md': await readFile(ROUTING_CONTRACT_PATH, 'utf8'),
  };
}

// Contract: Claude Code loads commands/start.md as /engineer:start and shows
// its frontmatter — a missing file, description or argument-hint drops the
// command or hides its usage.
describe('/engineer:start — file existence + frontmatter', () => {
  it('exists at the canonical path', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(text.length > 0, 'commands/start.md is empty');
  });

  it('frontmatter has non-empty description and argument-hint', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    match(fm, /^description:\s*\S/m);
    match(fm, /^argument-hint:\s*\S/m);
  });

  it('argument-hint mentions the feature description AND --base-branch', async () => {
    // Contract: Claude Code shows argument-hint as the usage — without
    // --base-branch a stacked branch's redundancy probe compares against main.
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    match(fm, /--base-branch/, 'argument-hint must surface --base-branch flag');
  });
});

describe('/engineer:start — Phase 1-7 sequencing (ADR-0020 §Sub-decision 2)', () => {
  it('runs the verbs in place, never as recursive /engineer:<verb> slash commands', async () => {
    // Contract: the agent running the lifecycle — a recursive slash command
    // bootstraps a second workflow on the branch instead of advancing this one.
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/no recursive slash dispatch/.test(text), 'body must forbid recursive /engineer:<verb> dispatch');
  });

  it('the SKILL.md Phase 7 runs phase7-commit.mjs --mode plan before --mode execute (Codex)', async () => {
    // Contract: the Codex agent running Phase 7 — an execute that is not preceded
    // by the plan commits a staging set the user never confirmed.
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(/phase7-commit\.mjs --mode plan[\s\S]*phase7-commit\.mjs --mode execute/.test(text),
      'SKILL.md Phase 7 must run --mode plan, then --mode execute');
  });
});

describe('/engineer:start — entry routing', () => {
  // Contract: the agent or user taking a start route — a route no plugin ships
  // sends them to a command that does not exist.
  // `/plugin:name` is a Claude command (commands/<name>.md), `$plugin:name` a
  // Codex skill (<skills-root>/<name>/SKILL.md). Placeholders (`<verb>`, `*`)
  // name no command and are skipped.
  it('every /plugin:command and $plugin:command route the start surfaces name is one the plugin ships', async () => {
    for (const [where, text] of Object.entries(await routeSurfaces())) {
      const routes = new Set();
      for (const m of text.matchAll(/(?<![\w./-])([/$])(engineer|orchestrator|runtime|founder|designer|companions|image):([a-z][a-z-]*)/g)) {
        const [route, sigil, plugin, name] = m;
        routes.add(route);
        const pluginDir = resolve(REPO_ROOT, 'plugins', plugin);
        const target = sigil === '/'
          ? resolve(pluginDir, 'commands', `${name}.md`)
          : resolve(resolveSkillsRoot(pluginDir), name, 'SKILL.md');
        ok(existsSync(target), `${where} routes to ${route}, which plugins/${plugin} does not ship`);
      }
      ok([...routes].some((r) => r.startsWith('/runtime:')), `${where} names no /runtime: route — the extraction found nothing to check`);
    }
  });

  // Contract: decide's argument parser (parseArgs) — a --size value it rejects
  // stops /engineer:decide at its Phase 0.5 resolve.
  it('every --size= value the start surfaces name is one /engineer:decide accepts', async () => {
    for (const [where, text] of Object.entries(await routeSurfaces())) {
      const sizes = new Set([...text.matchAll(/--size=([a-z]+)\b/g)].map((m) => m[1]));
      ok(sizes.size > 0, `${where} names no --size= value`);
      for (const size of sizes) {
        const parsed = parseDecideArgs([`--size=${size}`]);
        strictEqual(parsed.errors.length, 0, `${where} routes to /engineer:decide --size=${size}, which decide rejects: ${parsed.errors}`);
        strictEqual(parsed.flags.size, size, `${where}: decide did not read --size=${size}`);
      }
    }
  });
});

// The gate's worktree resolution once sent the user to `/runtime:worktree
// apply`, which the CLI rejects ("Command must be one of: plan"). Each route
// is checked against the CLI's own parser, so a subcommand the runtime drops
// or never had fails here.
describe('/engineer:start — runtime:worktree routes name a subcommand the CLI accepts', () => {
  // Every `/runtime:worktree` and `$runtime:worktree` mention in `text`. A
  // subcommand follows a single space, inside the same code span or echo
  // string, and runs to the next backtick or whitespace, so `plan2` is read
  // whole. Only the Codex mention may stand bare (`$runtime:worktree`, where
  // the CLI's default command applies); a slash route without its subcommand,
  // as in "`/runtime:worktree` apply" or "/runtime:worktree  apply", fails
  // instead of being skipped.
  function worktreeRoutes(text) {
    return [...text.matchAll(/([/$])runtime:worktree/g)].map((m) => {
      const rest = text.slice(m.index + m[0].length);
      const subcommand = rest.match(/^ ([^\s`]+)/);
      return {
        raw: m[0] + rest.split('\n')[0].slice(0, 40),
        subcommand: subcommand ? subcommand[1] : null,
        bareCodexMention: m[1] === '$' && rest.startsWith('`'),
      };
    });
  }

  function assertWorktreeRoute(route, where) {
    if (route.subcommand === null) {
      ok(route.bareCodexMention, `${where} names runtime:worktree without a subcommand in the route itself: ${route.raw}`);
      return;
    }
    let parsed;
    try {
      parsed = parseWorktreeArgs([route.subcommand]);
    } catch (err) {
      throw new Error(`${where} routes to \`runtime:worktree ${route.subcommand}\`, which the worktree CLI rejects: ${err.message}`);
    }
    strictEqual(parsed.command, route.subcommand, `${where}: the worktree CLI did not read ${route.subcommand} as its command`);
  }

  it('the Layer 1 gate\'s worktree resolution, in the command and the skill', async () => {
    // Contract: the user following the dirty-tree refusal runs this route — a
    // resolution line that loses it, or names a subcommand the CLI rejects,
    // leaves the refusal with no working way to isolate the change.
    const gates = {
      'commands/start.md': {
        text: await readFile(COMMAND_PATH, 'utf8'),
        line: /^\s*echo "\s*• worktree:.*$/m,
      },
      'start/SKILL.md': {
        text: await readFile(SKILL_PATH, 'utf8'),
        line: /^- \*\*worktree\*\* .*$/m,
      },
    };
    for (const [where, { text, line }] of Object.entries(gates)) {
      const resolution = text.match(line);
      ok(resolution, `${where} has no worktree resolution in the clean-baseline gate`);
      const routes = worktreeRoutes(resolution[0]);
      ok(
        routes.some((route) => route.raw.startsWith('/') && route.subcommand !== null),
        `${where}'s worktree resolution names no /runtime:worktree subcommand: ${resolution[0].trim()}`,
      );
      for (const route of routes) assertWorktreeRoute(route, `${where}'s worktree resolution`);
    }
  });

  it('every runtime:worktree subcommand the start route surfaces name', async () => {
    // Contract: the runtime:worktree CLI's parser — a route naming a subcommand
    // it rejects fails the moment the user runs it.
    for (const [where, text] of Object.entries(await routeSurfaces())) {
      const routes = worktreeRoutes(text);
      ok(routes.some((route) => route.subcommand !== null), `${where} no longer names a runtime:worktree subcommand`);
      for (const route of routes) assertWorktreeRoute(route, where);
    }
  });
});
