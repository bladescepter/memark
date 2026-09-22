#!/bin/sh
# memark P3 回归测试：搭建隔离 git 环境（bare + clone），不触碰真实 memory 仓库。
set -eu
G="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent/node_modules"
export NODE_PATH="$G"
export PI_NODE_MODULES="$G"
export TEST_REMOTE="${TEST_REMOTE:-/tmp/memark-test-remote.git}"
export TEST_REPO="${TEST_REPO:-/tmp/memark-test-repo}"
SRC_REPO="${MEMARK_REPO:-$HOME/DEV/memory}"

rm -rf "$TEST_REMOTE" "$TEST_REPO"
git init --bare -q --initial-branch=main "$TEST_REMOTE"
git clone -q "$SRC_REPO" "$TEST_REPO"
git -C "$TEST_REPO" remote set-url origin "$TEST_REMOTE"
git -C "$TEST_REPO" push -q -u origin main
git -C "$TEST_REPO" config user.email test@memark.local
git -C "$TEST_REPO" config user.name memark-test

node "$(dirname "$0")/p3_test.cjs"
STATUS=$?
rm -rf "$TEST_REMOTE" "$TEST_REPO"
exit $STATUS
