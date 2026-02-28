#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if command -v rg >/dev/null 2>&1; then
  mapfile -t shell_files < <(rg -l --hidden --glob '!.git/**' '^#!/usr/bin/env bash' bin scripts install.sh bootstrap.sh)
else
  mapfile -t shell_files < <(grep -RIl --exclude-dir=.git --exclude-dir=node_modules '^#!/usr/bin/env bash' bin scripts install.sh bootstrap.sh 2>/dev/null || true)
fi

if [ "${#shell_files[@]}" -eq 0 ]; then
  echo "lint:shell: no bash scripts found"
  exit 1
fi

for file in "${shell_files[@]}"; do
  bash -n "$file"
done

echo "lint:shell: validated ${#shell_files[@]} bash scripts"
