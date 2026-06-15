// Tests for plugins/founder/scripts/lib/yaml-mini.mjs — vendor minimal
// YAML parser for the founder:decide registry. Covers happy parsing
// + every reject case the schema's failure-mode table relies on.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse, YamlParseError } from "../../plugins/founder/scripts/lib/yaml-mini.mjs";

test("happy: top-level scalar map", () => {
  const out = parse(`schema: "1.0"\nname: "default"\n`);
  assert.deepEqual(out, { schema: "1.0", name: "default" });
});

test("happy: nested maps with mixed quoted and unquoted scalars", () => {
  const out = parse(
    [
      `schema: "1.0"`,
      `presets:`,
      `  default:`,
      `    description: "Default 5-axis preset"`,
      `    role: decisive`,
    ].join("\n"),
  );
  assert.deepEqual(out, {
    schema: "1.0",
    presets: {
      default: { description: "Default 5-axis preset", role: "decisive" },
    },
  });
});

test("happy: list of maps with nested map", () => {
  const out = parse(
    [
      `axes:`,
      `  - id: "essence"`,
      `    labels:`,
      `      en: "Essence"`,
      `      ko: "본질"`,
      `    question: "Does this solve the fundamental problem?"`,
      `    role: "decisive"`,
      `  - id: "foundation"`,
      `    labels:`,
      `      en: "Foundation"`,
      `      ko: "근본"`,
      `    question: "Is this architecturally sound?"`,
      `    role: "decisive"`,
    ].join("\n"),
  );
  assert.equal(out.axes.length, 2);
  assert.equal(out.axes[0].id, "essence");
  assert.equal(out.axes[0].labels.ko, "본질");
  assert.equal(out.axes[1].id, "foundation");
  assert.equal(out.axes[1].labels.en, "Foundation");
});

test("happy: line comments are stripped", () => {
  const out = parse(
    [
      `# top-level comment`,
      `schema: "1.0"  # trailing comment`,
      `# blank-style`,
      `name: "default"`,
    ].join("\n"),
  );
  assert.deepEqual(out, { schema: "1.0", name: "default" });
});

test("happy: # inside quoted strings is NOT a comment", () => {
  const out = parse(`label: "issue #42 is fixed"\n`);
  assert.deepEqual(out, { label: "issue #42 is fixed" });
});

test("happy: : inside quoted strings is preserved", () => {
  const out = parse(`question: "what:ever style"\n`);
  assert.deepEqual(out, { question: "what:ever style" });
});

test("happy: UTF-8 in string VALUES is preserved (labels.ko)", () => {
  const out = parse(`ko: "본질 정의"\n`);
  assert.deepEqual(out, { ko: "본질 정의" });
});

test("happy: integers coerce to string", () => {
  const out = parse(`weight: 42\n`);
  assert.deepEqual(out, { weight: "42" });
});

test("happy: nulls and booleans coerce to string", () => {
  const out = parse(`a: null\nb: true\nc: false\n`);
  assert.deepEqual(out, { a: "null", b: "true", c: "false" });
});

test("happy: BOM is stripped", () => {
  const bom = "﻿";
  const out = parse(`${bom}schema: "1.0"\n`);
  assert.deepEqual(out, { schema: "1.0" });
});

test("happy: CRLF line endings are normalized", () => {
  const out = parse(`schema: "1.0"\r\nname: "default"\r\n`);
  assert.deepEqual(out, { schema: "1.0", name: "default" });
});

test("happy: lone CR line endings are normalized", () => {
  const out = parse(`schema: "1.0"\rname: "default"\r`);
  assert.deepEqual(out, { schema: "1.0", name: "default" });
});

test("reject: tab in indent", () => {
  assert.throws(
    () => parse(`presets:\n\tdefault:\n`),
    (err) => err instanceof YamlParseError && /tab character in indent/.test(err.message),
  );
});

test("reject: flow-style braces in unquoted scalar", () => {
  assert.throws(
    () => parse(`presets: {a: b}\n`),
    (err) => err instanceof YamlParseError && /flow-style markers/.test(err.message),
  );
});

test("reject: anchor in value position", () => {
  assert.throws(
    () => parse(`name: &anchor "default"\n`),
    (err) => err instanceof YamlParseError && /anchors \/ aliases \/ tags/.test(err.message),
  );
});

test("reject: tag in value position", () => {
  assert.throws(
    () => parse(`name: !str "default"\n`),
    (err) => err instanceof YamlParseError && /anchors \/ aliases \/ tags/.test(err.message),
  );
});

test("reject: multi-line scalar marker |", () => {
  assert.throws(
    () => parse(`block: |\n  line1\n  line2\n`),
    (err) => err instanceof YamlParseError && /multi-line scalar marker/.test(err.message),
  );
});

test("reject: multi-line scalar marker >", () => {
  assert.throws(
    () => parse(`block: >\n  folded\n  text\n`),
    (err) => err instanceof YamlParseError && /multi-line scalar marker/.test(err.message),
  );
});

test("reject: non-ASCII key", () => {
  assert.throws(
    () => parse(`본질: "essence"\n`),
    (err) => err instanceof YamlParseError && /non-ASCII or unsupported/.test(err.message),
  );
});

test("reject: duplicate map keys at the same level", () => {
  assert.throws(
    () => parse(`schema: "1.0"\nschema: "2.0"\n`),
    (err) => err instanceof YamlParseError && /duplicate map key/.test(err.message),
  );
});

test("reject: unterminated quoted string", () => {
  assert.throws(
    () => parse(`label: "unclosed\n`),
    (err) => err instanceof YamlParseError && /unterminated/.test(err.message),
  );
});

test("error: line number is reported on syntax error", () => {
  try {
    parse(`schema: "1.0"\nname:\n\tdefault\n`);
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.line, 3);
    assert.ok(/Line 3/.test(err.message));
  }
});

test("reject: __proto__ key in map → reserved-key error (prototype-pollution guard)", () => {
  assert.throws(
    () => parse(`__proto__: "polluted"\n`),
    (err) => err instanceof YamlParseError && /reserved map key name "__proto__"/.test(err.message),
  );
});

test("reject: constructor key in nested map → reserved-key error", () => {
  assert.throws(
    () => parse(`presets:\n  default:\n    constructor: "hacked"\n`),
    (err) => err instanceof YamlParseError && /reserved map key name "constructor"/.test(err.message),
  );
});

test("reject: prototype key in list-item map → reserved-key error", () => {
  assert.throws(
    () => parse(`axes:\n  - prototype: "x"\n`),
    (err) => err instanceof YamlParseError && /reserved map key name "prototype"/.test(err.message),
  );
});

test("hardening: parsed map keys are own properties (no prototype-chain leakage)", () => {
  const out = parse(`schema: "1.0"\nname: "default"\n`);
  // Direct rejection above means __proto__ can never reach the result
  // map; we double-check here that the rejection actually happens at
  // parse time and the resulting object's own-property surface is
  // exactly what was parsed.
  assert.deepEqual(Object.keys(out).sort(), ["name", "schema"]);
  // hasOwnProperty (via Object.hasOwn) sees only parsed keys.
  assert.equal(Object.hasOwn(out, "schema"), true);
  assert.equal(Object.hasOwn(out, "__proto__"), false);
});

test("schema-shape: registry-style nested presets + axes round-trips", () => {
  const yaml = [
    `schema: "1.0"`,
    `presets:`,
    `  default:`,
    `    description: "Default 5-axis preset (current SKILL.md verbatim)"`,
    `    axes:`,
    `      - id: "essence"`,
    `        labels:`,
    `          en: "Essence"`,
    `          ko: "본질"`,
    `        question: "Does this solve the fundamental problem?"`,
    `        role: "decisive"`,
    `      - id: "foundation"`,
    `        labels:`,
    `          en: "Foundation"`,
    `          ko: "근본"`,
    `        question: "Is this architecturally sound?"`,
    `        role: "decisive"`,
    `  nine-axis:`,
    `    description: "9-axis canonical preset"`,
    `    axes:`,
    `      - id: "standards"`,
    `        labels:`,
    `          en: "Standards"`,
    `          ko: "표준"`,
    `        question: "Aligned with industry standards?"`,
    `        role: "supporting"`,
  ].join("\n");
  const out = parse(yaml);
  assert.equal(out.schema, "1.0");
  assert.equal(out.presets.default.axes.length, 2);
  assert.equal(out.presets.default.axes[0].id, "essence");
  assert.equal(out.presets.default.axes[0].labels.ko, "본질");
  assert.equal(out.presets["nine-axis"].axes.length, 1);
  assert.equal(out.presets["nine-axis"].axes[0].labels.en, "Standards");
});
