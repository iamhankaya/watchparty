#!/usr/bin/env bash
# remote-deploy.sh testleri: sahte fetch/systemctl/health/chown ile geçici dizinde çalışır.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../remote-deploy.sh"
PASS=0
FAIL=0

# Windows'ta (Git Bash) sembolik link yetkisi yoksa ln/readlink'i düz dosyayla taklit eden shim kullan.
install_symlink_shim() {
  local probe
  probe="$(mktemp -d)"
  mkdir "$probe/d"
  if ln -sfn "$probe/d" "$probe/l" 2>/dev/null && [ -L "$probe/l" ]; then rm -rf "$probe"; return 0; fi
  rm -rf "$probe"
  SHIM="$(mktemp -d)"
  cat > "$SHIM/ln" <<'SH'
#!/usr/bin/env bash
# yalnızca "ln -sfn <hedef> <link>" biçimi
target="${@: -2:1}"; link="${@: -1}"
rm -rf "$link"; printf '%s' "$target" > "$link"
SH
  cat > "$SHIM/readlink" <<'SH'
#!/usr/bin/env bash
[ -f "$1" ] && cat "$1" || exit 1
SH
  chmod +x "$SHIM/ln" "$SHIM/readlink"
  export PATH="$SHIM:$PATH"
  echo "(sembolik link yetkisi yok; ln/readlink shim'i kullanılıyor)"
}
install_symlink_shim

setup() {
  T="$(mktemp -d)"
  export WP_ROOT="$T/root"
  export WP_HEALTH_TIMEOUT=1
  export WP_SYSTEMCTL="$T/systemctl"
  export WP_FETCH="$T/fetch"
  export WP_CHOWN="true"
  export WP_HEALTH="true"
  LOG="$T/systemctl.log"
  : > "$LOG"
  mkdir -p "$T/pkg"
  echo "merhaba" > "$T/pkg/WatchParty.Api.dll"
  python -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],'WatchParty.Api.dll'); z.close()" "$T/pkg.zip" "$T/pkg/WatchParty.Api.dll"
  printf '#!/usr/bin/env bash\ncp "%s" "$2"\n' "$T/pkg.zip" > "$T/fetch"
  printf '#!/usr/bin/env bash\necho "$*" >> "%s"\n' "$LOG" > "$T/systemctl"
  chmod +x "$T/fetch" "$T/systemctl"
}

deploy() { bash "$SCRIPT" deploy "s3://bucket/backend/$1.zip" "$1" >/dev/null 2>&1; }
target() { readlink "$WP_ROOT/current" 2>/dev/null; }
check() { # check <açıklama> <koşul-kodu>
  if [ "$2" -eq 0 ]; then return 0; fi
  echo "    BAŞARISIZ: $1"; CASE_FAIL=1
}
run() {
  CASE_FAIL=0
  setup
  "$1"
  if [ "$CASE_FAIL" -eq 0 ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1"; FAIL=$((FAIL+1)); fi
  rm -rf "$T"
}

test_deploy_success_switches_current() {
  deploy r1; deploy r2; rc=$?
  check "çıkış 0" $rc
  [ "$(target)" = "$WP_ROOT/releases/r2" ]; check "current -> r2" $?
  grep -q "restart watchparty" "$LOG"; check "restart çağrıldı" $?
  [ -f "$WP_ROOT/releases/r2/WatchParty.Api.dll" ]; check "zip açıldı" $?
}

test_failed_health_rolls_back() {
  deploy r1
  : > "$LOG"
  WP_HEALTH=false deploy r2; rc=$?
  [ "$rc" -eq 1 ]; check "çıkış 1" $?
  [ "$(target)" = "$WP_ROOT/releases/r1" ]; check "current -> r1" $?
  [ "$(grep -c 'restart watchparty' "$LOG")" -eq 2 ]; check "iki restart" $?
}

test_first_deploy_failure_leaves_no_current() {
  WP_HEALTH=false deploy r1; rc=$?
  [ "$rc" -eq 1 ]; check "çıkış 1" $?
  [ ! -e "$WP_ROOT/current" ] && [ ! -L "$WP_ROOT/current" ]; check "current yok" $?
  grep -q "stop watchparty" "$LOG"; check "stop çağrıldı" $?
}

test_keeps_last_five_releases() {
  for i in 1 2 3 4 5 6 7; do deploy "r$i"; done
  [ "$(ls "$WP_ROOT/releases" | wc -l)" -eq 5 ]; check "5 klasör" $?
  [ ! -d "$WP_ROOT/releases/r1" ] && [ ! -d "$WP_ROOT/releases/r2" ]; check "en eskiler silindi" $?
  [ -d "$WP_ROOT/releases/r7" ]; check "en yeni duruyor" $?
}

test_rollback_command() {
  deploy r1; deploy r2
  bash "$SCRIPT" rollback >/dev/null 2>&1; rc=$?
  check "çıkış 0" $rc
  [ "$(target)" = "$WP_ROOT/releases/r1" ]; check "current -> r1" $?
  bash "$SCRIPT" rollback >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 1 ]; check "tek release varken rollback çıkış 1" $?
}

test_fetch_failure_leaves_everything_untouched() {
  deploy r1
  : > "$LOG"
  WP_FETCH=false deploy r2; rc=$?
  [ "$rc" -eq 1 ]; check "çıkış 1" $?
  [ "$(target)" = "$WP_ROOT/releases/r1" ]; check "current değişmedi" $?
  [ ! -s "$LOG" ]; check "restart/stop çağrılmadı" $?
  [ ! -d "$WP_ROOT/releases/r2" ]; check "yarım release silindi" $?
}

test_hanging_health_is_bounded_and_rolls_back() {
  deploy r1
  : > "$LOG"
  start=$SECONDS
  WP_HEALTH_TIMEOUT=2 WP_HEALTH="sleep 30" timeout 20 bash "$SCRIPT" deploy s3://b/r2.zip r2 >/dev/null 2>&1; rc=$?
  elapsed=$((SECONDS - start))
  [ "$rc" -eq 1 ]; check "çıkış 1 (zaman aşımı 124 değil)" $?
  [ "$elapsed" -le 6 ]; check "süre sınırlı ($elapsed sn)" $?
  [ "$(target)" = "$WP_ROOT/releases/r1" ]; check "current -> r1" $?
  [ "$(grep -c 'restart watchparty' "$LOG")" -eq 2 ]; check "iki restart" $?
}

test_failed_restart_rolls_back() {
  deploy r1
  : > "$LOG"
  # yalnızca yeni sürüm için (ilk restart) başarısız olan sahte systemctl
  printf '#!/usr/bin/env bash
echo "$*" >> "%s"
if [ "$1" = restart ] && [ ! -e "%s/failed-once" ]; then touch "%s/failed-once"; exit 1; fi
' "$LOG" "$T" "$T" > "$T/systemctl"
  deploy r2; rc=$?
  [ "$rc" -eq 1 ]; check "çıkış 1" $?
  [ "$(target)" = "$WP_ROOT/releases/r1" ]; check "current -> r1" $?
  [ "$(grep -c 'restart watchparty' "$LOG")" -eq 2 ]; check "geri alma restart'ı denendi" $?
}

# İlk denemede stderr'e yazıp başarısız olan, sonra başarılı olan sahte sağlık komutu
# (Kestrel açılmadan önceki "Failed to connect" durumu).
test_failing_then_healthy_keeps_stderr_clean() {
  printf '#!/usr/bin/env bash
if [ ! -e "%s/health-once" ]; then touch "%s/health-once"; echo "Failed to connect" >&2; exit 7; fi
' "$T" "$T" > "$T/health"
  chmod +x "$T/health"
  WP_HEALTH_TIMEOUT=5 WP_HEALTH="$T/health" bash "$SCRIPT" deploy s3://b/r1.zip r1 >/dev/null 2>"$T/err"; rc=$?
  check "çıkış 0" $rc
  [ -e "$T/health-once" ]; check "başarısız deneme oldu" $?
  [ ! -s "$T/err" ]; check "stderr boş" $?
}

test_failed_health_logs_last_error() {
  printf '#!/usr/bin/env bash\necho "Failed to connect" >&2\nexit 7\n' > "$T/health"
  chmod +x "$T/health"
  WP_HEALTH="$T/health" bash "$SCRIPT" deploy s3://b/r1.zip r1 >"$T/out" 2>&1; rc=$?
  [ "$rc" -eq 1 ]; check "çıkış 1" $?
  grep -q "Failed to connect" "$T/out"; check "son denemenin hatası loglandı" $?
  grep -q "HATA: sağlık kontrolü 1 sn içinde başarısız oldu." "$T/out"; check "HATA satırı korundu" $?
}

run test_deploy_success_switches_current
run test_failing_then_healthy_keeps_stderr_clean
run test_failed_health_logs_last_error
run test_failed_health_rolls_back
run test_first_deploy_failure_leaves_no_current
run test_keeps_last_five_releases
run test_rollback_command
run test_failed_restart_rolls_back
run test_fetch_failure_leaves_everything_untouched
run test_hanging_health_is_bounded_and_rolls_back

echo "Sonuç: $PASS geçti, $FAIL kaldı"
[ "$FAIL" -eq 0 ]
