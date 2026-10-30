#!/usr/bin/env bash
# Create and migrate the isolated test database. Integration tests are skipped
# unless TEST_DATABASE_URL points at a reachable, migrated database.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must be set in .env}"

TEST_DB_NAME="$(basename "${TEST_DATABASE_URL%%\?*}")"
ADMIN_URL="${TEST_DATABASE_URL%/*}/postgres"

echo "Ensuring database ${TEST_DB_NAME} exists..."
psql "$ADMIN_URL" -tc "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'" | grep -q 1 \
  || psql "$ADMIN_URL" -c "CREATE DATABASE ${TEST_DB_NAME}"

echo "Applying migrations to ${TEST_DB_NAME}..."
DATABASE_URL="$TEST_DATABASE_URL" npx tsx scripts/migrate.ts
echo "Test database ready."
