// plugins/runtime/scripts/lib/codex-config.mjs
//
// READ-ONLY Codex host-config TOML parsing (machine-bootstrap-contract.md §1.3
// extraction 4). This module never writes host config.
//
// This was the generic half of `lib/permission-config.mjs`. ADR-0057 §Decision 4
// split that file by consumer rather than by name: `parseCodexPermissionConfigToml`
// is generic Codex-config reading with a production consumer outside the advisor
// (`profile-readers.mjs`), while `readClaudePermissionConfig` /
// `readCodexPermissionConfig` existed only to feed the permission planner and were
// deleted with it.
//
// The exported function keeps its name: it reads Codex's PERMISSION configuration
// — approval policy, sandbox mode, per-project trust — which is what it is called
// after. The advisor it once fed is gone; the subject matter is not.

// Reverse of tomlString's escaping for a basic-string key/value: "\\"->"\",
// '\"'->'"'. Used to compare a stored [projects."<path>"] key against repoRoot.
export function unescapeTomlBasic(s) {
  return String(s).replace(/\\(["\\])/g, '$1');
}

// Minimal READ-ONLY scan of ~/.codex/config.toml for exactly the keys the Codex
// plan needs: top-level approval_policy / sandbox_mode, and the set of
// [projects."<path>"] sections whose trust_level = "trusted". Section-scoped
// line parser mirroring doctor's parseCodexHookStateConfigToml; every other
// section/key is ignored. Top-level keys are only honored before the first
// section (TOML requires that ordering).
export function parseCodexPermissionConfigToml(text) {
  let approvalPolicy = null;
  let sandboxMode = null;
  const trustedProjects = new Set();
  let currentProject = null;
  let inTopLevel = true;
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const projectSection = raw.match(/^\s*\[projects\."((?:[^"\\]|\\.)*)"\]\s*(?:#.*)?$/);
    if (projectSection) {
      currentProject = unescapeTomlBasic(projectSection[1]);
      inTopLevel = false;
      continue;
    }
    const line = raw.replace(/#.*/, '').trim();
    if (line.startsWith('[')) {
      // Any other section header — including [[array-tables]] and unsupported
      // shapes — leaves top-level so a later key is never mis-read as a top-level
      // approval_policy/sandbox_mode (Plan-verify peer MINOR).
      currentProject = null;
      inTopLevel = false;
      continue;
    }
    if (!line) continue;
    if (inTopLevel) {
      const ap = line.match(/^approval_policy\s*=\s*"([^"]*)"\s*$/);
      if (ap) { approvalPolicy = ap[1]; continue; }
      const sm = line.match(/^sandbox_mode\s*=\s*"([^"]*)"\s*$/);
      if (sm) { sandboxMode = sm[1]; continue; }
    } else if (currentProject) {
      const tl = line.match(/^trust_level\s*=\s*"([^"]*)"\s*$/);
      if (tl && tl[1] === 'trusted') trustedProjects.add(currentProject);
    }
  }
  return { approvalPolicy, sandboxMode, trustedProjects };
}
