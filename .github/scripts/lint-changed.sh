#!/usr/bin/env bash
# Lint ratchet for one app directory (run from inside it): every file this push
# or PR changed may not have MORE eslint errors than it had before the change.
#
# Why not lint everything: the repo carries ~23k old lint errors, so a full run
# is red on every push and a NEW error is invisible in the noise. Why not "a
# changed file must be fully clean": that would block a one-line fix in a file
# with 500 old errors. A ratchet catches every new error and lets the old debt
# shrink as files are cleaned.
#
# Usage: lint-changed.sh <app-dir> <extension regex>   e.g. backend 'src/.*\.ts$'
set -euo pipefail
APP="$1"; PATTERN="$2"
BASE="${BASE:-}"
if [ -z "$BASE" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  BASE=$(git rev-parse HEAD~1 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)
fi
mapfile -t FILES < <(git diff --name-only --diff-filter=ACMR "$BASE" HEAD -- . | sed "s#^$APP/##" | grep -E "$PATTERN" || true)
if [ ${#FILES[@]} -eq 0 ]; then echo "No changed files to lint."; exit 0; fi

count() { # errors in a file, or 0 if it does not exist at that commit
  { npx eslint --no-warn-ignored -f json "$1" 2>/dev/null || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).reduce((n,f)=>n+f.errorCount,0))}catch{console.log(0)}})'
}
fail=0
for f in "${FILES[@]}"; do
  now=$(count "$f")
  before=0
  if git cat-file -e "$BASE:$APP/$f" 2>/dev/null; then
    # Count the old version at the SAME path: typed lint rules only apply to
    # files inside the tsconfig project, so a temp copy elsewhere mis-counts.
    cp "$f" "$f.lint-now"; trap 'mv -f "$f.lint-now" "$f" 2>/dev/null || true' EXIT
    git show "$BASE:$APP/$f" > "$f"
    before=$(count "$f")
    mv -f "$f.lint-now" "$f"; trap - EXIT
  fi
  if [ "$now" -gt "$before" ]; then
    echo "::error file=$APP/$f::$f now has $now lint errors (was $before). Fix the new ones:"
    npx eslint --no-warn-ignored "$f" || true
    fail=1
  else
    echo "ok  $f  ($before -> $now errors)"
  fi
done
exit $fail
