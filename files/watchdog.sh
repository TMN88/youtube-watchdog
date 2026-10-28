#!/bin/sh
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
R=/tmp/youtube-watchdog
INIT=/etc/init.d/youtube-watchdog
ZAP=/etc/init.d/zapret2
PROBE=/usr/libexec/youtube-watchdog-probe
mkdir -p "$R" || exit 1
. /usr/share/libubox/jshn.sh
cfg() { uci -q get "youtube-watchdog.main.$1" 2>/dev/null; }
uptime_s() { cut -d. -f1 /proc/uptime; }
interval() {
    n=$(cfg interval)
    case "$n" in ''|*[!0-9]*) n=180 ;; esac
    [ "$n" -ge 180 ] 2>/dev/null && [ "$n" -le 86400 ] 2>/dev/null || n=180
    echo "$n"
}
lock() {
    # flock lives in RAM and is released by the kernel even after SIGKILL.
    exec 9>"$R/operation.lock"
    flock -n 9
}
write_state() {
    json_init
    json_add_string youtube "$result"
    json_add_string local_probe "$local_result"
    json_add_string reason "$reason"
    json_add_string configuration "$(uci -q show youtube-watchdog 2>/dev/null | sha256sum | cut -d' ' -f1)"
    json_add_string checked_at "$(date '+%Y-%m-%d %H:%M:%S %z')"
    json_add_int checked_uptime "$(uptime_s)"
    json_dump > "$R/state.new" || return 1
    mv "$R/state.new" "$R/state.json"
}
valid_host() {
    # Literal RFC1918 IPv4 only; no shell, DNS, ssh-option or URL injection.
    echo "$1" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || length($i)>3 || $i>255) exit 1; if($1==10 || ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168)) exit 0; exit 1}'
}
run_probe() {
    local_result=$("$PROBE") || local_result=UNKNOWN
    result=UNKNOWN; reason=router_local_only
    if [ "$(cfg mode)" = ssh ] && [ "$(cfg client_confirmed)" = 1 ]; then
        host=$(cfg client_host); user=$(cfg client_user)
        case "$user" in ''|*[!a-zA-Z0-9_-]*) reason=invalid_client_user; write_state; return ;; esac
        if ! valid_host "$host" || [ ! -f /etc/youtube-watchdog/client_key ] || [ ! -s /etc/youtube-watchdog/known_hosts ]; then
            reason=client_not_configured; write_state; return
        fi
        if ! command -v ssh >/dev/null 2>&1; then reason=ssh_missing; write_state; return; fi
        remote=$(timeout 65 ssh -F /dev/null -T -n -o BatchMode=yes -o PasswordAuthentication=no \
            -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/youtube-watchdog/known_hosts \
            -o ConnectTimeout=4 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 \
            -o IdentitiesOnly=yes -i /etc/youtube-watchdog/client_key \
            "$user@$host" /usr/libexec/youtube-watchdog-probe 2>/dev/null) || remote=UNKNOWN
        case "$remote" in
            HEALTHY) result=HEALTHY; reason=client_https_reachable ;;
            YOUTUBE_DOWN) result=YOUTUBE_DOWN; reason=client_youtube_transport_failure ;;
            NETWORK_DOWN|DNS_DOWN) reason=client_general_network_or_dns ;;
            *) reason=client_probe_unknown ;;
        esac
        # Local network/DNS/TLS uncertainty vetoes recovery as an additional guard.
        case "$local_result" in HEALTHY|YOUTUBE_DOWN) ;; *) result=UNKNOWN; reason=router_network_or_dns ;; esac
    fi
    write_state
}
event() {
    # Only these structured records reach the compact journal. No flash writes.
    logger -t youtube-watchdog-event -- "$1|$(date '+%Y-%m-%d %H:%M:%S %z')|$2|$3"
}
allowed() {
    now=$(uptime_s)
    if [ -r "$R/restarts" ]; then
        awk -v n="$now" '$1<=n && n-$1<3600 {print $1}' "$R/restarts" > "$R/restarts.new" || return 1
        mv "$R/restarts.new" "$R/restarts" || return 1
    fi
    count=0; last=0
    if [ -r "$R/restarts" ]; then count=$(wc -l < "$R/restarts"); last=$(tail -n 1 "$R/restarts"); fi
    [ "$count" -lt 3 ] && { [ "$count" -eq 0 ] || [ $((now - last)) -ge 900 ]; }
}
cycle() {
    run_probe || { result=UNKNOWN; return 1; }
    [ "$result" = YOUTUBE_DOWN ] || return 0
    # Rearm only after two consecutive healthy daemon checks.
    [ ! -e "$R/latched" ] || return 0
    sleep 10
    run_probe || { result=UNKNOWN; return 1; }
    [ "$result" = YOUTUBE_DOWN ] || return 0
    [ -x "$ZAP" ] && "$ZAP" running >/dev/null 2>&1 || return 0
    allowed || return 0
    # Charge attempts before invoking restart, including failed commands.
    uptime_s >> "$R/restarts" || return 1
    : > "$R/latched" || return 1
    if timeout 40 "$ZAP" restart >/dev/null 2>&1; then
        event restart confirmed_client_failure success
    else
        event restart confirmed_client_failure failed
    fi
    sleep 15
    run_probe || result=UNKNOWN
    case "$result" in HEALTHY) outcome=restored ;; YOUTUBE_DOWN) outcome=not_restored ;; *) outcome=unknown ;; esac
    event control post_restart "$outcome"
}
rearm() {
    if [ "$1" = HEALTHY ]; then healthy=$((healthy + 1)); else healthy=0; fi
    [ "$healthy" -lt 2 ] || rm -f "$R/latched"
}
wait_interval() {
    elapsed=0
    desired=$(interval)
    while [ "$elapsed" -lt "$desired" ]; do
        delay=$((desired - elapsed))
        [ "$delay" -le 5 ] || delay=5
        sleep "$delay" & child=$!; wait "$child"; child=''
        elapsed=$((elapsed + delay))
        if [ -e "$R/interval.changed" ]; then
            rm -f "$R/interval.changed"
            desired=$(interval)
        fi
    done
}
status() {
    saved=UNKNOWN; local_saved=UNKNOWN; why=not_checked; checked='—'
    if [ -r "$R/state.json" ]; then
        json_load "$(cat "$R/state.json")"
        json_get_var saved youtube; json_get_var local_saved local_probe
        json_get_var why reason; json_get_var checked checked_at
        json_get_var configuration configuration
        current=$(uci -q show youtube-watchdog 2>/dev/null | sha256sum | cut -d' ' -f1)
        if [ "$configuration" != "$current" ]; then saved=UNKNOWN; why=configuration_changed; fi
        json_get_var stamp checked_uptime
        now=$(uptime_s)
        case "$stamp" in ''|*[!0-9]*) saved=UNKNOWN; why=stale ;; *)
            if [ "$now" -lt "$stamp" ] || [ $((now - stamp)) -gt $(( $(interval) + 180 )) ]; then saved=UNKNOWN; why=stale; fi ;; esac
    fi
    # Changed/disabled client configuration invalidates previous availability.
    if [ "$(cfg mode)" != ssh ] || [ "$(cfg client_confirmed)" != 1 ]; then saved=UNKNOWN; why=router_local_only; fi
    json_init
    if "$INIT" running >/dev/null 2>&1; then json_add_boolean running 1; else json_add_boolean running 0; fi
    if "$INIT" enabled >/dev/null 2>&1; then json_add_boolean enabled 1; else json_add_boolean enabled 0; fi
    if [ -x "$ZAP" ] && "$ZAP" running >/dev/null 2>&1; then json_add_boolean zapret_running 1; else json_add_boolean zapret_running 0; fi
    json_add_string youtube "$saved"; json_add_string local_probe "$local_saved"
    json_add_string reason "$why"; json_add_string checked_at "$checked"
    json_add_int interval "$(interval)"
    if flock -n "$R/operation.lock" true 2>/dev/null; then json_add_boolean checking 0; else json_add_boolean checking 1; fi
    json_dump
}
logs() {
    json_init; json_add_array events
    # Anchor the unique logger tag and accept only two known record schemas.
    logread -e youtube-watchdog-event 2>/dev/null | sed -n 's/^.* youtube-watchdog-event: //p' | tail -n 20 | awk '{a[NR]=$0} END {for(i=NR;i>0;i--) print a[i]}' |
    while IFS='|' read -r kind at cause outcome extra; do
        [ -z "$extra" ] || continue
        case "$kind:$cause:$outcome" in
            restart:confirmed_client_failure:success|restart:confirmed_client_failure:failed|control:post_restart:restored|control:post_restart:not_restored|control:post_restart:unknown) ;;
            *) continue ;;
        esac
        # The pipeline subshell emits each object independently into a RAM stream.
        json_init; json_add_string type "$kind"; json_add_string at "$at"
        json_add_string reason "$cause"; json_add_string status "$outcome"; json_dump
    done > "$R/logs.$$"
    while IFS= read -r line; do
        json_add_object ''; json_add_string record "$line"; json_close_object
    done < "$R/logs.$$"
    rm -f "$R/logs.$$"
    json_close_array; json_dump
}
case "${1:-}" in
    daemon)
        exec 8>"$R/daemon.lock"
        flock -n 8 || exit 1
        child=''
        trap '[ -z "$child" ] || kill "$child" 2>/dev/null; exit 0' INT TERM
        # Worker inherits operation flock; stopping the parent cannot admit overlap.
        healthy=0
        while :; do
            "$0" cycle & child=$!; wait "$child"; cycle_rc=$?; child=''
            if [ "$cycle_rc" -eq 0 ] && [ -r "$R/state.json" ]; then
                json_load "$(cat "$R/state.json")"; json_get_var s youtube
                rearm "$s"
            else
                healthy=0
            fi
            wait_interval
        done ;;
    cycle) lock || exit 75; cycle ;;
    check) lock || { echo 'Проверка уже выполняется' >&2; exit 1; }; run_probe; status ;;
    status) status ;;
    logs) logs ;;
    *) echo 'youtube-watchdog check|status|logs' >&2; exit 1 ;;
esac
