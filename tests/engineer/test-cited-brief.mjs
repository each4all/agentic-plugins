// Fixture-level tests for the engineer:investigate cited-brief profile
// (ADR-0014 absorption of plugins/research). Complements the macro-level
// shape conformance test in tests/plugin-shape/test-engineer-plugin.mjs
// with per-document fixture and consistency checks at the spec / rules /
// ensemble protocol layer.
//
// The cited-brief profile is prose-driven (no `cited-brief.mjs` runtime
// helper), so these tests verify cross-document agreement rather than
// invoke runtime functions. The PEER-ONLY routing, existing-directory
// outcomes, citation audit checklist, and topic-slug sanitization
// examples are all encoded in references/ markdown files; the tests
// here parse those documents and assert the encoded expectations are
// internally consistent.
//
// Run via `node --test tests/engineer/test-cited-brief.mjs`.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SKILL_PATH = resolve(REPO_ROOT, 'plugins/engineer/skills/investigate/SKILL.md');
const COMMAND_PATH = resolve(REPO_ROOT, 'plugins/engineer/commands/investigate.md');
const SPEC_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/investigate/references/cited-brief-spec.md',
);
const RULES_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/investigate/references/output-file-rules.md',
);
const ENSEMBLE_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/investigate/references/cited-brief-ensemble.md',
);
const SHARED_ENSEMBLE_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/skills/_shared/references/ensemble-protocol.md',
);

describe('cited-brief — output path resolution (output-file-rules.md)', () => {
  it('output-file-rules.md describes the absolute-path requirement for RESEARCH_OUTPUT_ROOT', async () => {
    const text = await readFile(RULES_PATH, 'utf8');
    ok(/Absolute path required/.test(text), 'rules missing absolute-path requirement');
    ok(/relative paths[\s\S]*?rejected/i.test(text), 'rules missing relative-path rejection');
    ok(/falls back to[\s\S]{0,40}\.\/output\//.test(text), 'rules missing fallback to ./output/');
  });

  it('output-file-rules.md fixed filename is research_brief.md (Stage 1 backwards compat)', async () => {
    const text = await readFile(RULES_PATH, 'utf8');
    // The brief filename is preserved per ADR-0014 backwards compat.
    ok(
      /\*\*always\*\*\s*named\s*`research_brief\.md`/.test(text),
      'rules missing "always named research_brief.md" guarantee',
    );
    ok(/Stage 1.*plugins\/research/.test(text), 'rules missing Stage 1 backwards-compat note');
  });

  it('output-file-rules.md sandbox enforcement protects against traversal escape', async () => {
    const text = await readFile(RULES_PATH, 'utf8');
    ok(/Sandbox enforcement/i.test(text), 'rules missing Sandbox enforcement section');
    ok(/symlink resolution/i.test(text), 'rules missing symlink resolution mention');
    ok(/rejected\s+before the file is written/i.test(text), 'rules missing pre-write rejection');
  });

  it('output-file-rules.md topic-slug sanitization runs traversal rejection on raw input first', async () => {
    const text = await readFile(RULES_PATH, 'utf8');
    // Step 1 must run before character stripping to avoid `..` collapsing.
    ok(/Traversal rejection \(raw input\)/.test(text), 'rules missing Step 1 traversal rejection label');
    ok(
      /raw topic string contains[\s\S]{0,120}two or more consecutive dots/.test(text),
      'rules missing two-dot detection',
    );
    ok(/15 Unicode code points/.test(text), 'rules missing 15-codepoint truncation rule');
  });
});

describe('cited-brief — existing-directory gate (3 outcomes consistent across docs)', () => {
  // Outcome names: overwrite / distinct / abort. They appear in
  // output-file-rules.md (canonical), SKILL.md auto-mode Step 2, and
  // commands/investigate.md Completion. All three must agree.
  it('output-file-rules.md enumerates all 3 outcomes with default = distinct directory', async () => {
    const text = await readFile(RULES_PATH, 'utf8');
    ok(/Overwrite/.test(text), 'rules missing Overwrite outcome');
    ok(/Distinct directory/.test(text), 'rules missing Distinct directory outcome');
    ok(/Abort/.test(text), 'rules missing Abort outcome');
    ok(/Default if the user does not respond:\s*option 2/i.test(text), 'rules missing default = option 2 (distinct)');
  });

  it('SKILL.md cited-brief Step 2 mentions the existing-directory check pre-dispatch', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(
      /Existing-directory check/.test(text),
      'SKILL.md cited-brief arm missing Existing-directory check',
    );
    ok(
      /BEFORE\s+running web searches/.test(text),
      'SKILL.md missing pre-dispatch ordering for existing-directory gate',
    );
  });

  it('commands/investigate.md Completion taxonomy includes aborted-at-save outcome', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /aborted at save/i.test(text) && /existing-directory gate/i.test(text),
      'Completion missing aborted-at-save outcome with existing-dir gate reference',
    );
  });
});

describe('cited-brief — citation audit checklist (cited-brief-spec.md)', () => {
  it('audit checklist enumerates all 11 required items', async () => {
    const text = await readFile(SPEC_PATH, 'utf8');
    // Capture from "## Audit Checklist" to end of file (or next ## heading
    // if more sections exist). Use a non-greedy match anchored to either
    // the next ## heading or end-of-string.
    const auditMatch = text.match(/##\s+Audit Checklist[\s\S]+/);
    ok(auditMatch, 'Audit Checklist section not found');
    const items = (auditMatch[0].match(/^-\s+\[\s\]\s+\*\*[^*]/gm) || []).length;
    ok(items >= 11, `Audit Checklist has ${items} items (≥11 expected per spec contract)`);
  });

  it('permitted sentinels for un-cited claims are exactly 2', async () => {
    const text = await readFile(SPEC_PATH, 'utf8');
    ok(/\[uncited inference\]/.test(text), 'missing [uncited inference] sentinel');
    ok(/\[research interrupted — partial coverage\]/.test(text), 'missing [research interrupted] sentinel');
  });

  it('citation numbering rules describe research-execution capture order with no renumbering', async () => {
    const text = await readFile(SPEC_PATH, 'utf8');
    ok(
      /research-execution capture order/.test(text),
      'spec missing "research-execution capture order" rule',
    );
    ok(
      /Do not renumber on edits/.test(text),
      'spec missing "Do not renumber on edits" rule',
    );
  });

  it('source-tier taxonomy has exactly 4 tiers (official-docs / standards / academic / secondary)', async () => {
    const text = await readFile(SPEC_PATH, 'utf8');
    for (const tier of ['official-docs', 'standards', 'academic', 'secondary']) {
      ok(new RegExp(`\\*\\*${tier}\\*\\*`).test(text), `spec missing source-tier "${tier}"`);
    }
  });
});

describe('cited-brief — PEER-ONLY routing (Path A / Path B Independence Rule)', () => {
  // The bidirectional Independence Rule routes PEER-ONLY claims through
  // either Path A (locally verify and cite) or Path B (move to Open
  // Questions). This rule must be encoded in cited-brief-ensemble.md
  // (canonical), referenced by SKILL.md command-mode Step 4, and by the
  // shared ensemble-protocol.md research-scan section.
  it('cited-brief-ensemble.md describes both Path A and Path B', async () => {
    const text = await readFile(ENSEMBLE_PATH, 'utf8');
    ok(/Path A/.test(text), 'cited-brief-ensemble.md missing Path A');
    ok(/Path B/.test(text), 'cited-brief-ensemble.md missing Path B');
    ok(/Independence Rule/.test(text), 'cited-brief-ensemble.md missing Independence Rule');
  });

  it('SKILL.md command-mode Step 4 mentions Independence Rule routing', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(
      /Independence Rule[\s\S]{0,200}Path A[\s\S]{0,200}Path B/.test(text),
      'SKILL.md command-mode Step 4 missing Path A / Path B routing',
    );
  });

  it('shared ensemble-protocol.md research-scan synthesis describes Path A / Path B', async () => {
    const text = await readFile(SHARED_ENSEMBLE_PATH, 'utf8');
    const sectionMatch = text.match(
      /###\s+Research-scan[\s\S]+?(?=###\s+Refine-verify|\Z)/,
    );
    ok(sectionMatch, 'Research-scan section not found in shared ensemble-protocol.md');
    ok(
      /Path A[\s\S]{0,200}Path B/.test(sectionMatch[0]),
      'Research-scan section missing Path A / Path B routing',
    );
  });

  it('citation remapping forbids verbatim peer label copying', async () => {
    const text = await readFile(SHARED_ENSEMBLE_PATH, 'utf8');
    const sectionMatch = text.match(
      /###\s+Research-scan[\s\S]+?(?=###\s+Refine-verify|\Z)/,
    );
    ok(sectionMatch, 'Research-scan section not found');
    ok(
      /MUST NOT be copied verbatim/.test(sectionMatch[0]),
      'Research-scan section missing "MUST NOT copied verbatim" rule for peer labels',
    );
  });
});

describe('cited-brief — privacy gate consistency', () => {
  it('SKILL.md auto-mode Step 1 privacy gate covers web search and peer dispatch', async () => {
    const text = await readFile(SKILL_PATH, 'utf8');
    ok(
      /web search queries/i.test(text) && /peer-host dispatch/i.test(text),
      'SKILL.md privacy gate missing web search / peer dispatch coverage',
    );
  });

  it('cited-brief-ensemble.md privacy contract block defined under Prompt Construction', async () => {
    const text = await readFile(ENSEMBLE_PATH, 'utf8');
    ok(/<privacy_contract>/.test(text) || /privacy contract/i.test(text), 'ensemble missing privacy_contract block');
  });
});
