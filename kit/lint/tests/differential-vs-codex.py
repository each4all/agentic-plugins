#!/usr/bin/env python3
"""Differential check: kit/lint's agent-manifest rules vs Codex's own validator.

`checkSkillAgentManifest` in kit/lint/check-plugin-shape.mjs is defined as a
mirror of `validate_skill_agent_manifest` in the plugin validator Codex ships
inside its binary and unpacks to

    ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py

A mirror is only as good as its last comparison, so this runs both
implementations over the same fixtures and reports every disagreement. The
expectations in kit/lint/tests/test-check-plugin-shape.mjs were derived from a
run of this script, not from reading the rules and predicting the outcome.

    python3 kit/lint/tests/differential-vs-codex.py

Requires a local Codex install (for the validator) and PyYAML (which it
imports). It is NOT part of `npm test`: it depends on a file outside the
repository, so a CI run without Codex would pass vacuously rather than check
anything. Run it by hand after a Codex release, and update both the mirror and
the static tests from what it reports.

Last run: 2026-09-10 against codex-cli 0.154.0 - 38 cases, 38 in agreement.
"""
import importlib.util, subprocess, tempfile, os, sys, pathlib

V = "/Users/lmuffin/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py"
spec = importlib.util.spec_from_file_location("vp", V)
vp = importlib.util.module_from_spec(spec); spec.loader.exec_module(vp)

CASES = {
  "valid-minimal": 'interface:\n  display_name: "D"\n  short_description: "S"\n',
  "valid-full": 'interface:\n  display_name: "D"\n  short_description: "S"\n  default_prompt: "Use $x:y."\n\npolicy:\n  allow_implicit_invocation: false\n',
  "cutover-shipped": 'display_name: Runtime Cutover\ndescription: x\nallow_implicit_invocation: false\nprompt: |\n  Use $runtime:cutover only when explicitly requested.\n',
  "no-space-colon": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation:false\n',
  "deps-sequence": 'interface:\n  display_name: "D"\n  short_description: "S"\n\ndependencies:\n  - pkg\n',
  "deps-mapping-tools": 'interface:\n  display_name: "D"\n  short_description: "S"\n\ndependencies:\n  tools: "x"\n',
  "deps-mapping-bad-key": 'interface:\n  display_name: "D"\n  short_description: "S"\n\ndependencies:\n  packages: "x"\n',
  "deps-scalar": 'interface:\n  display_name: "D"\n  short_description: "S"\n\ndependencies: false\n',
  "empty-default-prompt": 'interface:\n  display_name: "D"\n  short_description: "S"\n  default_prompt: ""\n',
  "ws-default-prompt": 'interface:\n  display_name: "D"\n  short_description: "S"\n  default_prompt: "   "\n',
  "null-default-prompt": 'interface:\n  display_name: "D"\n  short_description: "S"\n  default_prompt:\n',
  "bool-False": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation: False\n',
  "bool-yes": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation: yes\n',
  "bool-quoted": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation: "false"\n',
  "bool-null": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation:\n',
  "trailing-comment": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  allow_implicit_invocation: false # explicit only\n',
  "section-comment": '# leading\ninterface:\n  # inner\n  display_name: "D"\n  short_description: "S"\n',
  "policy-null": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n',
  "policy-scalar": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy: false\n',
  "policy-bad-key": 'interface:\n  display_name: "D"\n  short_description: "S"\n\npolicy:\n  other: true\n',
  "interface-null": 'interface:\n',
  "interface-scalar": 'interface: "x"\n',
  "interface-missing": 'policy:\n  allow_implicit_invocation: false\n',
  "iface-bad-key": 'interface:\n  display_name: "D"\n  short_description: "S"\n  prompt: "x"\n',
  "empty-display-name": 'interface:\n  display_name: ""\n  short_description: "S"\n',
  "int-display-name": 'interface:\n  display_name: 42\n  short_description: "S"\n',
  "null-display-name": 'interface:\n  display_name:\n  short_description: "S"\n',
  "brand-ok": 'interface:\n  display_name: "D"\n  short_description: "S"\n  brand_color: "#AABBCC"\n',
  "brand-bad": 'interface:\n  display_name: "D"\n  short_description: "S"\n  brand_color: "AABBCC"\n',
  "brand-null": 'interface:\n  display_name: "D"\n  short_description: "S"\n  brand_color:\n',
  "icon-missing-file": 'interface:\n  display_name: "D"\n  short_description: "S"\n  icon_small: "missing.png"\n',
  "icon-present-file": 'interface:\n  display_name: "D"\n  short_description: "S"\n  icon_small: "icon.png"\n',
  "icon-absolute": 'interface:\n  display_name: "D"\n  short_description: "S"\n  icon_small: "/etc/passwd"\n',
  "icon-escape": 'interface:\n  display_name: "D"\n  short_description: "S"\n  icon_small: "../../../etc/passwd"\n',
  "icon-empty": 'interface:\n  display_name: "D"\n  short_description: "S"\n  icon_small: ""\n',
  "top-sequence": '- a\n- b\n',
  "top-scalar": 'just a string\n',
  "unknown-top": 'interface:\n  display_name: "D"\n  short_description: "S"\n\nextra: 1\n',
}

def mk(y, with_icon=False):
    d = tempfile.mkdtemp(prefix="diff-")
    for sub in (".claude-plugin", ".codex-plugin", "skills/demo/agents"):
        os.makedirs(f"{d}/{sub}", exist_ok=True)
    m = '{"name":"probe","version":"0.0.1","description":"probe"}'
    open(f"{d}/.claude-plugin/plugin.json","w").write(m)
    open(f"{d}/.codex-plugin/plugin.json","w").write(m)
    open(f"{d}/skills/demo/SKILL.md","w").write('---\nname: demo\ndescription: "A demo."\n---\n\n# demo\n')
    open(f"{d}/skills/demo/agents/openai.yaml","w").write(y)
    if with_icon: open(f"{d}/skills/demo/icon.png","wb").write(b"\x89PNG")
    return d

rows = []
for name, y in CASES.items():
    d = mk(y, with_icon=(name == "icon-present-file"))
    errs = []
    vp.validate_skill_agent_manifest(
        plugin_root=pathlib.Path(d), skill_root=pathlib.Path(d)/"skills/demo",
        agent_yaml_path=pathlib.Path(d)/"skills/demo/agents/openai.yaml", errors=errs)
    codex_reject = len(errs) > 0
    r = subprocess.run(["node","kit/lint/check-plugin-shape.mjs",d], capture_output=True, text=True)
    lint_reject = r.returncode != 0
    agree = codex_reject == lint_reject
    rows.append((name, codex_reject, lint_reject, agree, errs[:1], r.stderr.strip().splitlines()[-1:] ))

bad = [r for r in rows if not r[3]]
for name, c, l, a, ce, le in rows:
    mark = "  " if a else "✗ "
    print(f"{mark}{name:22} codex={'REJ' if c else 'ok ':3} lint={'REJ' if l else 'ok ':3}")
    if not a:
        print(f"      codex: {ce}")
        print(f"      lint : {le}")
print(f"\ncases={len(rows)} agree={len(rows)-len(bad)} disagree={len(bad)}")
