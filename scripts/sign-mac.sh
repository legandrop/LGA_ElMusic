#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS required.' >&2; exit 1; }
case "$(uname -m)" in
  arm64) architecture=arm64; suffix=-arm64 ;;
  x86_64) architecture=x64; suffix='' ;;
  *) echo 'Unsupported architecture.' >&2; exit 1 ;;
esac
node="$PWD/tools/node-v24.21.0-darwin-$architecture/bin/node"
python="$PWD/tools/evs-env/bin/python3"
stage="$PWD/release/staging-mac-$architecture"
package="$stage/mac$suffix"
app="$package/LGA El Music.app"
[[ -x "$node" && -x "$python" && -d "$app" ]] || { echo 'Repository runtimes and staged app required.' >&2; exit 1; }
export PYTHONNOUSERSITE=1 EVS_NO_ASK=1
export EVS_CONFIG_FILE="$PWD/.local/evs/config.json"
export EVS_CACHE_FILE="$PWD/.local/evs/cache.json"
export PYTHONPYCACHEPREFIX="$PWD/.local/python-cache"
/bin/mkdir -p "$PWD/.local/evs" "$PYTHONPYCACHEPREFIX"
echo 'Provisional signing procedure, not validated on Mac. Final packaging remains disabled.'
"$node" "$PWD/scripts/verify-package.mjs" "$stage"
"$python" -m castlabs_evs.vmp --no-ask sign-pkg "$package"
# Sign inner Mach-O binaries and bundles before the enclosing app.
while IFS= read -r -d '' candidate; do
  if [[ -f "$candidate" ]]; then
    case "$(/usr/bin/file -b "$candidate")" in
      *Mach-O*) /usr/bin/codesign --force --sign - --options runtime "$candidate" ;;
    esac
  else
    case "$candidate" in
      *.app) /usr/bin/codesign --force --sign - --options runtime --entitlements "$PWD/resources/entitlements.mac.plist" "$candidate" ;;
      *.framework|*.xpc) /usr/bin/codesign --force --sign - --options runtime "$candidate" ;;
    esac
  fi
done < <(/usr/bin/find "$app" -depth \( -type f -o -type d \) -print0)
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
"$python" -m castlabs_evs.vmp --no-ask verify-pkg --streaming "$package"
echo 'Signature commands completed. This provisional procedure does not certify Apple Music playback or authorize a final package.'
