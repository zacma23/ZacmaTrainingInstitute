#!/usr/bin/env bash
set -euo pipefail

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Requires NETLIFY_DB_URL (or DATABASE_URL) pointing at the Postgres database.
DB_URL="${NETLIFY_DB_URL:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "Error: NETLIFY_DB_URL (or DATABASE_URL) is not set." >&2
  exit 1
fi

DB_NAME="$(node -e "console.log(new URL(process.argv[1]).pathname.replace(/^\//,'') || 'database')" "$DB_URL")"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "Backing up Postgres database '${DB_NAME}'..."
pg_dump \
  --no-owner \
  --no-privileges \
  "$DB_URL" | gzip > "$OUT_FILE"

echo "Backup completed: ${OUT_FILE}"
