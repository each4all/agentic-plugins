#!/bin/bash
# Halt-path validation for the autopilot prototype (PROBES.md V0b, one directory up).
# Usage: AUTOPILOT_TEST_REPO=<git repo holding an UNAPPROVED macro plan> ./halt-tests.sh
# The repo must gitignore .agentic-plugins/{runs,state,tmp,cache}/.
AP="${AUTOPILOT_BIN:?set AUTOPILOT_BIN to the autopilot driver (the handoff package prototype, or the ported driver after S8)}"
R="${AUTOPILOT_TEST_REPO:?set AUTOPILOT_TEST_REPO to a repo holding an unapproved macro}"
APPROVAL="$R/.agentic-plugins/runs/autopilot/approval.json"
last() { grep -E "^■" | head -1; }

echo "N1 unapproved (dry-run):"; node "$AP" run --repo "$R" --dry-run | last

node "$AP" approve --repo "$R" --yes > /dev/null
cp "$APPROVAL" "$APPROVAL.bak"
node -e 'const f=process.argv[1];const a=require(f);a.plan_hash="0".repeat(64);require("fs").writeFileSync(f,JSON.stringify(a))' "$APPROVAL"
echo "N2 plan changed after approval (dry-run):"; node "$AP" run --repo "$R" --dry-run | last
mv "$APPROVAL.bak" "$APPROVAL"

touch "$R/untracked.txt"
echo "N3 dirty tree before dispatch (dry-run):"; node "$AP" run --repo "$R" --dry-run | last
rm -f "$R/untracked.txt"

sleep 60 & HOLDER=$!
echo "{\"pid\":$HOLDER}" > "$R/.agentic-plugins/runs/autopilot/.lock"
echo "N4 lock held by a live process:"; node "$AP" run --repo "$R" --dry-run 2>&1 | tail -1
kill $HOLDER 2>/dev/null; rm -f "$R/.agentic-plugins/runs/autopilot/.lock"

echo "N5 no-progress (haiku worker told to do nothing):"
node "$AP" run --repo "$R" --model haiku --max-steps 1 --step-budget 0.5 \
  --next "Reply with the single word OK. Do not run any tools and do not change anything." | grep -E "✓|report:|^■"

echo "N6 awaiting-owner reported without state change:"
node "$AP" run --repo "$R" --model haiku --max-steps 1 --step-budget 0.5 \
  --next "Do not run any tools and do not change anything. This step needs an owner decision between conflicting options: in the structured output set outcome=needs_owner, awaiting_owner=decide-conflict, next_step kind=owner-decision with verb null and confidence HIGH." | grep -E "✓|report:|^■"

echo "N7 re-run with nothing changed (dry-run, expect the same awaiting halt):"; node "$AP" run --repo "$R" --dry-run | last
echo "N8 owner override (dry-run):"; node "$AP" run --repo "$R" --dry-run --next "/orchestrator:next" | grep -E "→|^■"
