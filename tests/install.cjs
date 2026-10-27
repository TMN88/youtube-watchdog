const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert'),crypto=require('crypto');
const repo=path.resolve(__dirname,'..'), bb=process.env.BUSYBOX;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'yw-install-'));
const p=x=>x.replace(/\\/g,'/');
let total=0;
function write(file,body){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body,{mode:0o755});}
function run(name,pm,version,upgrade=false,failRpc=false,allInstalled=false){
 const dir=path.join(tmp,name),root=path.join(dir,'root'),source=path.join(dir,'source');
 fs.mkdirSync(root,{recursive:true});fs.mkdirSync(source,{recursive:true});
 const payload=['files/watchdog.sh','files/probe.sh','files/init','files/rpc','files/acl.json','files/menu.json','files/overview.js','files/config','uninstall.sh'];
 for(const f of payload)write(path.join(source,f),fs.readFileSync(path.join(repo,f),'utf8'));
 const init=`#!/bin/sh
case "$1" in
 start) touch '${p(root)}/running' ;;
 stop) rm -f '${p(root)}/running' ;;
 running) test -f '${p(root)}/running' ;;
 enable) touch '${p(root)}/enabled' ;;
 disable) rm -f '${p(root)}/enabled' ;;
 enabled) test -f '${p(root)}/enabled' ;;
 *) exit 1 ;;
esac
`;
 write(path.join(source,'files/init'),init);
 // Download fixture only: the real worker is separately behavior-tested.
 write(path.join(source,'files/watchdog.sh'),'#!/bin/sh\necho "{}"\n');
 fs.writeFileSync(path.join(source,'SHA256SUMS'),payload.map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(source,f))).digest('hex')+'  '+f).join('\n')+'\n');
 write(path.join(root,'etc/openwrt_release'),`DISTRIB_RELEASE='${version}'\n`);
 write(path.join(root,'etc/init.d/rpcd'),'#!/bin/sh\nexit 0\n');
 write(path.join(root,'usr/share/libubox/jshn.sh'),'# fixture\n');
 fs.mkdirSync(path.join(root,'etc/config'),{recursive:true});
 const config='config watchdog main\n option mode safe\n option interval 600\n';
 if(upgrade){
  write(path.join(root,'etc/config/youtube-watchdog'),config);
  write(path.join(root,'etc/init.d/youtube-watchdog'),init);
  write(path.join(root,'usr/bin/youtube-watchdog'),'#!/bin/sh\necho OLD_VERSION\n');
  write(path.join(root,'running'),'');write(path.join(root,'enabled'),'');
 }
 let installer=fs.readFileSync(path.join(repo,'install.sh'),'utf8');
 // Single pass: Linux fixture roots themselves live under /tmp.
 installer=installer.replace(/\/(?:etc|usr|www|tmp)\//g,prefix=>p(root)+prefix);
 const commands=`
id() { echo 0; }
uci() { echo watchdog; }
ubus() { ${failRpc?'return 1':'return 0'}; }
jsonfilter() { return 0; }
nslookup() { return 0; }
sleep() { return 0; }
flock() { return 0; }
timeout() { shift; "$@"; }
apk() { echo "apk $*" >> '${p(dir)}/packages'; case "$1" in info) return ${allInstalled?0:1} ;; esac; }
opkg() { echo "opkg $*" >> '${p(dir)}/packages'; case "$1" in status) ${allInstalled?'echo "Status: install ok installed"; return 0':'return 1'} ;; esac; }
command() {
 if [ "$1" = -v ] && [ "$2" = apk ] && [ '${pm}' = opkg ]; then return 1; fi
 return 0
}
curl() {
 rel=''; dst=''
 while [ "$#" -gt 0 ]; do
  case "$1" in https://raw.githubusercontent.com/TMN88/youtube-watchdog/*) rel=$(echo "$1" | sed 's|^https://raw.githubusercontent.com/TMN88/youtube-watchdog/[^/]*/||') ;; -o) shift; dst="$1" ;; esac
  shift
 done
 [ -n "$rel" ] && [ -n "$dst" ] || return 1
 cp '${p(source)}/'"$rel" "$dst"
}
`;
 const script=path.join(dir,'test.sh');write(script,commands+'\n'+installer);
 const result=cp.spawnSync(bb||'sh',bb?['sh',p(script)]:[script],{encoding:'utf8'});
 assert.equal(result.status,failRpc?1:0,name+'\n'+result.stdout+result.stderr);
 if(failRpc){
  assert.equal(fs.readFileSync(path.join(root,'usr/bin/youtube-watchdog'),'utf8'),'#!/bin/sh\necho OLD_VERSION\n');
  assert(fs.existsSync(path.join(root,'running')));assert(fs.existsSync(path.join(root,'enabled')));
 }else{
  assert(fs.existsSync(path.join(root,'running')));assert(fs.existsSync(path.join(root,'enabled')));
  assert(fs.existsSync(path.join(root,'usr/share/rpcd/acl.d/luci-app-youtube-watchdog.json')));
  assert(fs.existsSync(path.join(root,'www/luci-static/resources/view/youtube-watchdog/overview.js')));
 }
 if(upgrade)assert.equal(fs.readFileSync(path.join(root,'etc/config/youtube-watchdog'),'utf8'),config);
 assert.equal(fs.readFileSync(path.join(dir,'packages'),'utf8').includes(pm+(pm==='apk'?' add':' install')),!allInstalled);
 console.log('PASS '+name);total++;
}
run('OpenWrt24-opkg-install','opkg','24.10.7');
run('OpenWrt25-apk-install','apk','25.12.0');
run('upgrade-preserves-UCI','apk','25.12.0',true);
run('RPC-failure-restores-old-files-and-service','opkg','24.10.7',true,true);
run('repeat-install-keeps-config-and-skips-packages','apk','25.12.0',true,false,true);
console.log(total+' isolated installer fixture checks passed; not actual OpenWrt package/procd tests.');
fs.rmSync(tmp,{recursive:true,force:true});
