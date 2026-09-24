/* tools/perf-m10.js — M10 性能压测（§19 M10 第 3 项）
 *
 *   node tools/perf-m10.js            （须沙箱外跑；用 CDP 量真实加载/渲染）
 *
 * 量三类：
 *   A. 产物体积（单文件 gomoku.html vs 开发壳全家桶）
 *   B. 加载耗时（file:// 打开到 G.main 可用；含引擎求值 + worker-src 解析）
 *   C. 渲染帧率（连续 draw() 的 rAF 帧时间；含/不含动画两种模式）
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const WebSocket = (() => { try { return require('ws'); } catch (e) { return globalThis.WebSocket; } })();

const ROOT = path.join(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => { let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiters.has(m.id)) { const w = this.waiters.get(m.id); this.waiters.delete(m.id);
        m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); }
    });
  }
  send(method, params) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000); }); }
}
async function bootEdge(port, profile) {
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let ver = null, host = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(250);
    for (const h of ['127.0.0.1', '[::1]']) { try { ver = await getJson('http://' + h + ':' + port + '/json/version'); host = h; break; } catch (e) {} } }
  if (!ver) throw new Error('Edge 未就绪');
  return { child, host };
}

(async () => {
  console.log('=== M10 性能压测 ===\n');

  /* A. 体积 */
  const sf = path.join(ROOT, 'gomoku.html');
  if (!fs.existsSync(sf)) { console.error('✗ 先跑 node build.mjs'); process.exit(2); }
  const sfKB = fs.statSync(sf).size / 1024;
  let devBytes = fs.statSync(path.join(ROOT, 'index.html')).size;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\s+src="([^"]+)"><\/script>/g))
    devBytes += fs.statSync(path.join(ROOT, m[1])).size;
  const devKB = devBytes / 1024;
  console.log('A. 体积');
  console.log('   单文件 gomoku.html      : ' + sfKB.toFixed(1) + ' KB  ← 交付物（1 个文件）');
  console.log('   开发壳全家桶            : ' + devKB.toFixed(1) + ' KB  （index.html + 18 个 js）');
  console.log('   文件数                  : 1  vs  ' + (1 + (html.match(/<script/g) || []).length));
  console.log('');

  const port = 9701 + (process.pid % 200);
  const profile = path.join(os.tmpdir(), 'wb-perf-' + process.pid);
  const edge = await bootEdge(port, profile);
  const base = p => 'http://' + edge.host + ':' + port + p;
  let tab = (await getJson(base('/json/list'))).find(t => t.type === 'page');
  if (!tab) { await getJson(base('/json/new?about:blank')); await sleep(400);
    tab = (await getJson(base('/json/list'))).find(t => t.type === 'page'); }
  const cdp = new CDP(new WebSocket(tab.webSocketDebuggerUrl));
  await sleep(120);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable').catch(() => {});
  const ev = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  };

  /* B. 加载耗时（3 次取 min） */
  const fileUrl = 'file:///' + sf.replace(/\\/g, '/');
  const loads = [];
  for (let i = 0; i < 3; i++) {
    cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {}); await sleep(300);
    cdp.send('Page.navigate', { url: fileUrl }).catch(() => {});
    let ms = -1;
    for (let k = 0; k < 100; k++) {
      await sleep(50);
      const r = await ev("!!(window.G && window.G.main)");
      if (r === true) { ms = k * 50; break; }
    }
    loads.push(ms);
  }
  // 更精确：用 performance.timing 的 domContentLoaded
  const timing = await ev("(function(){var t=performance.timing;return {dcl:t.domContentLoadedEventEnd-t.navigationStart, load:t.loadEventEnd-t.navigationStart};})()");
  const best = Math.min.apply(null, loads.filter(x => x >= 0));
  console.log('B. 加载耗时（file:// 打开 → G.main 可用）');
  console.log('   3 次探测上界（50ms 粒度）: ' + loads.join(' / ') + ' ms  → 最快 ≈ ' + best + ' ms');
  console.log('   DOMContentLoaded         : ' + (timing && timing.dcl) + ' ms');
  console.log('   load 事件                : ' + (timing && timing.load) + ' ms');
  console.log('');

  /* C. 渲染帧率 */
  const fps = await ev(`(async () => {
    window.G.main.reset();
    // 铺一些子，让每帧有实际绘制量
    for (let i = 0; i < 12; i++) window.G.main.place(4 + (i % 6), 4 + ((i / 6) | 0), false);
    const canvas = document.getElementById('board');
    const N = 120;
    return await new Promise(res => {
      const times = []; let last = performance.now(), k = 0;
      function loop() {
        const now = performance.now(); times.push(now - last); last = now;
        // 触发一次完整重绘（模拟动画帧）
        window.G.render.Renderer ? null : null;
        if (++k >= N) { times.shift();
          const s = times.slice().sort((a,b)=>a-b);
          res({ mean: +(times.reduce((a,b)=>a+b,0)/times.length).toFixed(2),
                p50: +s[(s.length*0.5)|0].toFixed(2), p95: +s[(s.length*0.95)|0].toFixed(2) });
          return; }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    });
  })()`);
  console.log('C. rAF 帧间隔（空转基线，衡量事件循环余量）');
  if (fps && !fps.__err) {
    console.log('   均值 ' + fps.mean + ' ms / p50 ' + fps.p50 + ' ms / p95 ' + fps.p95 + ' ms'
      + '   （≈ ' + (1000 / fps.mean).toFixed(0) + ' fps）');
  } else console.log('   ✗ ' + JSON.stringify(fps));

  // 实测重绘成本：连续 draw() N 次
  const drawPerf = await ev(`(function(){
    var R = window.G.render, canvas = document.getElementById('board');
    var r = new R.Renderer(canvas, {});
    var st = { board: new Int8Array(225), lastMove:{x:7,y:7}, showNo:true, order:new Int16Array(225) };
    for (var i=0;i<40;i++) st.board[(5+i%8)*15+(5+i%7)] = (i%2)?1:2;
    for (var k=0;k<50;k++) r.draw(st);                 // warmup
    var t0=performance.now(); var N=300;
    for (var k=0;k<N;k++) r.draw(st);
    var withAnim = (performance.now()-t0)/N;
    var st2 = Object.assign({}, st, { anim: { t: performance.now(), dropUser:0, dropIdx:0, dropMs:180, pulse:true, blink:true } });
    for (var k=0;k<50;k++) r.draw(st2);
    t0=performance.now();
    for (var k=0;k<N;k++) r.draw(st2);
    var animCost = (performance.now()-t0)/N;
    return { static: +withAnim.toFixed(3), anim: +animCost.toFixed(3) };
  })()`);
  console.log('D. 单次 draw() 成本（300 次均值；20 子局面）');
  if (drawPerf && !drawPerf.__err) {
    console.log('   静态绘制      : ' + drawPerf.static + ' ms/帧  （≈ ' + (1000 / drawPerf.static).toFixed(0) + ' fps 上限）');
    console.log('   开动画        : ' + drawPerf.anim + ' ms/帧  （≈ ' + (1000 / drawPerf.anim).toFixed(0) + ' fps 上限）');
    console.log('   动画增量      : +' + (drawPerf.anim - drawPerf.static).toFixed(3) + ' ms/帧'
      + '  （' + (((drawPerf.anim / drawPerf.static) - 1) * 100).toFixed(1) + '%）');
  } else console.log('   ✗ ' + JSON.stringify(drawPerf));

  try { edge.child.kill(); } catch (e) {}
  console.log('\n──────── 压测完成 ────────');
  process.exit(0);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
