/* Targeted POSIX-shell behavior tests. No real network, router or service calls. */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const busybox = process.env.BUSYBOX;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'yw-test-'));
const posix = p => p.replace(/\\/g, '/');
let count = 0;
function shell(name, code) {
    const file = path.join(tmp, 'case.sh');
    fs.writeFileSync(file, 'set -eu\n' + code + '\n');
    const r = cp.spawnSync(busybox || 'sh', busybox ? ['sh', posix(file)] : [file], { encoding: 'utf8', env: {...process.env, TEST_TMP:posix(tmp)} });
    assert.equal(r.status, 0, name + '\n' + r.stdout + r.stderr);
    console.log('PASS ' + name); count++;
}
const read = f => fs.readFileSync(path.join(root,f),'utf8');
for (const file of ['install.sh','uninstall.sh','files/probe.sh','files/watchdog.sh','files/rpc','files/init']) {
    const args = busybox ? ['sh','-n',posix(path.join(root,file))] : ['-n',path.join(root,file)];
    assert.equal(cp.spawnSync(busybox || 'sh',args).status,0,file); count++;
}
new vm.Script('(function(){'+read('files/overview.js')+'})'); count++;
const acl=JSON.parse(read('files/acl.json'))['luci-app-youtube-watchdog'];
assert.deepEqual(acl.read.ubus['youtube-watchdog'],['status','logs']);
assert.deepEqual(acl.write.ubus['youtube-watchdog'],['start','stop','restart','check','enable','disable']);
assert(!JSON.stringify(acl).includes('file')); count++;
const menu=JSON.parse(read('files/menu.json'));
assert.equal(menu['admin/services/youtube-watchdog'].action.path,'youtube-watchdog/overview'); count++;
const probe=read('files/probe.sh').replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin','PATH="$PATH"').replace(/\nprobe\n?$/,'\n');
function probeTest(name, options, expected) {
    shell(name, probe+`
dns_ok() { ${options.dns === false ? 'return 1' : 'return 0'}; }
https_code() {
 case "$1" in
  https://example.com/) ${options.control || 'echo 200'} ;;
  https://www.youtube.com/*) ${options.www || 'echo 204'} ;;
  https://i.ytimg.com/*) ${options.img || 'echo 404'} ;;
  *) ${options.api || 'echo 403'} ;;
 esac
}
[ "$(probe)" = '${expected}' ]
`);
}
probeTest('403/404 count as TLS/HTTP reachability',{},'HEALTHY');
probeTest('two independent reachable resources suffice',{www:'return 28'},'HEALTHY');
probeTest('DNS failure veto',{dns:false},'DNS_DOWN');
probeTest('general HTTPS outage veto',{control:'return 28'},'NETWORK_DOWN');
probeTest('control HTTP 403 is not healthy internet',{control:'echo 403'},'NETWORK_DOWN');
probeTest('two YouTube transport failures',{www:'return 28',img:'return 35'},'YOUTUBE_DOWN');
probeTest('YouTube 5xx uncertainty',{www:'echo 503',img:'echo 502'},'UNKNOWN');
probeTest('certificate errors cannot trigger restart',{www:'return 60',img:'return 60'},'UNKNOWN');
probeTest('YouTube resolver error veto',{www:'return 6'},'DNS_DOWN');
shell('curl enforces IPv4/TLS/no proxy/time bounds',probe+`
curl() {
 case " $* " in *' --ipv4 '*) ;; *) return 90 ;; esac
 case " $* " in *' --noproxy * '*) ;; *) return 91 ;; esac
 case " $* " in *' --proto =https '*) ;; *) return 92 ;; esac
 case " $* " in *' --max-time 8 '*) ;; *) return 93 ;; esac
 case " $* " in *' --insecure '*|*' -k '*) return 94 ;; esac
 echo 204
}
[ "$(https_code https://www.youtube.com/generate_204)" = 204 ]
`);
const watchdog=read('files/watchdog.sh').split('case "${1:-}" in')[0]
 .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin','PATH="$PATH"')
 .replace('R=/tmp/youtube-watchdog','R="$TEST_TMP/runtime"')
 .replace('. /usr/share/libubox/jshn.sh','')
 .replaceAll('/etc/youtube-watchdog',posix(path.join(tmp,'keys')))
 .replace('local_result=$("$PROBE")','local_result=$(mock_local_probe)');
const common=watchdog+`
write_state() { printf '%s|%s\\n' "$result" "$reason" > "$R/test-state"; }
mock_local_probe() { echo "\${LOCAL:-HEALTHY}"; }
cfg() {
 case "$1" in mode) echo "\${MODE:-safe}" ;; client_confirmed) echo "\${CONFIRM:-1}" ;; client_host) echo "\${HOST:-192.168.1.2}" ;; client_user) echo "\${USER_NAME:-watchdog}" ;; interval) echo "\${INTERVAL:-180}" ;; esac
}
`;
shell('router-local failure always UNKNOWN',common+`
LOCAL=YOUTUBE_DOWN
run_probe
[ "$result" = UNKNOWN ] && [ "$reason" = router_local_only ]
`);
shell('interval cannot weaken 180 second floor',common+`
INTERVAL=1; [ "$(interval)" = 180 ]
INTERVAL=garbage; [ "$(interval)" = 180 ]
INTERVAL=300; [ "$(interval)" = 300 ]
`);
shell('client address and SSH injection validation',common+`
valid_host 192.168.1.2
valid_host 172.31.0.1
! valid_host 172.32.0.1
! valid_host 8.8.8.8
! valid_host '-oProxyCommand=evil'
! valid_host '192.168.1.2;id'
! valid_host 192.168.1.999
MODE=ssh; USER_NAME='bad;id'; run_probe
[ "$result" = UNKNOWN ] && [ "$reason" = invalid_client_user ]
`);
fs.mkdirSync(path.join(tmp,'keys'),{recursive:true});
fs.writeFileSync(path.join(tmp,'keys/client_key'),'test fixture, not a credential');
fs.writeFileSync(path.join(tmp,'keys/known_hosts'),'test fixture');
shell('SSH client is required and strict validated output gates availability',common+`
MODE=ssh
timeout() { shift; "$@"; }
ssh() {
 case " $* " in *' -o StrictHostKeyChecking=yes '*) ;; *) return 99 ;; esac
 case " $* " in *' -o BatchMode=yes '*) ;; *) return 99 ;; esac
 echo "$REMOTE"
}
REMOTE=HEALTHY; run_probe; [ "$result" = HEALTHY ]
REMOTE=YOUTUBE_DOWN; run_probe; [ "$result" = YOUTUBE_DOWN ]
REMOTE=DNS_DOWN; run_probe; [ "$result" = UNKNOWN ]
REMOTE='garbage HEALTHY'; run_probe; [ "$result" = UNKNOWN ]
REMOTE=YOUTUBE_DOWN; LOCAL=DNS_DOWN; run_probe; [ "$result" = UNKNOWN ]
LOCAL=''; mock_local_probe() { return 1; }; run_probe; [ "$result" = UNKNOWN ]
CONFIRM=0; run_probe; [ "$result" = UNKNOWN ]
`);
shell('procd command/respawn and UCI trigger wiring',read('files/init')+`
procd_open_instance() { :; }; procd_close_instance() { :; }
procd_set_param() { echo "$*" >> "$TEST_TMP/procd"; }
procd_add_reload_trigger() { echo "$*" >> "$TEST_TMP/procd"; }
start_service; service_triggers
grep -q '^command /usr/bin/youtube-watchdog daemon$' "$TEST_TMP/procd"
grep -q '^respawn 3600 5 5$' "$TEST_TMP/procd"
grep -q '^youtube-watchdog$' "$TEST_TMP/procd"
`);
shell('cooldown/hourly cap uses monotonic time',common+`
rm -f "$R/restarts" "$R/restarts.new"
uptime_s() { echo 5000; }
allowed
echo 4500 > "$R/restarts"; ! allowed
echo 4100 > "$R/restarts"; allowed
printf '2300\\n3200\\n4100\\n' > "$R/restarts"; ! allowed
printf '1000\\n2300\\n3200\\n' > "$R/restarts"; allowed
echo 9000 > "$R/restarts"; allowed
`);
const zap=posix(path.join(tmp,'zap.sh'));
fs.writeFileSync(zap,`#!/bin/sh
case "$1" in
 running) [ "\${ZAP_RUNNING:-1}" = 1 ] ;;
 restart) echo restart >> "$TEST_TMP/restart-count"; exit "\${ZAP_RC:-0}" ;;
 *) exit 1 ;;
esac
`,{mode:0o755});
const cycleBase=common+`
ZAP='${zap}'
rm -f "$R/latched" "$R/restarts" "$TEST_TMP/restart-count" "$TEST_TMP/events"
uptime_s() { echo 5000; }
sleep() { echo "$1" >> "$TEST_TMP/sleeps"; }
timeout() { shift; "$@"; }
event() { echo "$*" >> "$TEST_TMP/events"; }
step=0
run_probe() {
 step=$((step + 1)); result=YOUTUBE_DOWN
 [ "$step" -ne 2 ] || result="\${SECOND:-YOUTUBE_DOWN}"
 [ "$step" -ne 3 ] || result="\${POST:-HEALTHY}"
}
`;
shell('confirmed failure -> restart -> 15s control; hysteresis latch',cycleBase+`
cycle
[ "$(wc -l < "$TEST_TMP/restart-count")" -eq 1 ]
grep -q 'restart confirmed_client_failure success' "$TEST_TMP/events"
grep -q 'control post_restart restored' "$TEST_TMP/events"
grep -q '^10$' "$TEST_TMP/sleeps"; grep -q '^15$' "$TEST_TMP/sleeps"
cycle
[ "$(wc -l < "$TEST_TMP/restart-count")" -eq 1 ]
`);
shell('second test network/UNKNOWN prevents restart',cycleBase+`
SECOND=UNKNOWN; cycle
[ ! -e "$TEST_TMP/restart-count" ]
`);
shell('intentional Zapret2 stop is respected',cycleBase+`
ZAP_RUNNING=0; export ZAP_RUNNING; cycle
[ ! -e "$TEST_TMP/restart-count" ]
`);
shell('cooldown prevents restart',cycleBase+`
echo 4500 > "$R/restarts"; cycle
[ ! -e "$TEST_TMP/restart-count" ]
`);
shell('failed restart still charges budget and gets unknown control',cycleBase+`
ZAP_RC=1; export ZAP_RC; POST=UNKNOWN; cycle
[ "$(wc -l < "$R/restarts")" -eq 1 ]
grep -q 'restart confirmed_client_failure failed' "$TEST_TMP/events"
grep -q 'control post_restart unknown' "$TEST_TMP/events"
`);
shell('hysteresis needs two consecutive healthy daemon results',common+`
healthy=0; : > "$R/latched"
rearm HEALTHY; [ -f "$R/latched" ]
rearm UNKNOWN; rearm HEALTHY; [ -f "$R/latched" ]
rearm HEALTHY; [ ! -f "$R/latched" ]
`);
shell('missing runtime state cannot authorize recovery',cycleBase+`
run_probe() { result=YOUTUBE_DOWN; return 1; }
cycle && exit 1
[ ! -e "$TEST_TMP/restart-count" ]
`);
// Static guards supplement behavior tests: check branch cannot call cycle/restart.
assert.match(read('files/watchdog.sh'),/check\) lock[^\n]+run_probe; status/);
assert(!read('uninstall.sh').includes('/etc/init.d/zapret2')); count++;
assert(!read('files/rpc').includes('eval')); count++;
console.log(`${count} checks passed. No hardware/procd integration claimed.`);
fs.rmSync(tmp,{recursive:true,force:true});
