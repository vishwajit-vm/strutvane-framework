#!/usr/bin/env bash
# Consolidation step 1: rewrite each absorbed repo's history under packages/<name>/, on THROW-AWAY
# clones only (git clone --no-local copies the objects; the source repos are never touched).
#
# Usage: bash rewrite.sh <dir holding the contracts, core, devkit and cli repos> <scratch dir>
# Output: <scratch>/src/<name>, branch main, every path under packages/<name>/.
#
# `git filter-repo --to-subdirectory-filter packages/<name>` does the same in seconds; it was not
# installed on the machine that ran the consolidation, so this uses git's built-in filter-branch.
set -euo pipefail
P=${1:?packages dir}; W=${2:?scratch dir}
export FILTER_BRANCH_SQUELCH_WARNING=1
rm -rf "$W/src"; mkdir -p "$W/src"
for n in contracts core devkit cli; do
  git clone -q --no-local "$P/$n" "$W/src/$n"
  cd "$W/src/$n"
  git remote remove origin
  git filter-branch --index-filter "
    git ls-files -s | sed \"s#\t\\\"*#&packages/$n/#\" |
      GIT_INDEX_FILE=\$GIT_INDEX_FILE.new git update-index --index-info &&
      if [ -f \"\$GIT_INDEX_FILE.new\" ]; then mv \"\$GIT_INDEX_FILE.new\" \"\$GIT_INDEX_FILE\"; fi
  " -- main >/dev/null
  echo "$n: $(git rev-list --count main) commits rewritten under packages/$n/"
done
