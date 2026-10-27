#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Запустите от root' >&2; exit 1; }
mkdir -p /tmp/youtube-watchdog
exec 7>/tmp/youtube-watchdog/install.lock
flock -n 7 || { echo 'Установка/удаление уже выполняется' >&2; exit 1; }
if [ -x /etc/init.d/youtube-watchdog ]; then
    /etc/init.d/youtube-watchdog stop
    /etc/init.d/youtube-watchdog disable
fi
# Wait for any manual read-only check before removing its executable.
exec 9>/tmp/youtube-watchdog/operation.lock
timeout 130 flock 9 || { echo 'Проверка ещё выполняется. Повторите удаление позже.' >&2; exit 1; }
rm -f /usr/bin/youtube-watchdog /usr/libexec/youtube-watchdog-probe \
    /etc/init.d/youtube-watchdog /usr/libexec/rpcd/youtube-watchdog \
    /usr/share/rpcd/acl.d/luci-app-youtube-watchdog.json \
    /usr/share/luci/menu.d/luci-app-youtube-watchdog.json \
    /www/luci-static/resources/view/youtube-watchdog/overview.js \
    /usr/libexec/youtube-watchdog-uninstall /etc/config/youtube-watchdog
rmdir /www/luci-static/resources/view/youtube-watchdog 2>/dev/null || true
# Manually provisioned SSH credentials are retained to avoid deleting user keys.
rmdir /etc/youtube-watchdog 2>/dev/null || true
rm -f /tmp/youtube-watchdog/state.json /tmp/youtube-watchdog/latched /tmp/youtube-watchdog/restarts
rm -f /tmp/luci-indexcache
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
echo 'YouTube Watchdog удалён. Zapret2 не затронут. Зависимости и вручную добавленные SSH-ключи сохранены.'
