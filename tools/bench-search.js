/* tools/bench-search.js — 搜索效率基准（M7 交付物，支撑 §17.2 第 5 条"性能基准"）
 *
 * 用法：
 *   node tools/bench-search.js [局数] [每手时限ms] [最大深度]
 *
 * 做法（保证可比）：
 *   · 局面集：26 种固定开局 + 确定性伪随机铺子（固定种子），只保留"无立即战术"的安静中局，
 *     否则 L0/VCF 会直接接管、根本进不了 PVS，测不出搜索增强的差别；
 *   · 每个局面 **先清 TT** 再搜，两个被测配置看到的是同一初始状态；
 *   · 对比两组：default（M7 增强，cfg.h 默认）/ base（h=0，M7 前启发式）。
 *
 * 输出三类指标：
 *   ① 固定深度：节点数 / 耗时（越小越好）
 *   ② 固定时限：到达深度（越大越好）——★ 只在"两组都没见杀"的**公共安静子集**上比较，
 *      否则见杀提前退出会让深度样本集合不一致，得出虚假结论（这是本工具第一版的坑）
 *   ③ 一致性：两组根分值必须落在同一量级（搜索增强只应提速，不应改变棋力结论）
 */
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const OP = require('../engine/data/openings.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;

const NPOS = parseInt(process.argv[2] || '40', 10);
const TIME_MS = parseInt(process.argv[3] || '60', 10);
const MAXD = parseInt(process.argv[4] || '8', 10);

/* 确定性 PRNG（xorshift32），保证局面集可复现 */
function mkRnd(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* 生成安静中局：开局 3 手 + 若干随机合法手；要求 tacticalMove()==null 且无人已成五 */
function genPositions(n) {
  const rnd = mkRnd(20260918);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 200) {
    const op = OP.OPENINGS[out.length % OP.OPENINGS.length];
    const pos = core.createPosition();
    SEARCH.attachCache(pos, true);
    let t = BLACK;
    let bad = false;
    for (const m of op.moves) {
      if (!core.makeMove(pos, m.x, m.y, t)) { bad = true; break; }
      t = opp(t);
    }
    if (bad) continue;
    const extra = 8 + Math.floor(rnd() * 8);
    for (let k = 0; k < extra; k++) {
      // 只落在已有棋子的 2 邻域内，避免全盘散点（更接近真实中局）
      const cand = [];
      for (let i = 0; i < NN; i++) {
        if (pos.board[i] !== EMPTY) continue;
        const x = i % N, y = (i / N) | 0;
        let near = false;
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
      // 若已成五 → 这个局面不该用于搜索基准（L0 会接管）
      if (RU.isWin(pos.board, i % N, (i / N) | 0, t, 'freestyle', 'rif')) { bad = true; break; }
      t = opp(t);
    }
    if (bad) continue;
    const cfg = { maxDepth: 4, hardLimit: 50, width: 14, radius: 2, ttBits: 14 };
    if (SEARCH.tacticalMove(pos, cfg)) continue;              // 有立即战术 → 跳过
    if (SEARCH.threatSolve(pos, Object.assign({}, cfg, { vcfDepth: 8, vctDepth: 6, threatMs: 200 }), Date.now())) continue;
    out.push({ board: pos.board.slice(), stm: pos.stm });
  }
  return out;
}

const BASE = { width: 14, radius: 2, ttBits: 18, incr: true, rule: 'freestyle', overlineMode: 'rif' };
const MATEv = PAT.WIN - 1000;
function fresh(p) { const pos = SEARCH.posFromBoard(p.board, p.stm); SEARCH.attachCache(pos, true); return pos; }

function runFixedDepth(positions, h) {
  let nodes = 0, ms = 0, mates = 0;
  const vals = [], depths = [];
  for (const p of positions) {
    const cfg = Object.assign({}, BASE, { maxDepth: MAXD, hardLimit: 600000, h: h });
    SEARCH.ttClear();
    const pos = fresh(p);
    const t0 = Date.now();
    const r = SEARCH.think(pos, cfg);
    ms += Date.now() - t0;
    nodes += r.nodes; depths.push(r.depth);
    if (Math.abs(r.score) >= MATEv) mates++;
    vals.push(r.score);
  }
  return { nodes: nodes, ms: ms, mates: mates, vals: vals,
           depth: depths.reduce((s, x) => s + x, 0) / depths.length };
}

function runFixedTime(positions, h) {
  const depth = [], mate = [];
  let ms = 0;
  for (const p of positions) {
    const cfg = Object.assign({}, BASE, { maxDepth: 20, hardLimit: TIME_MS, h: h });
    SEARCH.ttClear();
    const pos = fresh(p);
    const t0 = Date.now();
    const r = SEARCH.think(pos, cfg);
    ms += Date.now() - t0;
    depth.push(r.depth);
    mate.push(Math.abs(r.score) >= MATEv);
  }
  return { depth: depth, mate: mate, ms: ms };
}

const H = SEARCH.H;
const positions = genPositions(NPOS);
console.log('=== 搜索效率基准（§17.2 第 5 条）===');
console.log('局面集 ' + positions.length + ' 个安静中局（26 种开局 + 确定性随机，已排除 L0/VCF/VCT 直接接管的局面）');

console.log('\n① 固定深度 maxDepth=' + MAXD + '（节点/耗时越小越好）');
const a = runFixedDepth(positions, H.ALL);
const b = runFixedDepth(positions, 0);
console.log('  M7 增强(h=' + H.ALL + ')：节点 ' + a.nodes + '  耗时 ' + a.ms + 'ms  平均深度 ' + a.depth.toFixed(2) + '  见杀 ' + a.mates);
console.log('  M7 前 (h=0)      ：节点 ' + b.nodes + '  耗时 ' + b.ms + 'ms  平均深度 ' + b.depth.toFixed(2) + '  见杀 ' + b.mates);
console.log('  → 节点 ' + (100 * (a.nodes / b.nodes - 1)).toFixed(1) + '%   耗时 ' +
  (100 * (a.ms / b.ms - 1)).toFixed(1) + '%');

console.log('\n② 固定时限 ' + TIME_MS + 'ms/手（到达深度越大越好）');
const c = runFixedTime(positions, H.ALL);
const d = runFixedTime(positions, 0);
// ★ 只在"两组都没见杀"的公共子集上比深度，否则样本集合不同 → 虚假结论
let sa = 0, sb = 0, n = 0, mateA = 0, mateB = 0;
for (let i = 0; i < positions.length; i++) {
  if (c.mate[i]) mateA++;
  if (d.mate[i]) mateB++;
  if (c.mate[i] || d.mate[i]) continue;
  sa += c.depth[i]; sb += d.depth[i]; n++;
}
console.log('  M7 增强：平均到达深度 ' + (sa / n).toFixed(2) + '（' + n + ' 个公共安静局面）  见杀 ' + mateA + '  总耗时 ' + c.ms + 'ms');
console.log('  M7 前  ：平均到达深度 ' + (sb / n).toFixed(2) + '                    见杀 ' + mateB + '  总耗时 ' + d.ms + 'ms');
console.log('  → 深度 ' + ((sa - sb) / n >= 0 ? '+' : '') + ((sa - sb) / n).toFixed(2) + ' 层（公共子集 ' + n + '/' + positions.length + '）');

console.log('\n③ 分值一致性（增强只应提速，不应把棋力结论改到相反量级）');
let same = 0, flip = 0, maxAbs = 0;
for (let i = 0; i < a.vals.length; i++) {
  const x = a.vals[i], y = b.vals[i];
  if (Math.abs(x - y) <= 1) same++;
  else if ((x > 0) !== (y > 0) && Math.abs(x - y) > 1000) flip++;
  maxAbs = Math.max(maxAbs, Math.abs(x - y));
}
console.log('  完全相同 ' + same + '/' + a.vals.length + '   符号翻转且差值>1000：' + flip +
  '   最大差值 ' + maxAbs);
console.log('  注：LMR 是近似算子，分值存在小幅差异属正常；出现符号翻转才需要警惕。');
