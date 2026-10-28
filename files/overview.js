'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var statusCall = rpc.declare({ object: 'youtube-watchdog', method: 'status', expect: {} });
var logsCall = rpc.declare({ object: 'youtube-watchdog', method: 'logs', expect: {} });
var setIntervalCall = rpc.declare({ object: 'youtube-watchdog', method: 'set_interval', params: ['minutes'], expect: {} });
var actions = {};
['start', 'stop', 'restart', 'enable', 'disable', 'check'].forEach(function(name) {
    actions[name] = rpc.declare({ object: 'youtube-watchdog', method: name, expect: {} });
});
var canWrite = L.hasViewPermission();
var css = `
.youtube-watchdog-root{background:#090F20;color:#EAF4FF;padding:20px;border-radius:20px;max-width:860px;margin:12px auto;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}
.youtube-watchdog-root *{box-sizing:border-box}
.youtube-watchdog-card{background:#111C35;border:1px solid #65E9FF44;border-radius:16px;padding:20px;margin-bottom:14px;box-shadow:0 0 22px #65E9FF0b}
.youtube-watchdog-title{font-size:25px;font-weight:750;color:#65E9FF;letter-spacing:.2px;line-height:1.2}
.youtube-watchdog-eyebrow{font-size:10px;letter-spacing:2px;color:#A4B3D4;margin-top:8px}
.youtube-watchdog-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
.youtube-watchdog-tile{background:#0B1428;border-radius:12px;padding:15px;border:1px solid #B893FF22;min-width:0}
.youtube-watchdog-label{font-size:12px;color:#A4B3D4;margin-bottom:7px}
.youtube-watchdog-value{font-size:17px;font-weight:650;display:flex;align-items:center;gap:9px}
.youtube-watchdog-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor;flex-shrink:0}
.youtube-watchdog-ok{color:#34E8A2}.youtube-watchdog-bad{color:#FF657F}.youtube-watchdog-warn{color:#F6B94B}.youtube-watchdog-cyan{color:#65E9FF}.youtube-watchdog-purple{color:#B893FF}
.youtube-watchdog-meta{font-size:12px;color:#A4B3D4;margin-top:14px;line-height:1.6;overflow-wrap:anywhere}
.youtube-watchdog-root .youtube-watchdog-button{background:#0B1428;border:1px solid currentColor;border-radius:10px;min-height:44px;padding:10px 12px;font:inherit;font-size:13px;cursor:pointer;box-shadow:0 0 12px #65E9FF08;transition:filter .2s}
.youtube-watchdog-root .youtube-watchdog-button:hover{filter:brightness(1.3)}
.youtube-watchdog-root .youtube-watchdog-button:disabled{opacity:.4;cursor:wait}
.youtube-watchdog-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.youtube-watchdog-heading{font-size:17px;font-weight:650;color:#EAF4FF}
.youtube-watchdog-event{display:flex;gap:12px;border-top:1px solid #A4B3D41b;padding:12px 0;font-size:13px;line-height:1.5}
.youtube-watchdog-icon{font-size:18px}.youtube-watchdog-time{color:#A4B3D4;font-size:11px}
.youtube-watchdog-footer{text-align:center;color:#A4B3D4;font-size:10px;letter-spacing:2px;padding:5px}
.youtube-watchdog-error{color:#FF657F;margin-top:12px;font-size:13px}
.youtube-watchdog-root .youtube-watchdog-input{background:#0B1428;color:#EAF4FF;border:1px solid #65E9FF66;border-radius:9px;padding:10px;width:120px;min-height:44px;font:inherit}
.youtube-watchdog-root .youtube-watchdog-input:focus{outline:2px solid #65E9FF;outline-offset:2px}
.youtube-watchdog-root .youtube-watchdog-input:disabled{opacity:.5}
@media(max-width:480px){.youtube-watchdog-root{padding:10px;margin:5px 0}.youtube-watchdog-card{padding:13px}.youtube-watchdog-title{font-size:21px}.youtube-watchdog-tile{padding:11px}.youtube-watchdog-value{font-size:14px}.youtube-watchdog-grid{gap:8px}}
`;
return view.extend({
    handleSave: null, handleSaveApply: null, handleReset: null,
    load: function() { return Promise.all([statusCall(), logsCall()]); },
    render: function(data) {
        var busy = false, serverBusy = false;
        var root = E('div', { 'class': 'youtube-watchdog-root' });
        root.appendChild(E('style', {}, css));
        var stateCard = E('div', { 'class': 'youtube-watchdog-card' });
        var journal = E('div', { 'class': 'youtube-watchdog-card' });
        var error = E('div', { 'class': 'youtube-watchdog-error', 'role': 'alert' });
        var buttons = [];
        var settingsControls = [];
        function disable(value) {
            buttons.forEach(function(b) { b.disabled = value || (!canWrite && b.dataset.write === '1'); });
            settingsControls.forEach(function(b) { b.disabled = busy || !canWrite; });
        }
        function button(text, color, action) {
            var b = E('button', { 'class': 'youtube-watchdog-button youtube-watchdog-' + color, 'type': 'button' }, text);
            b.dataset.write = action === 'refresh' ? '0' : '1';
            b.onclick = function() {
                if (busy) return;
                busy = true; disable(true); error.textContent = '';
                Promise.resolve().then(function() {
                    return action === 'refresh' ? null : actions[action]();
                }).then(function(result) {
                    if (result && !result.ok) throw new Error(result.message || 'Действие не выполнено. Возможно, уже идёт проверка.');
                    // check is queued server-side; all measurements remain in the backend.
                    return refresh();
                }).catch(function(e) {
                    error.textContent = e.message || String(e);
                }).finally(function() { busy = false; disable(serverBusy); });
            };
            buttons.push(b); return b;
        }
        function tile(label, text, color) {
            return E('div', { 'class': 'youtube-watchdog-tile' }, [
                E('div', { 'class': 'youtube-watchdog-label' }, label),
                E('div', { 'class': 'youtube-watchdog-value youtube-watchdog-' + color }, [E('span', { 'class': 'youtube-watchdog-dot' }), text])
            ]);
        }
        function drawStatus(s) {
            serverBusy = !!s.checking;
            stateCard.textContent = ''; buttons = buttons.filter(function(b) { return b.dataset.write === '0'; });
            var y = s.youtube, yt = y === 'HEALTHY' ? 'Доступен' : y === 'YOUTUBE_DOWN' ? 'Недоступен' : 'Неизвестно';
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-title' }, 'YouTube Watchdog'));
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-eyebrow' }, 'OPENWRT • MONITORING SYSTEM'));
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-grid' }, [
                tile('Watchdog', s.running ? 'Работает' : 'Остановлен', s.running ? 'ok' : 'bad'),
                tile('YouTube', yt, y === 'HEALTHY' ? 'ok' : y === 'YOUTUBE_DOWN' ? 'bad' : 'warn'),
                tile('Zapret2', s.zapret_running ? 'Работает' : 'Остановлен', s.zapret_running ? 'ok' : 'bad'),
                tile('Интервал', (s.interval || 180) % 60 ? String(s.interval) + ' сек' : String((s.interval || 180) / 60) + ' мин', 'cyan')
            ]));
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-meta' }, 'Последняя проверка: ' + (s.checked_at || '—') + (s.checking ? ' • Проверка выполняется…' : '')));
            var localText = { HEALTHY: 'доступен', YOUTUBE_DOWN: 'недоступен', DNS_DOWN: 'ошибка DNS', NETWORK_DOWN: 'ошибка сети', UNKNOWN: 'нет достоверного результата' };
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-meta' }, 'Проверка с роутера: ' + (localText[s.local_probe] || 'нет достоверного результата')));
            var notice = s.reason === 'router_local_only'
                ? 'Безопасный режим: проверка с роутера не подтверждает путь LAN-клиентов. Автоперезапуск запрещён.'
                : 'Проверяется доступность HTTPS с диагностического клиента. Воспроизведение видео не гарантируется.';
            if (s.reason === 'stale') notice = 'Данные устарели. Дождитесь новой проверки.';
            if (s.reason === 'client_not_configured' || s.reason === 'ssh_missing' || s.reason === 'invalid_client_user') notice = 'Диагностический клиент не настроен. Автоперезапуск запрещён.';
            if (s.reason === 'client_probe_unknown') notice = 'Нет достоверного ответа от диагностического клиента. Автоперезапуск запрещён.';
            if (s.reason === 'client_general_network_or_dns' || s.reason === 'router_network_or_dns') notice = 'Ошибка сети или DNS. Автоперезапуск запрещён.';
            if (s.reason === 'configuration_changed' || s.reason === 'not_checked') notice = 'Ожидается достоверная проверка. Автоперезапуск пока запрещён.';
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-meta' }, notice));
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-grid' }, [
                button('Запустить', 'ok', 'start'), button('Остановить', 'bad', 'stop'),
                button('Перезапустить', 'purple', 'restart'), button('Проверить YouTube', 'cyan', 'check')
            ]));
            stateCard.appendChild(E('div', { 'class': 'youtube-watchdog-row', 'style': 'margin-top:14px' }, [
                E('span', { 'class': 'youtube-watchdog-meta' }, 'Автозапуск: ' + (s.enabled ? 'включён' : 'выключен')),
                button(s.enabled ? 'Выключить' : 'Включить', 'purple', s.enabled ? 'disable' : 'enable')
            ]));
        }
        var events = E('div');
        journal.appendChild(E('div', { 'class': 'youtube-watchdog-row' }, [E('span', { 'class': 'youtube-watchdog-heading' }, 'Журнал событий'), button('Обновить', 'cyan', 'refresh')]));
        journal.appendChild(events);
        var dirtyInterval = false;
        var intervalInput = E('input', { 'class': 'youtube-watchdog-input', 'id': 'youtube-watchdog-interval', 'type': 'number', 'min': '3', 'max': '1440', 'step': '1', 'inputmode': 'numeric', 'aria-describedby': 'youtube-watchdog-interval-help' });
        intervalInput.value = String(Math.ceil((data[0].interval || 180) / 60));
        var intervalNotice = E('div', { 'class': 'youtube-watchdog-meta', 'aria-live': 'polite' });
        intervalInput.oninput = function() { dirtyInterval = true; intervalNotice.textContent = ''; };
        var saveInterval = E('button', { 'class': 'youtube-watchdog-button youtube-watchdog-cyan', 'type': 'button' }, 'Сохранить интервал');
        saveInterval.onclick = function() {
            if (busy || !canWrite) return;
            var raw = intervalInput.value.trim(), minutes = Number(raw);
            if (!/^[0-9]+$/.test(raw) || minutes < 3 || minutes > 1440) {
                intervalNotice.textContent = 'Укажите целое число минут от 3 до 1440.'; return;
            }
            busy = true; disable(true); error.textContent = ''; intervalNotice.textContent = 'Сохранение…';
            Promise.resolve().then(function() { return setIntervalCall(minutes); }).then(function(result) {
                if (!result.ok) throw new Error(result.message || 'Не удалось сохранить интервал');
                dirtyInterval = false;
                intervalNotice.textContent = 'Интервал сохранён: ' + minutes + ' мин. Применяется автоматически, без перезапуска службы.';
                return refresh();
            }).catch(function(e) { intervalNotice.textContent = e.message || String(e); }).finally(function() {
                busy = false; disable(serverBusy);
            });
        };
        settingsControls.push(intervalInput, saveInterval);
        var settings = E('div', { 'class': 'youtube-watchdog-card' }, [
            E('div', { 'class': 'youtube-watchdog-heading' }, 'Частота проверки'),
            E('div', { 'class': 'youtube-watchdog-row', 'style': 'margin-top:14px' }, [
                E('label', { 'for': 'youtube-watchdog-interval', 'class': 'youtube-watchdog-label' }, 'Интервал, минут'), intervalInput, saveInterval
            ]),
            E('div', { 'class': 'youtube-watchdog-meta', 'id': 'youtube-watchdog-interval-help' }, 'От 3 до 1440 минут. По умолчанию — 3 минуты. Лимиты перезапуска Zapret2 сохраняются.'), intervalNotice
        ]);
        function drawLogs(l) {
            events.textContent = '';
            (l.events || []).forEach(function(item) {
                var e;
                try { e = JSON.parse(item.record); } catch (ignore) { return; }
                var restart = e.type === 'restart', restored = e.status === 'restored';
                var text = restart ? 'Перезапуск Zapret2 • подтверждён отказ YouTube • ' + (e.status === 'success' ? 'команда выполнена' : 'ошибка команды')
                    : restored ? 'YouTube восстановлен' : e.status === 'not_restored' ? 'YouTube не восстановлен' : 'Результат неизвестен';
                var color = restart || e.status === 'unknown' ? 'warn' : restored ? 'ok' : 'bad';
                events.appendChild(E('div', { 'class': 'youtube-watchdog-event' }, [
                    E('span', { 'class': 'youtube-watchdog-icon youtube-watchdog-' + color }, restart ? '↻' : restored ? '●' : e.status === 'not_restored' ? '×' : '?'),
                    E('div', {}, [E('div', { 'class': 'youtube-watchdog-time' }, e.at), E('div', {}, text)])
                ]));
            });
            if (!events.childNodes.length) events.appendChild(E('div', { 'class': 'youtube-watchdog-meta' }, 'Перезапусков и контрольных тестов пока нет.'));
        }
        function refresh() {
            return Promise.all([statusCall(), logsCall()]).then(function(d) {
                drawStatus(d[0]); drawLogs(d[1]);
                if (!dirtyInterval && document.activeElement !== intervalInput) intervalInput.value = String(Math.ceil((d[0].interval || 180) / 60));
                disable(busy || !!d[0].checking);
            });
        }
        drawStatus(data[0]); drawLogs(data[1]); disable(serverBusy);
        root.appendChild(stateCard); root.appendChild(settings); root.appendChild(journal); root.appendChild(error);
        root.appendChild(E('div', { 'class': 'youtube-watchdog-footer' }, 'YOUTUBE WATCHDOG • TMN88'));
        poll.add(function() { if (!busy) return refresh().catch(function(e) { error.textContent = 'Ошибка обновления: ' + e.message; }); }, 5);
        return root;
    }
});
