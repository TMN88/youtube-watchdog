#!/bin/sh
set -eu
VERSION=1.2.0
BASE="https://raw.githubusercontent.com/TMN88/youtube-watchdog/1578abb17dec69bfb841fc8ea5888bfa61545126"
fail() { echo "Ошибка: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'Запустите от root'
[ -r /etc/openwrt_release ] || fail 'Требуется OpenWrt'
. /etc/openwrt_release
case "${DISTRIB_RELEASE:-}" in 24.10.*|25.12.*) ;; *) fail 'Поддерживаются OpenWrt 24.10.x и 25.12.x' ;; esac
for cmd in uci ubus nslookup sha256sum jsonfilter; do command -v "$cmd" >/dev/null || fail "Не найдена команда $cmd"; done
if command -v apk >/dev/null 2>&1; then pm=apk
elif command -v opkg >/dev/null 2>&1; then pm=opkg
else fail 'Не найден apk/opkg'; fi
installed() {
    if [ "$pm" = apk ]; then apk info -e "$1" >/dev/null 2>&1
    else opkg status "$1" 2>/dev/null | grep -q '^Status: install .* installed$'; fi
}
missing=''
for pkg in curl ca-bundle flock rpcd luci-base; do installed "$pkg" || missing="$missing $pkg"; done
# Some OpenWrt builds omit the BusyBox timeout applet. Install its small
# standalone replacement before checking runtime tools or changing service files.
command -v timeout >/dev/null 2>&1 || missing="$missing coreutils-timeout"
if [ -n "$missing" ]; then
    if [ "$pm" = apk ]; then apk update && apk add $missing || fail 'Не установлены зависимости'
    else opkg update && opkg install $missing || fail 'Не установлены зависимости'; fi
fi
command -v flock >/dev/null || fail 'Не установлен flock'
command -v timeout >/dev/null 2>&1 || fail 'Команда timeout недоступна после установки coreutils-timeout; служба не установлена'
[ -r /usr/share/libubox/jshn.sh ] || fail 'Не найдена библиотека jshn'
[ -x /etc/init.d/rpcd ] || fail 'Не найден rpcd'
mkdir -p /tmp/youtube-watchdog
exec 7>/tmp/youtube-watchdog/install.lock
flock -n 7 || fail 'Установка уже выполняется'
stage=$(mktemp -d /tmp/youtube-watchdog-install.XXXXXX)
applying=0; success=0; was_running=0; was_enabled=0
init=/etc/init.d/youtube-watchdog
if [ -x "$init" ]; then
    "$init" running >/dev/null 2>&1 && was_running=1
    "$init" enabled >/dev/null 2>&1 && was_enabled=1
fi
cleanup() {
    rc=$?
    trap - EXIT INT TERM
    if [ "$applying" = 1 ] && [ "$success" = 0 ]; then
        "$init" stop >/dev/null 2>&1 || true
        "$init" disable >/dev/null 2>&1 || true
        while IFS=' ' read -r src dst mode; do
            [ -n "$src" ] || continue
            if [ -e "$stage/backup/$src" ]; then cp -p "$stage/backup/$src" "$dst"; else rm -f "$dst"; fi
        done < "$stage/map"
        if [ "$was_enabled" = 1 ]; then "$init" enable || true; fi
        if [ "$was_running" = 1 ]; then "$init" start || true; fi
        /etc/init.d/rpcd restart >/dev/null 2>&1 || true
        echo 'Установка не завершена; прежние файлы восстановлены.' >&2
    fi
    rm -rf "$stage"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$stage/map" <<'MAP'
files/watchdog.sh /usr/bin/youtube-watchdog 755
files/probe.sh /usr/libexec/youtube-watchdog-probe 755
files/init /etc/init.d/youtube-watchdog 755
files/rpc /usr/libexec/rpcd/youtube-watchdog 755
files/acl.json /usr/share/rpcd/acl.d/luci-app-youtube-watchdog.json 644
files/menu.json /usr/share/luci/menu.d/luci-app-youtube-watchdog.json 644
files/overview.js /www/luci-static/resources/view/youtube-watchdog/overview.js 644
uninstall.sh /usr/libexec/youtube-watchdog-uninstall 755
MAP
fetch() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 10 --max-time 60 "$BASE/$1" -o "$stage/$1"; }
mkdir -p "$stage/files"
fetch SHA256SUMS || fail 'Не получена контрольная сумма'
while IFS=' ' read -r src dst mode; do fetch "$src" || fail "Не получен $src"; done < "$stage/map"
fetch files/config || fail 'Не получен UCI шаблон'
(cd "$stage" && sha256sum -c SHA256SUMS) || fail 'Контрольные суммы не совпали'
for file in files/watchdog.sh files/probe.sh files/init files/rpc uninstall.sh; do sh -n "$stage/$file" || fail "Синтаксис $file"; done
for file in files/acl.json files/menu.json; do jsonfilter -i "$stage/$file" -e '@' >/dev/null || fail "JSON $file"; done
# Stage every backup before the first service/file mutation.
while IFS=' ' read -r src dst mode; do
    mkdir -p "$stage/backup/$(dirname "$src")"
    [ ! -e "$dst" ] || cp -p "$dst" "$stage/backup/$src"
done < "$stage/map"
applying=1
[ ! -x "$init" ] || "$init" stop
exec 9>/tmp/youtube-watchdog/operation.lock
timeout 130 flock 9 || fail 'Не завершилась текущая проверка'
while IFS=' ' read -r src dst mode; do
    mkdir -p "$(dirname "$dst")"
    cp "$stage/$src" "$dst.new"
    chmod "$mode" "$dst.new"
    mv "$dst.new" "$dst"
done < "$stage/map"
# Configuration is never replaced during an upgrade.
if [ ! -e /etc/config/youtube-watchdog ]; then
    cp "$stage/files/config" /etc/config/youtube-watchdog
    chmod 600 /etc/config/youtube-watchdog
fi
uci -q get youtube-watchdog.main >/dev/null || fail 'Не найдена UCI секция main'
mkdir -p /etc/youtube-watchdog
chmod 700 /etc/youtube-watchdog
rm -f /tmp/luci-indexcache
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
ubus -t 10 wait_for youtube-watchdog || fail 'RPC объект не зарегистрирован'
"$init" enable
# Files and RPC registration are complete. Release the probe lock before
# procd starts the daemon so its first cycle can actually take the lock.
flock -u 9
"$init" start
sleep 2
"$init" running >/dev/null 2>&1 || fail 'Служба не запустилась'
success=1
echo "YouTube Watchdog $VERSION установлен. Меню: Службы → YouTube Watchdog"
echo 'По умолчанию: статус YouTube с роутера; безопасный режим без автоперезапуска. Доступ с устройств LAN отдельно не подтверждён.'
echo 'Команды: youtube-watchdog check | status | logs'
echo 'Удаление: sh /usr/libexec/youtube-watchdog-uninstall'
/usr/bin/youtube-watchdog status
