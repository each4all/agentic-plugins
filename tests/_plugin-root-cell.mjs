// The Codex plugin-root cell of a command-resolution table, checked one
// document at a time. tests/plugin-shape/test-codex-plugin-root-contract.mjs
// holds the cross-plugin contract (the enumerated tables, identical cells, the
// checkout sweep); the persona pipeline's skill contracts
// (tests/persona-pipeline/test-skill-contracts.mjs) run the same cell check
// over each committed and template-assembled SKILL.md, so a document that
// loses a sentence fails on its own (PC2a3 QD10).

export const CHECKOUT = '.tmp/marketplaces';
export const ROW = /^\s*\|\s*(?:\*\*)?\s*Plugin root\b/i;

// Retired claims, in the affirmative shapes the old sentences had (subject
// included), so that the corrected text — which names the checkout as the
// install source — and accurate corrections using the same words do not match.
export const RETIRED = [
  [/\(Codex marketplace install layout per ADR-0008/i, 'calls the marketplace checkout the Codex install layout per ADR-0008'],
  [/no versioned subdirectory, no glob needed/i, 'says the Codex install has no versioned subdirectory'],
  [/command resolution,? (?:which )?records the default (?:Codex )?layout/i, 'says the checkpoint table records a default layout to assume'],
  [/a non-default install root (?:means resolving|or marketplace name means the path must be|must be resolved)/i, 'treats the root as assumable unless the install is non-default'],
  [/is the marketplace checkout Codex installs from/i, 'says the checkout is what Codex installs from (ADR-0061 pins installs to release commits)'],
  [/\bCodex marketplace install path\b/i, 'calls the root the "Codex marketplace install path"'],
];

export const startClause = (persona) => ` (inside \`$${persona}:start\`, the mentioned skill is \`start\`, which runs the six verb skills in place)`;

// A GFM row: strip the outer pipes, split on unescaped ones (the Claude
// fallback carries `\|` inside a code span).
export const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

export function pluginRootRows(raw) {
  const lines = raw.split(/\r?\n/);
  const rows = [];
  lines.forEach((line, i) => {
    if (!ROW.test(line)) return;
    let top = i;
    while (top > 0 && lines[top - 1].trim().startsWith('|')) top -= 1;
    const header = splitRow(lines[top]);
    const cells = splitRow(line);
    rows.push({ header, cells, codex: cells[header.indexOf('Codex')] ?? '' });
  });
  return rows;
}

/**
 * What a Plugin root row's Codex cell fails to say, or says wrongly, for one
 * plugin: `skillsRel` is the plugin's declared skills root, `startMacro`
 * whether its start macro runs the verb skills in place. Empty when it holds.
 */
export function codexCellProblems(codex, persona, { skillsRel, startMacro }) {
  const problems = [];
  const required = [
    [`For a mentioned \`${persona}\` skill, the plugin directory that contains it`, 'scope the rule to a mentioned skill of this plugin'],
    ...(startMacro
      ? [[startClause(persona).trim().slice(1, -1), 'name start as the mentioned skill when it runs the verbs in place']]
      : []),
    ['Codex injects a mentioned skill with its absolute path', 'say where the root comes from'],
    [`dropping \`/${skillsRel}/<skill>/SKILL.md\` from it leaves the root, which holds \`.codex-plugin/plugin.json\``, `derive the root by dropping this plugin's declared skills root (/${skillsRel}/<skill>/SKILL.md)`],
    ['a new mention of the skill supplies it again', 'say how to recover the path once it has left the context'],
    [`With the default Codex home and the \`agentic-plugins\` marketplace added from Git, the root is \`~/.codex/plugins/cache/agentic-plugins/${persona}/<version>\`, the versioned copy Codex loads skills from`, "name its own plugin's versioned cache as the location under the default Codex home and Git marketplace"],
    [`\`~/.codex/.tmp/marketplaces/agentic-plugins/plugins/${persona}\` is the marketplace checkout, which tracks the repository's \`main\` branch, not that copy`, 'name the checkout as tracking main, not the loaded copy'],
  ];
  for (const [sentence, why] of required) {
    if (!codex.includes(sentence)) problems.push(`Codex cell must ${why}: expected "${sentence}"`);
  }
  const named = codex.split(CHECKOUT).length - 1;
  if (named !== 1) problems.push(`Codex cell must name the checkout once, as the install source only (found ${named})`);
  for (const [pattern, why] of RETIRED) {
    if (pattern.test(codex)) problems.push(`Codex cell ${why}`);
  }
  // orchestrator has no start macro; its cell is the same sentence without that clause.
  if (!startMacro && codex.includes(':start`')) problems.push('Codex cell must not name a start macro the plugin does not have');
  return problems;
}
