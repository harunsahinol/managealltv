#!/usr/bin/env bash
#
# ManageAllTV backup: PostgreSQL dump + media files, with rotation and an optional off-site copy.
# Meant for a nightly root cron job on the server (see README.md, "Yedekleme"):
#
#   30 3 * * * /opt/managealltv/deploy/backup.sh >> /var/log/managealltv-backup.log 2>&1
#
# Settings come from the environment or deploy/.env:
#   BACKUP_DIR           where backups go (default /var/backups/managealltv)
#   BACKUP_KEEP_DAYS     days to keep database dumps and copies of deleted media (default 14)
#   BACKUP_RSYNC_TARGET  optional rsync destination for an off-site copy, e.g. yedek@nas:/yedek/tv
#   MEDIA_VOLUME         Docker volume holding the media (default managealltv_media)
#
# Layout under BACKUP_DIR:
#   db/managealltv-<stamp>.dump      pg_dump custom format (restore with pg_restore), rotated
#   media/files, media/thumbs        mirror of the processed media (rsync), always current
#   media-deleted/<stamp>/           media removed since the previous run, rotated; keeps the
#                                    files that older dumps still reference
#   media-tar/media-<stamp>.tar      only without rsync: a full tar per run, rotated
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${ENV_FILE:-$SCRIPT_DIR/.env}
COMPOSE_FILE=${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "HATA: $*" >&2; exit 1; }
trap 'fail "yedekleme ${LINENO}. satırda yarıda kaldı (çıkış kodu $?)"' ERR

# Reads one KEY=value from .env without sourcing it: the file is in Docker Compose syntax, and secrets
# such as BETTER_AUTH_SECRET may contain characters a shell would interpret.
env_value() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

BACKUP_DIR=${BACKUP_DIR:-$(env_value BACKUP_DIR)}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/managealltv}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-$(env_value BACKUP_KEEP_DAYS)}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_RSYNC_TARGET=${BACKUP_RSYNC_TARGET:-$(env_value BACKUP_RSYNC_TARGET)}
MEDIA_VOLUME=${MEDIA_VOLUME:-$(env_value MEDIA_VOLUME)}
MEDIA_VOLUME=${MEDIA_VOLUME:-managealltv_media}

[[ $BACKUP_KEEP_DAYS =~ ^[0-9]+$ ]] || fail "BACKUP_KEEP_DAYS bir sayı olmalı: '$BACKUP_KEEP_DAYS'"
[[ -f $ENV_FILE ]] || fail "$ENV_FILE bulunamadı (docker compose ayarları bu dosyadan okunur)"
command -v docker >/dev/null || fail "docker bulunamadı"

compose() {
  docker compose --project-directory "$SCRIPT_DIR" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

STAMP=$(date '+%Y%m%d-%H%M%S')
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media"
# Dumps contain password hashes and sessions: keep the directory private (best effort on e.g. NFS).
chmod 700 "$BACKUP_DIR" 2>/dev/null || log "UYARI: $BACKUP_DIR izinleri değiştirilemedi"

# One run at a time (a slow off-site copy must not overlap the next night's run).
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || fail "başka bir yedekleme hâlâ çalışıyor"

# ------------------------------------------------------------------ database
log "Veritabanı yedekleniyor…"
dump="$BACKUP_DIR/db/managealltv-$STAMP.dump"
# Written under a temporary name first, so a half-written dump never looks like a good one.
compose exec -T postgres pg_dump -U managealltv -d managealltv --format=custom --compress=6 >"$dump.partial"
[[ -s "$dump.partial" ]] || fail "pg_dump boş çıktı üretti"
mv "$dump.partial" "$dump"
chmod 600 "$dump"
log "Veritabanı: $dump ($(du -h "$dump" | cut -f1))"

# ------------------------------------------------------------------ media
# Only the processed files and thumbnails: uploads/ holds in-flight originals that are deleted anyway.
media_source=$(docker volume inspect -f '{{ .Mountpoint }}' "$MEDIA_VOLUME" 2>/dev/null || true)
if command -v rsync >/dev/null && [[ -n $media_source && -r $media_source/files ]]; then
  log "Medya eşitleniyor (rsync)…"
  # Media files never change in place (a new upload is a new file), so a mirror plus the files that
  # disappeared since the last run is enough to restore any dump that is still kept.
  rsync -a --delete --backup --backup-dir="$BACKUP_DIR/media-deleted/$STAMP" \
    "$media_source/files" "$media_source/thumbs" "$BACKUP_DIR/media/"
  log "Medya: $BACKUP_DIR/media ($(du -sh "$BACKUP_DIR/media" | cut -f1))"
else
  # Without rsync (or without access to the volume directory): stream a tar out of the container.
  log "UYARI: rsync yok ya da medya klasörüne erişilemiyor; medyanın tamamı tar olarak kopyalanıyor."
  log "       Her gece tam kopya almamak için rsync kurun ve betiği root olarak çalıştırın."
  mkdir -p "$BACKUP_DIR/media-tar"
  archive="$BACKUP_DIR/media-tar/media-$STAMP.tar"
  compose exec -T server tar -C /data/media -cf - files thumbs >"$archive.partial"
  mv "$archive.partial" "$archive"
  log "Medya: $archive ($(du -h "$archive" | cut -f1))"
fi

# ------------------------------------------------------------------ rotation
log "$BACKUP_KEEP_DAYS günden eski yedekler siliniyor…"
find "$BACKUP_DIR/db" -maxdepth 1 -name 'managealltv-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -print -delete
find "$BACKUP_DIR/db" -maxdepth 1 -name '*.partial' -mtime +1 -print -delete
if [[ -d $BACKUP_DIR/media-deleted ]]; then
  find "$BACKUP_DIR/media-deleted" -mindepth 1 -maxdepth 1 -type d -mtime +"$BACKUP_KEEP_DAYS" -print -exec rm -rf {} +
fi
if [[ -d $BACKUP_DIR/media-tar ]]; then
  find "$BACKUP_DIR/media-tar" -maxdepth 1 -name 'media-*.tar*' -mtime +"$BACKUP_KEEP_DAYS" -print -delete
fi

# ------------------------------------------------------------------ off-site copy
if [[ -n $BACKUP_RSYNC_TARGET ]]; then
  command -v rsync >/dev/null || fail "BACKUP_RSYNC_TARGET ayarlı ama rsync kurulu değil"
  log "Sunucu dışına kopyalanıyor: $BACKUP_RSYNC_TARGET"
  rsync -a --delete --exclude '.lock' --exclude '*.partial' "$BACKUP_DIR/" "$BACKUP_RSYNC_TARGET/"
else
  log "UYARI: BACKUP_RSYNC_TARGET boş; yedekler yalnız bu sunucuda. Disk arızasına karşı başka bir makineye kopyalayın."
fi

log "Yedekleme tamamlandı."
