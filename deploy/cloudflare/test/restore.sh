#!/usr/bin/env bash
# Proves the Litestream image survives a container replacement: write → stop (SIGTERM) → fresh container → data restored.
# Also proves restore fails closed: with a replica present but unreachable (wrong secret key, closed endpoint), a fresh
# container must exit non-zero without ever serving, rather than starting an empty database.
# Uses SeaweedFS from docker-compose.yml as a stand-in for R2. Run from the repository root.
# Production (Cloudflare Containers) and the pinned Litestream tarball are linux/amd64, so everything is built and run as amd64
# (emulated on arm64 hosts, which is slower).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PLATFORM=linux/amd64
cleanup() { docker rm -f tr-a tr-b tr-bad >/dev/null 2>&1 || true; docker compose rm -sf seaweedfs >/dev/null 2>&1 || true; }
trap cleanup EXIT

# retry <attempts> <description> <command…>: runs the command every 2s until it succeeds; fails the test when exhausted.
retry() {
  local n=$1 what=$2; shift 2
  for _ in $(seq "$n"); do "$@" && return 0; sleep 2; done
  echo "FAIL: gave up waiting for: $what"; exit 1
}

docker build --platform "$PLATFORM" -t poietic-issues:local .
docker build --platform "$PLATFORM" -t tracker-cloudflare:test deploy/cloudflare
docker compose up -d seaweedfs
SW=$(docker compose ps -q seaweedfs)
# SeaweedFS only listens on its own compose network's address, so the test containers join that network (alias: seaweedfs).
NET=$(docker inspect "$SW" -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')
# Start from an empty bucket: the compose volume persists between runs and a stale replica would be restored into tr-a.
weed() { echo "$1" | docker compose exec -T seaweedfs weed shell -master=localhost:9333 2>&1; }
bucket_exists() { weed "s3.bucket.create -name tracker-db" | grep -qE "created|already exists"; }
bucket_created() { weed "s3.bucket.create -name tracker-db" | grep -qE "created"; }
retry 60 "SeaweedFS master (bucket create)" bucket_exists
weed "s3.bucket.delete -name tracker-db" >/dev/null
retry 60 "SeaweedFS to recreate an empty bucket" bucket_created

# The bucket is created through the master; wait until the S3 gateway itself accepts connections (probed from the test network).
s3_up() {
  docker run --rm --platform "$PLATFORM" --network "$NET" --entrypoint node poietic-issues:local \
    -e 'require("net").connect(8333,"seaweedfs").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))'
}
retry 60 "SeaweedFS S3 gateway on seaweedfs:8333" s3_up

# start <name> [docker run args…]: starts the image against the replica; extra args (later -e wins) override the defaults.
start() {
  local name=$1; shift
  docker run -d --platform "$PLATFORM" --name "$name" --network "$NET" -p 3999:3000 \
    -e LITESTREAM_ENDPOINT=http://seaweedfs:8333 -e LITESTREAM_BUCKET=tracker-db \
    -e LITESTREAM_ACCESS_KEY_ID=tracker -e LITESTREAM_SECRET_ACCESS_KEY=tracker-secret \
    -e POIETIC_ISSUES_SECURE_COOKIES=0 "$@" tracker-cloudflare:test >/dev/null
}
run() {
  start "$1"
  for _ in $(seq 120); do curl -fs http://127.0.0.1:3999/readyz >/dev/null && return; sleep 1; done
  docker logs "$1"; echo "FAIL: container $1 never became ready"; exit 1
}

# expect_fail_closed <case> [docker run args…]: a fresh container (no local database) whose replica cannot be read must
# exit non-zero within the window and never answer /readyz in the meantime.
expect_fail_closed() {
  local what=$1; shift
  start tr-bad "$@"
  for _ in $(seq 180); do
    if curl -fs --max-time 2 http://127.0.0.1:3999/readyz >/dev/null; then
      docker logs tr-bad; echo "FAIL ($what): container became ready instead of failing closed"; exit 1
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' tr-bad)" = false ]; then
      local code; code=$(docker inspect -f '{{.State.ExitCode}}' tr-bad)
      docker logs tr-bad 2>&1 | tail -n 5
      [ "$code" != 0 ] || { echo "FAIL ($what): container exited 0"; exit 1; }
      echo "PASS ($what): container exited $code without serving"
      docker rm tr-bad >/dev/null
      return
    fi
    sleep 1
  done
  docker logs tr-bad; echo "FAIL ($what): container neither exited nor became ready within 180s"; exit 1
}

run tr-a
docker exec tr-a poietic-issues db bootstrap --handle ada --name Ada >/dev/null
docker exec tr-a poietic-issues --actor ada project create -k RST --name "Restore test" -q >/dev/null
docker stop -t 60 tr-a >/dev/null   # SIGTERM → tracker exits → Litestream final sync
code=$(docker inspect -f '{{.State.ExitCode}}' tr-a)
[ "$code" = 0 ] || { docker logs tr-a; echo "FAIL: tr-a exited $code after SIGTERM"; exit 1; }
docker logs tr-a 2>&1 | grep -q "litestream shut down" || { docker logs tr-a; echo "FAIL: no clean Litestream shutdown"; exit 1; }
docker rm tr-a >/dev/null

# The replica now holds data. Unreachable replica → must not start empty.
expect_fail_closed "wrong secret key" -e LITESTREAM_SECRET_ACCESS_KEY=wrong-secret
expect_fail_closed "closed endpoint" -e LITESTREAM_ENDPOINT=http://seaweedfs:1

run tr-b                            # fresh disk: must restore from the replica (and the failed starts left it intact)
docker exec tr-b poietic-issues --actor ada project view RST -q | grep -qx RST \
  || { docker logs tr-b; echo "FAIL: project not restored"; exit 1; }
echo "PASS: data survived container replacement"
