#!/usr/bin/env bash
# ===================================================================
#  Jointbox — nightly database backup (push OFF the box).
#  Backups you keep on the same server don't survive a disk failure.
#
#  Install:
#    sudo cp backup.sh /usr/local/bin/jointbox-backup && sudo chmod +x /usr/local/bin/jointbox-backup
#    sudo crontab -e   ->   15 2 * * *  /usr/local/bin/jointbox-backup
#
#  Configure the remote target below (rsync/scp or S3).
# ===================================================================
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://jointbox:jointbox123@localhost:5432/jointbox}"
OUT_DIR="/var/backups/jointbox"
KEEP_DAYS=14
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$OUT_DIR/jointbox_${STAMP}.sql.gz"

# Off-box target — set ONE of these:
RSYNC_DEST="${JOINTBOX_BACKUP_RSYNC:-}"      # e.g. user@backup-host:/backups/jointbox/
S3_BUCKET="${JOINTBOX_BACKUP_S3:-}"          # e.g. s3://my-bucket/jointbox/

mkdir -p "$OUT_DIR"

echo "==> Dumping database…"
pg_dump "$DB_URL" --no-owner --no-privileges | gzip -9 > "$FILE"
echo "    wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Ship it off the box
if [[ -n "$RSYNC_DEST" ]]; then
  echo "==> rsync -> $RSYNC_DEST"
  rsync -az "$FILE" "$RSYNC_DEST"
elif [[ -n "$S3_BUCKET" ]]; then
  echo "==> aws s3 cp -> $S3_BUCKET"
  aws s3 cp "$FILE" "$S3_BUCKET" --only-show-errors
else
  echo "    WARNING: no off-box target set (JOINTBOX_BACKUP_RSYNC or JOINTBOX_BACKUP_S3)."
  echo "    Backup is LOCAL ONLY — set a remote target to be safe."
fi

# Retention (local)
find "$OUT_DIR" -name 'jointbox_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "==> done. Restore with:  gunzip -c FILE.sql.gz | psql \"\$DATABASE_URL\""
