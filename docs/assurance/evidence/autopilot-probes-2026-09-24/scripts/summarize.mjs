#!/usr/bin/env node
// Summarize a `claude -p --output-format stream-json` capture without dumping it.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const trunc = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

const kinds = new Map();
const out = [];
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { out.push(`[non-json] ${trunc(line)}`); continue; }
  const key = `${ev.type}${ev.subtype ? `/${ev.subtype}` : ''}`;
  kinds.set(key, (kinds.get(key) || 0) + 1);

  if (ev.type === 'system' && ev.subtype === 'init') {
    const tools = ev.tools || [];
    const cmds = ev.slash_commands || [];
    out.push(`init: model=${ev.model} permissionMode=${ev.permissionMode} tools=${tools.length} askUser=${tools.includes('AskUserQuestion')}`);
    out.push(`init: slash_commands=${cmds.length} has(orchestrator:next)=${cmds.some(c => String(c).includes('orchestrator:next'))} has(engineer:compose)=${cmds.some(c => String(c).includes('engineer:compose'))}`);
    out.push(`init: plugins=${trunc((ev.plugins || []).map(p => p.name || p), 300)}`);
    out.push(`init: keys=${Object.keys(ev).join(',')}`);
  } else if (ev.type === 'system') {
    out.push(`${key}: ${trunc(Object.fromEntries(Object.entries(ev).filter(([k]) => !['type', 'subtype', 'session_id', 'uuid'].includes(k))), 260)}`);
  } else if (ev.type === 'assistant') {
    const u = ev.message?.usage || {};
    const blocks = (ev.message?.content || []).map(b => b.type === 'tool_use' ? `tool_use:${b.name}` : b.type).join('+');
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    out.push(`assistant[${blocks}] ctx≈${ctx} (in=${u.input_tokens} cc=${u.cache_creation_input_tokens} cr=${u.cache_read_input_tokens} out=${u.output_tokens})`);
    for (const b of ev.message?.content || []) {
      if (b.type === 'text') out.push(`  text: ${trunc(b.text, 300)}`);
      if (b.type === 'tool_use') out.push(`  input: ${trunc(b.input, 300)}`);
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'tool_result') out.push(`  tool_result(err=${!!b.is_error}): ${trunc(b.content, 300)}`);
    }
  } else if (ev.type === 'result') {
    out.push(`result: subtype=${ev.subtype} is_error=${ev.is_error} turns=${ev.num_turns} cost=$${ev.total_cost_usd} duration_ms=${ev.duration_ms}`);
    out.push(`result: usage=${trunc(ev.usage, 400)}`);
    if (ev.modelUsage) out.push(`result: modelUsage=${trunc(ev.modelUsage, 400)}`);
    if (ev.structured_output !== undefined) out.push(`result: structured_output=${trunc(ev.structured_output, 400)}`);
    if (ev.permission_denials?.length) out.push(`result: permission_denials=${trunc(ev.permission_denials, 400)}`);
    out.push(`result: text=${trunc(ev.result, 300)}`);
    out.push(`result: keys=${Object.keys(ev).join(',')}`);
  }
}
console.log(`event kinds: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(', ')}`);
console.log(out.join('\n'));
