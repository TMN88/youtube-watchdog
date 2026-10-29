#!/bin/sh
# Site_Checker files/sitecheck-check-zapret, revision
# ed1e31ac4e5e8fa662532b58bf7fb6dbf89375b7: test YouTube itself.
# A completed HTTP exchange is reachability, not video playback proof.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
dns_ok() { timeout 6 nslookup "$1" >/dev/null 2>&1; }
https_code() {
    curl --disable --ipv4 --noproxy '*' --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --location --max-redirs 3 --silent --connect-timeout 3 --max-time 5 \
        --speed-time 3 --speed-limit 1 --range 0-65535 \
        --user-agent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) curl/8.0' \
        --output /dev/null --write-out '%{http_code}' "$1" 2>/dev/null
}
probe() {
    # Control/DNS failures veto recovery, but cannot override a successful
    # direct request to YouTube with an invented YouTube failure.
    yt_dns=0; dns_ok www.youtube.com && yt_dns=1
    control_dns=0; dns_ok example.com && control_dns=1
    yt_code=$(https_code https://www.youtube.com/) && yt_rc=0 || yt_rc=$?
    if [ "$yt_rc" -eq 0 ]; then
        case "$yt_code" in [1-5][0-9][0-9]) echo HEALTHY; return ;; *) echo UNKNOWN; return ;; esac
    fi
    if [ "$yt_dns" -ne 1 ] || [ "$yt_rc" -eq 6 ] || [ "$control_dns" -ne 1 ]; then echo DNS_DOWN; return; fi
    control_code=$(https_code https://example.com/) || { echo NETWORK_DOWN; return; }
    case "$control_code" in 2??|3??) ;; *) echo NETWORK_DOWN; return ;; esac
    case "$yt_rc" in
        7|28|35|52|55|56) echo YOUTUBE_DOWN ;;
        *) echo UNKNOWN ;;
    esac
}
probe
