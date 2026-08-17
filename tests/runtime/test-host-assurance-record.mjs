// Compatibility assurance record — ADR-0053 §Decision 2, encoded by ADR-0054.
//
// The record is a SECOND grammar over the same packaged file the dated header
// lives in, so the cases here are grouped by the two things that can go wrong
// with that arrangement:
//
//   - the new grammar changes what the OLD one parses (ADR-0053 §Decision 1
//     forbids it, and the extraction of a shared read path is where it would
//     happen);
//   - the new grammar returns `resolved` for a document a human reading the
//     markdown would not read as that record — which is the only way this
//     plane produces a FALSE positive, the single failure the whole assurance
//     decision exists to prevent.
//
// Every rejection case is paired with a CONTROL that must pass, because a
// fixture can be rejected for a reason other than the one under test and a
// green "it was refused" says nothing about which rule refused it.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual, deepStrictEqual, throws, rejects, match, doesNotMatch } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, symlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSURANCE_BEGIN_SENTINEL,
  ASSURANCE_END_SENTINEL,
  ASSURANCE_SCHEMA_FAMILY,
  ASSURANCE_SCHEMA_VERSION,
  ASSURANCE_STATUSES,
  assuranceFailure,
  parseAssuranceSection,
  parseBaseline,
  resolveAssuranceRecord,
  resolveHostParityBaseline,
} from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import {
  PACKAGED_SCHEMA_FILES,
  compareSchemaVersion,
  loadSchema,
} from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const RUNTIME_ROOT = join(REPO_ROOT, 'plugins', 'runtime');
const SHIPPED_BASELINE = join(RUNTIME_ROOT, 'docs', 'host-parity-baseline.md');

const SCHEMA = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot: RUNTIME_ROOT });

const HEADER = 'Observed on 2026-08-16 with Claude Code `2.1.233`, Codex CLI\n`0.147.0`, official docs.\n';

/** A document with the dated header and a sentinel-delimited region carrying `body` verbatim. */
function doc(body, { header = HEADER, trailing = '\n## Version History\n' } = {}) {
  return `${header}\n${ASSURANCE_BEGIN_SENTINEL}\n${body}\n${ASSURANCE_END_SENTINEL}\n${trailing}`;
}

/** A fenced block around `json`, which is what the region is required to hold. */
function fenced(json) {
  return `\`\`\`json\n${json}\`\`\``;
}

const EMPTY_RECORD = '{\n  "schema": "runtime-host-assurance-1.0",\n  "grants": []\n}\n';

// Hand-written in the canonical order rather than produced by `canonicalJson`.
// Building the positive fixture with the same function the check uses would
// make it pass by construction and prove nothing about whether a human can
// author a block that satisfies it.
//
// The first draft of this fixture was REJECTED, and by the rule that is easiest
// for an author to miss: keys the schema NAMES follow the schema's order, but a
// dynamic map's keys (`packages`, a patternProperties node) are SORTED. It was
// written `runtime` before `attention`. That is the check earning its place —
// the same mechanism that refuses a shadowed duplicate refuses this.
const GRANT_RECORD = `{
  "schema": "runtime-host-assurance-1.0",
  "grants": [
    {
      "id": "host-pair-2026-08-16",
      "state": "granted",
      "reviewed_at": "2026-08-16",
      "review_provenance": {
        "kind": "adr",
        "reference": "ADR-0054"
      },
      "cohort": [
        {
          "claude": "2.1.233",
          "codex": "0.147.0"
        }
      ],
      "packages": {
        "attention": "0.9.0",
        "runtime": "0.90.3"
      },
      "residuals": [
        {
          "surface": "Notification hook payload on Desktop and VS Code",
          "consumption": "consumed",
          "disposition": "probe-pending",
          "consuming_package": "attention"
        }
      ]
    }
  ]
}
`;

const parse = (text) => parseAssuranceSection(text, { schema: SCHEMA });

async function fixturePackage({ baseline, version = '0.90.3', withSchema = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assurance-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  if (baseline !== null) await writeFile(join(root, 'docs', 'host-parity-baseline.md'), baseline);
  if (withSchema) {
    await mkdir(join(root, 'data', 'schemas'), { recursive: true });
    await copyFile(
      join(RUNTIME_ROOT, 'data', 'schemas', PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY]),
      join(root, 'data', 'schemas', PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY]),
    );
  }
  return root;
}

describe('compatibility assurance record — the shipped asset (ADR-0054 §Decision 1)', () => {
  it('the PACKAGED baseline carries a record this reader resolves', async () => {
    // The one test that fails if the section is edited into a shape the reader
    // cannot read. Everything else here runs on fixtures; this runs on the
    // bytes that actually ship, which is the only place the human-authored
    // grammar and the machine-read grammar are forced to agree.
    const resolved = await resolveAssuranceRecord({ pluginRoot: RUNTIME_ROOT });
    strictEqual(resolved.status, 'resolved', `packaged assurance section must resolve (findings: ${JSON.stringify(resolved.findings)})`);
    strictEqual(assuranceFailure(resolved), null);
    strictEqual(resolved.record.schema, ASSURANCE_SCHEMA_VERSION);
    ok(Array.isArray(resolved.record.grants));
    strictEqual(resolved.provenance.source, 'package');
    ok(/^[0-9a-f]{64}$/.test(resolved.block_sha256), 'the record carries a content hash of its canonical bytes');
  });

  it('ships an EMPTY grant set — the R1 rollout state, asserted rather than assumed', async () => {
    // ADR-0054 §Decision 6: R1 ships both gate paths with `grants: []` so the
    // failing path is exercised by the real gate before any positive is
    // possible. A grant appearing here without the semantic matcher that
    // honours it is exactly the ordering this assertion exists to catch.
    const resolved = await resolveAssuranceRecord({ pluginRoot: RUNTIME_ROOT });
    deepStrictEqual(resolved.record.grants, [], 'the first grant lands with the matcher (ST2B), not with the reader');
  });

  it('the reader, the registry, and the schema file agree on ONE version string', async () => {
    strictEqual(SCHEMA.$id, ASSURANCE_SCHEMA_VERSION, 'reader constant matches the schema $id');
    strictEqual(
      PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY],
      `${ASSURANCE_SCHEMA_VERSION}.json`,
      'registry filename matches the $id',
    );
    strictEqual(SCHEMA.properties.schema.pattern, `^${ASSURANCE_SCHEMA_VERSION.replace('.', '\\.')}$`, 'the schema pins its own version EXACTLY');
  });

  it('does NOT change what the dated-header grammar parses (§Decision 1)', async () => {
    // The invariant stated behaviourally rather than by inspection: the same
    // document with and without the assurance section must yield an identical
    // `{date, claude, codex}`, and the shipped file must still resolve.
    const shipped = await readFile(SHIPPED_BASELINE, 'utf-8');
    ok(shipped.includes(ASSURANCE_BEGIN_SENTINEL), 'precondition: the shipped file has the section');
    const beginAt = shipped.indexOf(ASSURANCE_BEGIN_SENTINEL);
    const endAt = shipped.indexOf(ASSURANCE_END_SENTINEL) + ASSURANCE_END_SENTINEL.length;
    const withoutSection = shipped.slice(0, beginAt) + shipped.slice(endAt);
    deepStrictEqual(
      parseBaseline(withoutSection),
      parseBaseline(shipped),
      'removing the assurance section changes nothing the header reader sees',
    );
    const resolved = await resolveHostParityBaseline({ pluginRoot: RUNTIME_ROOT });
    strictEqual(resolved.status, 'resolved');
    deepStrictEqual(resolved.baseline, { date: '2026-08-16', claude: '2.1.233', codex: '0.147.0' });
  });
});

describe('compatibility assurance record — sentinel and fence grammar', () => {
  it('CONTROL: the canonical shape resolves', () => {
    const result = parse(doc(fenced(EMPTY_RECORD)));
    strictEqual(result.status, 'resolved');
    deepStrictEqual(result.record, { schema: ASSURANCE_SCHEMA_VERSION, grants: [] });
  });

  it('a baseline with no section at all is `absent`, and absent BLOCKS', () => {
    const result = parse(`${HEADER}\nno record here\n`);
    strictEqual(result.status, 'absent');
    // §Decision 11 — a new reader against an old baseline yields unassured, and
    // unassured blocks. Reporting it as a usable record with zero grants would
    // be the fail-OPEN direction, so `assuranceFailure` must not return null.
    const failure = assuranceFailure(result);
    ok(failure, 'absent is a failure, not a usable record with no grants');
    match(failure.operator_action, /Update the runtime plugin/);
    match(failure.operator_action, /granted by review/, 'the action does not promise an upgrade grants coverage');
  });

  it('TWO blocks are ambiguous — a reader may not pick one', () => {
    const two = `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n${fenced(EMPTY_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`
      + `${ASSURANCE_BEGIN_SENTINEL}\n${fenced(EMPTY_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`;
    strictEqual(parse(two).status, 'ambiguous');
  });

  it('a sentinel without its mate is unparseable, not absent', () => {
    // `absent` means "this baseline predates the record". A half-written
    // section is a REPAIR, and collapsing the two would send the operator to
    // the wrong remedy.
    strictEqual(parse(`${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n${fenced(EMPTY_RECORD)}\n`).status, 'unparseable');
    strictEqual(parse(`${HEADER}\n${fenced(EMPTY_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`).status, 'unparseable');
  });

  it('sentinels out of order are unparseable', () => {
    const inverted = `${HEADER}\n${ASSURANCE_END_SENTINEL}\n${fenced(EMPTY_RECORD)}\n${ASSURANCE_BEGIN_SENTINEL}\n`;
    strictEqual(parse(inverted).status, 'unparseable');
  });

  it('the region must be a ```json fence — a bare fence or raw JSON is refused', () => {
    strictEqual(parse(doc(EMPTY_RECORD)).status, 'unparseable', 'raw JSON with no fence');
    strictEqual(parse(doc('```\n' + EMPTY_RECORD + '```')).status, 'unparseable', 'an unlabelled fence');
    strictEqual(parse(doc('```JSON\n' + EMPTY_RECORD + '```')).status, 'unparseable', 'a differently-cased info string');
  });

  it('a SECOND fence inside the region is refused rather than silently truncated', () => {
    // The failure a non-greedy regex would produce: stop at the first closing
    // fence and parse a prefix, so a record could be followed by a second one
    // that no reader ever sees.
    const region = `\`\`\`json\n${EMPTY_RECORD}\`\`\`\n\n\`\`\`json\n${GRANT_RECORD}\`\`\``;
    strictEqual(parse(doc(region)).status, 'unparseable');
  });

  it('prose between the sentinel and the fence is refused', () => {
    const region = `A note the author left here.\n\n\`\`\`json\n${EMPTY_RECORD}\`\`\``;
    strictEqual(parse(doc(region)).status, 'unparseable');
  });

  it('CONTROL: blank lines around the fence are tolerated', () => {
    // The strictness above must not make the grammar unauthorable — a markdown
    // writer's blank line after the sentinel is not a defect.
    strictEqual(parse(doc(`\n\n${fenced(EMPTY_RECORD)}\n\n`)).status, 'resolved');
  });

  it('a JSON array or scalar at the root is unparseable, not invalid', () => {
    strictEqual(parse(doc(fenced('[]\n'))).status, 'unparseable');
    strictEqual(parse(doc(fenced('"runtime-host-assurance-1.0"\n'))).status, 'unparseable');
  });

  it('broken JSON never leaks the parser message, which quotes the input', () => {
    const result = parse(doc(fenced('{ "schema": "runtime-host-assurance-1.0", "grants": [ }\n')));
    strictEqual(result.status, 'unparseable');
    for (const finding of result.findings) {
      doesNotMatch(finding, /position|token|JSON\.parse|Unexpected/i, 'no parser text crosses the boundary');
    }
  });
});

describe('compatibility assurance record — canonical form is load-bearing', () => {
  it('a DUPLICATE key is caught, and it is the canonical check that catches it', () => {
    // The case the ADR names: `JSON.parse` resolves duplicates last-wins and
    // says nothing, so a block a human reads as a revocation parses as a grant.
    const duplicated = GRANT_RECORD.replace(
      '      "state": "granted",',
      '      "state": "revoked",\n      "state": "granted",',
    );
    notStrictEqual(duplicated, GRANT_RECORD, 'precondition: the fixture actually carries the duplicate');
    const shadowed = parse(doc(fenced(duplicated)));
    strictEqual(shadowed.status, 'noncanonical');

    // CONTROL — the same record without the duplicate resolves, so the
    // rejection above is caused by the duplicate and not by anything else in
    // this fixture.
    const clean = parse(doc(fenced(GRANT_RECORD)));
    strictEqual(clean.status, 'resolved', `control grant record must resolve (findings: ${JSON.stringify(clean.findings)})`);
    strictEqual(clean.record.grants[0].state, 'granted');

    // And the CONSEQUENCE, stated: the shadowed document parses to the grant a
    // reader of the markdown would NOT expect. That is what makes silence here
    // a false positive rather than a formatting nit.
    strictEqual(JSON.parse(duplicated).grants[0].state, 'granted');
  });

  it('a non-canonical KEY ORDER is refused', () => {
    const reordered = '{\n  "grants": [],\n  "schema": "runtime-host-assurance-1.0"\n}\n';
    strictEqual(parse(doc(fenced(reordered))).status, 'noncanonical');
    strictEqual(parse(doc(fenced(EMPTY_RECORD))).status, 'resolved', 'CONTROL: declared order resolves');
  });

  it('re-indentation is refused — the bytes are the record', () => {
    const reindented = EMPTY_RECORD.replace(/^ {2}/gm, '    ');
    notStrictEqual(reindented, EMPTY_RECORD);
    strictEqual(parse(doc(fenced(reindented))).status, 'noncanonical');
  });

  it('the content hash is over the CANONICAL bytes, so prose around it does not move it', () => {
    const a = parse(doc(fenced(EMPTY_RECORD)));
    const b = parse(doc(fenced(EMPTY_RECORD), { trailing: '\n## Something Else Entirely\n\nmore prose\n' }));
    strictEqual(a.status, 'resolved');
    strictEqual(b.status, 'resolved');
    strictEqual(a.block_sha256, b.block_sha256, 'the same record in a different document is the same record');
    const other = parse(doc(fenced(GRANT_RECORD)));
    notStrictEqual(a.block_sha256, other.block_sha256, 'a different record is a different hash');
  });
});

describe('compatibility assurance record — the EXACT version pin (ADR-0054 §Decision 3)', () => {
  it('a newer MINOR is refused as unknown-schema, not read with its unknown keys ignored', () => {
    // The divergence this decision makes, pinned against the generic rule it
    // diverges from: `compareSchemaVersion` WOULD accept this document and
    // forgive its unknown scalars. That is right for additive bootstrap and
    // session artifacts and wrong here, because a narrowing key an older reader
    // dropped turns a restricted grant into a broad one.
    const generic = compareSchemaVersion('runtime-host-assurance-1.1', ASSURANCE_SCHEMA_VERSION);
    strictEqual(generic.ok, true, 'CONTROL: the generic gate would have accepted it');
    strictEqual(generic.allowUnknownScalars, true, 'CONTROL: and would have forgiven unknown scalars');

    const newerMinor = EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, 'runtime-host-assurance-1.1');
    const result = parse(doc(fenced(newerMinor)));
    // `unknown-schema`, NOT `invalid`: the operator action is "upgrade the
    // runtime", and a generic pattern violation would have said "repair the
    // record" — the wrong remedy for a runtime that is simply too old.
    strictEqual(result.status, 'unknown-schema');
    match(assuranceFailure(result).operator_action, /Update the runtime plugin/);
  });

  it('an unknown MAJOR and a foreign family are refused the same way', () => {
    for (const version of ['runtime-host-assurance-2.0', 'runtime-session-note-1.0', 'not-a-schema-version']) {
      const body = EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, version);
      strictEqual(parse(doc(fenced(body))).status, 'unknown-schema', version);
    }
  });

  it('the declared version is WITHHELD from the finding', () => {
    // It is unclamped free content the moment it fails to be the one value this
    // reader accepts — the same rule `compareSchemaVersion` states for itself.
    const smuggled = 'runtime-host-assurance-1.0-glpat-SECRETVALUE';
    const body = EMPTY_RECORD.replace(`"${ASSURANCE_SCHEMA_VERSION}"`, `"${smuggled}"`);
    const result = parse(doc(fenced(body)));
    strictEqual(result.status, 'unknown-schema');
    for (const finding of result.findings) {
      doesNotMatch(finding, /SECRETVALUE/, 'the declared value does not cross the boundary');
      match(finding, /reads exactly runtime-host-assurance-1\.0/, 'the EXPECTED value does, because it is the reader\'s own');
    }
  });
});

describe('compatibility assurance record — structural validation and disclosure', () => {
  it('a structurally wrong record is `invalid`, with content-free findings', () => {
    const badState = GRANT_RECORD.replace('"state": "granted"', '"state": "probably-fine-glpat-SECRETVALUE"');
    const result = parse(doc(fenced(badState)));
    strictEqual(result.status, 'invalid');
    ok(result.findings.length > 0);
    for (const finding of result.findings) {
      doesNotMatch(finding, /SECRETVALUE/, 'no observed scalar crosses the boundary');
    }
  });

  it('an unknown grant key is refused — the closed-schema rule at depth', () => {
    const extra = GRANT_RECORD.replace('      "state": "granted",', '      "state": "granted",\n      "expires_at": "2026-12-31",');
    const result = parse(doc(fenced(extra)));
    // The exact hazard §Decision 3 names: a NARROWING key. It must not be
    // ignored, and at this minor it is not even forgivable.
    strictEqual(result.status, 'invalid');
    for (const finding of result.findings) {
      doesNotMatch(finding, /expires_at/, 'a document-supplied key name does not cross the boundary');
    }
  });

  it('a per-host version LIST cannot be written down (§Decision 7)', () => {
    // The structural half of "independent per-host cohorts do not authorize
    // their Cartesian product": the cohort is an array of complete tuples, so
    // there is no shape in which two separate lists can be expressed.
    const cartesian = GRANT_RECORD.replace(
      /"cohort": \[[\s\S]*?\n {6}\],/,
      '"cohort": [\n        {\n          "claude": ["2.1.232", "2.1.233"],\n          "codex": ["0.147.0"]\n        }\n      ],',
    );
    notStrictEqual(cartesian, GRANT_RECORD, 'precondition: the fixture was rewritten');
    strictEqual(parse(doc(fenced(cartesian))).status, 'invalid');
  });

  it('a package version that is not a release version is refused', () => {
    const loose = GRANT_RECORD.replace('"runtime": "0.90.3"', '"runtime": "latest"');
    strictEqual(parse(doc(fenced(loose))).status, 'invalid');
  });

  it('CONTROL: the semantic cases the schema deliberately does NOT catch still parse', () => {
    // Recorded as a control, not a gap. ADR-0054 §Decision 2 places these in
    // lib/assurance-contract.mjs (ST2B) precisely because the closed keyword
    // subset cannot express them, and a test asserting the schema catches them
    // would be asserting the wrong module's job.
    const vacuous = GRANT_RECORD
      .replace(/"cohort": \[[\s\S]*?\n {6}\],/, '"cohort": [],')
      .replace(/"packages": \{[\s\S]*?\n {6}\},/, '"packages": {},');
    const result = parse(doc(fenced(vacuous)));
    strictEqual(result.status, 'resolved', 'a vacuous grant is STRUCTURALLY valid — the semantic module rejects it');
    deepStrictEqual(result.record.grants[0].cohort, []);
    deepStrictEqual(result.record.grants[0].packages, {});
  });
});

describe('compatibility assurance record — integrity outranks assurance (ADR-0053 §Decision 3)', () => {
  it('resolves from the SAME package the schema is loaded from', async () => {
    const root = await fixturePackage({ baseline: doc(fenced(GRANT_RECORD)) });
    const resolved = await resolveAssuranceRecord({ pluginRoot: root });
    strictEqual(resolved.status, 'resolved', JSON.stringify(resolved.findings));
    strictEqual(resolved.record.grants[0].id, 'host-pair-2026-08-16');
    strictEqual(resolved.provenance.runtime_version, '0.90.3');
    ok(/^[0-9a-f]{64}$/.test(resolved.provenance.content_sha256));
  });

  it('a MISSING baseline is baseline-unavailable, and the action is the INTEGRITY action', async () => {
    const root = await fixturePackage({ baseline: null });
    const resolved = await resolveAssuranceRecord({ pluginRoot: root });
    strictEqual(resolved.status, 'baseline-unavailable');
    strictEqual(resolved.record, null);
    strictEqual(resolved.baseline_failure.status, 'missing');
    const failure = assuranceFailure(resolved);
    // Delegated, not re-invented: repairing the record is meaningless while the
    // file it lives in cannot be read, and one fact must not grow two names.
    strictEqual(failure.operator_action, resolved.baseline_failure.operator_action);
  });

  it('an ESCAPED baseline never yields a record, however parseable the target is', async () => {
    // The measured ADR-0051 escape, re-run for the new grammar: a symlinked
    // docs/ makes an arbitrary outside file the authority. A perfectly valid
    // assurance record in that file must NOT become coverage.
    const outside = await mkdtemp(join(tmpdir(), 'assurance-outside-'));
    await writeFile(join(outside, 'host-parity-baseline.md'), doc(fenced(GRANT_RECORD)));
    const root = await mkdtemp(join(tmpdir(), 'assurance-pkg-'));
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: '0.90.3' }));
    await symlink(outside, join(root, 'docs'), 'dir');
    const resolved = await resolveAssuranceRecord({ pluginRoot: root });
    strictEqual(resolved.status, 'baseline-unavailable');
    strictEqual(resolved.record, null);
    strictEqual(resolved.baseline_failure.status, 'escaped');
  });

  it('a baseline whose HEADER is broken can still carry a readable record — and vice versa', async () => {
    // The two grammars are separate facts (§Decision 1/3). A header failure is
    // a FRESHNESS failure; it does not make the record unreadable, and the
    // consumer that gates on assurance must be able to see both answers
    // independently rather than inheriting one from the other.
    const noHeader = doc(fenced(EMPTY_RECORD), { header: '# Host Parity Baseline\n\nno dated header here\n' });
    const root = await fixturePackage({ baseline: noHeader });
    strictEqual((await resolveHostParityBaseline({ pluginRoot: root })).status, 'unparseable');
    strictEqual((await resolveAssuranceRecord({ pluginRoot: root })).status, 'resolved');

    const noRecord = await fixturePackage({ baseline: `${HEADER}\nnothing else\n` });
    strictEqual((await resolveHostParityBaseline({ pluginRoot: noRecord })).status, 'resolved');
    strictEqual((await resolveAssuranceRecord({ pluginRoot: noRecord })).status, 'absent');
  });

  it('refuses an explicit empty pluginRoot instead of reading its own package', async () => {
    // An empty override used to be laundered into the packaged default by the
    // callers, so a caller that meant to inspect a specific install silently
    // inspected its own. Same rule, same reason, for the new resolver.
    await rejects(() => resolveAssuranceRecord({ pluginRoot: '' }), /must be a non-empty string/);
    await rejects(() => resolveAssuranceRecord({ pluginRoot: null }), /must be a non-empty string/);
  });
});

describe('compatibility assurance record — the failure vocabulary', () => {
  it('fails CLOSED on a status it does not recognise', () => {
    // The same rule `baselineFailure` follows: an unrecognised status is itself
    // an integrity problem, and treating it as usable is the direction that
    // harms.
    const failure = assuranceFailure({ status: 'looks-fine' });
    ok(failure, 'an unknown status is never a pass');
    strictEqual(failure.status, 'looks-fine');
    match(failure.operator_action, /disagree on the failure vocabulary/);
    ok(assuranceFailure(null), 'a null result is a failure too');
    ok(assuranceFailure({}), 'a result with no status is a failure too');
  });

  it('every status except `resolved` produces a failure with an operator action', () => {
    for (const status of ASSURANCE_STATUSES) {
      const result = assuranceFailure({ status, baseline_failure: { operator_action: 'x' } });
      if (status === 'resolved') {
        strictEqual(result, null);
        continue;
      }
      ok(result, `${status} is a failure`);
      ok(result.summary && result.operator_action, `${status} names what happened and what to do`);
    }
  });

  it('parseAssuranceSection THROWS on a bad schema — that is a bug here, not data', () => {
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), {}), /must be the packaged/);
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), { schema: null }), /must be the packaged/);
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), { schema: [] }), /must be the packaged/);
  });
});
