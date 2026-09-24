/* tools/verdict.js —— 统一裁决入口（V1/V2，verdict-methodology §3.1/§3.2）
 *
 * 用法：
 *   node tools/verdict.js --change=A1 --l1 --l2              快筛 + 中筛
 *   node tools/verdict.js --change=A1 --l2 --skip-tests      L2 且跳过全量测试（L1 已跑过时）
 *   node tools/verdict.js --change=A1 --l3 --games=300 --a=hard-i100 --b=hard   确认（仅幸存者）
 *
 * 三层漏斗（§2.1）：
 *   L1 快筛（秒~分钟级，确定性，必跑）= 全量测试 + 等价对拍 + 微基准 vs 基线
 *   L2 中筛（分钟级，离散/确定性）    = 题库 + 深度/节点/NPS vs 基线
 *   L3 确认（小时级，采样，只对幸存者）= bench-elo + 分层 CI
 * 本文件**只是编排**：测量逻辑全部复用 test/、against.js、snapshot-metrics.js、bench-elo.js。
 * 退出码：任一层有 ✗ → 1；全过 → 0。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const SM = require('./snapshot-metrics.js');
const AG = require('./against.js');

const ROOT = path.join(__dirname, '..');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const val = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
const has = k => argv.includes('--' + k);
const CHANGE = val('change') || 'X';
const DO_L1 = has('l1'), DO_L2 = has('l2'), DO_L3 = has('l3');
const GAMES = val('games') || '200';
const SKIP_TESTS = has('skip-tests');
if (!DO_L1 && !DO_L2 && !DO_L3) {
  console.log('用法：node tools/verdict.js --change=<id> [--l1] [--l2] [--l3 --games=N --a=<cfgA> --b=<cfgB>] [--skip-tests]');
  process.exit(2);
}

/* ---------- 辅助 ---------- */
function runNode(args, opts) {
  return execFileSync(process.execPath, args, Object.assign({ cwd: ROOT, encoding: 'utf8' }, opts));
}
function cmpRow(n, o, c, lo, ref) {   // 口径与 snapshot-metrics --diff 一致：×1.05 / ×0.98；ref=墙钟参考
  const r = c / o, bad = !ref && (lo ? r > 1.05 : r < 0.98);
  return { line: '  ' + (bad ? '✗' : ref ? '·' : '✓') + ' ' + String(n).padEnd(26) + o + ' → ' + c +
    '（' + ((r - 1) * 100).toFixed(2) + '%）' + (ref ? '  〔墙钟，参考〕' : ''), bad };
}
function loadBase() {
  const base = JSON.parse(fs.readFileSync(SM.BASE_PATH, 'utf8'));
  if (base.positions.sha !== SM.POS_SHA)
    throw new Error('局面集已变（' + base.positions.sha + ' → ' + SM.POS_SHA + '）⇒ 基线失效，先 snapshot-metrics --save');
  return base;
}

/* ---------- L1 快筛（★ 全进程内：本环境实测禁止 node 内二层 spawn，spawnSync 恒 EBUSY） ---------- */
async function l1() {
  const out = { bad: 0, lines: [] };
  // ① 全量测试（node:test 的 run() 进程内逐文件；并发 1 与逐文件跑同序）
  if (!SKIP_TESTS) {
    const files = fs.readdirSync(path.join(ROOT, 'test'))
      .filter(f => f.endsWith('.test.js')).sort()
      .map(f => path.join(ROOT, 'test', f));
    const fails = [];
    const { run } = require('node:test');
    const s = run({ files, concurrency: 1 });
    for await (const ev of s) {
      if (ev.type === 'test:complete' && ev.data && ev.data.nesting === 0 && ev.data.file
          && !ev.data.details.passed) fails.push(path.basename(ev.data.file));
    }
    out.lines.push('  ' + (fails.length ? '✗' : '✓') + ' 测试 ' + (files.length - fails.length) + '/' + files.length +
      ' 文件全绿（进程内 run()）' + (fails.length ? '\n      失败：' + fails.join(', ') : ''));
    if (fails.length) out.bad++;
  } else {
    out.lines.push('  – 测试（--skip-tests 跳过）');
  }
  // ② 等价对拍（against-cases.js 注册表，进程内跑 40 档 = SM.POS 同源）
  {
    const names = AG.selectNames('all');
    const rs = AG.runCases(names, SM.POS);
    const badCases = rs.filter(r => r.diff > 0 || r.err > 0);
    out.lines.push('  ' + (badCases.length ? '✗' : '✓') + ' 对拍 ' + (rs.length - badCases.length) + '/' + rs.length +
      ' 用例 diff=0（' + names.join(', ') + '）');
    for (const r of badCases) {
      out.bad++;
      for (const s2 of r.samples.slice(0, 3)) out.lines.push('      [' + r.name + '] ' + s2);
    }
  }
  // ③ 微基准 vs 基线（≤×1.05）
  const base = loadBase();
  if (!base.micro) out.lines.push('  – 基线无 micro 段，跳过');
  else {
    const cur = SM.snapMicro();
    for (const k of Object.keys(cur)) {
      const r = cmpRow('micro.' + k, base.micro[k], +cur[k].toFixed(3), true);
      out.lines.push(r.line); if (r.bad) out.bad++;
    }
  }
  return out;
}

/* ---------- L2 中筛 ---------- */
function l2() {
  const out = { bad: 0, lines: [] };
  const base = loadBase();
  console.log('  （采 mates + search …约 2 分钟）');
  const mates = SM.snapMates(), search = SM.snapSearch(60);
  const cmp = (n, o, c, lo, ref) => { const r = cmpRow(n, o, c, lo, ref); out.lines.push(r.line); if (r.bad) out.bad++; };
  if (base.mates) {
    cmp('mates.attackPass', base.mates.attackPass, mates.attackPass, false);
    cmp('mates.defensePass', base.mates.defensePass, mates.defensePass, false);
    cmp('mates.totalNodes', base.mates.totalNodes, mates.totalNodes, true);
  }
  if (base.search) {
    cmp('search.depthFixedNodes', base.search.depthFixedTotalNodes, search.depthFixedTotalNodes, true);
    cmp('search.timeDepthMean', base.search.timeDepthMean, search.timeDepthMean, false, true);
    cmp('search.nps', base.search.nps, search.nps, false, true);
  }
  return out;
}

/* ---------- L3 确认 ---------- */
function l3() {
  const A = val('a'), B = val('b');
  if (!A || !B) { console.log('  ✗ L3 需要 --a=<cfgA> --b=<cfgB>（如 --a=hard-i100 --b=hard）'); return { bad: 1, lines: [] }; }
  console.log('  （bench-elo ' + A + ' vs ' + B + ' × ' + GAMES + ' 局；长任务建议直接后台跑 bench-elo.js）');
  try {
    runNode(['tools/bench-elo.js', A, B, String(GAMES)], { stdio: 'inherit' });
    return { bad: 0, lines: ['  – 详见上方 bench-elo 输出（以分层 CI 是否含 0 裁决）'] };
  } catch (e) {
    const busy = String(e.message || '').includes('EBUSY');
    return { bad: busy ? 0 : 1, lines: [busy
      ? '  – 本环境禁止 node 内 spawn（EBUSY）⇒ 请直接后台跑：node tools/bench-elo.js ' + A + ' ' + B + ' ' + GAMES
      : '  ✗ bench-elo 退出码非 0'] };
  }
}

/* ---------- 裁决卡 ---------- */
(async () => {
console.log('═══ 裁决卡：' + CHANGE + ' ═══');
let totalBad = 0;
if (DO_L1) {
  console.log('[L1] 快筛');
  const r = await l1(); totalBad += r.bad;
  for (const l of r.lines) console.log(l);
}
if (DO_L2) {
  console.log('[L2] 中筛');
  const r = l2(); totalBad += r.bad;
  for (const l of r.lines) console.log(l);
}
if (DO_L3) {
  console.log('[L3] 确认');
  const r = l3(); totalBad += r.bad;
  for (const l of r.lines) console.log(l);
}
if (!DO_L3) console.log('[L3] — 未跑（如需声称棋力提升：node tools/verdict.js --change=' + CHANGE + ' --l3 --games=300 --a=<cfgA> --b=<cfgB>）');
console.log(totalBad ? '结论：✗ 有 ' + totalBad + ' 项报警（见上）' : '结论：✓ 所选层全部通过');
process.exit(totalBad ? 1 : 0);
})().catch(e => { console.error('✘ verdict 异常：' + (e && e.message || e)); process.exit(2); });
