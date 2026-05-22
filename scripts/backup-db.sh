#!/bin/bash
# Backup script for OT Dashboard SQLite database
# Run via cron or Render health check to persist data between deploys
# Usage: ./scripts/backup-db.sh
#
# IMPORTANT: This works on Render ONLY with a persistent disk attached.
# On free tier, all data is ephemeral. See render.yaml disk: config.

set -e

BACKUP_DIR="./data/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_PATH="./data/ot-dashboard.db"

mkdir -p "$BACKUP_DIR"

if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "${BACKUP_DIR}/ot-dashboard_${TIMESTAMP}.db"
  # Keep only last 10 backups
  ls -t "$BACKUP_DIR"/ot-dashboard_*.db 2>/dev/null | tail -n +11 | xargs -r rm
  echo "✅ Backup saved: ot-dashboard_${TIMESTAMP}.db"
else
  echo "⚠️ No database found at $DB_PATH"
fi
