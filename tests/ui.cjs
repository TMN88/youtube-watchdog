// Real view code, isolated browser, simulated LuCI transport. No router access.
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'files/overview.js'),'utf8');
const shim=`
window.writeAllowed=true;window.calls=[];window.polls=[];window.failInterval=false;
var state={running:true,enabled:true,zapret_running:true,youtube:'HEALTHY',youtube_scope:'router',client_youtube:'UNKNOWN',local_probe:'HEALTHY',recovery_enabled:true,reason:'router_https_reachable',interval:180,checked_at:'2026-10-28 10:00:00 +0300'};
var entries={events:[]};
var E=function(tag,attrs,children){var e=document.createElement(tag);Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,attrs[k])});if(children!=null)(Array.isArray(children)?children:[children]).forEach(function(c){e.appendChild(c instanceof Node?c:document.createTextNode(String(c)))});return e};
var L={hasViewPermission:function(){return window.writeAllowed}},ui={},poll={add:function(f){window.polls.push(f)}},view={extend:function(v){return v}},rpc={declare:function(o){return function(minutes){
 calls.push({method:o.method,minutes:minutes});
 if(o.method==='status')return Promise.resolve(state);
 if(o.method==='logs')return Promise.resolve(entries);
 if(o.method==='set_interval')return new Promise(function(resolve){setTimeout(function(){if(window.failInterval)return resolve({ok:false,message:'Ошибка тестового сохранения'});state.interval=minutes*60;resolve({ok:true});},80)});
 if(o.method==='stop')state.running=false;
 if(o.method==='start'||o.method==='restart')state.running=true;
 if(o.method==='enable')state.enabled=true;if(o.method==='disable')state.enabled=false;
 return Promise.resolve({ok:true});
}}};
var app=(function(){${source}})();app.load().then(function(d){document.body.appendChild(app.render(d));});
`;
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>YouTube Watchdog — демонстрационные данные</title><body style="background:#070c18;margin:0;padding:20px"><script>'+shim+'</script>';
fs.writeFileSync(path.join(root,'preview.html'),html);
(async()=>{
 const {chromium}=require('playwright');
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
 const page=await browser.newPage({viewport:{width:1050,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(html);
 const input=page.getByLabel('Интервал, минут'),save=page.getByRole('button',{name:'Сохранить интервал',exact:true});
 await input.waitFor();assert.equal(await input.inputValue(),'3');
 assert(await page.getByText('YouTube · роутер',{exact:true}).isVisible());
 assert(await page.getByText('Доступен',{exact:true}).isVisible());
 assert(await page.getByText('Автовосстановление включено.',{exact:false}).isVisible());
 assert.equal(await page.getByText('Проверка с роутера:',{exact:false}).count(),0);
 assert.deepEqual(await input.locator('option').evaluateAll(a=>a.map(x=>x.value)),['1','3','5','7','10','15','20','30']);
 await page.screenshot({path:path.join(root,'preview-desktop.png'),fullPage:true});
 await input.selectOption('7');await page.evaluate(()=>Promise.all(polls.map(f=>f())));assert.equal(await input.inputValue(),'7');
 await input.selectOption('5');
 await page.evaluate(()=>{var b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='Сохранить интервал');b.click();b.click();});
 await page.getByText('Интервал сохранён: 5 мин.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>state.interval),300);
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='set_interval').length),1);
 assert.equal(await save.isEnabled(),true);
 await input.evaluate(e=>{e.appendChild(new Option('2 мин','2'));e.value='2';e.dispatchEvent(new Event('change'));});
 await save.click();await page.getByText('Выберите интервал: 1, 3, 5, 7, 10, 15, 20 или 30 минут.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='set_interval').length),1);
 await input.selectOption('7');await page.evaluate(()=>{window.failInterval=true;});await save.click();await page.getByText('Ошибка тестового сохранения',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>state.interval),300);
 await input.evaluate(e=>e.querySelector('option[value="2"]').remove());
 await input.selectOption('5');await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(root,'preview-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const readonly=await browser.newPage();await readonly.setContent(html.replace('window.writeAllowed=true','window.writeAllowed=false'));
 await readonly.getByLabel('Интервал, минут').waitFor();
 assert(await readonly.getByLabel('Интервал, минут').isDisabled());
 assert(await readonly.getByRole('button',{name:'Сохранить интервал',exact:true}).isDisabled());
 assert.deepEqual(errors,[]);
 await page.evaluate(()=>{state.youtube='YOUTUBE_DOWN';state.youtube_scope='lan';state.client_youtube='YOUTUBE_DOWN';state.reason='client_youtube_transport_failure';});
 await page.evaluate(()=>Promise.all(polls.map(f=>f())));
 assert(await page.getByText('YouTube · LAN-клиент',{exact:true}).isVisible());
 assert(await page.getByText('Недоступен',{exact:true}).isVisible());
 await page.evaluate(()=>{state.zapret_state='crashed';state.zapret_running=false;});
 await page.evaluate(()=>Promise.all(polls.map(f=>f())));
 assert(await page.getByText('Сбой процесса',{exact:true}).isVisible());
 console.log('PASS exact interval presets, save, double-click guard, validation, RPC errors, poll preserves edits, readonly permissions, scoped router/LAN status, no redundant row, desktop/mobile layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
