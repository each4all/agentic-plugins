// Mutation spec — do the image plugin's send-disclosure tests catch the
// defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/image-send-disclosure.mjs
//
// ADR-0037 Decision 5, amended 2026-10-12: on the Claude host, compose, refine
// and critique tell the user that the request goes to Codex (OpenAI). The
// guarantee is held where the send happens: compose-dispatch.mjs (refine
// reuses it) and critique-dispatch.mjs write the disclosure immediately before
// they spawn the companion, and record it in their result. Each surface
// repeats it as the agent's instruction. An earlier test ordered the surface
// text against the dispatch commands in the markdown; three review rounds each
// found another markdown form it misread, and the owner moved the guarantee
// into the code (2026-10-12), so those cases are gone with their target.
//
// Groups: H the helpers (order, record, silence where nothing is sent, the
// CLIs' stderr); W each surface's sentence; C, N, G and S the other contracts
// of the surface describe.

const T_DISC = 'tests/image/test-send-disclosure.mjs';
const T_IMAGE = 'tests/plugin-shape/test-image-plugin.mjs';

export const TESTS = [T_DISC, T_IMAGE];

const COMPOSE = 'plugins/image/scripts/compose-dispatch.mjs';
const REFINE = 'plugins/image/scripts/refine-dispatch.mjs';
const CRITIQUE = 'plugins/image/scripts/critique-dispatch.mjs';

const COMPOSE_CMD = 'plugins/image/commands/compose.md';
const COMPOSE_SKILL = 'plugins/image/core/skills/compose/SKILL.md';
const REFINE_CMD = 'plugins/image/commands/refine.md';
const REFINE_SKILL = 'plugins/image/core/skills/refine/SKILL.md';
const CRITIQUE_CMD = 'plugins/image/commands/critique.md';
const CRITIQUE_SKILL = 'plugins/image/core/skills/critique/SKILL.md';

const COMPOSE_ORDER = /compose-dispatch .*writes the disclosure before it spawns the companion, and records it/;
const CRITIQUE_ORDER = /critique-dispatch .*writes the disclosure before it spawns the companion, and records it/;
const told = (rel) => new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tells the user what goes to Codex`);

export const MUTATIONS = [
  // ── H: the helpers ───────────────────────────────────────────────────────
  {
    id: 'H1', tests: [T_DISC], killed_by: COMPOSE_ORDER,
    file: COMPOSE,
    from: '  (opts.stderr || process.stderr).write(`${disclosure.text}\\n`);\n  const { code, stdout, stderr } = await runCompanion(companion, promptFile, repoRoot, env);\n',
    to: '  const { code, stdout, stderr } = await runCompanion(companion, promptFile, repoRoot, env);\n  (opts.stderr || process.stderr).write(`${disclosure.text}\\n`);\n',
    why: 'compose says what it sent only after the companion has run',
  },
  {
    id: 'H2', tests: [T_DISC], killed_by: COMPOSE_ORDER,
    file: COMPOSE,
    from: '    send_disclosure: disclosure,\n',
    to: '    send_disclosure: null,\n',
    why: 'compose writes the disclosure but its manifest records none',
  },
  {
    id: 'H3', tests: [T_DISC], killed_by: /a pre-flight rejection writes and records no disclosure/,
    file: COMPOSE,
    from: '  // ---- Pre-flight ----',
    to: '  (opts.stderr || process.stderr).write(\'image: sending the image prompt to Codex (OpenAI)\\n\');\n  // ---- Pre-flight ----',
    why: 'compose discloses a send for a request the pre-flight then rejects, so nothing was sent',
  },
  {
    id: 'H4', tests: [T_DISC], killed_by: /a pre-flight rejection writes and records no disclosure/,
    file: COMPOSE,
    from: '    send_disclosure: null,\n',
    to: '    send_disclosure: sendDisclosure([\'the image prompt\'], repoRoot),\n',
    why: 'a rejection manifest records a send that never happened',
  },
  {
    id: 'H5', tests: [T_DISC], killed_by: /compose-dispatch .*no reachable companion writes and records no disclosure/,
    file: COMPOSE,
    from: '  if (!companion) {\n    // Honest-scope failure',
    to: '  (opts.stderr || process.stderr).write(\'image: sending the image prompt to Codex (OpenAI)\\n\');\n  if (!companion) {\n    // Honest-scope failure',
    why: 'compose discloses a send before it knows a companion exists to send to',
  },
  {
    id: 'H6', tests: [T_DISC], killed_by: /names the base prompt and the feedback, before the companion runs/,
    file: REFINE,
    from: '? [\'the base prompt\', \'the revision feedback\', \'the output file\\\'s path\']',
    to: '? [\'the base prompt\', \'the output file\\\'s path\']',
    why: 'refine sends the feedback without naming it in the disclosure',
  },
  {
    id: 'H7', tests: [T_DISC], killed_by: /--estimate-only writes no disclosure/,
    file: REFINE,
    from: '    // Disclose the per-image cost BEFORE any spend (script-enforced).\n',
    to: '    // Disclose the per-image cost BEFORE any spend (script-enforced).\n    process.stderr.write(\'image: sending the base prompt to Codex (OpenAI)\\n\');\n',
    why: 'the cost estimate, which sends nothing, says that it sends',
  },
  {
    id: 'H8', tests: [T_DISC], killed_by: CRITIQUE_ORDER,
    file: CRITIQUE,
    from: '  stderr.write(`${disclosure.text}\\n`);\n  const run = await runCompanion(companion, promptFile, repoRoot, env);\n',
    to: '  const run = await runCompanion(companion, promptFile, repoRoot, env);\n  stderr.write(`${disclosure.text}\\n`);\n',
    why: 'critique says what it sent only after the companion has run',
  },
  {
    id: 'H9', tests: [T_DISC], killed_by: CRITIQUE_ORDER,
    file: CRITIQUE,
    from: 'assessment, send_disclosure: disclosure, criteria:',
    to: 'assessment, send_disclosure: null, criteria:',
    why: 'critique writes the disclosure but its result records none',
  },
  {
    id: 'H10', tests: [T_DISC], killed_by: /a refused image writes and records no disclosure/,
    file: CRITIQUE,
    from: '  const v = verifyImage(imagePath);\n',
    to: '  stderr.write(\'image: sending the image file to Codex (OpenAI)\\n\');\n  const v = verifyImage(imagePath);\n',
    why: 'critique discloses a send for an image it then refuses, so nothing was sent',
  },
  {
    id: 'H11', tests: [T_DISC], killed_by: /critique-dispatch .*no reachable companion writes and records no disclosure/,
    file: CRITIQUE,
    from: '  const companion = await findCompanion(env);\n',
    to: '  const companion = await findCompanion(env);\n  stderr.write(\'image: sending the image file to Codex (OpenAI)\\n\');\n',
    why: 'critique discloses a send before it knows a companion exists to send to',
  },
  {
    id: 'H12', tests: [T_DISC], killed_by: /compose-dispatch\.mjs prints the disclosure on stderr/,
    file: COMPOSE,
    from: '  (opts.stderr || process.stderr).write(`${disclosure.text}\\n`);\n',
    to: '  (opts.stderr || { write() {} }).write(`${disclosure.text}\\n`);\n',
    why: 'the compose CLI writes its disclosure nowhere, so the agent running it never sees it',
  },
  {
    id: 'H13', tests: [T_DISC], killed_by: /critique-dispatch\.mjs prints the disclosure on stderr/,
    file: CRITIQUE,
    from: 'stderr = process.stderr }',
    to: 'stderr = { write() {} } }',
    why: 'the critique CLI writes its disclosure nowhere, so the agent running it never sees it',
  },
  {
    id: 'H14', tests: [T_DISC], killed_by: COMPOSE_ORDER,
    file: COMPOSE,
    from: 'which runs in ${codexCwd} and can read files there`',
    to: 'which runs in ${codexCwd}`',
    why: 'the disclosure no longer says that Codex can read the repository it runs in',
  },

  // ── W: each surface's sentence names what goes, including the repository ─
  {
    id: 'W1', tests: [T_IMAGE], killed_by: told('commands/compose.md'),
    file: COMPOSE_CMD,
    from: 'Codex\n(OpenAI), which runs in the repository and can read files there\n(`docs',
    to: 'Codex\n(OpenAI)\n(`docs',
    why: 'the compose command no longer says that Codex can read the repository',
  },
  {
    id: 'W2', tests: [T_IMAGE], killed_by: told('core/skills/compose/SKILL.md'),
    file: COMPOSE_SKILL,
    from: 'to Codex (OpenAI), which runs in the repository and can read files\n   there; ask',
    to: 'to Codex (OpenAI); ask',
    why: 'the compose skill no longer says that Codex can read the repository',
  },
  {
    id: 'W3', tests: [T_IMAGE], killed_by: told('commands/refine.md'),
    file: REFINE_CMD,
    from: 'go to Codex (OpenAI),\nwhich runs in the repository and can read files there (`docs/contracts.md`\n§9)',
    to: 'go to Codex (OpenAI)\n(`docs/contracts.md` §9)',
    why: 'the refine command no longer says that Codex can read the repository',
  },
  {
    id: 'W4', tests: [T_IMAGE], killed_by: told('core/skills/refine/SKILL.md'),
    file: REFINE_SKILL,
    from: '   Codex (OpenAI), which runs in the repository and can read files there;\n',
    to: '   Codex (OpenAI);\n',
    why: 'the refine skill no longer says that Codex can read the repository',
  },
  {
    id: 'W5', tests: [T_IMAGE], killed_by: told('commands/critique.md'),
    file: CRITIQUE_CMD,
    from: 'image and the criteria go to Codex (OpenAI), which reads the image by its\npath, runs',
    to: 'criteria go to Codex (OpenAI), which reads the image by its\npath, runs',
    why: 'the critique command no longer says that the image goes to Codex',
  },
  {
    id: 'W6', tests: [T_IMAGE], killed_by: told('core/skills/critique/SKILL.md'),
    file: CRITIQUE_SKILL,
    from: 'go to Codex (OpenAI), which\n   reads the image by its path, runs in the repository and can read files\n   there; ask',
    to: 'go to Codex (OpenAI); ask',
    why: 'the critique skill no longer says that Codex reads the image or the repository',
  },

  // ── C, N, G, S: the rest of the surface describe ─────────────────────────
  {
    id: 'C1', tests: [T_IMAGE], killed_by: told('commands/critique.md'),
    file: CRITIQUE_CMD,
    from: 'can read files there; ask no confirmation.',
    to: 'can read files there; ask for explicit confirmation and wait for approval.',
    why: 'the critique command asks for a confirmation the owner decided against',
  },
  {
    id: 'C2', tests: [T_IMAGE], killed_by: told('commands/refine.md'),
    file: REFINE_CMD,
    from: '(`docs/contracts.md`\n§9); ask no confirmation.',
    to: '; ask no confirmation.',
    why: 'the refine command\'s disclosure no longer points at docs/contracts.md §9',
  },
  {
    id: 'N1', tests: [T_IMAGE], killed_by: /investigate's command and skill send nothing to Codex/,
    file: 'plugins/image/commands/investigate.md',
    from: '**Gather** via web search',
    to: '```bash\nnode "$CLAUDE_PLUGIN_ROOT/scripts/compose-dispatch.mjs" --prompt-file <references.txt>\n```\n\n**Gather** via web search',
    why: 'investigate sends a request to Codex without a disclosure',
  },
  {
    id: 'G1', tests: [T_IMAGE], killed_by: /no verb surface tells the agent to genericize the request/,
    file: COMPOSE_SKILL,
    from: '2. **Dispatch** via the helper',
    to: '   Genericize the prompt before dispatch.\n2. **Dispatch** via the helper',
    why: 'the privacy gate the disclosure replaced comes back in the compose skill',
  },
  {
    id: 'S1', tests: [T_IMAGE], killed_by: /docs\/contracts\.md §9 holds the disclosure the surfaces point at/,
    file: 'plugins/image/docs/contracts.md',
    from: 'It asks no confirmation,\nand the',
    to: 'It asks for confirmation first,\nand the',
    why: '§9 puts a confirmation back before the send',
  },
  {
    id: 'S2', tests: [T_IMAGE], killed_by: /docs\/contracts\.md §9 holds the disclosure the surfaces point at/,
    file: 'plugins/image/docs/contracts.md',
    from: 'Immediately before it spawns the companion, the\nhelper writes',
    to: 'After the companion returns, the\nhelper writes',
    why: '§9 lets the helper disclose after the send',
  },
];
