#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/.local/share/talonbot}"
SESSIONS_DIR="$DATA_DIR/sessions"

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "redact-logs: no sessions directory"
  exit 0
fi

redacted_files=0

while IFS= read -r file; do
  [ -f "$file" ] || continue
  tmp="${file}.redact.tmp"
  perl -pe 's/(sk-[A-Za-z0-9_\-]{12,}|xox[baprs]-[A-Za-z0-9\-]{10,}|ghp_[A-Za-z0-9]{30,}|xapp-[A-Za-z0-9\-]{10,})/[REDACTED]/g' "$file" > "$tmp"
  if ! cmp -s "$file" "$tmp"; then
    mv "$tmp" "$file"
    redacted_files=$((redacted_files + 1))
  else
    rm -f "$tmp"
  fi
done < <(find "$SESSIONS_DIR" -type f -name '*.jsonl')

echo "redact-logs: redacted_files=$redacted_files"
