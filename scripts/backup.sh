#!/usr/bin/env bash
# F-02: logical backup of Supabase Postgres (run daily via cron / GitHub Actions).
# Requires SUPABASE_DB_URL in env. Stores compressed dump in ./backups/.
set -euo pipefail
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="backups/veloxora_${STAMP}.sql.gz"
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges | gzip -9 > "$FILE"
echo "backup written: $FILE"
# Retention: keep last 14
ls -1t backups/veloxora_*.sql.gz | tail -n +15 | xargs -r rm -f