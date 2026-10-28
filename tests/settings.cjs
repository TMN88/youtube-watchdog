const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert');
const root=path.resolve(__dirname,'..'),bb=process.env.BUSYBOX;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yw-settings-'));
const posix=p=>p.replace(/\\/g,'/');
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
let count=0;
function run(name,body,ok,options={}){
 const dir=path.join(tmp,name);fs.mkdirSync(dir,{recursive:true});
 const runtime=posix(path.join(dir,'runtime'));
 const value=body&&body.minutes;
 const type=Number.isInteger(value)?'int':typeof value==='number'?'double':typeof value==='string'?'string':value===null?'null':'';
 const rpc=fs.readFileSync(path.join(root,'files/rpc'),'utf8').replace('. /usr/share/libubox/jshn.sh','').replaceAll('/tmp/youtube-watchdog',runtime);
 const header=`
json_init(){ ok_value=''; message_value=''; }
json_add_boolean(){ ok_value="$2"; }
json_add_string(){ message_value="$2"; }
json_dump(){ printf 'ok=%s\\nmessage=%s\\n' "$ok_value" "$message_value"; }
json_load(){ return 0; }
json_get_type(){ value_type=${quote(type)}; }
json_get_var(){ minutes=${quote(value===undefined?'':value)}; }
flock(){ return 0; }
uci(){
 case "$*" in
  '-q get youtube-watchdog.main') echo watchdog ;;
  '-q get youtube-watchdog.main.interval') echo '${options.current||180}' ;;
  set*) printf '%s\\n' "$*" >> '${posix(dir)}/writes' ;;
  commit*) printf '%s\\n' "$*" >> '${posix(dir)}/writes'; return ${options.commitFailure?1:0} ;;
  *) return 1 ;;
 esac
}
`;
 const file=path.join(dir,'rpc.sh');fs.writeFileSync(file,header+rpc);
 const r=cp.spawnSync(bb||'sh',bb?['sh',posix(file),'call','set_interval']:[file,'call','set_interval'],{input:JSON.stringify(body)+'\n',encoding:'utf8'});
 assert.equal(r.status,0,name+'\n'+r.stderr);assert(r.stdout.includes('ok='+(ok?1:0)),name+'\n'+r.stdout);
 const writes=fs.existsSync(path.join(dir,'writes'))?fs.readFileSync(path.join(dir,'writes'),'utf8'):'';
 const changed=ok&&!options.noWrite;
 if(changed||options.commitFailure){assert.equal(writes,`set youtube-watchdog.main.interval=${value*60}\ncommit youtube-watchdog\n`);}
 else assert.equal(writes,'',name+' unexpectedly wrote UCI');
 assert.equal(fs.existsSync(path.join(runtime,'interval.changed')),changed,name+' notification');
 console.log('PASS '+name);count++;
}
run('save-five-minutes',{minutes:5},true);
run('minimum-three-minutes',{minutes:3},true,{current:300});
run('maximum-1440-minutes',{minutes:1440},true);
run('same-value-no-flash-write',{minutes:3},true,{noWrite:true});
for(const [name,value] of [['below-minimum',2],['above-maximum',1441],['fraction',3.5],['negative',-3],['string-number','5'],['shell-injection','3; touch /tmp/pwn'],['missing',undefined],['null',null],['overflow',1e20]])run(name,{minutes:value},false);
run('commit-failure-reported',{minutes:5},false,{commitFailure:true});
console.log(count+' settings RPC fixture checks passed.');
fs.rmSync(tmp,{recursive:true,force:true});
