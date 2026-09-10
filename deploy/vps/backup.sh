#!/bin/bash
# Backup noturno Wise Wolf: banco (pg_dump) + storage (tar) — retenção 14 dias
set -e
STAMP=$(date +%F)
DEST=/opt/wisewolf/backups
docker exec supabase-db pg_dump -U supabase_admin -d postgres --clean --if-exists | gzip > "$DEST/db-$STAMP.sql.gz"
tar -czf "$DEST/storage-$STAMP.tar.gz" -C /opt/wisewolf/supabase-docker/volumes storage 2>/dev/null || true
find "$DEST" -name "*.gz" -mtime +14 -delete
echo "$(date -Is) backup ok: $(du -sh $DEST/db-$STAMP.sql.gz | cut -f1) db" >> "$DEST/backup.log"
