/* Isolated installer integration: real file replacement and SHA256, mocked OpenWrt services/network. */
const fs=require('fs'),path=require('path'),cp=require('child_process'),os=require('os'),crypto=require('crypto'),assert=require('assert');
const repo=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yw-update-'));
const posix=p=>p.replace(/\\/g,'/');
const write=(p,s,mode=0o755)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s,{mode});};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let total=0;
const payload=['files/watchdog.sh','files/probe.sh','files/init','files/rpc','files/acl.json','files/menu.json','files/overview.js','files/config','uninstall.sh'];
for(const spec of [
 {name:'upgrade-opkg',pm:'opkg'}, {name:'upgrade-apk',pm:'apk'},
 {name:'stopped-disabled',pm:'opkg',stopped:true}, {name:'fresh',pm:'opkg',fresh:true},
 {name:'corrupt-payload',pm:'opkg',corrupt:true,fail:true},
 {name:'rpc-failure-rollback',pm:'opkg',rpcFail:true,fail:true},
 {name:'start-failure-rollback',pm:'opkg',startFail:true,fail:true},
 {name:'reject-downgrade',pm:'opkg',newer:true,fail:true}
]) {
 const dir=path.join(tmp,spec.name),root=path.join(dir,'root'),src=path.join(dir,'source');
 fs.mkdirSync(root,{recursive:true});
 const R=posix(root),S=posix(src);
 const init=`#!/bin/sh
case "$1" in
 running) test -f '${R}/running' ;;
 enabled) test -f '${R}/enabled' ;;
 stop) rm -f '${R}/running' ;;
 disable) rm -f '${R}/enabled' ;;
 enable) touch '${R}/enabled' ;;
 start)
  if [ -f '${R}/fail-start-once' ]; then rm -f '${R}/fail-start-once'; exit 1; fi
  touch '${R}/running' ;;
 *) exit 0 ;;
esac
`;
 for(const f of payload) write(path.join(src,f),fs.readFileSync(path.join(repo,f),'utf8'));
 write(path.join(src,'files/init'),init);
 fs.writeFileSync(path.join(src,'SHA256SUMS'),payload.map(f=>hash(path.join(src,f))+'  '+f).join('\n')+'\n');
 write(path.join(root,'etc/openwrt_release'),"DISTRIB_RELEASE='24.10.5'\n");
 write(path.join(root,'etc/init.d/rpcd'),'#!/bin/sh\nexit 0\n');
 write(path.join(root,'usr/share/libubox/jshn.sh'),'# fixture\n');
 const cfg="config watchdog 'main'\n option mode 'safe'\n option interval '420'\n option engine 'zapret'\n";
 const old=`#!/bin/sh\nVERSION=${spec.newer?'9.0.0':'1.3.1'}\n`;
 if(!spec.fresh){
  write(path.join(root,'etc/config/youtube-watchdog'),cfg,0o600);
  write(path.join(root,'etc/init.d/youtube-watchdog'),init+'# legacy\n');
  write(path.join(root,'usr/bin/youtube-watchdog'),old);
  if(!spec.stopped){write(path.join(root,'running'),'');write(path.join(root,'enabled'),'');}
 }
 if(spec.startFail)write(path.join(root,'fail-start-once'),'');
 const hashTool=path.join(dir,'hash.cjs');
 write(hashTool,`const fs=require('fs'),c=require('crypto');let ok=true;for(const l of fs.readFileSync(process.argv[2],'utf8').trim().split('\\n')){const m=l.match(/^([a-f0-9]{64})  (.+)$/);if(!m||c.createHash('sha256').update(fs.readFileSync(m[2])).digest('hex')!==m[1])ok=false;}process.exit(ok?0:1);`);
 let script=fs.readFileSync(path.join(repo,'update.sh'),'utf8').replace(/\/(?:etc|usr|www|tmp)\//g,p=>R+p);
 const mock=`
id(){ echo 0; }
opkg(){ case "$1" in status) echo 'Status: install ok installed' ;; esac; }
apk(){ return 0; }
command(){ if [ "$1" = -v ] && [ "$2" = apk ] && [ '${spec.pm}' = opkg ]; then return 1; fi; return 0; }
if [ '${process.platform}' = win32 ]; then
 chmod(){ node -e 'require("fs").chmodSync(process.argv[2],parseInt(process.argv[1],8))' "$@"; }
 ls(){ case "$2" in *.json|*.js) echo '-rw-r--r-- fixture' ;; *) echo '-rwxr-xr-x fixture' ;; esac; }
fi
flock(){ return 0; }
timeout(){ shift; "$@"; }
sleep(){ :; }
uci(){ case "$1" in set) printf "\\n option engine 'auto'\\n" >> '${R}/etc/config/youtube-watchdog' ;; esac; }
ubus(){ ${spec.rpcFail?'return 1':'return 0'}; }
jsonfilter(){ node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$2"; }
sha256sum(){ node '${posix(hashTool)}' "$2"; }
curl(){
 rel=''; dst=''
 while [ "$#" -gt 0 ]; do
  case "$1" in https://raw.githubusercontent.com/TMN88/youtube-watchdog/*) rel=$(echo "$1" | sed 's|^https://raw.githubusercontent.com/TMN88/youtube-watchdog/[^/]*/||') ;; -o) shift; dst="$1" ;; esac
  shift
 done
 cp '${S}/'"$rel" "$dst"
 ${spec.corrupt?'[ "$rel" != files/watchdog.sh ] || echo CORRUPTED >> "$dst"':':'}
}
`;
 const file=path.join(dir,'run.sh');write(file,script.replace('set -eu','set -eu\n'+mock));
 const run=()=>cp.spawnSync('sh',[posix(file)],{encoding:'utf8',timeout:30000});
 const r=run();assert.equal(r.status,spec.fail?1:0,spec.name+'\n'+r.stdout+r.stderr);
 const current=path.join(root,'usr/bin/youtube-watchdog');
 if(spec.fail){
  assert.equal(fs.readFileSync(current,'utf8'),old,spec.name+' restored binary');
  assert.equal(fs.readFileSync(path.join(root,'etc/config/youtube-watchdog'),'utf8'),cfg);
  assert(fs.existsSync(path.join(root,'running')));assert(fs.existsSync(path.join(root,'enabled')));
 } else {
  assert.equal(hash(current),hash(path.join(src,'files/watchdog.sh')));
  if(spec.fresh){assert.match(fs.readFileSync(path.join(root,'etc/config/youtube-watchdog'),'utf8'),/interval '600'/);}
  else assert.equal(fs.readFileSync(path.join(root,'etc/config/youtube-watchdog'),'utf8'),cfg);
  assert.equal(fs.existsSync(path.join(root,'running')),!spec.stopped);
  assert.equal(fs.existsSync(path.join(root,'enabled')),!spec.stopped);
  const again=run();assert.equal(again.status,0,again.stderr);assert.match(again.stdout,/уже актуален/);
 }
 console.log('PASS '+spec.name);total++;
}
// The top-level toolkit must invoke Watchdog even when readiness reports true.
const toolkitPath=process.env.TOOLKIT_FILE || path.join(repo,'../install-packets-fix/openwrt-toolkit.sh');
if(fs.existsSync(toolkitPath)) {
const toolkit=fs.readFileSync(toolkitPath,'utf8');
const runComponent=toolkit.slice(toolkit.indexOf('run_component() {'),toolkit.indexOf('show_results() {'));
const gateFile=path.join(tmp,'gate.sh'),calls=posix(path.join(tmp,'calls'));
write(gateFile,`set -eu
step(){ :; }; compatibility_check(){ return 0; }; conflict_check(){ return 0; }
component_installed(){ return 0; }; record_result(){ :; }; warn(){ :; }
update_stub(){ echo "$run_detection" >> '${calls}'; }
${runComponent}
run_component Watchdog update_stub watchdog
run_component Other update_stub other
`);
const gate=cp.spawnSync('sh',[posix(gateFile)],{encoding:'utf8'});assert.equal(gate.status,0,gate.stderr);
assert.equal(fs.readFileSync(calls,'utf8').trim(),'watchdog');total++;
assert.match(toolkit,/youtube-watchdog\/main\/update.sh/);
}
console.log(`${total} updater/toolkit integration checks passed`);
fs.rmSync(tmp,{recursive:true,force:true});
