#!/bin/sh
# Resolve Node for Codex plugin hooks without relying on a login-shell PATH.

set -u

script=${1:-}
if [ -z "$script" ]; then
  exit 0
fi
shift || true

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  if [ -n "${NVM_BIN:-}" ] && [ -x "$NVM_BIN/node" ]; then
    printf '%s\n' "$NVM_BIN/node"
    return 0
  fi

  home=${HOME:-}
  nvm_dir=${NVM_DIR:-"$home/.nvm"}

  for candidate in \
    "$home/.volta/bin/node" \
    "$home/.asdf/shims/node" \
    "$home/.local/share/mise/shims/node" \
    "$nvm_dir/current/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  latest=
  for candidate in "$nvm_dir"/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      latest=$candidate
    fi
  done
  if [ -n "$latest" ]; then
    printf '%s\n' "$latest"
    return 0
  fi

  return 1
}

node_bin=$(find_node) || exit 0
exec "$node_bin" "$script" "$@"
