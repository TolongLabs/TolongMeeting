#!/usr/bin/env bash
# precommit-check.sh: exit 1 when a staged file or added line looks like media, an archive or a secret.
# Prints file names only, never the match.
set -uo pipefail
bad=0
while IFS= read -r f; do
  case "$f" in spikes/03-qr/samples/*) continue ;; esac
  if printf '%s\n' "$f" | grep -Eq '\.(png|jpe?g|webp|mkv|mp4|webm|wav|flac|pcm|tar|enc|db|sqlite)$'; then
    echo "media/archive: $f"; bad=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)
while IFS= read -r f; do
  [ "$f" = spikes/00-setup/precommit-check.sh ] && continue # holds the patterns itself
  if git diff --cached -U0 -- "$f" | grep -E '^\+' | grep -Ev '^\+\+\+' | grep -Eq 'pwd=|tk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|tskey-|Bearer [A-Za-z0-9._-]{8,}'; then
    echo "secret-like line: $f"; bad=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)
exit $bad
