#!/bin/bash
# End-to-end regression for the autopilot (PROBES.md V0, one directory up; the plan's V1).
# Creates a scratch repo, has a headless /orchestrator:plan build a two-subtask
# macro, approves it, runs the autopilot, and asserts the end state.
#
# Usage: ./e2e-macro.sh            (defaults below; costs roughly $4–6 on sonnet/medium)
# Env:   E2E_DIR     scratch dir (default: a new mktemp dir)
#        E2E_MODEL   worker model (default sonnet)   E2E_EFFORT (default medium)
#        E2E_MAX_COST total cap in USD (default 15)
#        AUTOPILOT_BIN driver path, required (the handoff package prototype; point it
#                      at the ported driver once S8 lands)
# ADR-0062 (orchestrator >= 0.14.0): a subtask completes only when its pull
# request lands, so this scratch repo, which has no origin and no PRs, cannot
# reach finalize. The assertions below expect completion; extend the harness
# with the landing step of ADR-0063 D3a before relying on its exit code. Until
# then, read the per-step denial count from the ledger.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AP="${AUTOPILOT_BIN:?set AUTOPILOT_BIN to the autopilot driver (the handoff package prototype, or the ported driver after S8)}"
DIR="${E2E_DIR:-$(mktemp -d -t autopilot-e2e)}"
MODEL="${E2E_MODEL:-sonnet}"; EFFORT="${E2E_EFFORT:-medium}"; MAX_COST="${E2E_MAX_COST:-15}"
R="$DIR/repo"
fail() { echo "✗ $*"; exit 1; }

mkdir -p "$R" && cd "$R" || fail "cannot create $R"
git init -q -b main && git config user.email e2e@example.invalid && git config user.name e2e
printf '.agentic-plugins/runs/\n.agentic-plugins/state/\n.agentic-plugins/tmp/\n.agentic-plugins/cache/\n' > .gitignore
echo '{ "name": "greet-demo", "type": "module", "private": true }' > package.json
echo "# greet-demo" > README.md
git add -A && git commit -qm "chore: init"
echo "repo: $R"

# The macro plan is the owner's step; here it is headless, with the same
# posture and plugin-root hint the driver gives its workers.
HINT=$(node -e 'const p=require(process.env.HOME+"/.claude/plugins/installed_plugins.json").plugins;const l=["orchestrator","engineer","runtime","companions"].map(n=>{const e=(p[n+"@agentic-plugins"]||[]).find(x=>x.scope==="user");return "   "+n+"="+e.installPath});console.log(["$CLAUDE_PLUGIN_ROOT is NOT set in Bash. Use these exact plugin roots and never search the plugin cache:",...l].join("\n"))')
"$HERE/clean-claude.sh" -p '/orchestrator:plan Add a tiny greet CLI (greet.mjs printing "Hello, <name>") and a README usage section documenting it. This is an intentionally small two-deliverable validation of the macro workflow: plan exactly two subtasks (code first, then docs) and do not downscope to a single deliverable.' \
  --model "$MODEL" --effort "$EFFORT" --permission-mode manual --permission-prompts none \
  --allowedTools "Bash Read Edit Write Task Skill Monitor" --append-system-prompt "$HINT" \
  --output-format stream-json --verbose --max-budget-usd 5 < /dev/null > "$DIR/plan.jsonl" 2>/dev/null \
  || fail "headless plan failed (see $DIR/plan.jsonl)"

node "$AP" approve --repo "$R" || fail "no macro to approve"
node "$AP" approve --repo "$R" --yes > /dev/null
node "$AP" run --repo "$R" --model "$MODEL" --effort "$EFFORT" --max-steps 14 --max-cost "$MAX_COST" --step-budget 4 | tee "$DIR/run.log"
RC=${PIPESTATUS[0]}

echo; echo "== assertions =="
[ "$RC" -eq 0 ] || fail "driver exit $RC (expected 0 = completed)"
COMMITS=$(git -C "$R" rev-list --count HEAD); [ "$COMMITS" -ge 3 ] || fail "expected ≥2 commits beyond init, got $((COMMITS - 1))"
[ -z "$(git -C "$R" status --porcelain)" ] || fail "working tree not clean"
[ -z "$(ls "$R/.agentic-plugins/state/orchestrator/workflows/" 2>/dev/null)" ] || fail "macro not archived"
git -C "$R" log --format=%s | grep -qvE '^(feat|fix|docs|chore|refactor|test|build|ci|perf|style)(\(.+\))?!?: ' && fail "non-conventional commit subject"
LEDGER=$(ls -d "$R"/.agentic-plugins/runs/autopilot/autopilot-* | tail -1)
DENIALS=$(node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n"))n+=JSON.parse(l).permission_denials.length;console.log(n)' "$LEDGER/steps.jsonl")
echo "✓ completed · commits=$((COMMITS - 1)) · clean tree · macro archived · conventional subjects"
echo "  permission denials across steps: $DENIALS (V0 baseline 8; S0 target 0 Bash)"
echo "  ledger: $LEDGER"
