#!/usr/bin/env bash
# Builds the sync image for the K3s node, imports it, applies the manifest and rolls the StatefulSet onto it.
#   deploy/k3s/deploy.sh            # host `papa`, tag = current commit
#   K3S_HOST=other deploy/k3s/deploy.sh
set -euo pipefail

host="${K3S_HOST:-papa}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Refusing to deploy a dirty tree: commit first so the image tag names what is in it." >&2
  exit 1
fi
tag="$(git -C "$root" rev-parse --short=12 HEAD)"
image="localhost/poietic-issues-github-sync:${tag}"
kubectl() { ssh "$host" sudo k3s kubectl "$@"; }

echo "Building ${image}"
docker build --platform linux/amd64 -f "$root/apps/github-sync/Dockerfile" -t "$image" "$root"

echo "Importing into K3s on ${host}"
docker save "$image" | ssh "$host" sudo k3s ctr images import -

if ! kubectl -n poietic-issues-sync get secret github-sync-runtime >/dev/null 2>&1; then
  echo "Secret poietic-issues-sync/github-sync-runtime is missing: run deploy/k3s/set-secret.sh first." >&2
  exit 1
fi

# The image goes into the manifest before it is applied: a StatefulSet does not replace a pod that never started,
# so a first rollout on the placeholder tag would stay stuck.
sed "s#localhost/poietic-issues-github-sync:unset#${image}#" "$root/deploy/k3s/github-sync.yaml" | kubectl apply -f -
kubectl -n poietic-issues-sync rollout status statefulset/github-sync --timeout=180s
kubectl -n poietic-issues-sync logs statefulset/github-sync --tail=20
