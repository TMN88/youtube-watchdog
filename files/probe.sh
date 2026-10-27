#!/bin/sh
# Runs unchanged on the router and the explicitly enrolled LAN diagnostic client.
# Transport reachability only; never a claim of video playback.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
dns_ok() { timeout 6 nslookup "$1" >/dev/null 2>&1; }
https_code() {
    curl --disable --ipv4 --noproxy '*' --proto '=https' --tlsv1.2 --silent \
        --connect-timeout 4 --max-time 8 --max-filesize 262144 \
        --output /dev/null --write-out '%{http_code}' "$1" 2>/dev/null
}
probe() {
    for host in www.youtube.com i.ytimg.com youtubei.googleapis.com example.com; do
        dns_ok "$host" || { echo DNS_DOWN; return; }
    done
    code=$(https_code https://example.com/) || { echo NETWORK_DOWN; return; }
    case "$code" in 200|204|301|302) ;; *) echo NETWORK_DOWN; return ;; esac
    good=0; bad=0; uncertain=0
    for url in https://www.youtube.com/generate_204 https://i.ytimg.com/generate_204 https://youtubei.googleapis.com/; do
        code=$(https_code "$url"); rc=$?
        if [ "$rc" -ne 0 ]; then
            case "$rc" in 6) echo DNS_DOWN; return ;; 7|28|35|52|55|56) bad=$((bad + 1)) ;; *) uncertain=$((uncertain + 1)) ;; esac
        else
            case "$code" in
                200|204|301|302|303|307|308|403|404|405) good=$((good + 1)) ;;
                *) uncertain=$((uncertain + 1)) ;;
            esac
        fi
    done
    if [ "$good" -ge 2 ]; then echo HEALTHY
    elif [ "$bad" -ge 2 ] && [ "$uncertain" -eq 0 ]; then echo YOUTUBE_DOWN
    else echo UNKNOWN; fi
}
probe
