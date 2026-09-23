#!/bin/sh
# memark 回归测试：使用公开的虚构 fixture 搭建隔离 git 环境，不读取真实 memory 仓库。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
if [ -d "$ROOT/node_modules/@earendil-works/pi-coding-agent/node_modules" ]; then
  NPM_ROOT="$ROOT/node_modules"
else
  NPM_ROOT="$(npm root -g 2>/dev/null)"
fi
G="$NPM_ROOT/@earendil-works/pi-coding-agent/node_modules"
BASE="${TMPDIR:-/tmp}/memark-test-$$"
SEED="$BASE/seed"
export TEST_REMOTE="$BASE/remote.git"
export TEST_REPO="$BASE/repo"
export TEST_AGENT_DIR="$BASE/agent"
export NODE_PATH="$NPM_ROOT:$G"
export PI_NODE_MODULES="$G"

case "$BASE" in
  "${TMPDIR:-/tmp}"/memark-test-*) ;;
  *) echo "unsafe test path: $BASE" >&2; exit 1 ;;
esac
cleanup() { rm -rf "$BASE"; }
trap cleanup EXIT INT TERM

mkdir -p "$SEED"
cp -R "$ROOT/tests/fixtures/memory/." "$SEED/"
git -C "$SEED" init -q --initial-branch=main
git -C "$SEED" config user.email test@memark.local
git -C "$SEED" config user.name memark-test
git -C "$SEED" config core.hooksPath .githooks
git -C "$SEED" add -A
git -C "$SEED" commit -q -m "test fixture"

git init --bare -q --initial-branch=main "$TEST_REMOTE"
git clone -q "$SEED" "$TEST_REPO"
git -C "$TEST_REPO" remote set-url origin "$TEST_REMOTE"
git -C "$TEST_REPO" push -q -u origin main
git -C "$TEST_REPO" config user.email test@memark.local
git -C "$TEST_REPO" config user.name memark-test
git -C "$TEST_REPO" config core.hooksPath .githooks
git -C "$TEST_REPO" config core.quotepath false

node "$HERE/p3_test.cjs"
