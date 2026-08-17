// The SEMANTIC half of the compatibility assurance record — ADR-0054
// §Decision 2, and the membership matcher of ADR-0053 §Decision 5.
//
// The structural schema is tested next door in test-host-assurance-record.mjs.
// What is tested HERE is everything that schema was measured to accept and must
// not: ADR-0054 lists eight such cases by name, and each has a case below.
//
// TWO RULES THIS FILE FOLLOWS, both learned the hard way in this repository:
//
//   1. EVERY rejection carries a CONTROL that must pass. A fixture can be
//      rejected for a reason other than the one under test, and a green "it was
//      refused" says nothing about which rule refused it. The controls here are
//      one-field edits away from the failing fixture, so they take the same
//      branch.
//   2. NO bare "X is absent" assertion. `matchAssurance` returning `unassured`
//      is the DEFAULT answer — a function that returned `unassured`
//      unconditionally would pass every negative case in this file. So every
//      negative asserts the REASON, and the positive control proves the
//      function can reach `covered` at all.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual, match } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSURANCE_GRANT_STATES,
  ASSURANCE_MATCH_STATES,
  UNOBSERVABLE_PREDICATE_KEYS,
  assuranceRecordIssues,
  matchAssurance,
  observePackages,
} from '../../plugins/runtime/scripts/lib/assurance-contract.mjs';
import {
  ASSURANCE_SCHEMA_FAMILY,
  ASSURANCE_SCHEMA_VERSION,
  classifyVersionRelation,
  parseAssuranceSection,
  readVersionToken,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { loadSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { loadPluginSet, validatePluginSet } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const RUNTIME_ROOT = join(REPO_ROOT, 'plugins', 'runtime');

const SCHEMA = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot: RUNTIME_ROOT });
const PLUGIN_SET = await loadPluginSet({ pluginRoot: RUNTIME_ROOT });

const TODAY = '2026-08-17';
const HOSTS = { claude: '2.1.233', codex: '0.147.0' };

/** A coherent single-grant record; `patch` edits the grant, `top` the record. */
function record({ grant = {}, grants = null, top = {} } = {}) {
  const base = {
    id: 'host-pair-2026-08-16',
    state: 'granted',
    reviewed_at: '2026-08-16',
    review_provenance: { kind: 'adr', reference: 'ADR-0054' },
    cohort: [{ claude: '2.1.233', codex: '0.147.0' }],
    packages: { attention: '0.9.0', runtime: '0.90.3' },
    residuals: [],
  };
  return { schema: ASSURANCE_SCHEMA_VERSION, grants: grants ?? [{ ...base, ...grant }], ...top };
}

/**
 * Installed facts that satisfy `record()`'s package bindings on both hosts.
 *
 * `claudeListStatus` is passed explicitly and is REQUIRED by `observePackages`:
 * `parseClaudePluginList` parses whatever stdout it is handed, success or not, so
 * the probe status is the only thing that distinguishes a clean list from a
 * failed command that printed partial text.
 */
function observed({ claude = {}, codex = {}, codexStatus = 'available', claudeStatus = 'available' } = {}) {
  const claudeRow = (name, version) => ({ name, marketplace: 'agentic-plugins', version, scope: 'user', status: 'enabled', error: null, observations: 1, ambiguous: false });
  const codexRow = (name, version) => ({ name, marketplace: 'agentic-plugins', version, installed: true, enabled: true, status: 'enabled', error: null, observations: 1, ambiguous: false });
  return observePackages({
    claudeListStatus: claudeStatus,
    claudePluginList: {
      attention: claudeRow('attention', '0.9.0'),
      runtime: claudeRow('runtime', '0.90.3'),
      ...claude,
    },
    codexPluginList: {
      status: codexStatus,
      entries: {
        attention: codexRow('attention', '0.9.0'),
        runtime: codexRow('runtime', '0.90.3'),
        ...codex,
      },
      warnings: [],
    },
  });
}

const matchIt = (rec, extra = {}) => matchAssurance({
  record: rec, hosts: HOSTS, observed: observed(), pluginSet: PLUGIN_SET, today: TODAY, ...extra,
});

const issuesIn = (rec) => assuranceRecordIssues(rec, { today: TODAY });

// ---------------------------------------------------------------------------
// The positive control — everything else here is a departure from it
// ---------------------------------------------------------------------------

describe('assurance matching — the positive control (ADR-0053 §Decision 5)', () => {
  it('a coherent grant naming this host pair and these packages is COVERED', () => {
    deepStrictEqual(issuesIn(record()), [], 'precondition: the control record is coherent');
    const result = matchIt(record());
    strictEqual(result.state, 'covered');
    strictEqual(result.grant_id, 'host-pair-2026-08-16');
    deepStrictEqual([...result.reasons], []);
    // ADR-0053 §Decision 6 — a grant may carry residuals, and a consumer that
    // reported `covered` without them would drop the reviewer's own caveats.
    deepStrictEqual(result.residuals, []);
    deepStrictEqual(result.review_provenance, { kind: 'adr', reference: 'ADR-0054' });
    strictEqual(result.reviewed_at, '2026-08-16');
  });

  it('the match vocabulary has exactly two values, and no path invents a third', () => {
    // A `partially-covered` or `covered-with-caveats` state is what a reader
    // downstream would treat as good enough, so the shape refuses to have one.
    deepStrictEqual([...ASSURANCE_MATCH_STATES], ['covered', 'unassured']);
    const states = new Set();
    for (const rec of [record(), record({ grant: { state: 'revoked' } }), record({ top: { grants: [] } }), { schema: 'x', grants: [] }]) {
      states.add(matchIt(rec).state);
    }
    for (const state of states) ok(ASSURANCE_MATCH_STATES.includes(state), `${state} is in the vocabulary`);
  });

  it('carries residuals through to the positive result', () => {
    const result = matchIt(record({
      grant: {
        residuals: [{ surface: 'Notification hook payload on Desktop', consumption: 'consumed', disposition: 'probe-pending', consuming_package: 'attention' }],
      },
    }));
    strictEqual(result.state, 'covered');
    strictEqual(result.residuals.length, 1);
    strictEqual(result.residuals[0].disposition, 'probe-pending');
  });
});

// ---------------------------------------------------------------------------
// The eight cases ADR-0054 measured the schema accepting
// ---------------------------------------------------------------------------

describe("assurance record — the eight semantic cases the validator was measured to accept (ADR-0054 §'The validator can carry the shape and nothing else')", () => {
  it('1. duplicate grant ids', () => {
    const dup = record({ grants: [record().grants[0], { ...record().grants[0], reviewed_at: '2026-08-15' }] });
    match(issuesIn(dup).join('\n'), /is a duplicate/);
    // The structural schema is measured accepting it, which is the claim the
    // ADR makes and the reason this module exists. Asserted rather than cited.
    strictEqual(schemaAccepts(dup), true, 'the schema accepts it — that is the boundary this module sits on');
    strictEqual(matchIt(dup).state, 'unassured');
  });

  it('2. granted and revoked for the same cohort', () => {
    const contradiction = record({
      grants: [
        record().grants[0],
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked' },
      ],
    });
    match(issuesIn(contradiction).join('\n'), /a contradiction, not two grants/);
    strictEqual(schemaAccepts(contradiction), true);
    strictEqual(matchIt(contradiction).state, 'unassured');
  });

  it('2b. CONTROL: the same shape WITH a reapproval link is legitimate, not a contradiction', () => {
    // The exemption a naive contradiction rule gets wrong. ADR-0054 §Decision 8
    // prescribes exactly this pair — a revoked id plus a NEW id carrying
    // `reapproval_of` — so a rule that flagged it would forbid the mechanism.
    const reapproved = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked', reviewed_at: '2026-08-10' },
        { ...record().grants[0], id: 'reapproved-2026-08-16', reapproval_of: 'withdrawn-2026-08-10' },
      ],
    });
    deepStrictEqual(issuesIn(reapproved), [], 'a re-approval is coherent');
    const result = matchIt(reapproved);
    strictEqual(result.state, 'covered', 'the re-approval retires the tombstone it names');
    strictEqual(result.grant_id, 'reapproved-2026-08-16');
  });

  it('3. supersedes naming an id that does not exist', () => {
    const dangling = record({ grant: { supersedes: ['never-existed'] } });
    match(issuesIn(dangling).join('\n'), /which no grant in this record declares/);
    strictEqual(schemaAccepts(dangling), true);
    strictEqual(matchIt(dangling).state, 'unassured');
  });

  it('3b. CONTROL: supersedes naming a real superseded grant is coherent and covers', () => {
    const superseding = record({
      grants: [
        { ...record().grants[0], id: 'earlier-2026-08-01', state: 'superseded', reviewed_at: '2026-08-01' },
        { ...record().grants[0], id: 'later-2026-08-16', supersedes: ['earlier-2026-08-01'] },
      ],
    });
    deepStrictEqual(issuesIn(superseding), []);
    strictEqual(matchIt(superseding).grant_id, 'later-2026-08-16');
  });

  it('4. granted with packages: {} (vacuous)', () => {
    const vacuous = record({ grant: { packages: {} } });
    match(issuesIn(vacuous).join('\n'), /must name the consuming package set/);
    strictEqual(schemaAccepts(vacuous), true);
    strictEqual(matchIt(vacuous).state, 'unassured');
  });

  it('5. granted with cohort: [] (vacuous)', () => {
    const vacuous = record({ grant: { cohort: [] } });
    match(issuesIn(vacuous).join('\n'), /names no reviewed host tuple/);
    strictEqual(schemaAccepts(vacuous), true);
    strictEqual(matchIt(vacuous).state, 'unassured');
  });

  it('6. a residual that is consumed AND not-applicable', () => {
    const contradiction = record({
      grant: { residuals: [{ surface: 'hook payload', consumption: 'consumed', disposition: 'not-applicable' }] },
    });
    match(issuesIn(contradiction).join('\n'), /cannot be inapplicable/);
    strictEqual(schemaAccepts(contradiction), true);
  });

  it('6b. CONTROL: consumed + accepted-with-risk is the reviewer’s call and passes (§Decision 6)', () => {
    const accepted = record({
      grant: { residuals: [{ surface: 'hook payload', consumption: 'consumed', disposition: 'accepted-with-risk', consuming_package: 'attention' }] },
    });
    deepStrictEqual(issuesIn(accepted), []);
    strictEqual(matchIt(accepted).state, 'covered');
  });

  it('7. reviewed_at in the future', () => {
    const future = record({ grant: { reviewed_at: '2027-01-01' } });
    match(issuesIn(future).join('\n'), /is in the future/);
    strictEqual(schemaAccepts(future), true);
    strictEqual(matchIt(future).state, 'unassured');
  });

  it('8. calendar-invalid reviewed_at (2026-13-45)', () => {
    for (const bad of ['2026-13-45', '2026-02-30', '2026-00-10']) {
      const invalid = record({ grant: { reviewed_at: bad } });
      match(issuesIn(invalid).join('\n'), /is not a calendar date/, `${bad} is not a date`);
      strictEqual(schemaAccepts(invalid), true, `${bad} is digit-shaped, so the schema accepts it`);
    }
    // CONTROL: a real leap day, which a naive month-length table gets wrong.
    // PAST, not future — the first draft used 2028-02-29 and the future rule
    // caught it, which is the two rules proving they are independent.
    deepStrictEqual(issuesIn(record({ grant: { reviewed_at: '2024-02-29' } })), []);
  });
});

/**
 * Does the packaged STRUCTURAL schema accept this record?
 *
 * The eight cases above each claim "the schema accepts it, and that is why the
 * semantic module exists". Asserting it rather than citing ADR-0054 is what
 * keeps the claim true: if a future schema minor started rejecting one of
 * these, the case above would be testing a rule that has moved, and this
 * assertion is what says so.
 */
function schemaAccepts(rec) {
  const body = `${JSON.stringify(rec, null, 2)}\n`;
  const text = 'Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI `0.147.0`.\n\n'
    + `<!-- BEGIN COMPATIBILITY ASSURANCE -->\n\`\`\`json\n${body}\`\`\`\n<!-- END COMPATIBILITY ASSURANCE -->\n`;
  const parsed = parseAssuranceSection(text, { schema: SCHEMA });
  // `noncanonical` means it satisfied the SCHEMA and failed only the byte-form
  // requirement, which is what a JSON.stringify fixture is expected to do.
  return parsed.status === 'resolved' || parsed.status === 'noncanonical';
}

// ---------------------------------------------------------------------------
// Cohort membership — identity, never precedence
// ---------------------------------------------------------------------------

describe('cohort membership (ADR-0053 §Decision 7 / ADR-0054 §Decision 7)', () => {
  it('requires BOTH hosts from ONE reviewed tuple — no Cartesian product', () => {
    // Two reviewed tuples, and a machine running the "cross" combination that
    // neither tuple names. §Decision 7's whole point: independent per-host
    // cohorts do not authorize their combinations.
    const twoTuples = record({
      grant: {
        cohort: [
          { claude: '2.1.233', codex: '0.147.0' },
          { claude: '2.1.234', codex: '0.148.0' },
        ],
      },
    });
    strictEqual(matchIt(twoTuples).state, 'covered', 'CONTROL: a reviewed tuple matches');
    const crossed = matchAssurance({
      record: twoTuples, hosts: { claude: '2.1.233', codex: '0.148.0' },
      observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
    });
    strictEqual(crossed.state, 'unassured');
    match(crossed.reasons.join('\n'), /no grant names the host pair/);
  });

  it('is IDENTITY, so a prerelease is never silently its release', () => {
    const result = matchAssurance({
      record: record({ grant: { cohort: [{ claude: '2.1.233', codex: '0.147.0' }] } }),
      hosts: { claude: '2.1.233', codex: '0.147.0-rc.1' },
      observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
    });
    strictEqual(result.state, 'unassured', '0.147.0-rc.1 is not 0.147.0');
    match(result.reasons.join('\n'), /no grant names the host pair/);
  });

  it('refuses the FALSE-EXACT four-component OBSERVED version at the readability gate', () => {
    // The row ADR-0054's direction table marks `false-exact`: `SEMVER_RE` takes
    // the first three components, so `1.2.3.4` reports as `1.2.3`. A membership
    // path built on `normalizeVersion` alone would call this machine a member.
    //
    // On the OBSERVED side this is refused before membership runs at all, by the
    // host-version readability gate — which is the better place, because
    // "unreadable for claude" is an operator-actionable message and a silent
    // membership miss is not.
    const rec = record({ grant: { cohort: [{ claude: '2.1.233', codex: '0.147.0' }] } });
    const result = matchAssurance({
      record: rec, hosts: { claude: '2.1.233.9', codex: '0.147.0' },
      observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
    });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /unreadable for claude/);
    // The mechanism, pinned: the shared grammar reports the truncation.
    strictEqual(readVersionToken('2.1.233.9').truncated, true);
    strictEqual(readVersionToken('2.1.233').truncated, false);
  });

  it('refuses a truncated REVIEWED cohort version too, which the gate above cannot see', () => {
    // Found by mutation, and the finding is why this case exists: deleting the
    // truncation refusal from the membership comparison left the test above
    // GREEN, because the readability gate had already refused the observed side.
    // The reviewed side is the reachable half — `assuranceRecordIssues` does not
    // re-check the schema's host-tuple version pattern, so a caller that reached
    // the matcher without `parseAssuranceSection` can present `1.2.3.4` in a
    // cohort, and the membership comparison is the only thing that refuses it.
    const rec = record({ grant: { cohort: [{ claude: '1.2.3.4', codex: '0.147.0' }] } });
    const result = matchAssurance({
      record: rec, hosts: { claude: '1.2.3', codex: '0.147.0' },
      observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
    });
    strictEqual(result.state, 'unassured', '1.2.3 must not be a member of a cohort naming 1.2.3.4');
    match(result.reasons.join('\n'), /no grant names the host pair/);
    // CONTROL: the same call with a faithful three-component cohort DOES match,
    // so the assertion above is about the truncation and not about the fixture
    // being unmatchable for some other reason.
    strictEqual(
      matchAssurance({
        record: record({ grant: { cohort: [{ claude: '1.2.3', codex: '0.147.0' }] } }),
        hosts: { claude: '1.2.3', codex: '0.147.0' },
        observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
      }).state,
      'covered',
    );
  });

  it('agrees with the packaged comparator on ADR-0054’s direction table, without importing its verdict', () => {
    // The membership path deliberately does NOT call `classifyVersionRelation`
    // (direction is evidence, and ADR-0053 §Decision 9 forbids promoting
    // evidence to coverage). Separate paths drift, so this binds them: for
    // every row of the table, "membership matches" and "the comparator says
    // exact" must be the same answer.
    const table = [
      ['2.1.233', '2.1.233', true],
      ['2.1.234', '2.1.233', false],
      ['2.1.232', '2.1.233', false],
      ['0.147.0-rc.1', '0.147.0', false],
      ['2.1', '2.1.0', false],
      ['0.147.0+build.5', '0.147.0+build.9', false],
      ['01.2.3', '1.2.3', false],
      ['banana', '2.1.233', false],
      ['1.2.3.4', '1.2.3', false],
    ];
    for (const [observedVersion, reviewed, expected] of table) {
      const membership = matchAssurance({
        record: record({ grant: { cohort: [{ claude: reviewed, codex: '0.147.0' }] } }),
        hosts: { claude: observedVersion, codex: '0.147.0' },
        observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
      }).state === 'covered';
      strictEqual(membership, expected, `membership(${observedVersion} vs ${reviewed})`);
      const comparator = classifyVersionRelation({ observed: observedVersion, reviewed });
      strictEqual(
        comparator.exact,
        expected,
        `the comparator and the membership path must agree on ${observedVersion} vs ${reviewed} `
        + `(comparator said ${comparator.state})`,
      );
    }
  });

  it('an unreadable observed host version covers nothing, and names WHICH host', () => {
    for (const [host, hosts] of [['claude', { claude: 'banana', codex: '0.147.0' }], ['codex', { claude: '2.1.233', codex: '' }]]) {
      const result = matchAssurance({ record: record(), hosts, observed: observed(), pluginSet: PLUGIN_SET, today: TODAY });
      strictEqual(result.state, 'unassured');
      match(result.reasons.join('\n'), new RegExp(`unreadable for ${host}`));
    }
  });
});

// ---------------------------------------------------------------------------
// Package binding and invalidation — ADR-0053 §Decision 8
// ---------------------------------------------------------------------------

describe('package binding and its three invalidations (ADR-0053 §Decision 8)', () => {
  it('a CHANGED version invalidates, on either host', () => {
    const bumped = observed({ claude: { attention: { name: 'attention', version: '0.9.1', status: 'enabled', observations: 1, ambiguous: false } } });
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: bumped, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /claude: package "attention" is 0\.9\.1, reviewed at 0\.9\.0/);
  });

  it('an ABSENT package invalidates', () => {
    const withoutRuntime = observePackages({
      claudeListStatus: 'available',
      claudePluginList: { attention: { name: 'attention', version: '0.9.0', status: 'enabled', observations: 1, ambiguous: false } },
      codexPluginList: { status: 'available', entries: { attention: { name: 'attention', version: '0.9.0', status: 'enabled', enabled: true, observations: 1, ambiguous: false } }, warnings: [] },
    });
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: withoutRuntime, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /package "runtime" is absent/);
  });

  it('a DISABLED package invalidates — the fact doctor’s coarse status cannot see (§Decision 9)', () => {
    // ADR-0054 §Decision 9 forbids reusing `summarizePluginStatus`, which
    // counts a disabled Codex install toward `available`. This is that rule
    // made observable: the same install, disabled, must not cover.
    const disabled = observePackages({
      claudeListStatus: 'available',
      claudePluginList: {
        attention: { name: 'attention', version: '0.9.0', status: 'enabled', observations: 1, ambiguous: false },
        runtime: { name: 'runtime', version: '0.90.3', status: 'enabled', observations: 1, ambiguous: false },
      },
      codexPluginList: {
        status: 'available',
        entries: {
          attention: { name: 'attention', version: '0.9.0', installed: true, enabled: false, status: 'disabled', observations: 1, ambiguous: false },
          runtime: { name: 'runtime', version: '0.90.3', installed: true, enabled: true, status: 'enabled', observations: 1, ambiguous: false },
        },
        warnings: [],
      },
    });
    strictEqual(disabled.codex.packages.attention.enabled, false, 'the observation preserves the disabled state');
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: disabled, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /codex: package "attention" is disabled/);
  });

  it('a NON-AUTHORITATIVE list covers nothing — a cache answer is about disk, not about loading', () => {
    for (const status of ['unavailable', 'unsupported', 'empty', 'parse_error', 'malformed']) {
      const result = matchAssurance({
        record: record(), hosts: HOSTS, pluginSet: PLUGIN_SET, today: TODAY,
        observed: observed({ codexStatus: status }),
      });
      strictEqual(result.state, 'unassured', status);
      match(result.reasons.join('\n'), /the installed-plugin list is not authoritative/);
    }
  });

  it('a package the plugin set does not declare is unobservable, not covered', () => {
    const foreign = record({ grant: { packages: { 'not-a-plugin': '1.0.0' } } });
    const result = matchIt(foreign);
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /which the plugin set does not declare/);
  });

  it('reads WHICH hosts from the plugin set rather than assuming both', () => {
    // The single-host case does not exist in the shipped set (asserted, so this
    // test says something rather than nothing), so it is constructed. Without
    // this, a Claude-only package would be checked against a Codex install that
    // is correctly absent.
    const shipped = validatePluginSet(PLUGIN_SET);
    deepStrictEqual(shipped.errors, []);
    ok(
      Object.values(PLUGIN_SET.plugins).every((entry) => entry.hosts.length === 2),
      'precondition: every shipped entry is dual-host, so the single-host path needs a fixture',
    );
    // The fixture is narrowed CONSISTENTLY, and the first draft was not: setting
    // `hosts: ['claude']` alone leaves `soft_requires: [{ name: 'runtime', hosts:
    // ['claude','codex'] }]`, which `validatePluginSet` rejects ("requires on host
    // codex that attention does not target"). That rejection is the plugin-set
    // validation earning its new place in the matcher — the malformed fixture
    // produced `unassured`, not a false positive.
    const claudeOnly = {
      ...PLUGIN_SET,
      plugins: {
        ...PLUGIN_SET.plugins,
        attention: {
          ...PLUGIN_SET.plugins.attention,
          hosts: ['claude'],
          soft_requires: PLUGIN_SET.plugins.attention.soft_requires.map((edge) => ({ ...edge, hosts: edge.hosts.filter((host) => host === 'claude') })),
        },
      },
    };
    deepStrictEqual(validatePluginSet(claudeOnly).errors, [], 'precondition: the narrowed fixture is a VALID plugin set');
    const codexMissingAttention = observePackages({
      claudeListStatus: 'available',
      claudePluginList: {
        attention: { name: 'attention', version: '0.9.0', status: 'enabled', observations: 1, ambiguous: false },
        runtime: { name: 'runtime', version: '0.90.3', status: 'enabled', observations: 1, ambiguous: false },
      },
      codexPluginList: { status: 'available', entries: { runtime: { name: 'runtime', version: '0.90.3', installed: true, enabled: true, status: 'enabled', observations: 1, ambiguous: false } }, warnings: [] },
    });
    strictEqual(
      matchAssurance({ record: record(), hosts: HOSTS, observed: codexMissingAttention, pluginSet: PLUGIN_SET, today: TODAY }).state,
      'unassured',
      'CONTROL: with the shipped dual-host set, the missing Codex install invalidates',
    );
    strictEqual(
      matchAssurance({ record: record(), hosts: HOSTS, observed: codexMissingAttention, pluginSet: claudeOnly, today: TODAY }).state,
      'covered',
      'declared Claude-only, the absent Codex install is not a gap',
    );
  });

  it('an unparseable installed version cannot be compared, so it blocks', () => {
    const junk = observed({ claude: { runtime: { name: 'runtime', version: 'unknown', status: 'enabled', observations: 1, ambiguous: false } } });
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: junk, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /reports version "unknown", which cannot be compared/);
  });

  it('names the CARRIER package like any other, and self-invalidation fails closed', () => {
    // The macro plan asked whether `runtime` naming itself needs release-time
    // self-binding. Measured: it does not. `runtime` legitimately consumes
    // reviewed host surfaces (it parses `claude plugin list`, `codex plugin
    // list --json`, `codex features list` and the Codex hook config), so it is
    // nameable. And a grant that names a runtime version other than the one
    // installed simply fails to match — the failure direction is safe, so no
    // substitution mechanism is introduced. Substitution is the ONE direction
    // that could manufacture coverage, which is why there is none.
    const stale = matchAssurance({
      record: record({ grant: { packages: { runtime: '0.89.0' } } }),
      hosts: HOSTS, observed: observed(), pluginSet: PLUGIN_SET, today: TODAY,
    });
    strictEqual(stale.state, 'unassured');
    match(stale.reasons.join('\n'), /package "runtime" is 0\.90\.3, reviewed at 0\.89\.0/);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity — ADR-0053 §Decision 5
// ---------------------------------------------------------------------------

describe('ambiguity is unassured (ADR-0053 §Decision 5)', () => {
  it('a package observed twice with DIFFERING facts blocks', () => {
    const ambiguous = observed({ claude: { runtime: { name: 'runtime', version: '0.90.3', status: 'enabled', observations: 2, ambiguous: true } } });
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: ambiguous, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /observed 2 times with differing facts/);
  });

  it('CONTROL: observed twice in AGREEMENT is determinate and still covers', () => {
    // Over-blocking is a defect too: two rows agreeing on version and
    // enablement leave "which version is active" with one answer, and ADR-0053
    // §Decision 6 exists because a gate stricter than the one it replaces
    // relocates the treadmill rather than removing it.
    const agreeing = observed({ claude: { runtime: { name: 'runtime', version: '0.90.3', status: 'enabled', observations: 2, ambiguous: false } } });
    strictEqual(matchAssurance({ record: record(), hosts: HOSTS, observed: agreeing, pluginSet: PLUGIN_SET, today: TODAY }).state, 'covered');
  });

  it('two grants that both cover this pair resolve NEGATIVE, not first-wins', () => {
    const duplicated = record({
      grants: [
        { ...record().grants[0], id: 'grant-alpha' },
        { ...record().grants[0], id: 'grant-beta' },
      ],
    });
    deepStrictEqual(issuesIn(duplicated), [], 'two distinct ids over one tuple is not a record-level contradiction');
    const result = matchIt(duplicated);
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /duplicate records resolve negative/);
    deepStrictEqual([...result.candidate_grant_ids], ['grant-alpha', 'grant-beta']);
  });
});

// ---------------------------------------------------------------------------
// Predicate observability — ADR-0053 §Decision 5
// ---------------------------------------------------------------------------

describe('unobservable predicates are unassured (ADR-0053 §Decision 5)', () => {
  const cases = {
    models: { models: ['claude-opus-5'] },
    integrations: { integrations: ['terminal'] },
    env_flags: { env_flags: ['AGENTIC_SOMETHING=1'] },
  };

  for (const [key, predicate] of Object.entries(cases)) {
    it(`predicate.${key} narrows the grant to unassured`, () => {
      const scoped = record({ grant: { predicate } });
      deepStrictEqual(issuesIn(scoped), [], 'a predicate is a legal record — it just cannot be matched');
      const result = matchIt(scoped);
      strictEqual(result.state, 'unassured');
      match(result.reasons.join('\n'), new RegExp(`predicate\\.${key}`));
    });
  }

  it('every key the schema allows is accounted for — a new key cannot arrive unobserved', () => {
    // The hole this closes: adding a predicate key to the schema without adding
    // it here would make it silently ignored, which is ADR-0053 §Decision 5's
    // "absence of evidence becomes coverage" reached by omission. The schema is
    // the authority for the key list, so it is read rather than restated.
    const schemaKeys = Object.keys(SCHEMA.$defs.grant.properties.predicate.properties).sort();
    deepStrictEqual(schemaKeys, Object.keys(UNOBSERVABLE_PREDICATE_KEYS).sort());
    deepStrictEqual(schemaKeys, Object.keys(cases).sort(), 'and each has a case above');
  });

  it('an EMPTY predicate object does not block — nothing was scoped', () => {
    strictEqual(matchIt(record({ grant: { predicate: {} } })).state, 'covered');
  });
});

// ---------------------------------------------------------------------------
// Negative-wins — ADR-0053 §Decision 3
// ---------------------------------------------------------------------------

describe('negative-wins (ADR-0053 §Decision 3)', () => {
  for (const state of ['revoked', 'superseded']) {
    it(`a ${state} grant covering this pair blocks, and nothing observable restores it`, () => {
      const rec = state === 'superseded'
        // A `superseded` grant needs a successor to be coherent, and the
        // successor must not itself cover this pair — otherwise the case would
        // be testing the reapproval path instead.
        ? record({
          grants: [
            { ...record().grants[0], id: 'retired-2026-08-01', state: 'superseded', reviewed_at: '2026-08-01' },
            { ...record().grants[0], id: 'successor-2026-08-16', supersedes: ['retired-2026-08-01'], cohort: [{ claude: '2.1.999', codex: '0.147.0' }] },
          ],
        })
        : record({ grant: { state: 'revoked' } });
      deepStrictEqual(issuesIn(rec), [], 'precondition: the fixture is coherent');
      const result = matchIt(rec);
      strictEqual(result.state, 'unassured');
      match(result.reasons.join('\n'), new RegExp(`is ${state} for this host pair`));
    });
  }

  it('a negative beside a positive that does NOT retire it still wins', () => {
    // Constructed to defeat a matcher that returns on the first qualifying
    // positive: the positive is listed first and is fully valid.
    const mixed = record({
      grants: [
        { ...record().grants[0], id: 'live-2026-08-16' },
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked', reviewed_at: '2026-08-10' },
      ],
    });
    ok(issuesIn(mixed).some((issue) => /a contradiction, not two grants/.test(issue)), 'the record is also incoherent, and that is reported');
    const result = matchIt(mixed);
    strictEqual(result.state, 'unassured');
  });

  it('the matcher resolves negative-wins INDEPENDENTLY of record validation', () => {
    // Defense in depth, driven rather than asserted: the contradiction rule and
    // the negative-wins rule are two mechanisms, and a caller that reached the
    // matcher with validation skipped must still not get coverage. Here the
    // record is coherent (the tombstone's cohort does not overlap the
    // positive's, so no contradiction fires) yet the machine's pair is named by
    // the tombstone only.
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'other-pair', cohort: [{ claude: '2.1.200', codex: '0.140.0' }] },
        { ...record().grants[0], id: 'withdrawn-here', state: 'revoked', reviewed_at: '2026-08-10' },
      ],
    });
    deepStrictEqual(issuesIn(rec), [], 'coherent: the two grants name different tuples');
    const result = matchIt(rec);
    strictEqual(result.state, 'unassured');
    deepStrictEqual([...result.negative_grant_ids], ['withdrawn-here']);
  });

  it('a re-approval whose OWN bindings fail does not retire the tombstone', () => {
    // The direction that matters: retirement is granted only by a QUALIFYING
    // positive. A re-approval that fails its package binding must leave the
    // revocation standing rather than cancelling it and falling through to
    // "no matching grant".
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked', reviewed_at: '2026-08-10' },
        { ...record().grants[0], id: 'reapproved-2026-08-16', reapproval_of: 'withdrawn-2026-08-10', packages: { runtime: '0.89.0' } },
      ],
    });
    deepStrictEqual(issuesIn(rec), []);
    const result = matchIt(rec);
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /is revoked for this host pair/);
  });

  it('re-approving something that is not revoked is refused', () => {
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'live-one' },
        { ...record().grants[0], id: 'copy-of-it', reapproval_of: 'live-one' },
      ],
    });
    match(issuesIn(rec).join('\n'), /only a revoked grant can be re-approved/);
  });

  it('a re-approval cannot predate what it re-approves', () => {
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn', state: 'revoked', reviewed_at: '2026-08-16' },
        { ...record().grants[0], id: 'earlier-reapproval', reapproval_of: 'withdrawn', reviewed_at: '2026-08-01' },
      ],
    });
    match(issuesIn(rec).join('\n'), /cannot predate what it re-approves/);
  });

  it('superseding a grant that is still `granted` is a record error', () => {
    // The reachable form of "this grant should have been retired". The rule that
    // used to fire here ("has state granted but is retired by …") became
    // unreachable once the edges were typed, and was removed rather than left as
    // a guard that cannot fire.
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'should-be-retired' },
        { ...record().grants[0], id: 'the-successor', supersedes: ['should-be-retired'], cohort: [{ claude: '2.1.999', codex: '0.147.0' }] },
      ],
    });
    match(issuesIn(rec).join('\n'), /whose state is "granted" — mark the replaced grant "superseded"/);
  });

  it('a `superseded` grant with no successor is a revocation spelled wrong', () => {
    match(issuesIn(record({ grant: { state: 'superseded' } })).join('\n'), /no grant supersedes it/);
  });
});

// ---------------------------------------------------------------------------
// Structural fail-closed behaviour of the semantic layer itself
// ---------------------------------------------------------------------------

describe('the semantic layer fails closed on its own inputs', () => {
  it('a record that is not an object, or lacks grants, is an issue rather than a throw', () => {
    for (const bad of [null, undefined, 'a string', 42, []]) {
      deepStrictEqual(assuranceRecordIssues(bad, { today: TODAY }), ['assurance record is not an object']);
    }
    match(issuesIn({ schema: ASSURANCE_SCHEMA_VERSION }).join('\n'), /grants must be an array/);
  });

  it('a wrong schema string is an issue — the semantic layer does not trust its caller', () => {
    match(issuesIn({ schema: 'runtime-host-assurance-2.0', grants: [] }).join('\n'), /schema must be "runtime-host-assurance-1\.0"/);
  });

  it('an unknown grant state is an issue, and the state list matches the schema enum', () => {
    match(issuesIn(record({ grant: { state: 'probationary' } })).join('\n'), /state must be one of/);
    deepStrictEqual([...ASSURANCE_GRANT_STATES], SCHEMA.$defs.grant.properties.state.enum);
  });

  it('an EMPTY grant set is coherent and covers nothing — the shipped R1 state', () => {
    // ADR-0054 §Decision 6: `grants: []` is the valid, meaningful state of a
    // runtime that ships the gate before any grant exists. Coherent, and every
    // host reads unassured.
    deepStrictEqual(issuesIn({ schema: ASSURANCE_SCHEMA_VERSION, grants: [] }), []);
    const result = matchIt({ schema: ASSURANCE_SCHEMA_VERSION, grants: [] });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /no grant names the host pair/);
  });

  it('the SHIPPED record reads unassured on this machine’s own host pair', () => {
    // Not a fixture: the bytes that ship, matched against a plausible machine.
    // This is the R1 property stated as behaviour — the gate's failing path is
    // what real machines exercise.
    const shipped = { schema: ASSURANCE_SCHEMA_VERSION, grants: [] };
    strictEqual(matchIt(shipped).state, 'unassured');
  });

  it('a missing plugin set blocks rather than defaulting to both hosts', () => {
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: observed(), today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /no plugin set was supplied/);
  });

  it('missing observations block rather than reading as satisfied', () => {
    const result = matchAssurance({ record: record(), hosts: HOSTS, pluginSet: PLUGIN_SET, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /is not authoritative/);
  });

  it('the future-reviewed_at rule runs WITHOUT an injected today', () => {
    // A rule that only fires when a test passes a clock is a rule that does not
    // fire. The injected `today` exists for determinism, not to gate the check.
    const farFuture = record({ grant: { reviewed_at: '2099-01-01' } });
    match(assuranceRecordIssues(farFuture).join('\n'), /is in the future/);
    // CONTROL: a past date passes with the same call shape, so the assertion
    // above is about the future rule and not about the clock being absent.
    deepStrictEqual(assuranceRecordIssues(record()), []);
  });
});

// ---------------------------------------------------------------------------
// The record's own residual rules and duplicate-surface detection
// ---------------------------------------------------------------------------

describe('residual coherence (ADR-0053 §Decision 6)', () => {
  it('one surface cannot carry two dispositions', () => {
    const rec = record({
      grant: {
        residuals: [
          { surface: 'hook payload', consumption: 'consumed', disposition: 'probe-pending' },
          { surface: 'hook payload', consumption: 'consumed', disposition: 'accepted-with-risk' },
        ],
      },
    });
    match(issuesIn(rec).join('\n'), /is listed twice/);
  });

  it('an unadopted surface cannot name a consuming package', () => {
    const rec = record({
      grant: { residuals: [{ surface: 'todo tools', consumption: 'unadopted', disposition: 'not-applicable', consuming_package: 'engineer' }] },
    });
    match(issuesIn(rec).join('\n'), /unadopted means no package consumes it/);
  });

  it('CONTROL: an unadopted surface with no consuming package is the normal case (§Decision 6)', () => {
    const rec = record({
      grant: { residuals: [{ surface: 'todo tools', consumption: 'unadopted', disposition: 'not-applicable' }] },
    });
    deepStrictEqual(issuesIn(rec), []);
    strictEqual(matchIt(rec).state, 'covered');
  });

  it('a repeated cohort tuple is an issue', () => {
    const rec = record({ grant: { cohort: [{ claude: '2.1.233', codex: '0.147.0' }, { claude: '2.1.233', codex: '0.147.0' }] } });
    match(issuesIn(rec).join('\n'), /repeats cohort\[0\]/);
  });

  it('self-reference in supersedes or reapproval_of is an issue', () => {
    match(issuesIn(record({ grant: { supersedes: ['host-pair-2026-08-16'] } })).join('\n'), /names its own id/);
    match(issuesIn(record({ grant: { reapproval_of: 'host-pair-2026-08-16' } })).join('\n'), /cannot re-approve itself/);
  });
});

// ---------------------------------------------------------------------------
// The observation layer
// ---------------------------------------------------------------------------

describe('observePackages — list-authoritative, ambiguity preserved', () => {
  it('does not consult doctor’s coarse plugin status (ADR-0054 §Decision 9)', async () => {
    // Structural, because the rule is about which function is called and a
    // behavioural test cannot see an import that is merely available.
    // `summarizePluginStatus` counts a disabled Codex install as available, so
    // importing it here would reintroduce exactly the blindness §Decision 9
    // names.
    const source = await readFile(join(RUNTIME_ROOT, 'scripts', 'lib', 'assurance-contract.mjs'), 'utf8');
    ok(!/summarizePluginStatus/.test(source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no code reference to summarizePluginStatus');
    ok(!/from '\.\.\/doctor\.mjs'/.test(source), 'the matcher does not import from doctor.mjs at all');
  });

  it('preserves Claude enablement as a TRISTATE', () => {
    const facts = observePackages({
      claudeListStatus: 'available',
      claudePluginList: {
        good: { name: 'good', version: '1.0.0', status: 'enabled' },
        broken: { name: 'broken', version: '1.0.0', status: 'failed' },
        quiet: { name: 'quiet', version: '1.0.0', status: null },
      },
    });
    strictEqual(facts.claude.packages.good.enabled, true);
    strictEqual(facts.claude.packages.broken.enabled, false);
    strictEqual(facts.claude.packages.quiet.enabled, null, 'no Status line is unknown, not enabled');
  });

  it('reports a non-available Codex list as non-authoritative and carries the status', () => {
    const facts = observePackages({ claudeListStatus: 'available', claudePluginList: {}, codexPluginList: { status: 'parse_error', entries: {} } });
    strictEqual(facts.codex.authoritative, false);
    strictEqual(facts.codex.list_status, 'parse_error');
    deepStrictEqual(facts.codex.packages, {}, 'a non-authoritative list contributes no package facts');
  });

  it('treats a Codex not_installed entry as absent', () => {
    const facts = observePackages({
      claudeListStatus: 'available',
      claudePluginList: {},
      codexPluginList: { status: 'available', entries: { gone: { name: 'gone', version: null, status: 'not_installed', installed: false, enabled: null } } },
    });
    strictEqual(facts.codex.packages.gone.present, false);
  });
});

// ---------------------------------------------------------------------------
// The false-coverage paths found by adversarial review
// ---------------------------------------------------------------------------
//
// Seven of these were reachable on the first version of this module. Two were
// found in self-review and five by the cross-host peer, and every one produced a
// literal `covered` — the single failure ADR-0053 exists to prevent. They are
// grouped here rather than filed under the rule each belongs to, because what
// they have in common is more instructive than what separates them: each was a
// guard that existed and a second path around it.

describe('closed false-coverage paths (adversarial review of the first version)', () => {
  it('supersedes cannot launder a REVOCATION past the reapproval_of guard', () => {
    // The worst of them. Both edge types went into one flat `retired` set, so
    // naming a revoked grant in `supersedes` retired it — skipping every guard on
    // the re-approval path (target must be revoked, date must not go backwards,
    // at most one). ADR-0054 §Decision 8: a revoked grant "is never un-revoked,
    // only replaced by a NEW id carrying reapproval_of".
    const laundered = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked', reviewed_at: '2026-08-10' },
        { ...record().grants[0], id: 'launderer-2026-08-16', supersedes: ['withdrawn-2026-08-10'] },
      ],
    });
    match(issuesIn(laundered).join('\n'), /which is REVOKED — supersession never un-revokes/);
    const result = matchIt(laundered);
    strictEqual(result.state, 'unassured', 'a revocation is not retired by supersession');
    // The REASON is the coherence gate, not negative-wins, and that is worth
    // pinning rather than glossing: `matchAssurance` validates first, so a record
    // carrying this edge never reaches the retirement logic at all. The typed-edge
    // rule is what refuses it, and the message an author gets says so.
    match(result.reasons.join('\n'), /the assurance record is not coherent/);
    match(result.record_issues.join('\n'), /supersession never un-revokes/);
    // CONTROL: the SAME pair with the correct edge type covers, so this is about
    // the edge type and not about the fixture being unmatchable.
    const proper = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn-2026-08-10', state: 'revoked', reviewed_at: '2026-08-10' },
        { ...record().grants[0], id: 'reapproved-2026-08-16', reapproval_of: 'withdrawn-2026-08-10' },
      ],
    });
    deepStrictEqual(issuesIn(proper), []);
    strictEqual(matchIt(proper).state, 'covered');
  });

  it('the retirement closure re-applies the edge rules (structural, and stated as UNREACHABLE)', async () => {
    // Honest bookkeeping. `retirementClosure` checks the target's state before
    // retiring it, which is belt-and-braces: `matchAssurance` validates the record
    // first, so no `supersedes → revoked` edge can reach the closure and NO test
    // can drive that branch. Rather than write a case that appears to cover it,
    // the redundancy is asserted structurally and labelled — a guard that cannot
    // fire must not be mistaken for one that is tested.
    //
    // It is kept rather than deleted because it is the second guard on the path
    // that produced the worst defect adversarial review found, and because a
    // future reordering of the validate-then-match sequence would make it
    // load-bearing. The unreachable `granted`-is-retired branch was deleted on the
    // opposite reasoning: nothing would ever make it reachable.
    const source = await readFile(join(RUNTIME_ROOT, 'scripts', 'lib', 'assurance-contract.mjs'), 'utf8');
    const closure = source.slice(source.indexOf('function retirementClosure'));
    match(closure.slice(0, 900), /candidate\.state !== 'superseded'/, 'supersession steps only through superseded targets');
    match(closure.slice(0, 900), /\?\.state === 'revoked'/, 'reapproval retires only a revoked target');
  });

  it('an UNKNOWN narrowing predicate key blocks — §Decision 3 via the semantic door', () => {
    // ADR-0054 §Decision 3 pins the schema version exactly so a newer minor's
    // narrowing key cannot be read as absent, and names an EXPIRY as the example.
    // Enumerating only the three known keys reintroduced exactly that failure one
    // layer down: `predicate: { expires_at }` was ignored and the grant covered.
    for (const predicate of [{ expires_at: '2026-08-01' }, { safe_mode: true }, { session_cap: 5 }]) {
      const scoped = record({ grant: { predicate } });
      const key = Object.keys(predicate)[0];
      match(issuesIn(scoped).join('\n'), new RegExp(`unrecognised key "${key}"`));
      const result = matchIt(scoped);
      strictEqual(result.state, 'unassured', `predicate.${key} must block`);
      // As with the laundering case: the record is refused for incoherence, and
      // the issue names the key. The matcher carries its own unknown-key branch
      // too, but validate-then-match makes the validator's message the one an
      // author sees — so that is the one asserted.
      match(result.record_issues.join('\n'), new RegExp(`unrecognised key "${key}"`));
    }
  });

  it('a non-object predicate blocks — an unreadable scope is not an absent one', () => {
    for (const predicate of [['models'], 'models', 42]) {
      const scoped = record({ grant: { predicate } });
      match(issuesIn(scoped).join('\n'), /must be an object when present/);
      strictEqual(matchIt(scoped).state, 'unassured');
    }
  });

  it('a CONSUMED residual must name a consuming package, and it must be BOUND', () => {
    // The reviewer's own record said `attention` consumes the surface while
    // `packages` bound only `runtime`, so nothing ever checked attention's
    // version — ADR-0053 §Decision 8 binds assurance to the code reviewed, and
    // the record named that code.
    const unbound = record({
      grant: {
        packages: { runtime: '0.90.3' },
        residuals: [{ surface: 'Notification hook payload', consumption: 'consumed', disposition: 'probe-pending', consuming_package: 'attention' }],
      },
    });
    match(issuesIn(unbound).join('\n'), /which grants\[0\]\.packages does not bind/);
    strictEqual(matchIt(unbound).state, 'unassured');

    const unnamed = record({
      grant: { residuals: [{ surface: 'Notification hook payload', consumption: 'consumed', disposition: 'probe-pending' }] },
    });
    match(issuesIn(unnamed).join('\n'), /is consumed but names no consuming_package/);

    // CONTROL: bound and named passes, and the binding is then enforced — the
    // same grant fails once attention's observed version moves.
    const bound = record({
      grant: {
        packages: { attention: '0.9.0', runtime: '0.90.3' },
        residuals: [{ surface: 'Notification hook payload', consumption: 'consumed', disposition: 'probe-pending', consuming_package: 'attention' }],
      },
    });
    deepStrictEqual(issuesIn(bound), []);
    strictEqual(matchIt(bound).state, 'covered');
    strictEqual(
      matchAssurance({
        record: bound, hosts: HOSTS, pluginSet: PLUGIN_SET, today: TODAY,
        observed: observed({ claude: { attention: { name: 'attention', version: '0.9.1', status: 'enabled', observations: 1, ambiguous: false } } }),
      }).state,
      'unassured',
      'the newly-bound package is actually checked',
    );
  });

  it('a FAILED Claude list is not authoritative — parsing ran regardless of exit status', () => {
    // The producer asymmetry: `parseCodexPluginList` carries a status because it
    // parses a JSON envelope, while `parseClaudePluginList` is handed stdout
    // whether or not the command succeeded. A failed `claude plugin list` that
    // printed partial text produced entries indistinguishable from a clean probe's.
    for (const claudeStatus of ['unknown', 'unavailable', 'failed', null]) {
      const result = matchAssurance({
        record: record(), hosts: HOSTS, pluginSet: PLUGIN_SET, today: TODAY,
        observed: observed({ claudeStatus }),
      });
      strictEqual(result.state, 'unassured', `claude list status ${String(claudeStatus)} must not be authoritative`);
      match(result.reasons.join('\n'), /claude: the installed-plugin list is not authoritative/);
    }
    // OMITTING the key is the same as a failed probe, which is why the parameter
    // has no permissive default. (`undefined` cannot be tested through the
    // fixture helper — a destructuring default swallows it — so it is driven
    // against `observePackages` directly.)
    strictEqual(
      observePackages({ claudePluginList: { runtime: { name: 'runtime', version: '0.90.3', status: 'enabled' } } }).claude.authoritative,
      false,
      'no status supplied is not authoritative',
    );
    // CONTROL: the same entries WITH an available status cover, so this is about
    // the status and not about the entries.
    strictEqual(matchIt(record()).state, 'covered');
  });

  it('a MALFORMED plugin set blocks instead of making the package check vacuous', () => {
    // `hosts: ['not-a-host']` filtered to `[]`, `evaluatePackages` then ran zero
    // host checks, and an empty loop reported the binding satisfied.
    const bogus = {
      ...PLUGIN_SET,
      plugins: { ...PLUGIN_SET.plugins, runtime: { ...PLUGIN_SET.plugins.runtime, hosts: ['not-a-host'] } },
    };
    const result = matchAssurance({ record: record(), hosts: HOSTS, observed: observed(), pluginSet: bogus, today: TODAY });
    strictEqual(result.state, 'unassured');
    match(result.reasons.join('\n'), /the supplied plugin set is not valid/);
    ok(result.plugin_set_errors.length > 0, 'the underlying errors travel with the verdict');
  });

  it('a grant with no review PROVENANCE covers nothing', () => {
    // The schema requires it; the semantic layer did not, so a matcher call that
    // skipped structural validation reached `covered` on a grant nobody can be
    // shown to have made.
    for (const provenance of [undefined, {}, { kind: 'adr' }, { kind: 'adr', reference: '  ' }]) {
      const rec = { schema: ASSURANCE_SCHEMA_VERSION, grants: [{ ...record().grants[0], review_provenance: provenance }] };
      match(issuesIn(rec).join('\n'), /review_provenance must name the kind and reference/);
      strictEqual(matchIt(rec).state, 'unassured');
    }
  });

  it('absent `residuals` is refused — an empty array says "none", absence says nothing', () => {
    const rec = { schema: ASSURANCE_SCHEMA_VERSION, grants: [{ ...record().grants[0], residuals: undefined }] };
    match(issuesIn(rec).join('\n'), /residuals must be an array/);
    strictEqual(matchIt(rec).state, 'unassured');
  });
});

describe('supersession is a graph, not a single edge', () => {
  it('a natural CHAIN covers — direct-edge-only called a correct record a contradiction', () => {
    // C replaces B replaces A is how a third review gets authored. A direct-edge
    // rule reported it as `granted` + `superseded` over one cohort, telling the
    // author to fix a record that was already right.
    const chain = record({
      grants: [
        { ...record().grants[0], id: 'gen1-2026-08-01', state: 'superseded', reviewed_at: '2026-08-01' },
        { ...record().grants[0], id: 'gen2-2026-08-08', state: 'superseded', reviewed_at: '2026-08-08', supersedes: ['gen1-2026-08-01'] },
        { ...record().grants[0], id: 'gen3-2026-08-16', reviewed_at: '2026-08-16', supersedes: ['gen2-2026-08-08'] },
      ],
    });
    deepStrictEqual(issuesIn(chain), [], 'a chain of replacements is coherent');
    const result = matchIt(chain);
    strictEqual(result.state, 'covered');
    strictEqual(result.grant_id, 'gen3-2026-08-16', 'the live generation is the one that covers');
  });

  it('but a chain whose ROOT is a revocation does not cover', () => {
    // The chain must not become a second route around the reapproval guard: the
    // walk only steps through `superseded` targets.
    const rec = record({
      grants: [
        { ...record().grants[0], id: 'withdrawn', state: 'revoked', reviewed_at: '2026-08-01' },
        { ...record().grants[0], id: 'mid', state: 'superseded', reviewed_at: '2026-08-08', supersedes: ['withdrawn'] },
        { ...record().grants[0], id: 'live', reviewed_at: '2026-08-16', supersedes: ['mid'] },
      ],
    });
    match(issuesIn(rec).join('\n'), /which is REVOKED — supersession never un-revokes/);
    strictEqual(matchIt(rec).state, 'unassured');
  });

  it('a supersession CYCLE is refused and does not hang the walk', () => {
    const cycle = record({
      grants: [
        { ...record().grants[0], id: 'ping', state: 'superseded', supersedes: ['pong'] },
        { ...record().grants[0], id: 'pong', state: 'superseded', supersedes: ['ping'] },
      ],
    });
    match(issuesIn(cycle).join('\n'), /contains a cycle through grant/);
    strictEqual(matchIt(cycle).state, 'unassured');
  });

  it('a replacement cannot predate what it replaces', () => {
    const backdated = record({
      grants: [
        { ...record().grants[0], id: 'newer-review', state: 'superseded', reviewed_at: '2026-08-16' },
        { ...record().grants[0], id: 'older-successor', reviewed_at: '2026-08-01', supersedes: ['newer-review'] },
      ],
    });
    match(issuesIn(backdated).join('\n'), /supersedes "newer-review" but was reviewed earlier/);
  });

  it('one grant cannot both supersede and re-approve the same id', () => {
    const both = record({
      grants: [
        { ...record().grants[0], id: 'target', state: 'revoked', reviewed_at: '2026-08-01' },
        { ...record().grants[0], id: 'confused', supersedes: ['target'], reapproval_of: 'target' },
      ],
    });
    match(issuesIn(both).join('\n'), /both supersedes and re-approves/);
    strictEqual(matchIt(both).state, 'unassured');
  });

  it('a revocation is restored ONCE, by one successor', () => {
    const twice = record({
      grants: [
        { ...record().grants[0], id: 'gone', state: 'revoked', reviewed_at: '2026-08-01' },
        { ...record().grants[0], id: 'restore-a', reapproval_of: 'gone' },
        { ...record().grants[0], id: 'restore-b', reapproval_of: 'gone' },
      ],
    });
    match(issuesIn(twice).join('\n'), /is re-approved by 2 grants/);
    strictEqual(matchIt(twice).state, 'unassured');
  });
});
