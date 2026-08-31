#!/usr/bin/env bash
# Compile and run the ClojureScript test suite, plus the tagger round-trip.
#
# Exits non-zero on ANY failure. shadow-cljs prints compile errors and still
# exits 0 in some paths, and karma's summary is easy to misread when the bundle
# is stale -- so this recompiles first and greps the summary for an exact match.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@21}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
: "${CHROME_BIN:=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
export CHROME_BIN

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "== compiling karma-test =="
out=$(npx shadow-cljs compile karma-test 2>&1)
echo "$out" | grep -v omz_nvm
echo "$out" | grep -q "Build completed" || fail "compile did not complete"
echo "$out" | grep -qiE "^(Errors|.*Error in )" && fail "compile reported an error"

echo "== karma =="
kout=$(npx karma start --single-run 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
echo "$kout" | grep -E "FAILED$" | sed 's/^/  /'
summary=$(echo "$kout" | grep -oE "TOTAL: [0-9]+ (SUCCESS|FAILED)[^$]*" | tail -1)
echo "  $summary"
echo "$summary" | grep -q "FAILED" && fail "karma reported failures"
echo "$summary" | grep -q "SUCCESS" || fail "no karma summary found - did the browser start?"

echo "== tagger round-trip (both shells) =="
node test/js/verify_tagger.mjs 2>&1 | grep -E "FAIL|ALL GREEN" || fail "tagger verification produced no result"

# The dev build cannot see Closure property renaming, so the JS -> ClojureScript
# boundary is checked under :advanced separately. Skipped with --fast because it
# costs a full release compile.
if [ "${1:-}" != "--fast" ]; then
  echo "== boundary under advanced optimizations =="
  npx shadow-cljs release release-guard 2>&1 | grep -q "Build completed" \
    || fail "release-guard build did not complete"
  node target/release-guard.js || fail "boundary broken in the release build"
fi

echo "ALL SUITES GREEN"
