#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Node syntax =="
while IFS= read -r -d '' file; do
  node --check "$file" >/dev/null
  echo "OK  $file"
done < <(find server -type f -name '*.js' -print0 | sort -z)

echo "== Project configuration =="
node --input-type=module <<'NODE'
import fs from 'node:fs';
for (const file of ['package.json','server/package.json','cloudflare/api/package.json','cloudflare/api/wrangler.jsonc']) {
  JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`OK  ${file}`);
}
NODE

echo "== Deployment script syntax =="
bash -n scripts/deploy-cloudflare.sh
echo "OK  scripts/deploy-cloudflare.sh"

echo "== Secret exclusion =="
if find . -path './.git' -prune -o -type f \( -name '.env' -o -name '.env.local' \) -print | grep -q .; then
  echo "FAIL: real environment file found in project"
  exit 1
fi
echo "OK  no real .env files"

echo "All static checks passed. Run npm install/build/test on a networked development machine for dependency-backed verification."
