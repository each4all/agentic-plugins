// plugins/runtime/scripts/version.mjs
//
// Runtime script version follows the plugin manifest so release-please can keep
// one source of truth. Scripts may run from source or from a host cache; both
// layouts keep manifests beside the scripts directory.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPluginManifestVersionsSync } from './lib/plugin-manifest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

// One reader, shared with the host-parity baseline resolver. They used to read
// the two manifests in OPPOSITE orders, so a package whose manifests disagreed
// stamped artifacts with one version and reported provenance with the other,
// and nothing said so. The order here is preserved (Codex first) precisely so
// unifying the readers does not restamp anything; what changed is that the
// disagreement is now visible in `RUNTIME_VERSION_EVIDENCE`.
const EVIDENCE = readPluginManifestVersionsSync(PLUGIN_ROOT);

// `0.0.0-dev` stays the floor: source checkouts and ad-hoc script copies may
// carry no manifest at all, and a runtime command that cannot stamp an
// artifact is worse than one that stamps it `dev`.
export const RUNTIME_VERSION = EVIDENCE.version ?? '0.0.0-dev';

/**
 * Why the version is what it is: `{ status, manifests: { codex, claude } }`
 * with `status` in `ok | partial | disagreement | absent | unusable`. Surfaces
 * that report installed state can say "this package is corrupt" instead of
 * silently picking one of two conflicting manifests.
 */
export const RUNTIME_VERSION_EVIDENCE = Object.freeze({
  status: EVIDENCE.status,
  manifests: EVIDENCE.manifests,
});
