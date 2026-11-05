#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
case "$(uname -m)" in
  arm64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) echo 'Unsupported macOS architecture.' >&2; exit 1 ;;
esac
node="$PWD/tools/node-v24.21.0-darwin-$architecture/bin/node"
[[ -x "$node" ]] || { echo "Missing repository Node runtime: $node" >&2; exit 1; }
export npm_config_cache="$PWD/.local/npm-cache"
export ELECTRON_CACHE="$PWD/.local/ecs-cache"
export ELECTRON_BUILDER_CACHE="$PWD/.local/builder-cache"
action=''
for argument in "$@"; do
  case "$argument" in
    --no-run) ;;
    --stage) action=stage ;;
    --prototype) action=prototype ;;
    --finalize) action=finalize ;;
    *) echo "Unknown option: $argument" >&2; exit 1 ;;
  esac
done
if [[ "$action" != prototype && "$action" != finalize ]]; then
  "$node" "$PWD/node_modules/typescript/bin/tsc"
  "$node" "$PWD/scripts/copy-ui.mjs"
  "$node" "$PWD/scripts/pack-streamdeck.mjs"
fi
if [[ -n "$action" ]]; then "$node" "$PWD/scripts/package.mjs" mac "$action"; fi
