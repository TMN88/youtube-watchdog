# YouTube Watchdog 1.4.2

DNS, network and uncertain YouTube probe failures now allow recovery after a second failed probe 30 seconds later. The probe retains diagnostic classifications. Intentionally stopped engines and monitor-only mode remain unchanged. Invalid/unconfigured LAN client settings do not authorize recovery.

Added highlighted manual engine restart button and fixed restart_engine RPC with write-only ACL, operation flock shared with automatic cycles and checks, shared minimum 15-minute / 3-per-hour restart budget, and 15-second post-restart check. Manual user action may start a stopped selected engine. RPC queues the action; its final result is recorded in the journal. No arbitrary command arguments are accepted.

Update via update.sh; user configuration and enabled/running state are preserved. Legacy install.sh remains unchanged. No live client router was altered or disrupted for these development tests. Router-local reachability does not establish LAN playback.
