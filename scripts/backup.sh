#!/usr/bin/env bash
# Dump the PHIRST2 database to a timestamped, compressed file and prune old ones.
# The order history and audit log are the records that matter; everything else on
# the host is reproducible from the repository.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${DATABASE_URL:?DATABASE_URL must be set in .env}"

BACKUP_DIR="${PHIRST_BACKUP_DIR:-/var/backups/phirst2}"
RETENTION_DAYS="${PHIRST_BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

# Allow a containerized pg_dump, e.g. PHIRST_PG_DUMP="docker exec phirst-pg pg_dump".
PG_DUMP="${PHIRST_PG_DUMP:-pg_dump}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/phirst-${STAMP}.sql.gz"

# A partial dump must never be mistaken for a good one, so write to a temp name
# and rename only after pg_dump exits cleanly.
# shellcheck disable=SC2086
$PG_DUMP --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "${FILE}.part"
mv "${FILE}.part" "$FILE"

# Verify the archive is readable before trusting it.
gzip -t "$FILE"
SIZE="$(du -h "$FILE" | cut -f1)"
echo "backup written: ${FILE} (${SIZE})"

find "$BACKUP_DIR" -name 'phirst-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete

# Refuse to be quiet about an empty backup directory; a silent backup failure is
# worse than no backup at all.
COUNT="$(find "$BACKUP_DIR" -name 'phirst-*.sql.gz' -type f | wc -l)"
if [ "$COUNT" -lt 1 ]; then
  echo "ERROR: no backups present after a run" >&2
  exit 1
fi
