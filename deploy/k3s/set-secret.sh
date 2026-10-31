#!/usr/bin/env bash
# Creates or replaces the sync's Secret on the K3s node from values typed at hidden prompts. Nothing is echoed,
# written to disk or put on a command line.
#   deploy/k3s/set-secret.sh
set -euo pipefail

host="${K3S_HOST:-papa}"
read -rsp 'github-sync agent token (pat_…): ' agent_token && echo
read -rsp 'GitHub fine-grained token (github_pat_…): ' github_token && echo
[ -n "$agent_token" ] && [ -n "$github_token" ] || { echo 'Both tokens are required.' >&2; exit 1; }

printf 'POIETIC_AGENT_TOKEN=%s\nGITHUB_TOKEN=%s\n' "$agent_token" "$github_token" |
  ssh "$host" 'sudo k3s kubectl create namespace poietic-issues-sync --dry-run=client -o yaml | sudo k3s kubectl apply -f - >/dev/null &&
    sudo k3s kubectl -n poietic-issues-sync create secret generic github-sync-runtime --from-env-file=/dev/stdin \
      --dry-run=client -o yaml | sudo k3s kubectl apply -f -'
echo 'Secret poietic-issues-sync/github-sync-runtime is set. Restart the pod to pick it up:'
echo "  ssh $host sudo k3s kubectl -n poietic-issues-sync rollout restart statefulset/github-sync"
