#!/usr/bin/env bash
# Copies the sync's two tokens from Infisical into the K3s Secret poietic-issues-sync/github-sync-runtime. The
# values travel in memory and over ssh on stdin: nothing is echoed, written to disk or put on a command line.
#   deploy/k3s/set-secret.sh                 # needs `infisical login`
# Infisical (Poietic Dot Tech / prod / /agents/github-sync) holds:
#   POIETIC_API_KEY  the github-sync agent's pat_ token (stored in the cluster as POIETIC_AGENT_TOKEN)
#   GITHUB_TOKEN     the fine-grained GitHub token (Issues: read and write)
set -euo pipefail

host="${K3S_HOST:-papa}"
project="${INFISICAL_PROJECT_ID:-6cdd60d7-cca6-4231-8032-3dd342eaca13}"
env="${INFISICAL_ENV:-prod}"
path="${INFISICAL_PATH:-/agents/github-sync}"

secret() {
  infisical secrets get "$1" --projectId "$project" --env "$env" --path "$path" --plain --silent 2>/dev/null ||
    { echo "Cannot read $1 from Infisical $env:$path (run \`infisical login\`?)." >&2; return 1; }
}
agent_token="$(secret POIETIC_API_KEY)"
github_token="$(secret GITHUB_TOKEN)"
[ -n "$agent_token" ] && [ -n "$github_token" ] || { echo 'Both tokens must be set in Infisical.' >&2; exit 1; }

printf 'POIETIC_AGENT_TOKEN=%s\nGITHUB_TOKEN=%s\n' "$agent_token" "$github_token" |
  ssh "$host" 'sudo k3s kubectl create namespace poietic-issues-sync --dry-run=client -o yaml | sudo k3s kubectl apply -f - >/dev/null &&
    sudo k3s kubectl -n poietic-issues-sync create secret generic github-sync-runtime --from-env-file=/dev/stdin \
      --dry-run=client -o yaml | sudo k3s kubectl apply -f -'
echo 'Secret poietic-issues-sync/github-sync-runtime is set. A running pod picks it up on restart:'
echo "  ssh $host sudo k3s kubectl -n poietic-issues-sync rollout restart statefulset/github-sync"
