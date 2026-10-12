#!/usr/bin/env bash
# Sunucu tarafı deploy: remote-deploy.sh deploy <s3-uri> <release> | remote-deploy.sh rollback
# Çıkış kodu: 0 başarı, 1 hata. Yollar/komutlar test için ortam değişkeniyle değiştirilebilir.
set -euo pipefail

WP_ROOT="${WP_ROOT:-/opt/watchparty}"
WP_SYSTEMCTL="${WP_SYSTEMCTL:-systemctl}"
WP_HEALTH="${WP_HEALTH:-curl -fsS -o /dev/null http://localhost/api/health}"
WP_FETCH="${WP_FETCH:-aws s3 cp}"
WP_HEALTH_TIMEOUT="${WP_HEALTH_TIMEOUT:-20}"
WP_CHOWN="${WP_CHOWN:-chown -R watchparty:watchparty}"
SERVICE="watchparty"
KEEP=5

RELEASES="$WP_ROOT/releases"
CURRENT="$WP_ROOT/current"

log() { echo "[remote-deploy] $*"; }

# Sağlık kontrolü: timeout saniye boyunca saniyede bir dener.
wait_healthy() {
  local i
  for ((i = 0; i < WP_HEALTH_TIMEOUT; i++)); do
    # shellcheck disable=SC2086
    if $WP_HEALTH; then return 0; fi
    sleep 1
  done
  return 1
}

# Eski sürümleri KEEP adede indirir; current'ın hedefini asla silmez.
prune_releases() {
  local cur dir
  cur="$(readlink "$CURRENT" 2>/dev/null || true)"
  ls -1 "$RELEASES" | sort | head -n -"$KEEP" | while read -r name; do
    dir="$RELEASES/$name"
    [ "$dir" = "$cur" ] && continue
    log "Eski sürüm siliniyor: $name"
    rm -rf "$dir"
  done
}

do_deploy() {
  local uri="$1" release="$2" dir prev zip
  dir="$RELEASES/$release"
  mkdir -p "$RELEASES"

  zip="$(mktemp --suffix=.zip)"
  log "Paket indiriliyor: $uri"
  # shellcheck disable=SC2086
  $WP_FETCH "$uri" "$zip"

  log "Açılıyor: $dir"
  rm -rf "$dir"
  mkdir -p "$dir"
  unzip -q -o "$zip" -d "$dir"
  rm -f "$zip"
  # shellcheck disable=SC2086
  $WP_CHOWN "$dir"

  prev="$(readlink "$CURRENT" 2>/dev/null || true)"
  log "current -> $dir (önceki: ${prev:-yok})"
  ln -sfn "$dir" "$CURRENT"
  $WP_SYSTEMCTL restart "$SERVICE"

  if wait_healthy; then
    log "Sağlık kontrolü başarılı."
    prune_releases
    return 0
  fi

  log "HATA: sağlık kontrolü ${WP_HEALTH_TIMEOUT} sn içinde başarısız oldu."
  rm -rf "$dir"
  if [ -n "$prev" ]; then
    log "Önceki sürüme dönülüyor: $prev"
    ln -sfn "$prev" "$CURRENT"
    $WP_SYSTEMCTL restart "$SERVICE"
  else
    log "Önceki sürüm yok; current kaldırılıp servis durduruluyor."
    rm -f "$CURRENT"
    $WP_SYSTEMCTL stop "$SERVICE"
  fi
  return 1
}

do_rollback() {
  local cur prev name
  cur="$(readlink "$CURRENT" 2>/dev/null || true)"
  prev=""
  if [ -d "$RELEASES" ]; then
    while read -r name; do
      [ "$RELEASES/$name" = "$cur" ] && break
      prev="$RELEASES/$name"
    done < <(ls -1 "$RELEASES" | sort)
  fi
  if [ -z "$cur" ] || [ -z "$prev" ]; then
    log "HATA: geri dönülecek önceki sürüm yok."
    return 1
  fi
  log "Geri alınıyor: $cur -> $prev"
  ln -sfn "$prev" "$CURRENT"
  $WP_SYSTEMCTL restart "$SERVICE"
  if wait_healthy; then
    log "Sağlık kontrolü başarılı."
    return 0
  fi
  log "HATA: geri aldıktan sonra sağlık kontrolü başarısız."
  return 1
}

case "${1:-}" in
  deploy)
    [ $# -eq 3 ] || { log "Kullanım: remote-deploy.sh deploy <s3-uri> <release>"; exit 1; }
    do_deploy "$2" "$3" || exit 1
    ;;
  rollback)
    do_rollback || exit 1
    ;;
  *)
    log "Kullanım: remote-deploy.sh deploy <s3-uri> <release> | rollback"
    exit 1
    ;;
esac
