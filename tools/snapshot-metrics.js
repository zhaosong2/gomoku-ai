/* tools/snapshot-metrics.js —— 采集 / 比对效果层基线（S1，test-methodology §4.3/§4.4）
 *
 *   node tools/snapshot-metrics.js --save --note A0-baseline        全量采集并写基线
 *   node tools/snapshot-metrics.js --save --note A1-x --only=search 只重采 search 段（其余段继承旧基线）
 *   node tools/snapshot-metrics.js --diff                           只打印与基线差异（不改文件）
 *
 * 对 §4.4 骨架的实施修正（已对照 engine 源码核实）：
 *   ① SEARCH.winningPoints 是 board 基 (board, p, mode, rule)——骨架误传 pos；
 *   ② DEFENSE 题判定按 mates.test.js 题库③口径（think + avoidOpp + safe 集合），
 *     骨架的 solveAndVerify(p.atk) 求的是攻方杀，语义不通。
 * 铁律：--diff 时 positions.sha 不符必须拒绝比对；A/A 对照必须零报警。
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');
const SEARCH = require('../engine/search.js');
const V = require('./verify-mate.js');
const M = require('../engine/data/mates.js');
const { idxOf, N, NN, BLACK, WHITE } = core;

const ROOT = path.join(__dirname, '..');
const BASE_PATH = path.join(ROOT, 'test', 'baseline', 'metrics.json');
const POS_PATH = path.join(ROOT, 'test', 'data', 'positions40.json');
const POS = require(POS_PATH);
const POS_SHA = crypto.createHash('sha1').update(JSON.stringify(POS)).digest('hex').slice(0, 12);

const MATE_OPT = { vcfDepth: 20, vcfBudget: 300000, vctDepth: 16, vctBudget: 200000 };
const CFG_DEPTH = h => ({ width: 14, radius: 2, ttBits: 18, incr: true, rule: 'freestyle',
                          overlineMode: 'rif', maxDepth: 8, hardLimit: 600000, h });
const MATE = 1e8 - 1000;                                    // search.js:25 同口径（|score|≥MATE 即已见杀）

/* ---- E1 mates ---- */
function snapMates() {
  let tot = 0, max = 0, ok = 0;
  const bands = { T1: 0, T2: 0, T3: 0 };
  const bandOf = p => p.plies <= 6 ? 'T1' : p.plies <= 8 ? 'T2' : 'T3';
  for (const p of M.ATTACK) {
    const r = V.solveAndVerify(p.stones, p.atk, MATE_OPT);
    if (!r.ok) continue;
    ok++; tot += r.res.nodes; if (r.res.nodes > max) max = r.res.nodes;
    bands[bandOf(p)]++;
  }
  // DEFENSE：think 必须选到 safe 集合内的着法（与 mates.test.js 题库③同口径）
  let def = 0;
  for (const p of M.DEFENSE) {
    const safeSet = new Set(p.safe.map(s => idxOf(s[0], s[1])));
    SEARCH.ttClear();
    const r = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), {
      rule: 'freestyle', difficulty: 'hard',
      vcfDepth: 10, vctDepth: 8, vcfBudget: 120000, vctBudget: 80000, threatMs: 600,
      avoidOpp: true, avoidK: 40, avoidDepth: 8, avoidBudget: 25000,
    });
    if (r && r.move && safeSet.has(idxOf(r.move.x, r.move.y))) def++;
  }
  return { attackPass: ok, defensePass: def, totalNodes: tot, maxNodes: max,
           meanNodes: Math.round(tot / Math.max(1, ok)), bands };
}

/* ---- E2 search ---- */
function buildPos(p) {
  const pos = SEARCH.posFromBoard(p.board, p.stm, p.hist);
  SEARCH.attachCache(pos, true);
  return pos;
}
function runAll(h, timeMs) {
  const out = [];
  for (const p of POS) {
    SEARCH.ttClear();
    const pos = buildPos(p);
    const cfg = Object.assign(CFG_DEPTH(h), timeMs ? { maxDepth: 20, hardLimit: timeMs } : {});
    const t0 = Date.now();
    const r = SEARCH.think(pos, cfg);
    out.push({ nodes: r.nodes, depth: r.depth, ms: Date.now() - t0,
               mate: Math.abs(r.score) >= MATE });
  }
  return out;
}
function snapSearch(timeMs) {
  const a = runAll(SEARCH.H.ALL, 0);
  const t = runAll(SEARCH.H.ALL, timeMs), t0 = runAll(0, timeMs);
  let sa = 0, n = 0;
  for (let i = 0; i < POS.length; i++) { if (t[i].mate || t0[i].mate) continue; sa += t[i].depth; n++; }
  const totN = a.reduce((s, x) => s + x.nodes, 0), totMs = a.reduce((s, x) => s + x.ms, 0);
  return { depthFixedTotalNodes: totN,
           depthFixedNodesH0: runAll(0, 0).reduce((s, x) => s + x.nodes, 0),
           timeDepthMean: +(sa / Math.max(1, n)).toFixed(2), timeDepthQuiet: n,
           timeMs, nps: Math.round(totN / Math.max(1, totMs / 1000)) };
}

/* ---- E3 micro（STONES 与 §3.4 一致）---- */
const STONES = [[7,7,BLACK],[7,6,WHITE],[8,6,BLACK],[6,6,WHITE],[8,8,BLACK],
                [6,7,WHITE],[6,5,BLACK],[9,7,WHITE],[10,7,BLACK],[5,8,WHITE]];
function boardOf(s) { const b = new Int8Array(NN); for (const [x, y, c] of s) b[idxOf(x, y)] = c; return b; }
function benchMicro(R, fn) {
  let sink = 0;
  for (let k = 0; k < 5000; k++) sink += fn() | 0;         // warmup（1000 不够：首跑 JIT/惰性初始化毛刺实测 -55%）
  let best = Infinity;                                      // 3 轮取 min（min 受 GC/调度干扰最少）
  for (let round = 0; round < 3; round++) {
    const t0 = Date.now();
    for (let k = 0; k < R; k++) sink += fn() | 0;
    const dt = Date.now() - t0;
    if (dt < best) best = dt;
  }
  return { us: best * 1000 / R, sink };
}
function snapMicro() {
  const B = boardOf(STONES), pos = buildPos({ board: Array.from(B), stm: BLACK, hist: STONES.map(s => [s[0], s[1]]) });
  const modeR = PAT.forbidMode(BLACK, 'renju', 'rif');       // forbiddenAt 用（覆盖禁手路径）
  // ★ forbiddenAt 口径对齐 forbidden.test.js『性能』用例：mulberry32(99) 20 个 18 子随机局面 × 空点遍历
  //   （骨架传已占点 (7,7) 是测量坑：实测 0.02µs 只是占用快速返回，方法论基线 6.02µs 才是目标函数）
  const rnd = core.mulberry32(99);
  const boards = [];
  for (let t = 0; t < 20; t++) {
    const b = new Int8Array(NN);
    for (let k = 0; k < 18; k++) { const i = (rnd() * NN) | 0; if (b[i] === core.EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE; }
    boards.push(b);
  }
  let nF = 0, bestF = Infinity;
  for (let round = 0; round < 3; round++) {
    const t0 = Date.now();
    nF = 0;
    for (const b of boards) for (let i = 0; i < NN; i++) if (b[i] === core.EMPTY) { PAT.forbiddenAt(b, i, modeR); nF++; }
    const dt = Date.now() - t0;
    if (dt < bestF) bestF = dt;
  }
  const g = (R, fn) => benchMicro(R, fn).us;
  return {
    staticEval:   g(100000, () => EV.staticEval(B, BLACK, { rule: 'freestyle' })),
    staticEvalPos:g(100000, () => EV.staticEvalPos(pos, { rule: 'freestyle' })),
    levelAt:      g(500000, () => PAT.levelAt(B, 7 * N + 6, BLACK)),
    candidates:   g(100000, () => EV.candidates(B, 2).length),
    winningPoints:g(30000,  () => SEARCH.winningPoints(B, BLACK).length),   // 口径对齐 bench-eval.js（2 参 freestyle 语义）
    makeMove:     g(300000, () => { core.makeMove(pos, 0, 0, BLACK); core.unmakeMove(pos); return 1; }),
    forbiddenAt:  +(bestF * 1000 / Math.max(1, nF)).toFixed(3)              // µs/次（3 轮取 min）
  };
}

/* ---- 采集 / 主流程（CLI 模式才执行；函数导出供 verdict.js 编排复用）---- */
function main() {
const argv = process.argv.slice(2);
const SAVE = argv.includes('--save');
const NOTE = argv.includes('--note') ? argv[argv.indexOf('--note') + 1] : '';
const onlyArg = argv.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map(s => s.trim()) : null;
const want = seg => !ONLY || ONLY.includes(seg);
const t00 = Date.now();
const cur = { stamp: new Date().toISOString(), note: NOTE || 'snapshot',
              env: { node: process.version, plat: process.platform, cores: os.cpus().length },
              positions: { file: 'test/data/positions40.json', n: POS.length, sha: POS_SHA } };
if (want('mates')) { console.log('采 E1 mates …'); cur.mates = snapMates(); }
if (want('search')) { console.log('采 E2 search …'); cur.search = snapSearch(60); }
if (want('micro')) { console.log('采 E3 micro …'); cur.micro = snapMicro(); }

/* ---- 主流程 ---- */
if (!SAVE) {
  if (!fs.existsSync(BASE_PATH)) { console.error('✘ 基线不存在：' + BASE_PATH + '（先 --save）'); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
  if (base.positions.sha !== POS_SHA)
    throw new Error('局面集已变（' + base.positions.sha + ' → ' + POS_SHA + '）⇒ 基线失效，须先 --save 重建');
  const row = (n, o, c, lo, ref) => {   // lo=true 表示"越小越好"；ref=true 墙钟派生量（参考，不报警）
    const r = c / o, bad = !ref && (lo ? r > 1.05 : r < 0.98);
    console.log('  ' + (bad ? '✗' : ref ? '·' : '✓') + ' ' + n.padEnd(24) + o + ' → ' + c +
                '（' + ((r - 1) * 100).toFixed(2) + '%）' + (ref ? '  〔墙钟，参考〕' : ''));
  };
  console.log('┌ 与基线差异（--diff）  基线 note=' + base.note + ' @ ' + base.stamp);
  if (base.mates && cur.mates) {
    row('mates.totalNodes', base.mates.totalNodes, cur.mates.totalNodes, true);
    row('mates.attackPass', base.mates.attackPass, cur.mates.attackPass, false);
    row('mates.defensePass', base.mates.defensePass, cur.mates.defensePass, false);
  }
  if (base.search && cur.search) {
    row('search.depthFixedNodes', base.search.depthFixedTotalNodes, cur.search.depthFixedTotalNodes, true);
    row('search.timeDepthMean', base.search.timeDepthMean, cur.search.timeDepthMean, false, true);
    row('search.nps', base.search.nps, cur.search.nps, false, true);
  }
  if (base.micro && cur.micro)
    for (const k of Object.keys(cur.micro)) row('micro.' + k, base.micro[k], +cur.micro[k].toFixed(3), true);
  console.log('└ 耗时 ' + ((Date.now() - t00) / 1000).toFixed(0) + 's');
} else {
  // --only 分段：未采集段从旧基线继承（旧基线必须存在且 sha 一致）
  let merged = cur;
  if (ONLY) {
    if (!fs.existsSync(BASE_PATH)) { console.error('✘ --only 需要已存在的基线（首采请全量）'); process.exit(2); }
    const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
    if (base.positions.sha !== POS_SHA) { console.error('✘ 局面集已变，须全量 --save 重建'); process.exit(2); }
    merged = Object.assign({}, base, cur);
    console.log('继承未采集段：' + ['mates', 'search', 'micro'].filter(s => !want(s)).join(', '));
  }
  fs.mkdirSync(path.dirname(BASE_PATH), { recursive: true });
  const round = (o, d) => { for (const k of Object.keys(o)) o[k] = typeof o[k] === 'object' ? round(o[k], d) : (typeof o[k] === 'number' ? +o[k].toFixed(d) : o[k]); return o; };
  fs.writeFileSync(BASE_PATH, JSON.stringify(round(merged, 3), null, 1));
  console.log('✔ 已写基线 →', BASE_PATH, '  note =', merged.note, '  sha =', POS_SHA,
    '  耗时 ' + ((Date.now() - t00) / 1000).toFixed(0) + 's');
}
}
if (require.main === module) main();
module.exports = { POS, POS_SHA, POS_PATH, BASE_PATH, snapMates, snapSearch, snapMicro };
