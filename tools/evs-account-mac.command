#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'This helper requires macOS.' >&2; exit 1; }
python_local="$PWD/tools/evs-env/bin/python3"
[[ -x "$python_local" ]] || { echo 'The repository EVS environment is missing.' >&2; exit 1; }
export EVS_CONFIG_FILE="$PWD/.local/evs/config.json"
export EVS_CACHE_FILE="$PWD/.local/evs/cache.json"
export PYTHONPYCACHEPREFIX="$PWD/.local/python-cache"
export TMPDIR="$PWD/.local/tmp" TMP="$PWD/.local/tmp" TEMP="$PWD/.local/tmp"
export AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE="$PWD/.local/evs/aws-config-empty"
export AWS_SHARED_CREDENTIALS_FILE="$PWD/.local/evs/aws-credentials-empty"
export BOTO_CONFIG=/dev/null
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN EVS_NO_ASK
mkdir -p "$PWD/.local/evs" "$TMPDIR"
action="${1:-}"
if [[ -z "$action" && -t 0 && -t 1 ]]; then
  echo 'Castlabs provides free production DRM signing for El Music.'
  echo '1. Create an account'
  echo '2. Sign in to an existing account'
  read -r -p 'Choose 1 or 2: ' choice
  case "$choice" in 1) action=signup ;; 2) action=reauth ;; *) exit 0 ;; esac
fi
case "${action:---help}" in
  --help) echo 'Usage: bash tools/evs-account-mac.command signup|reauth'
    echo 'Run in your own Terminal. Enter credentials and the email verification code there.'
    echo 'This helper only manages the Castlabs account; it does not sign the application.' ;;
  signup|reauth)
    [[ -t 0 && -t 1 ]] || { echo 'Use an interactive Terminal; credentials must stay outside chat and logs.' >&2; exit 1; }
    exec "$python_local" -I -B -m castlabs_evs.account "$action" ;;
  *) echo 'Unknown action. Use --help.' >&2; exit 1 ;;
esac
