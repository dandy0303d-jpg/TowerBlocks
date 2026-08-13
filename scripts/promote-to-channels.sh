#!/bin/bash
# Sync `main` into every long-lived channel branch.
#
# Usage:
#   ./scripts/promote-to-channels.sh
#
# Discovers all local branches matching `channel/*` and merges main
# into each with --no-ff. Bails on the first merge conflict so you can
# resolve it manually — rerun the script afterward to continue.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Sanity: must have a clean working tree before we start switching branches.
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: working tree not clean. Commit or stash first." >&2
    git status --short
    exit 1
fi

# Sanity: main must exist.
if ! git rev-parse --verify --quiet main >/dev/null; then
    echo "ERROR: no 'main' branch." >&2
    exit 1
fi

STARTING_BRANCH="$(git branch --show-current)"

# Discover all channel/* branches.
CHANNELS=$(git for-each-ref --format='%(refname:short)' refs/heads/channel/*)

if [ -z "$CHANNELS" ]; then
    echo "No channel/* branches found. Nothing to promote."
    exit 0
fi

echo "Will sync main into:"
for ch in $CHANNELS; do
    echo "  - $ch"
done
echo

# Do it.
for ch in $CHANNELS; do
    echo "=== merging main → $ch ==="
    git checkout "$ch"
    if ! git merge --no-ff main -m "chore: sync main into $ch"; then
        echo
        echo "CONFLICT on $ch. Resolve, commit, then re-run this script." >&2
        exit 1
    fi
done

# Return to whatever branch the user started on (or develop as a fallback).
if [ -n "$STARTING_BRANCH" ] && git rev-parse --verify --quiet "$STARTING_BRANCH" >/dev/null; then
    git checkout "$STARTING_BRANCH"
else
    git checkout develop 2>/dev/null || true
fi

echo
echo "All channels synced. Now on: $(git branch --show-current)"
