#!/usr/bin/env bash
# Backup noturno Wise Wolf: banco + storage, com publicação atômica e retenção.
set -euo pipefail

STAMP="$(date +%F)"
DEST=/opt/wisewolf/backups
STORAGE_ROOT=/opt/wisewolf/supabase-docker/volumes
mkdir -p "$DEST"
[[ -d "$STORAGE_ROOT/storage" ]] || { echo "Storage ausente" >&2; exit 1; }

DB_TMP="$(mktemp "$DEST/.db-$STAMP.XXXXXXXX.sql.gz")"
STORAGE_TMP="$(mktemp "$DEST/.storage-$STAMP.XXXXXXXX.tar.gz")"
trap 'rm -f -- "$DB_TMP" "$STORAGE_TMP"' EXIT

docker exec supabase-db pg_dump -U supabase_admin -d postgres --clean --if-exists | gzip > "$DB_TMP"
gzip -t "$DB_TMP"
[[ "$(stat -c%s "$DB_TMP")" -gt 100000 ]] || { echo "Dump do banco pequeno demais" >&2; exit 1; }

tar -czf "$STORAGE_TMP" -C "$STORAGE_ROOT" storage
gzip -t "$STORAGE_TMP"
[[ "$(stat -c%s "$STORAGE_TMP")" -gt 1000000 ]] || { echo "Backup do storage pequeno demais" >&2; exit 1; }

mv -f -- "$DB_TMP" "$DEST/db-$STAMP.sql.gz"
mv -f -- "$STORAGE_TMP" "$DEST/storage-$STAMP.tar.gz"
trap - EXIT

find "$DEST" -mindepth 1 -maxdepth 1 -type f \( -name 'db-20??-??-??.sql.gz' -o -name 'storage-20??-??-??.tar.gz' \) -mtime +14 -delete
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name 'release-20??????T??????Z-*' -mtime +14 -exec rm -r -- {} +
echo "$(date -Is) backup OK: $(du -h "$DEST/db-$STAMP.sql.gz" | cut -f1) db; $(du -h "$DEST/storage-$STAMP.tar.gz" | cut -f1) storage" >> "$DEST/backup.log"
