// Regression tests for the defects ST5's adversarial audit of the assembled
// assurance plane REPRODUCED (ADR-0053 / ADR-0054).
//
// One file rather than seven, because these are one finding class seen from
// seven modules: a reader that accepts input it cannot faithfully read, and a
// consumer that reads absence as permission. Each `describe` names the measured
// failure, and each carries the CONTROL that failed first when the fix was
// prototyped — the fixes here all tighten a predicate, and a tightening with no
// control is how a guard grows until it refuses correct input.
//
// Every test in this file was mutation-verified: reverting the production line
// it names turns it red. Tests that pass either way are the defect this whole
// subtask exists to find.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ASSURANCE_BEGIN_SENTINEL,
  ASSURANCE_END_SENTINEL,
  parseAssuranceSection,
  parseBaseline,
  readVersionToken,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { matchAssurance } from '../../plugins/runtime/scripts/lib/assurance-contract.mjs';
import { FUTURE_SKEW_TOLERANCE_MS, elapsedMsSince } from '../../plugins/runtime/scripts/lib/clock.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME_ROOT = join(REPO_ROOT, 'plugins', 'runtime');
const SCHEMA = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'data', 'schemas', 'runtime-host-assurance-1.0.json'), 'utf8'));
const PLUGIN_SET = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'data', 'plugin-set.json'), 'utf8'));

const HEADER = 'Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI `0.147.0`.';

function grant(overrides = {}) {
  return {
    id: 'st5-fixture-grant',
    state: 'granted',
    reviewed_at: '2026-08-18',
    review_provenance: { kind: 'adr', reference: 'ADR-0054' },
    cohort: [{ claude: '2.1.234', codex: '0.147.0' }],
    packages: { runtime: '0.91.0' },
    residuals: [],
    ...overrides,
  };
}

function hostFacts(extraPackages = {}) {
  return {
    authoritative: true,
    list_status: 'available',
    packages: {
      runtime: { present: true, enabled: true, version: '0.91.0', ambiguous: false },
      ...extraPackages,
    },
  };
}

function match({ hosts, grants = [grant()], extraPackages = {} } = {}) {
  const facts = hostFacts(extraPackages);
  return matchAssurance({
    record: { schema: 'runtime-host-assurance-1.0', grants },
    hosts,
    observed: { claude: facts, codex: facts },
    pluginSet: PLUGIN_SET,
    today: '2026-08-18',
  });
}

function document(body) {
  const record = JSON.stringify({ schema: 'runtime-host-assurance-1.0', grants: [] }, null, 2);
  const block = `${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${record}\n\`\`\`\n${ASSURANCE_END_SENTINEL}`;
  return body.replace('{BLOCK}', block);
}

// ---------------------------------------------------------------------------
// F1 — a malformed observed version aliased to a reviewed release
// ---------------------------------------------------------------------------

describe('readVersionToken reports every DROPPED residue, not only a further component', () => {
  // The old rule flagged `1.2.3.4` and nothing else, and its own note recorded
  // the three shapes it let through as a stated residual to be decided
  // deliberately. ST5 is that decision: `2.1.234-` reached `covered` against a
  // human grant for `2.1.234`, which is the plane's whole failure mode.
  for (const malformed of ['1.2.3.4', '1.2.3-', '1.2.3+', '1.2.3..4']) {
    it(`refuses ${JSON.stringify(malformed)} — the token is not what the text said`, () => {
      const read = readVersionToken(malformed);
      assert.equal(read.token, '1.2.3');
      assert.equal(read.truncated, true, `${malformed} must be flagged as having dropped something`);
    });
  }

  // CONTROLS. These are the exact strings the original note named as the
  // property a wider detector would cost, plus the two real host output shapes.
  // A fix that flags any of them is over-tightened, not fixed.
  for (const [faithful, token] of [
    ['1.2.3', '1.2.3'],
    ['1.2.3-rc.1', '1.2.3-rc.1'],
    ['1.2.3+build.5', '1.2.3+build.5'],
    ['0.147.0-rc.1', '0.147.0-rc.1'],
    ['v1.2.3', '1.2.3'],
    ['  1.2.3  ', '1.2.3'],
    ['2.1.197 (Claude Code)', '2.1.197'],
    ['codex-cli 0.142.4', '0.142.4'],
    ['rust-v0.137.0', '0.137.0'],
    ['2.1.233. See the note below.', '2.1.233'],
    ['1.2', '1.2'],
  ]) {
    it(`CONTROL: ${JSON.stringify(faithful)} is read faithfully`, () => {
      const read = readVersionToken(faithful);
      assert.equal(read.token, token);
      assert.equal(read.truncated, false, `${faithful} must NOT be flagged`);
    });
  }
});

describe('a malformed observed version cannot reach covered', () => {
  it('CONTROL: the exact pair the cohort names is covered', () => {
    assert.equal(match({ hosts: { claude: '2.1.234', codex: '0.147.0' } }).state, 'covered');
  });

  for (const malformed of ['2.1.234-', '2.1.234+', '2.1.234..9', '2.1.234.9']) {
    it(`${JSON.stringify(malformed)} is unassured, not covered`, () => {
      const result = match({ hosts: { claude: malformed, codex: '0.147.0' } });
      assert.equal(result.state, 'unassured');
      assert.equal(result.grant_id, null);
      assert.match(result.reasons.join(' '), /unreadable/);
    });
  }
});

// ---------------------------------------------------------------------------
// F2 — a grant quoted inside raw HTML resolved as the live record
// ---------------------------------------------------------------------------

describe('a sentinel inside a literal HTML container is quoted content', () => {
  it('CONTROL: a top-level block resolves', () => {
    assert.equal(parseAssuranceSection(document(`${HEADER}\n\n{BLOCK}\n`), { schema: SCHEMA }).status, 'resolved');
  });

  for (const [label, open, close] of [
    ['<pre>', '<pre>', '</pre>'],
    ['<PRE> uppercase', '<PRE>', '</PRE>'],
    ['<pre> with attributes', '<pre class="example">', '</pre>'],
    ['<script>', '<script>', '</script>'],
    ['<style>', '<style>', '</style>'],
    ['<textarea>', '<textarea>', '</textarea>'],
  ]) {
    it(`${label} makes the block non-live`, () => {
      const text = document(`${HEADER}\n\n${open}\n{BLOCK}\n${close}\n`);
      assert.equal(parseAssuranceSection(text, { schema: SCHEMA }).status, 'absent');
    });
  }

  it('CONTROL: the fence, indent and blockquote cases stay refused', () => {
    // Prefixes apply per LINE — `{BLOCK}` is multi-line, so substituting first
    // and prefixing the placeholder would build a document that is malformed
    // for a different reason and pass for the wrong one.
    const fenced = document(`${HEADER}\n\n\`\`\`\`markdown\n{BLOCK}\n\`\`\`\`\n`);
    const prefixed = (prefix) => document('{BLOCK}').split('\n').map((line) => (line ? prefix + line : line)).join('\n');
    for (const text of [fenced, `${HEADER}\n\n${prefixed('    ')}\n`, `${HEADER}\n\n${prefixed('> ')}\n`]) {
      assert.equal(parseAssuranceSection(text, { schema: SCHEMA }).status, 'absent');
    }
  });

  it('CONTROL: a tag whose NAME merely starts with a container name is prose', () => {
    // `<presenter>` is not `<pre>`. A prefix match here would make an ordinary
    // custom tag swallow the rest of the document.
    const text = document(`${HEADER}\n\n<presenter>\n{BLOCK}\n`);
    assert.equal(parseAssuranceSection(text, { schema: SCHEMA }).status, 'resolved');
  });

  it('CONTROL: a quoted example ABOVE the live record does not hide it', () => {
    const text = document(`${HEADER}\n\n<pre>\n{BLOCK}\n</pre>\n`)
      + '\n' + document('{BLOCK}\n');
    assert.equal(parseAssuranceSection(text, { schema: SCHEMA }).status, 'resolved');
  });
});

// ---------------------------------------------------------------------------
// F4 — header-shaped text inside the assurance region supplied the baseline
// ---------------------------------------------------------------------------

describe('the dated header is never read out of the assurance region', () => {
  const fake = 'Observed on 2099-01-01 with Claude Code `9.9.9`, Codex CLI `9.9.9`.';
  // The carrier is a SCHEMA-VALID field, which is what makes this reachable:
  // `review_provenance.reference` is a free-text string the record legitimately
  // carries, and `HEADER_RE` has no anchor.
  const carrier = JSON.stringify({
    schema: 'runtime-host-assurance-1.0',
    grants: [grant({ review_provenance: { kind: 'owner-attestation', reference: fake } })],
  }, null, 2);
  const block = `${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${carrier}\n\`\`\`\n${ASSURANCE_END_SENTINEL}`;

  it('a document with NO real header does not parse one out of the record', () => {
    assert.equal(parseBaseline(`# doc\n\nprose, no dated header\n\n${block}\n`), null);
  });

  it('an UNTERMINATED region does not expose a header that follows it', () => {
    assert.equal(parseBaseline(`# doc\n\n${ASSURANCE_BEGIN_SENTINEL}\n\`\`\`json\n${carrier}\n\`\`\`\n\n${HEADER}\n`), null);
  });

  it('CONTROL: the real header still wins beside the carrier', () => {
    assert.deepEqual(parseBaseline(`${HEADER}\n\n${block}\n`), { date: '2026-08-16', claude: '2.1.233', codex: '0.147.0' });
  });

  it('CONTROL: a document with no assurance section is unchanged', () => {
    assert.deepEqual(parseBaseline(HEADER), { date: '2026-08-16', claude: '2.1.233', codex: '0.147.0' });
  });

  it('CONTROL: the SHIPPED baseline still parses', () => {
    const shipped = readFileSync(join(RUNTIME_ROOT, 'docs', 'host-parity-baseline.md'), 'utf8');
    const parsed = parseBaseline(shipped);
    assert.ok(parsed, 'the packaged baseline must still parse');
    assert.match(parsed.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// F5 — a future timestamp clamped to age 0, i.e. maximally fresh
// ---------------------------------------------------------------------------

describe('a beyond-skew future timestamp establishes no age', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');

  it('a past timestamp yields its elapsed time', () => {
    assert.equal(elapsedMsSince(now, now - 3600_000), 3600_000);
  });

  it('CONTROL: drift WITHIN the bound is age 0, not a refusal', () => {
    assert.equal(elapsedMsSince(now, now + FUTURE_SKEW_TOLERANCE_MS), 0);
    assert.equal(elapsedMsSince(now, now + 1), 0);
  });

  it('BEYOND the bound is null — never 0, which is the freshest value there is', () => {
    assert.equal(elapsedMsSince(now, now + FUTURE_SKEW_TOLERANCE_MS + 1), null);
    assert.equal(elapsedMsSince(now, Date.parse('2099-01-01T00:00:00.000Z')), null);
  });

  it('an unparseable timestamp is null too — both are "no age"', () => {
    assert.equal(elapsedMsSince(now, Number.NaN), null);
    assert.equal(elapsedMsSince(Number.NaN, now), null);
  });
});

// ---------------------------------------------------------------------------
// F3 — a grant covers while naming fewer packages than the machine runs
// ---------------------------------------------------------------------------

describe('a covered verdict names the installed packages no reviewer bound', () => {
  it('is empty when the grant names everything installed', () => {
    const result = match({ hosts: { claude: '2.1.234', codex: '0.147.0' } });
    assert.equal(result.state, 'covered');
    assert.deepEqual([...result.unbound_packages], []);
  });

  it('names an installed package the grant omits, sorted', () => {
    const result = match({
      hosts: { claude: '2.1.234', codex: '0.147.0' },
      extraPackages: {
        engineer: { present: true, enabled: true, version: '0.21.5', ambiguous: false },
        attention: { present: true, enabled: true, version: '9.9.9', ambiguous: false },
      },
    });
    assert.equal(result.state, 'covered');
    assert.deepEqual([...result.unbound_packages], ['attention', 'engineer']);
  });

  it('CONTROL: a package the grant DOES name is not reported as unbound', () => {
    const result = match({
      hosts: { claude: '2.1.234', codex: '0.147.0' },
      grants: [grant({ packages: { runtime: '0.91.0', attention: '0.4.0' } })],
      extraPackages: { attention: { present: true, enabled: true, version: '0.4.0', ambiguous: false } },
    });
    assert.equal(result.state, 'covered');
    assert.deepEqual([...result.unbound_packages], []);
  });
});

// ---------------------------------------------------------------------------
// The floor is a policy value, not a convention
// ---------------------------------------------------------------------------

describe('the packaged plugin set declares a runtime floor', () => {
  // The existing assertion pins the LITERAL ('0.91.0'), which is right for
  // lockstep but reads as a version-sync lag when it fails — and the honest
  // repair for a version-sync failure is to update the literal, including to
  // `null`. This names the INVARIANT instead: a null floor makes
  // `evaluateRuntimeFloor` return satisfied with no host evaluated.
  it('runtime.minimum_version is a non-null semver, not merely some value', () => {
    const floor = PLUGIN_SET.plugins?.runtime?.minimum_version;
    assert.equal(typeof floor, 'string', 'a null runtime floor silently disables the ADR-0054 §Decision 5 gate');
    assert.match(floor, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
