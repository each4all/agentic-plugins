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

  it('ships EXACTLY ONE grant — the R2 rollout state, pinned BY IDENTITY', async () => {
    // ADR-0054 §Decision 6, read precisely: R1 shipped the reader, the semantic
    // matcher, the comparator, the floor and BOTH gate paths with `grants: []`;
    // R2 ships one owner-ratified grant AND NOTHING ELSE.
    //
    // This REPLACES R1's `deepStrictEqual(grants, [])`. That assertion did its
    // job — the negative path was observed on a real machine in the `0.91.1`
    // proof — and deleting it outright would leave the first immutable grant
    // unpinned, which is the one thing §Decision 8 cannot recover from: once
    // released, a grant's contents cannot be edited, only superseded by a new
    // id. So the guard is transitioned rather than removed.
    //
    // Pinned BY IDENTITY rather than by count. A bare `length === 1` would let
    // a DIFFERENT first grant pass — a widened cohort, a swapped provenance, an
    // extra bound package — and each of those changes what the machine reports
    // `covered` for.
    const resolved = await resolveAssuranceRecord({ pluginRoot: RUNTIME_ROOT });
    strictEqual(resolved.record.grants.length, 1, 'R2 ships one grant, alone');
    const [grant] = resolved.record.grants;
    strictEqual(grant.id, 'claude-2-1-234-235-codex-0-147-0', 'the first grant id is immutable');
    strictEqual(grant.state, 'granted');
    strictEqual(grant.reviewed_at, '2026-08-19');
    deepStrictEqual(
      grant.cohort,
      [{ claude: '2.1.234', codex: '0.147.0' }, { claude: '2.1.235', codex: '0.147.0' }],
      'two tuples: the machine moved mid-review and both deltas were reviewed',
    );
    strictEqual(grant.review_provenance.kind, 'owner-attestation');
    ok(
      grant.review_provenance.reference.startsWith('docs/assurance/grant-reviews/owner-ratification-first-grant.md@'),
      'provenance points at the ratified owner decision, pinned to a commit',
    );
    strictEqual(
      grant.predicate,
      undefined,
      'ADR-0053 §Decision 5: every key `predicate` permits is unobservable, so any non-empty predicate would yield `unassured`',
    );
  });

  it('binds the seven reviewed consumers, and every consumed residual names one of them', async () => {
    // The owner chose the consuming set by hand (`follow-ups.md`: requiring
    // every installed plugin relocates the treadmill ADR-0053 §Decision 6
    // exists to prevent). This pins WHICH seven, because the choice is a review
    // judgement and not derivable from the machine.
    const resolved = await resolveAssuranceRecord({ pluginRoot: RUNTIME_ROOT });
    const [grant] = resolved.record.grants;
    deepStrictEqual(
      Object.keys(grant.packages).sort(),
      ['attention', 'companions', 'designer', 'engineer', 'founder', 'orchestrator', 'runtime'],
      'image is deliberately unbound and must surface in `unbound_packages` instead',
    );
    // `assurance-contract.mjs` enforces that a consumed residual's package is
    // bound; asserting it here pins the pairing the owner actually recorded,
    // which the contract cannot know.
    for (const residual of grant.residuals) {
      if (residual.consumption !== 'consumed') continue;
      ok(
        Object.hasOwn(grant.packages, residual.consuming_package),
        `consumed residual names ${residual.consuming_package}, which packages must bind`,
      );
    }
    strictEqual(grant.residuals.length, 11);
  });

  it('the reader, the registry, and the schema file agree on ONE version string', async () => {
    strictEqual(SCHEMA.$id, ASSURANCE_SCHEMA_VERSION, 'reader constant matches the schema $id');
    strictEqual(
      PACKAGED_SCHEMA_FILES[ASSURANCE_SCHEMA_FAMILY],
      `${ASSURANCE_SCHEMA_VERSION}.json`,
      'registry filename matches the $id',
    );
    strictEqual(SCHEMA.properties.schema.pattern, `^${ASSURANCE_SCHEMA_VERSION.replaceAll('.', '\\.')}$`, 'the schema pins its own version EXACTLY');
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

  it('a record QUOTED inside an outer fence is not the record', () => {
    // The false positive cross-host review found, and the likeliest real one:
    // this document explains its own grammar, so an author demonstrating it in
    // a fenced example would have made a grant nobody granted authoritative.
    const quoted = `${HEADER}\nHere is what a record looks like:\n\n~~~~markdown\n`
      + `${ASSURANCE_BEGIN_SENTINEL}\n${fenced(GRANT_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`
      + `~~~~\n`;
    strictEqual(parse(quoted).status, 'absent', 'a quoted example is not markup');

    // CONTROL: the identical bytes WITHOUT the outer fence are the record, so
    // the rejection is caused by the quoting and not by the example's content.
    const live = `${HEADER}\n${ASSURANCE_BEGIN_SENTINEL}\n${fenced(GRANT_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`;
    strictEqual(parse(live).status, 'resolved');
  });

  it('a sentinel MENTIONED in prose or in a grant note leaves the real record readable', () => {
    // The mirror of the case above, and the one that bites an honest author:
    // before the fix, a `note` quoting the sentinel — or prose citing it in
    // backticks — counted as a second marker and made the whole record
    // `ambiguous`, with no edit short of censoring the word to fix it.
    const noted = GRANT_RECORD.replace(
      '      "residuals": [',
      `      "note": "the block is delimited by ${ASSURANCE_BEGIN_SENTINEL}",\n      "residuals": [`,
    );
    // `note` sorts AFTER residuals in the schema's declared order, so place it
    // there instead; this asserts the fixture is the canonical one.
    const canonicalNoted = GRANT_RECORD.replace(
      /\n {4}\}\n {2}\]\n\}\n$/,
      `,\n      "note": "the block is delimited by ${ASSURANCE_BEGIN_SENTINEL}"\n    }\n  ]\n}\n`,
    );
    notStrictEqual(canonicalNoted, GRANT_RECORD, 'precondition: the note was inserted');
    ok(canonicalNoted.includes(ASSURANCE_BEGIN_SENTINEL), 'precondition: the sentinel really is in the JSON');
    strictEqual(parse(doc(fenced(canonicalNoted))).status, 'resolved', `a sentinel inside the fence is data (findings: ${JSON.stringify(parse(doc(fenced(canonicalNoted))).findings)})`);
    ok(!noted.includes('__unused__'));

    const cited = `${doc(fenced(EMPTY_RECORD))}\nThe block opens with \`${ASSURANCE_BEGIN_SENTINEL}\` on its own line.\n`;
    strictEqual(parse(cited).status, 'resolved', 'an inline code span is prose, not markup');
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

  it('a CRLF checkout reads the SAME record, because the header grammar already does', async () => {
    // Measured before it was fixed: a CRLF copy of the shipped baseline parsed
    // its dated header (HEADER_RE's `\s*` matches `\r`) and failed to parse its
    // assurance record — one module disagreeing with itself about one file.
    // There is no .gitattributes forcing LF, so that copy is reachable, and the
    // failure was fail-closed but UNREPAIRABLE: every byte of the record right,
    // no edit that fixes it.
    const shipped = await readFile(SHIPPED_BASELINE, 'utf-8');
    const crlf = shipped.replaceAll('\n', '\r\n');
    notStrictEqual(crlf, shipped, 'precondition: the fixture actually converted');
    deepStrictEqual(parseBaseline(crlf), parseBaseline(shipped), 'CONTROL: the header grammar was already tolerant');

    const lfResult = parse(shipped);
    const crlfResult = parse(crlf);
    strictEqual(crlfResult.status, 'resolved');
    deepStrictEqual(crlfResult.record, lfResult.record);
    // And the identity of the record does not move with the checkout style,
    // which is what lets ADR-0054 §Decision 8's cross-tag check compare
    // contents rather than formatting.
    strictEqual(crlfResult.block_sha256, lfResult.block_sha256);
  });

  it('trailing whitespace on a fence line does not make the record unreadable', () => {
    // Same dead-end reasoning, same safety argument: the fence lines carry no
    // record data, so tolerating a stray space cannot change what was parsed.
    const padded = `\`\`\`json  \n${EMPTY_RECORD}\`\`\` `;
    strictEqual(parse(doc(padded)).status, 'resolved');
    // But the tolerance does NOT extend to the body — a space is still a byte.
    const paddedBody = `\`\`\`json\n${EMPTY_RECORD.replace('\n}', ' \n}')}\`\`\``;
    strictEqual(parse(doc(paddedBody)).status, 'noncanonical');
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

  it('an unknown MAJOR of THIS family is unknown-schema; anything else is a defective record', () => {
    // The remedies are opposite, so the classification has to be. "Update the
    // runtime" is right only when the declaration is one this runtime cannot
    // READ. A missing, mistyped, malformed, or foreign-family declaration is a
    // record to REPAIR, and telling the operator to upgrade would send them
    // after a fix that does not exist — measured: a block that simply omitted
    // `schema` was told to update the plugin.
    for (const version of ['runtime-host-assurance-2.0', 'runtime-host-assurance-1.1', 'runtime-host-assurance-0.9']) {
      const body = EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, version);
      strictEqual(parse(doc(fenced(body))).status, 'unknown-schema', version);
    }
    for (const version of ['runtime-session-note-1.0', 'not-a-schema-version', 'runtime-host-assurance-1']) {
      const body = EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, version);
      strictEqual(parse(doc(fenced(body))).status, 'invalid', version);
    }
    strictEqual(parse(doc(fenced('{\n  "grants": []\n}\n'))).status, 'invalid', 'a MISSING declaration is a repair, not an upgrade');
    strictEqual(parse(doc(fenced('{\n  "schema": 10,\n  "grants": []\n}\n'))).status, 'invalid', 'a mistyped declaration likewise');
    match(assuranceFailure(parse(doc(fenced('{\n  "grants": []\n}\n')))).operator_action, /Repair the compatibility assurance block/);
  });

  it('carries the finding COUNT, so a capped display is not a smaller problem', () => {
    // The validator caps findings at 16 for display and returns the real count
    // beside them. Keeping only the array reported "16 problems" for a record
    // with twenty — the flood hidden rather than bounded.
    const grant = (i) => `    {
      "id": "grant-${String(i).padStart(3, '0')}",
      "state": "not-a-state",
      "reviewed_at": "2026-08-16",
      "review_provenance": {
        "kind": "adr",
        "reference": "ADR-0054"
      },
      "cohort": [],
      "packages": {},
      "residuals": []
    }`;
    const many = `{\n  "schema": "${ASSURANCE_SCHEMA_VERSION}",\n  "grants": [\n${Array.from({ length: 20 }, (_, i) => grant(i)).join(',\n')}\n  ]\n}\n`;
    const result = parse(doc(fenced(many)));
    strictEqual(result.status, 'invalid');
    strictEqual(result.finding_count, 20, 'the real count survives the display cap');
    strictEqual(result.findings.length, 16, 'and the displayed list is still bounded');
    strictEqual(result.findings_omitted, true);
  });

  it('bounds the RAW block, not only the object it parses to', () => {
    // The advertised 64 KiB cap was a bound on the re-serialized document,
    // which whitespace padding shrinks below — so it was not a bound on what
    // this reader would accept as input.
    const padded = EMPTY_RECORD.replace('{\n', `{${' '.repeat(70_000)}\n`);
    const result = parse(doc(fenced(padded)));
    strictEqual(result.status, 'unparseable');
    match(result.findings[0], /over the \d+-byte cap/);
  });

  it('the declared version is WITHHELD on BOTH branches it can take', () => {
    // It is unclamped free content the moment it fails to be the one value this
    // reader accepts — the same rule `compareSchemaVersion` states for itself.
    // Both branches are covered because splitting the classification split the
    // disclosure surface with it.
    const unreadable = parse(doc(fenced(EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, 'runtime-host-assurance-1.99'))));
    strictEqual(unreadable.status, 'unknown-schema');
    for (const finding of unreadable.findings) {
      doesNotMatch(finding, /1\.99/, 'the declared value does not cross the boundary');
      match(finding, /reads exactly runtime-host-assurance-1\.0/, 'the EXPECTED value does, because it is the reader\'s own');
    }

    // A value shaped to smuggle content does not parse as a schema version at
    // all, so it takes the `invalid` branch — where the validator's own
    // disclosure invariant has to hold instead.
    const smuggled = parse(doc(fenced(EMPTY_RECORD.replace(ASSURANCE_SCHEMA_VERSION, 'runtime-host-assurance-1.0-glpat-SECRETVALUE'))));
    strictEqual(smuggled.status, 'invalid');
    ok(smuggled.findings.length > 0, 'and it does produce a finding to inspect');
    for (const finding of smuggled.findings) {
      doesNotMatch(finding, /SECRETVALUE/, 'no observed scalar crosses the boundary on this branch either');
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

  it('a BROKEN HEADER blocks the record, however well the record itself reads', async () => {
    // ADR-0053 §Decision 3, verbatim: "A parseable assurance section next to a
    // broken or escaped baseline ... is blocked, never covered."
    //
    // An earlier version of this test asserted the OPPOSITE — that a readable
    // record beside an unparseable header is `resolved`, on the reasoning that
    // the two grammars are separate facts. They are separate facts, and that is
    // why the PURE grammar still reports what the text says; but integrity
    // outranks assurance at the resolver, which is the answer a gate uses.
    // Cross-host review caught the inversion.
    const noHeader = doc(fenced(EMPTY_RECORD), { header: '# Host Parity Baseline\n\nno dated header here\n' });
    const root = await fixturePackage({ baseline: noHeader });
    strictEqual((await resolveHostParityBaseline({ pluginRoot: root })).status, 'unparseable');
    const resolved = await resolveAssuranceRecord({ pluginRoot: root });
    strictEqual(resolved.status, 'baseline-unavailable', 'integrity outranks assurance');
    strictEqual(resolved.record, null);
    strictEqual(resolved.baseline_failure.status, 'unparseable');
    ok(assuranceFailure(resolved), 'and it blocks');

    // The pure grammar is unchanged, and stays the answer to a different
    // question: what does this TEXT say.
    strictEqual(parse(noHeader).status, 'resolved');

    // The mirror direction, which the ST2 topic states explicitly: an
    // unreadable assurance section is an ASSURANCE failure, not a freshness one.
    const noRecord = await fixturePackage({ baseline: `${HEADER}\nnothing else\n` });
    strictEqual((await resolveHostParityBaseline({ pluginRoot: noRecord })).status, 'resolved');
    strictEqual((await resolveAssuranceRecord({ pluginRoot: noRecord })).status, 'absent');
  });

  it('a file that is not valid UTF-8 has no well-defined record', async () => {
    // The MIRROR of a bug this module already fixed one level up. Its own
    // comment records why the provenance hash moved onto the bytes: "every
    // invalid byte sequence decodes to U+FFFD, so two different files collide.
    // Reproduced — FF FE and FF FF produced one hash." The block hash was
    // computed from the DECODED text and inherited exactly that collision.
    const block = `${ASSURANCE_BEGIN_SENTINEL}\n${fenced(EMPTY_RECORD)}\n${ASSURANCE_END_SENTINEL}\n`;
    const mk = (bad) => Buffer.concat([
      Buffer.from(`${HEADER}\nnote:`, 'utf8'),
      Buffer.from([bad]),
      Buffer.from(`\n\n${block}`, 'utf8'),
    ]);
    const [a, b] = [mk(0xFF), mk(0xFE)];
    ok(!a.equals(b), 'precondition: the two files differ in their raw bytes');
    strictEqual(a.toString('utf8'), b.toString('utf8'), 'precondition: and decode to ONE text');

    for (const bytes of [a, b]) {
      const root = await mkdtemp(join(tmpdir(), 'assurance-pkg-'));
      await mkdir(join(root, 'docs'), { recursive: true });
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: '0.90.3' }));
      await writeFile(join(root, 'docs', 'host-parity-baseline.md'), bytes);
      const resolved = await resolveAssuranceRecord({ pluginRoot: root });
      strictEqual(resolved.status, 'undecodable');
      strictEqual(resolved.record, null);
      strictEqual(resolved.block_sha256, null, 'no hash is published for content that is not well defined');
      match(assuranceFailure(resolved).operator_action, /not valid UTF-8/);
    }
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

  it('parseAssuranceSection THROWS on a schema that is not THE schema', () => {
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), {}), /must be the packaged/);
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), { schema: null }), /must be the packaged/);
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), { schema: [] }), /must be the packaged/);
    // Identity, not shape. An object-shape guard admitted `{}`, and an empty
    // schema constrains nothing — cross-host review showed a record missing its
    // required `grants` resolving through it.
    throws(() => parseAssuranceSection(doc(fenced('{\n  "schema": "runtime-host-assurance-1.0"\n}\n')), { schema: {} }), /must be the packaged/);
    throws(() => parseAssuranceSection(doc(fenced(EMPTY_RECORD)), { schema: { ...SCHEMA, $id: 'runtime-session-note-1.0' } }), /must be the packaged/);
  });

  it('resolveAssuranceRecord takes NO schema override — the packaged one is the authority', async () => {
    // The override existed and defeated this function's own stated guarantee
    // that schema and baseline come from one install. Removed rather than
    // documented, so there is no supported way to weaken it.
    const root = await fixturePackage({ baseline: doc(fenced('{\n  "schema": "runtime-host-assurance-1.0"\n}\n')) });
    const resolved = await resolveAssuranceRecord({ pluginRoot: root, schema: {} });
    strictEqual(resolved.status, 'invalid', 'a record missing `grants` is invalid whatever the caller passes');
  });
});
