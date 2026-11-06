#!/bin/sh
# Install/update the current bundle; the legacy install.sh stays unchanged.
set -eu
VERSION=1.4.1
BASE='https://raw.githubusercontent.com/TMN88/youtube-watchdog/7d3f636924653bb47909872ab6b0059d495a68e0'
fail() { echo "Ошибка обновления Watchdog: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'требуется root'
. /etc/openwrt_release
case "${DISTRIB_RELEASE:-}" in 24.10.*|25.12.*) ;; *) fail 'поддерживаются OpenWrt 24.10/25.12' ;; esac
if command -v apk >/dev/null 2>&1; then pm=apk
elif command -v opkg >/dev/null 2>&1; then pm=opkg
else fail 'нет opkg/apk'; fi
installed() {
    if [ "$pm" = apk ]; then apk info -e "$1" >/dev/null 2>&1
    else opkg status "$1" 2>/dev/null | grep -q '^Status: install .* installed$'; fi
}
missing=''
for pkg in curl ca-bundle flock rpcd luci-base; do installed "$pkg" || missing="$missing $pkg"; done
command -v timeout >/dev/null 2>&1 || missing="$missing coreutils-timeout"
if [ -n "$missing" ]; then
    if [ "$pm" = apk ]; then apk update && apk add $missing || fail 'зависимости'
    else opkg update && opkg install $missing || fail 'зависимости'; fi
fi
for c in curl flock timeout sha256sum jsonfilter uci ubus cmp; do command -v "$c" >/dev/null || fail "нет $c"; done
[ -r /usr/share/libubox/jshn.sh ] || fail 'нет jshn'
[ -x /etc/init.d/rpcd ] || fail 'нет rpcd'
umask 077
mkdir -p /tmp/youtube-watchdog
exec 7>/tmp/youtube-watchdog/install.lock
flock -n 7 || fail 'другая установка уже выполняется'
stage=$(mktemp -d /tmp/youtube-watchdog-update.XXXXXX)
applying=0; success=0; backup=''
cleanup() {
    rc=$?
    trap - EXIT INT TERM HUP
    if [ "$applying" = 1 ] && [ "$success" = 0 ]; then
        flock -u 9 2>/dev/null || true
        if sh "$backup/rollback.sh"; then echo "Обновление отменено; восстановлена прежняя версия. Backup: $backup" >&2
        else echo "Ошибка автоматического отката! Выполните: sh $backup/rollback.sh" >&2; fi
    fi
    rm -rf "$stage"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
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
mkdir -p "$stage/files"
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLsS --connect-timeout 10 --max-time 90 "$BASE/$1" -o "$stage/$1"; }
fetch SHA256SUMS || fail 'не получен manifest'
while read -r src dst mode; do fetch "$src" || fail "не получен $src"; done < "$stage/map"
fetch files/config || fail 'не получен шаблон настроек'
(cd "$stage" && sha256sum -c SHA256SUMS) || fail 'контрольные суммы не совпали'
for f in files/watchdog.sh files/probe.sh files/init files/rpc uninstall.sh; do sh -n "$stage/$f" || fail "синтаксис $f"; done
for f in files/acl.json files/menu.json; do jsonfilter -i "$stage/$f" -e '@' >/dev/null || fail "JSON $f"; done
grep -qx "VERSION=$VERSION" "$stage/files/watchdog.sh" || fail 'версия payload не совпала'
current=$(sed -n 's/^VERSION=//p' /usr/bin/youtube-watchdog 2>/dev/null | head -1) || current=''
if awk -v a="$current" -v b="$VERSION" 'BEGIN {if(a !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1; split(a,x,"."); split(b,y,"."); for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 1}'; then
    fail "установлена более новая версия $current; понижение до $VERSION запрещено"
fi
same=1
while read -r src dst mode; do
    if [ -f "$dst" ] && cmp -s "$stage/$src" "$dst"; then
        case "$mode:$(ls -ld "$dst" | cut -c2-10)" in 755:rwxr-xr-x|644:rw-r--r--) ;; *) same=0 ;; esac
    else same=0; fi
done < "$stage/map"
if [ "$same" = 1 ] && [ -f /etc/config/youtube-watchdog ]; then
    echo "YouTube Watchdog $VERSION уже актуален; файлы и состояние службы сохранены."
    exit 0
fi
init=/etc/init.d/youtube-watchdog
was_running=0; was_enabled=0; fresh=0
if [ -x "$init" ]; then
    if "$init" running >/dev/null 2>&1; then was_running=1; fi
    if "$init" enabled >/dev/null 2>&1; then was_enabled=1; fi
elif [ ! -f /etc/config/youtube-watchdog ]; then fresh=1; fi
mkdir -p /etc/youtube-watchdog-backups
chmod 700 /etc/youtube-watchdog-backups
backup=$(mktemp -d /etc/youtube-watchdog-backups/update.XXXXXX)
cp "$stage/map" "$backup/map"
printf '%s %s\n' "$was_running" "$was_enabled" > "$backup/service-state"
while read -r src dst mode; do
    mkdir -p "$backup/files/$(dirname "$src")"
    [ ! -e "$dst" ] || cp -p "$dst" "$backup/files/$src"
done < "$backup/map"
[ ! -f /etc/config/youtube-watchdog ] || cp -p /etc/config/youtube-watchdog "$backup/config.before"
cat > "$backup/rollback.sh" <<'ROLLBACK'
#!/bin/sh
set -eu
b=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
init=/etc/init.d/youtube-watchdog
[ ! -x "$init" ] || { "$init" stop || true; "$init" disable || true; }
while read -r src dst mode; do
    if [ -e "$b/files/$src" ]; then cp -p "$b/files/$src" "$dst"; else rm -f "$dst"; fi
done < "$b/map"
if [ -f "$b/config.before" ]; then cp -p "$b/config.before" /etc/config/youtube-watchdog
else rm -f /etc/config/youtube-watchdog; fi
read -r running enabled < "$b/service-state"
/etc/init.d/rpcd restart
if [ "$enabled" = 1 ]; then "$init" enable; fi
if [ "$running" = 1 ]; then "$init" start; fi
ROLLBACK
chmod 700 "$backup/rollback.sh"
applying=1
if [ "$was_running" = 1 ]; then "$init" stop || fail 'не удалось остановить службу'
elif [ -x "$init" ]; then "$init" stop >/dev/null 2>&1 || true; fi
exec 9>/tmp/youtube-watchdog/operation.lock
timeout 150 flock 9 || fail 'не завершилась предыдущая проверка'
while read -r src dst mode; do
    mkdir -p "$(dirname "$dst")"
    cp "$stage/$src" "$dst.new"; chmod "$mode" "$dst.new"; mv "$dst.new" "$dst"
done < "$stage/map"
if [ ! -f /etc/config/youtube-watchdog ]; then
    mkdir -p /etc/config
    cp "$stage/files/config" /etc/config/youtube-watchdog
    chmod 600 /etc/config/youtube-watchdog
    if [ "$fresh" = 1 ]; then uci set youtube-watchdog.main.engine=auto; uci commit youtube-watchdog; fi
fi
if [ -f "$backup/config.before" ]; then cmp -s "$backup/config.before" /etc/config/youtube-watchdog || fail 'изменились пользовательские настройки'; fi
rm -f /tmp/luci-indexcache
/etc/init.d/rpcd restart
ubus -t 10 wait_for youtube-watchdog || fail 'RPC не зарегистрирован'
flock -u 9
if [ "$was_enabled" = 1 ] || [ "$fresh" = 1 ]; then "$init" enable; else "$init" disable; fi
if [ "$was_running" = 1 ] || [ "$fresh" = 1 ]; then
    "$init" start; sleep 2; "$init" running >/dev/null || fail 'служба не запустилась'
fi
actual=$(sed -n 's/^VERSION=//p' /usr/bin/youtube-watchdog | head -1)
[ "$actual" = "$VERSION" ] || fail 'версия после установки не совпала'
success=1
echo "YouTube Watchdog $actual установлен/обновлён. Backup: $backup"
echo "Откат: sh $backup/rollback.sh"
echo 'Обновите страницу LuCI. Настройки и прежнее состояние службы сохранены.'
