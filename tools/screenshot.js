/* tools/screenshot.js — 生成 README 用的真实界面截图（CDP，零依赖）
 *
 * 为什么不用旧的 assets/screenshot-m*.png：那些是 2026-09 的**里程碑截图**
 * （M1/M4/M6/M8/R8/R9 对应当时的开发阶段），记录的是历史界面而非当前版本。
 * 本脚本按**当前 v3.41 代码**重新截取，覆盖 README 展示所需的关键界面。
 *
 * 走官方入口驱动（`G.main.place(x,y)` / `G.main.reset()`），不用模拟点击——
 * 前者与真实对局走同一条代码路径（§29.4 提供的浏览器实跑接口）。
 *
 * 用法：node tools/_shot.js [outDir]
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { WS } = require('./cdp-ws.js');

const CHROME = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'assets');
const TARGET = 'file:///' + path.join(ROOT, 'gomoku.html').replace(/\\/g, '/');
const PORT = 9800 + (process.pid % 150);
const PROFILE = path.join(os.tmpdir(), 'cdp-shot-' + process.pid);
const LOG = path.join(__dirname, '_screenshot.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const say = s => { log.push(String(s)); fs.writeFileSync(LOG, log.join('\n')); };

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, x => {
      let d = ''; x.on('data', c => d += c); x.on('end', () => res(d));
    });
    r.on('error', rej); r.end();
  });
}

/* ---------- 在页面里执行的场景脚本 ----------
 * 三个要点（第一版全踩了）：
 *  ① 面板是**折叠式**的：必须**点按钮**才会展开（直接调 G.main.hint() 不会展开 UI）；
 *  ② 提示/形势是**异步**的（走 Worker），调用后必须等结果回来；
 *  ③ 空盘上提示无意义（"第 0 手 · 1 个候选"）⇒ 先布置一个有攻防张力的中局。
 */
const MID = '[[7,7],[8,8],[6,8],[9,7],[7,9],[5,7],[10,9],[6,6],[8,10]]';  // 9 手 ⇒ 轮到我方（黑）
const SETUP = `(function(){ var s=${MID};
  for (var i=0;i<s.length;i++) G.main.place(s[i][0], s[i][1], i%2===1);
  return document.getElementById('status').textContent; })()`;

const SCENES = {
  // ① 开局空盘（默认视图，展示完整侧栏）
  board_start: `G.main.reset(); 'ok'`,

  // ② AI 对局中局：轮到 AI，状态栏显示"思考中/上一手"
  ai_playing: SETUP,

  // ③ 提示 Top-5：摆子 → 点「提示」展开 → 等 Worker 返回
  hint_panel: SETUP + `; document.getElementById('btnHint').click(); 'hint clicked'`,

  // ④ 形势判断：摆子 → 点「形势」→ 等
  judge_panel: SETUP + `; document.getElementById('btnJudge').click(); 'judge clicked'`,

  // ⑥ 棋谱面板：载入示例棋谱（Renju 记谱）
  record_panel: `(function(){
    var h=document.getElementById('btnHint'); if(h && h.getAttribute('aria-pressed')==='true') h.click();
    try { G.main.loadRecord('1.H8 2.I9 3.G8 4.H7 5.F8 6.J9 7.G6 8.H6 9.F6 10.E7','renju'); }
    catch(e){ return 'ERR '+e.message; }
    return 'record loaded';
  })()`,
};

(async () => {
  say('目标: ' + TARGET);
  fs.mkdirSync(OUT, { recursive: true });

  try {
    spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--allow-file-access-from-files', '--force-device-scale-factor=2',
      '--window-size=1280,1180', 'about:blank',
    ], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { say('spawn 失败: ' + e.message); }

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/json/version'); up = true; break; } catch (e) { await sleep(300); }
  }
  if (!up) { say('FATAL: Chrome CDP 未就绪'); process.exit(1); }
  say('chrome ready');

  const tgt = JSON.parse(await req('PUT', '/json/new?' + encodeURIComponent('about:blank')));
  const ws = WS.connect(tgt.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  const send = (method, params) => new Promise(r => {
    const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
    }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1180, deviceScaleFactor: 2, mobile: false,
  });
  await send('Page.navigate', { url: TARGET });
  await sleep(4500);

  // 确认页面就绪
  const ready = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){var G=window.G||{};return JSON.stringify({
      canvas: !!document.querySelector('canvas'),
      main: !!G.main, engine: !!G.search,
      worker: (document.body.textContent||'').indexOf('后端：worker')>=0
    })})()`,
  });
  say('就绪检查: ' + (ready && ready.result && ready.result.value));
  if (!ready || !ready.result || !/canvas":true/.test(ready.result.value || '')) {
    say('FATAL: 页面未就绪'); process.exit(1);
  }

  for (const [name, script] of Object.entries(SCENES)) {
    // 每张图前重置到干净状态，避免场景互相污染
    await send('Runtime.evaluate', { returnByValue: true, expression: "G.main.reset()" });
    await sleep(500);
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: script });
    // ★ 提示/形势/热力都走 Worker 异步：轮询等面板**真的有内容**再截图，
    //   否则会拍到"第 0 手 · 1 个候选"这类空面板（第一版的问题）。
    let ready = '';
    for (let i = 0; i < 20; i++) {
      await sleep(600);
      const st = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){
          var b=document.body.innerText||'';
          var m=b.match(/第\\s*\\d+\\s*手[^\\n]*/);      // 提示候选计数
          var j=b.match(/(均势|黑大优|黑优|黑稍优|白稍优|白优|白大优)/); // 形势标签
          return JSON.stringify({ hint: m?m[0]:null, judge: j?j[0]:null,
                                  heat: b.indexOf('热力')>=0 });
        })()`,
      });
      ready = st && st.result && st.result.value ? st.result.value : '';
      // 提示/形势类场景要求拿到内容；其余场景只等渲染
      if (/hint_panel|judge_panel/.test(name)) {
        if (/"hint":"第\s*[1-9]/.test(ready) || /"judge":"(?!null)/.test(ready)) break;
      } else if (/heat_overlay/.test(name)) {
        if (/"heat":true/.test(ready)) break;
      } else {
        await sleep(1200); break;
      }
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      const file = path.join(OUT, 'screenshot-' + name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const kb = Math.round(fs.statSync(file).size / 1024);
      say('✓ ' + name + '  ' + kb + ' KB  ' + ready);
    } else {
      say('✗ ' + name + ' 截图失败');
    }
  }

  // ⑦ 移动端窄屏（触屏布局）
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Runtime.evaluate', { returnByValue: true, expression: "G.main.reset()" });
  await sleep(600);
  await send('Runtime.evaluate', {
    returnByValue: true,
    expression: "(function(){var s=[[7,7],[8,8],[6,8],[9,7]];for(var i=0;i<s.length;i++)G.main.place(s[i][0],s[i][1],i%2===1);return 1})()",
  });
  await sleep(2200);
  const mshot = await send('Page.captureScreenshot', { format: 'png' });
  if (mshot && mshot.data) {
    const file = path.join(OUT, 'screenshot-mobile.png');
    fs.writeFileSync(file, Buffer.from(mshot.data, 'base64'));
    say('✓ mobile  ' + Math.round(fs.statSync(file).size / 1024) + ' KB');
  }

  say('页面异常: ' + errs.length);
  errs.slice(0, 6).forEach(e => say('  ' + e));
  try { ws.close(); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { say('FATAL: ' + String(e && e.message || e)); process.exit(1); });
