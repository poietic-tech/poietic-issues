#!/usr/bin/env bash
# Host smoke test: packs @poietic-tech/issues, installs it beside the real
# poietic-tech host in a temp prefix, and checks that the host discovers it,
# loads it on demand, and runs it. Needs network (installs from npm).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"; rm -f "$here"/poietic-tech-issues-*.tgz' EXIT

# Nothing real is read: HOME and the credentials dir live in the temp dir, and
# no agent identity or token is inherited.
export HOME="$T/home"
export POIETIC_CREDENTIALS_DIR="$T/home/credentials"
export XDG_CONFIG_HOME="$T/home/.config"
export NPM_CONFIG_CACHE="$T/npm-cache"
unset POIETIC_AGENT_TOKEN POIETIC_IDENTITY
mkdir -p "$HOME"

cd "$here"
npm pack --silent >/dev/null
tarball="$(ls "$here"/poietic-tech-issues-*.tgz)"

npm i -g --prefix "$T/p" '@poietic-tech/cli@^0.2.0' "$tarball"
bin="$T/p/bin/poietic-tech"

echo "== issues --help"
help="$("$bin" issues --help)"
grep -q 'issue' <<<"$help" || { echo "FAIL: help does not mention issue" >&2; exit 1; }

echo "== modules list --json"
"$bin" modules list --json | node -e '
  const text = require("fs").readFileSync(0, "utf8").trim();
  const rows = JSON.parse(text).data;
  const m = rows.find((r) => r.package === "@poietic-tech/issues");
  if (!m || m.command !== "issues" || m.state !== "loaded on demand") {
    console.error("FAIL: unexpected module row", JSON.stringify(m), text);
    process.exit(1);
  }
'

echo "== issues issue list (not logged in)"
set +e
"$bin" issues issue list >/dev/null 2>"$T/err"
code=$?
set -e
if [ "$code" -ne 3 ]; then
  echo "FAIL: expected exit 3 (not logged in), got $code" >&2
  cat "$T/err" >&2
  exit 1
fi

echo "smoke ok"
