/* tools/against.js —— U' 等价对拍通用 runner（S3，施工图 §5.5.9）
 *
 * 用法：
 *   node tools/against.js [--case=a,b,...|all] [--set=40|1000|<path>] [--limit=N] [--quiet]
 *   --case 缺省 all（跑注册表全部非 hidden 用例）
 *   --set  缺省 40 → test/data/positions40.json；1000 → positions-renjunet.json；
 *          其余按路径解析（供将来 kifu 大语料等新档位）
 *   --limit 只取前 N 局面（快筛）
 *
 * 退出码：全部选中用例 diff == 0 → 0；任一 diff > 0 或 fn 抛异常 → 1（供 verdict.js / CI 断言）
 * 输出纪律：不一致必须打印**前 5 个反例**（id/旧值/新值），不允许只报数量。
 */
'use strict';
const path = require('path');
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const { cases } = require('./against-cases.js');

/* ---------- 参数与档位（CLI 模式才解析；runCases 导出供 verdict.js 进程内复用）---------- */
function main() {
let caseArg = 'all', setArg = '40', limit = 0;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--case=')) caseArg = a.slice(7);
  else if (a.startsWith('--set=')) setArg = a.slice(6);
  else if (a.startsWith('--limit=')) limit = parseInt(a.slice(8), 10) || 0;
  else if (a === '--quiet') { /* 保留位：反例输出始终打印 */ }
  else { console.error('✘ 未知参数：' + a); process.exit(2); }
}

const DATA = path.join(__dirname, '..', 'test', 'data');
const SET_FILE = (setArg === '40') ? path.join(DATA, 'positions40.json')
  : (setArg === '1000') ? path.join(DATA, 'positions-renjunet.json')
  : path.resolve(setArg);
let positions;
try { positions = require(SET_FILE); } catch (e) { console.error('✘ 局面集不可读：' + SET_FILE); process.exit(2); }
if (!Array.isArray(positions) || !positions.length) { console.error('✘ 局面集为空：' + SET_FILE); process.exit(2); }
const list = limit > 0 ? positions.slice(0, limit) : positions;

/* ---------- 选择用例 ---------- */
const names = selectNames(caseArg);
for (const n of names) if (!cases[n]) { console.error('✘ 未注册的对拍用例：' + n); process.exit(2); }

console.log("[U'] against.js  set=" + setArg + '（' + list.length + ' 局面）  cases=' + names.join(','));
let bad = 0;
for (const n of names) {
  const r = runCase(n, cases[n], list);
  const total = list.length;
  if (r.diff === 0 && r.err === 0) {
    console.log('  ✔ ' + n.padEnd(20) + ' diff = 0/' + total + '   ' + (cases[n].desc || ''));
  } else {
    bad++;
    console.log('  ✘ ' + n.padEnd(20) + ' diff = ' + r.diff + '/' + total + (r.err ? '（异常 ' + r.err + '）' : '') +
      '   ' + (cases[n].desc || ''));
    for (const s of r.samples) console.log('      ' + s);
  }
}
if (bad) { console.log("RESULT: FAIL（" + bad + '/' + names.length + " 用例不一致）"); process.exit(1); }
console.log('RESULT: PASS（' + names.length + ' 用例全一致）');
}

/* ---------- 建 pos（每次调用前重建 ⇒ 旧/新互不污染） ---------- */
function buildPos(p) {
  const pos = SEARCH.posFromBoard(Int8Array.from(p.board), p.stm, p.hist);
  SEARCH.attachCache(pos, true);
  return pos;
}
function histToIdx(hist) {
  return hist.map(h => (Array.isArray(h) ? h[1] * 15 + h[0] : h));
}

/* ---------- 跑一个用例 ---------- */
function runCase(name, c, list) {
  const ctx = { core, SEARCH };
  let diff = 0, err = 0;
  const samples = [];
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    const meta = { id: p.id, opening: p.opening, stm: p.stm, histIdx: histToIdx(p.hist), index: k };
    let a, b, fail = null;
    try { a = c.oldFn(buildPos(p), ctx, meta); } catch (e) { fail = 'oldFn: ' + e.message; }
    try { b = c.newFn(buildPos(p), ctx, meta); } catch (e) { fail = fail || ('newFn: ' + e.message); }
    if (fail) { err++; if (samples.length < 5) samples.push('#' + k + ' id=' + p.id + ' ' + fail); continue; }
    const same = c.cmp ? c.cmp(a, b) : JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      diff++;
      if (samples.length < 5) samples.push('#' + k + ' id=' + p.id + ' 旧=' + JSON.stringify(a) + ' 新=' + JSON.stringify(b));
    }
  }
  return { diff, err, samples };
}

function selectNames(caseArg) {
  return (caseArg === 'all')
    ? Object.keys(cases).filter(n => !cases[n].hidden)
    : caseArg.split(',').map(s => s.trim()).filter(Boolean);
}

/* 进程内跑一批用例（verdict.js 复用；不打印，返回逐用例结果） */
function runCases(names, list) {
  return names.map(n => Object.assign({ name: n }, runCase(n, cases[n], list)));
}

if (require.main === module) main();
module.exports = { runCases, selectNames };
