#!/usr/bin/env bash
# Consolidation step 2: merge the rewritten histories (rewrite.sh) into the framework repo on a NEW
# branch, in a separate worktree (the main checkout and its node_modules stay untouched), then move
# everything into place in ONE commit of pure renames, so `git log --follow` and `git blame`
# reach the original commits.
#
# Usage: bash merge.sh <framework repo> <scratch dir used by rewrite.sh> <new worktree dir>
# Env:   BRANCH (default v2/consolidate)
set -euo pipefail
FW=${1:?framework repo}; W=${2:?scratch dir}; F=${3:?new worktree dir}
BRANCH=${BRANCH:-v2/consolidate}
# DCO sign-off first, co-author line last (what `-s` adds, in the order this project wants).
TRAILER="Signed-off-by: $(git -C "$FW" config user.name) <$(git -C "$FW" config user.email)>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C "$FW" worktree add -q -b "$BRANCH" "$F" main
cd "$F"
for n in contracts core devkit cli; do
  git fetch -q "$W/src/$n" main:import/$n
  git merge -q --allow-unrelated-histories --no-edit \
    -m "chore: import strutvane-$n history (staged under packages/$n/)" \
    -m "The full history of vishwajit-vm/strutvane-$n, rewritten under packages/$n/ on a throw-away clone (git filter-branch index filter), so every original commit stays reachable from the framework repo. The next commit moves the files into place." \
    -m "$TRAILER" import/$n
  git branch -q -D import/$n
done
# One commit of PURE renames into the framework's own tree, so `git log --follow` and `git blame`
# see 100%-similarity renames.
mkdir -p src test docs/changelogs docs/absorbed
for n in contracts core devkit; do
  git mv packages/$n/src src/$n
  git mv packages/$n/test test/$n
  git mv packages/$n/CHANGELOG.md docs/changelogs/$n.md
  git mv packages/$n/README.md docs/absorbed/$n.md
done
git mv packages/cli/packages/cli/src src/console
git mv packages/cli/packages/cli/test test/console
git mv packages/cli/packages/cli/CHANGELOG.md docs/changelogs/cli.md
git mv packages/cli/packages/cli/README.md docs/absorbed/cli.md
git mv packages/cli/packages/launcher/CHANGELOG.md docs/changelogs/launcher.md
# Pending changesets of the absorbed packages become framework changesets (retargeted later).
for n in contracts core devkit cli; do
  for f in packages/$n/.changeset/*.md packages/$n/.changeset/pre/*.md; do
    [ -e "$f" ] || continue
    b=$(basename $f); [ "$b" = README.md ] && continue
    # pre/ holds the inert records of what 0.1.0-next.0 shipped (changesets only reads the top
    # level), exactly like the framework's own .changeset/pre/, so they stay inert there.
    case "$f" in */pre/*) git mv "$f" ".changeset/pre/$n-$b" ;; *) git mv "$f" ".changeset/$n-$b" ;; esac
  done
done
# Everything else of the absorbed repos (synced configs, lockfiles, CI, CLAUDE.md, .claude/, the
# launcher) stays reachable in history but leaves the tree.
git rm -rq packages
git commit -q -m "refactor: fold contracts, core, devkit and cli into the framework tree (pure renames)" \
  -m "contracts, core and devkit move to src/<part> and test/<part>; the CLI moves to src/console and test/console. Changelogs go to docs/changelogs/, READMEs to docs/absorbed/, and pending changesets to .changeset/<part>-*.md (their pre/ records to .changeset/pre/<part>-*.md). The launcher package, the absorbed repos' synced configs, lockfiles, CI and Claude files leave the tree; they stay in history. No file content changes in this commit." \
  -m "$TRAILER"
echo "$(git log --oneline | wc -l) commits on $BRANCH"
