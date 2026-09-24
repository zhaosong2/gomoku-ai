/* tools/bench-leafvcf.js — A3 叶节点 VCF 专用对照探针（§4.3 验收）
 *
 * 为什么不能直接用 bench-mates.js / bench-search.js：
 *   · bench-mates 的"有威胁搜索"档根层 VCF 就已覆盖全部题库（40/40），叶 VCF 无从体现；
 *   · bench-search 只对比 h=ALL vs h=0，不读 cfg.leafVcfDepth，且它测的是安静中局。
 *
 * 本探针的对照设计（关键）：**同时关掉根层 VCF/VCT**，把全部战术发现压力推给叶节点，
 * 这样"开/关 leafVcfDepth"的差就是叶 VCF 的**净贡献**。
 *
 * 三个指标对应施工图 §4.3 的三条门槛：
 *   ① 题库通过率   开 ≥ 关        （不降）
 *   ② 固定深度节点 开 ≤ 关 × 1.05 （不爆）
 *   ③ 叶 VCF 命中率  ≥ 2%         （否则关掉）
 *
 * ★ 硬时限下分数不可复现 ⇒ 固定深度档一律 hardLimit=600000 + 固定 maxDepth。
 *
 * 用法：node tools/bench-leafvcf.js [局数] [叶深度] [叶预算]
 */
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const OP = require('../engine/data/openings.js');
const M = require('../engine/data/mates.js');
const MV = require('./verify-mate.js');       // 复用 boardOf（mates.js 的 stones → board）

const { N, NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;

const NPOS = parseInt(process.argv[2] || '40', 10);
const LDEPTH = parseInt(process.argv[3] || '6', 10);
const LBUDGET = parseInt(process.argv[4] || '2000', 10);
// ★ 固定深度档的时限：大到"不构成约束"但不足以拖死探针。maxDepth=8 时 20s/局面足够
//   （实测 bench-search 40 局面 maxDepth=8 总耗时 39s ⇒ 约 1s/局面）。
//   施工图要求"硬时限下分数不可复现 ⇒ 用固定 maxDepth"——这里 maxDepth 固定，
//   时限只作为兜底（若真触发会打印警告，该档结果视为无效）。
const HLIMIT = parseInt(process.argv[5] || '20000', 10);
const MATE_HLIMIT = parseInt(process.argv[6] || '4000', 10);   // 题库档：每题 4s（VCF 题链长 ≤10，足够）

const MATEv = PAT.WIN - 1000;

/* ---------- ① 题库通过率（关掉根层 VCF/VCT，只看叶 VCF） ---------- */
function mateRate(leafVcfDepth) {
  let pass = 0;
  const fails = [];
  for (let k = 0; k < M.ATTACK.length; k++) {
    const p = M.ATTACK[k];
    const cfg = {
      difficulty: 'hard', vcfDepth: 0, vctDepth: 0, avoidOpp: false,   // ★ 根层战术全关
      hardLimit: MATE_HLIMIT, maxDepth: 8, h: SEARCH.H.ALL | SEARCH.H.LEAFVCF,
      leafVcfDepth: leafVcfDepth, leafVcfBudget: LBUDGET,
    };
    SEARCH.ttClear();
    const q = SEARCH.think(SEARCH.posFromBoard(MV.boardOf(p.stones), p.atk), cfg);
    const ok = !!q && q.score >= MATEv;
    if (ok) pass++; else fails.push(k + '(' + p.kind + p.plies + ')');
  }
  return { pass: pass, total: M.ATTACK.length, fails: fails };
}

/* ---------- ② 固定深度节点数（安静中局；确定性 PRNG 同 bench-search） ---------- */
function mkRnd(seed) {
  let s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function genPositions(n) {
  const rnd = mkRnd(20260918);
  const out = []; let guard = 0;
  while (out.length < n && guard++ < n * 200) {
    const op = OP.OPENINGS[out.length % OP.OPENINGS.length];
    const pos = core.createPosition(); SEARCH.attachCache(pos, true);
    let t = BLACK, bad = false;
    for (const m of op.moves) { if (!core.makeMove(pos, m.x, m.y, t)) { bad = true; break; } t = opp(t); }
    if (bad) continue;
    const extra = 8 + Math.floor(rnd() * 8);
    for (let k = 0; k < extra; k++) {
      const cand = [];
      for (let i = 0; i < NN; i++) {
        if (pos.board[i] !== EMPTY) continue;
        const x = i % N, y = (i / N) | 0; let near = false;
        for (let dx = -2; dx <= 2 && !near; dx++) for (let dy = -2; dy <= 2; dy++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          if (pos.board[idxOf(nx, ny)] !== EMPTY) { near = true; break; }
        }
        if (near) cand.push(i);
      }
      if (!cand.length) break;
      const i = cand[Math.floor(rnd() * cand.length)];
      core.makeMove(pos, i % N, (i / N) | 0, t);
      if (RU.isWin(pos.board, i % N, (i / N) | 0, t, 'freestyle', 'rif')) { bad = true; break; }
      t = opp(t);
    }
    if (bad) continue;
    const cfg = { maxDepth: 4, hardLimit: 50, width: 14, radius: 2, ttBits: 14 };
    if (SEARCH.tacticalMove(pos, cfg)) continue;
    if (SEARCH.threatSolve(pos, Object.assign({}, cfg, { vcfDepth: 8, vctDepth: 6, threatMs: 200 }), Date.now())) continue;
    out.push({ board: pos.board.slice(), stm: pos.stm });
  }
  return out;
}

const BASE = { width: 14, radius: 2, ttBits: 18, incr: true, rule: 'freestyle', overlineMode: 'rif' };
function fresh(p) { const pos = SEARCH.posFromBoard(p.board, p.stm); SEARCH.attachCache(pos, true); return pos; }
function runFixedDepth(positions, leafVcfDepth) {
  let nodes = 0, ms = 0, mates = 0, timeouts = 0; const vals = [];
  for (const p of positions) {
    const cfg = Object.assign({}, BASE, {
      maxDepth: 8, hardLimit: HLIMIT, h: SEARCH.H.ALL | SEARCH.H.LEAFVCF,
      leafVcfDepth: leafVcfDepth, leafVcfBudget: LBUDGET, vcfDepth: 0, vctDepth: 0,
    });
    SEARCH.ttClear();
    const t0 = Date.now();
    const r = SEARCH.think(fresh(p), cfg);
    ms += Date.now() - t0; nodes += r.nodes;
    if (r.depth < 8) timeouts++;    // 未到 maxDepth ⇒ 时限约束生效（该档不可比）
    if (Math.abs(r.score) >= MATEv) mates++;
    vals.push(r.score);
  }
  return { nodes: nodes, ms: ms, mates: mates, vals: vals, timeouts: timeouts };
}

/* ================= 执行 ================= */
console.log('=== A3 叶节点 VCF 对照探针（§4.3）===');
console.log('参数：叶深度=' + LDEPTH + '  叶预算=' + LBUDGET +
  '  | 题库 ' + M.ATTACK.length + ' 道  | 根层 vcfDepth/vctDepth 一律 0（隔离叶 VCF 净贡献）\n');

console.log('① 题库通过率（关 vs 开）');
const mOff = mateRate(0);
const mOn = mateRate(LDEPTH);
console.log('  叶 VCF 关：' + String(mOff.pass).padStart(2) + '/' + mOff.total +
  '  ' + (100 * mOff.pass / mOff.total).toFixed(0) + '%');
console.log('  叶 VCF 开：' + String(mOn.pass).padStart(2) + '/' + mOn.total +
  '  ' + (100 * mOn.pass / mOn.total).toFixed(0) + '%   Δ=' + (mOn.pass - mOff.pass));
if (mOff.fails.length) console.log('    [关]漏: ' + mOff.fails.slice(0, 10).join(' '));
if (mOn.fails.length) console.log('    [开]漏: ' + mOn.fails.slice(0, 10).join(' '));

console.log('\n② 固定深度节点数（maxDepth=8, hardLimit=' + HLIMIT + '）');
const positions = genPositions(NPOS);
console.log('  局面集 ' + positions.length + ' 个安静中局');
SEARCH.leafVcfReset();
const nOff = runFixedDepth(positions, 0);
const offStat = SEARCH.leafVcfStat();
const nOn = runFixedDepth(positions, LDEPTH);
const onStat = SEARCH.leafVcfStat();
console.log('  叶 VCF 关：节点 ' + nOff.nodes + '  耗时 ' + nOff.ms + 'ms  见杀 ' + nOff.mates);
console.log('  叶 VCF 开：节点 ' + nOn.nodes + '  耗时 ' + nOn.ms + 'ms  见杀 ' + nOn.mates);
console.log('  → 节点 ' + (100 * (nOn.nodes / nOff.nodes - 1)).toFixed(1) + '%   耗时 ' +
  (100 * (nOn.ms / nOff.ms - 1)).toFixed(1) + '%' +
  (nOn.mates !== nOff.mates ? '   见杀 ' + (nOn.mates - nOff.mates) : ''));
if (nOff.timeouts || nOn.timeouts) {
  console.log('  ⚠ 时限约束生效（未达 maxDepth）：关档 ' + nOff.timeouts + '/' + positions.length +
    '  开档 ' + nOn.timeouts + '/' + positions.length + ' ⇒ 节点数不可比，请调大 HLIMIT');
}

console.log('\n③ 叶 VCF 命中率（成本护栏，门槛 ≥2%）');
const calls = onStat.calls - offStat.calls, hits = onStat.hits - offStat.hits;
const hr = calls ? 100 * hits / calls : 0;
console.log('  调用 ' + calls + '  命中 ' + hits + '  命中率 ' + hr.toFixed(2) + '%' +
  (calls === 0 ? '  (叶 VCF 从未触发——本局面集不触达叶节点)' : (hr < 2 ? '  ✗ <2% 应关掉' : '  ✓')));

console.log('\n④ 一致性：开/关根分值差异数');
let diff = 0;
for (let i = 0; i < nOff.vals.length; i++) if (nOff.vals[i] !== nOn.vals[i]) diff++;
console.log('  ' + diff + '/' + nOff.vals.length + ' 个局面根分值不同' +
  (diff ? '  （叶 VCF 改变了评估；需确认方向正确）' : '  （完全一致）'));
