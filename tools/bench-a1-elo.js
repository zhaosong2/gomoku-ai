/* tools/bench-a1-elo.js —— A1 时间管理「交叉开局」自对弈（A1 统一 Elo 快确认口径）
 *
 * 为什么需要独立工具（与 tools/bench-elo.js 的分工）：
 *   bench-elo 用 26 种固定开局 → 开局库吃 ~7.8 手/局 ⇒ 时间管理差异被开局库冲淡；
 *   本工具改为**交叉开局**：开局由 A/B 自己搜出来（useBook:false 时每局从空盘/短前缀开始），
 *   每一手都暴露在时间管理下 ⇒ 正是 A1 需要度量的场景。
 *
 * 用法：
 *   node tools/bench-a1-elo.js <配置A> <配置B> [局数] [最大手数]
 *   配置串同 bench-elo（hard / hard-h191 / ...），额外支持 `-i<ms>` 覆盖 hardLimit。
 *   例：node tools/bench-a1-elo.js hard-i100 hard-i100 120
 *
 * 口径（可复现）：
 *   · 开局：只放**固定首手**（黑 1 手 H8 或按局号轮换的 4 个中心点之一）→ 其后双方自行搜出；
 *   · 每手清 TT（与 bench-elo 一致，双方互不借力）；
 *   · **不开局库**（useBook:false）——本工具的目的就是让搜出的每一手都经过时间管理层；
 *   · 同开局双色各一局；
 *   · 三次重复/满手数判和；SEED 固定（默认 20260920）→ 可复现。
 * 输出：A 视角胜负和、Elo 差、**分层 95% CI**（格子 = 开局×执色）。
 */
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const { BLACK, WHITE, EMPTY, NN, idxOf } = core;

function parseCfg(str) {
  const parts = String(str).split('-').filter(Boolean);
  const lvl = parts.shift() || 'hard';
  const cfg = { difficulty: lvl, rule: 'freestyle' };
  for (const t of parts) {
    if (t === 'vcf0') { cfg.vcfDepth = 0; cfg.vctDepth = 0; cfg.avoidOpp = false; }
    else if (t === 'navoid') { cfg.avoidOpp = false; }
    else if (/^i\d+$/.test(t)) cfg.hardLimit = parseInt(t.slice(1), 10);
    else if (/^vcf\d+$/.test(t)) { cfg.vcfDepth = parseInt(t.slice(3), 10); cfg.vctDepth = Math.max(2, cfg.vcfDepth - 4); cfg.avoidOpp = true; }
    else if (/^w\d+$/.test(t)) cfg.width = parseInt(t.slice(1), 10);
    else if (/^d\d+$/.test(t)) cfg.maxDepth = parseInt(t.slice(1), 10);
    else if (/^h\d+$/.test(t)) cfg.h = parseInt(t.slice(1), 10);
    else if (/^min\d+$/.test(t)) cfg.lmrMin = parseInt(t.slice(3), 10);
    else if (/^iid\d+$/.test(t)) cfg.iidMode = parseInt(t.slice(3), 10);
    else if (/^s\d+$/.test(t)) cfg.rnd = mulberry32(parseInt(t.slice(1), 10));
    // ★ A1 时间管理参数（用于"A1 开 vs A1 前"对比；回滚三件套 = k0-stab100-stop100）
    else if (/^k(\d+)$/.test(t)) cfg.layerFactor = parseInt(t.slice(1), 10);      // 预测式停止 K（默认 8）
    else if (/^stab(\d+)$/.test(t)) cfg.stabilFactor = parseInt(t.slice(3), 10) / 100;  // 稳定收缩（默认 0.97）
    else if (/^stop(\d+)$/.test(t)) cfg.stopEarly = parseInt(t.slice(4), 10) / 100;     // 提前终止（默认 0.7）
    else if (/^ratio(\d+)$/.test(t)) cfg.tacticalRatio = parseInt(t.slice(5), 10) / 100; // 战术预算比例（默认 0.35）
    // ★ A3 叶节点 VCF（§4.3）：`lv<depth>` 开叶 VCF 并自动带 H_LEAFVCF 位；`lv0` = 关（回滚）
    else if (/^lv0$/.test(t)) { cfg.leafVcfDepth = 0; cfg.h = (cfg.h === undefined ? SEARCH.H.ALL : cfg.h) & ~SEARCH.H.LEAFVCF; }
    else if (/^lv(\d+)$/.test(t)) {
      const d = parseInt(t.slice(2), 10);
      cfg.leafVcfDepth = d;
      if (d > 0) cfg.h = (cfg.h === undefined ? SEARCH.H.ALL : cfg.h) | SEARCH.H.LEAFVCF;
    }
    else if (/^lvb(\d+)$/.test(t)) cfg.leafVcfBudget = parseInt(t.slice(3), 10);   // 叶 VCF 预算
    else throw new Error('无法识别配置项：' + t);
  }
  return cfg;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 交叉开局首手池：中心周边 5 点（含天元）。第 g 局取池中第 (g/2)%5 个，双色各一局。
const FIRSTS = [[7, 7], [6, 6], [8, 8], [6, 8], [8, 6]];
function keyOf(pos) { return pos.zobHi + ':' + pos.zobLo; }

function playGame(cfgA, cfgB, opening, aIsBlack, maxPlies) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const hist = new Map();
  let plies = 0;
  for (const [x, y] of opening) {
    if (pos.board[idxOf(x, y)] !== EMPTY) continue;
    core.makeMove(pos, x, y, pos.stm);
    plies++;
  }
  while (plies < maxPlies) {
    if (pos.stones >= NN) return { winner: 0, plies, why: 'full' };
    const k = keyOf(pos);
    const cnt = (hist.get(k) || 0) + 1;
    hist.set(k, cnt);
    if (cnt >= 3) return { winner: 0, plies, why: 'repeat3' };
    const stm = pos.stm;
    const isA = ((stm === BLACK) === aIsBlack);
    const cfg = isA ? cfgA : cfgB;
    SEARCH.ttClear();
    const r = SEARCH.think(pos, cfg);
    if (!r || !r.move) return { winner: 0, plies, why: 'nomove' };
    if (pos.board[idxOf(r.move.x, r.move.y)] !== EMPTY) return { winner: 0, plies, why: 'illegal' };
    core.makeMove(pos, r.move.x, r.move.y, stm);
    plies++;
    if (RU.isWin(pos.board, r.move.x, r.move.y, stm)) return { winner: stm, plies, why: 'win' };
  }
  return { winner: 0, plies, why: 'maxplies' };
}

const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const A = parseCfg(ARGS[0] || 'hard-i100');
const B = parseCfg(ARGS[1] || 'hard-i100');
const GAMES = parseInt(ARGS[2] || '120', 10);
const MAXPLY = parseInt(ARGS[3] || '80', 10);
const A_NAME = ARGS[0] || 'hard-i100', B_NAME = ARGS[1] || 'hard-i100';
// ★ 本工具强制 useBook:false（目的就是让每一手都过时间管理层）
A.useBook = false; B.useBook = false;

const SEED = parseInt(process.env.SEED || '20260920', 10);
if (!A.rnd) A.rnd = mulberry32(SEED);
if (!B.rnd) B.rnd = mulberry32((SEED ^ 0x9e3779b9) >>> 0);

console.log('=== A1 时间管理「交叉开局」自对弈（useBook:false，每手清 TT） ===');
console.log('A = ' + A_NAME + '  ' + JSON.stringify(A));
console.log('B = ' + B_NAME + '  ' + JSON.stringify(B));
console.log('局数 ' + GAMES + '（每局双色各一）  最大手数 ' + MAXPLY + '  首手池 ' + FIRSTS.length + ' 种');

let w = 0, l = 0, d = 0, pliesSum = 0, aBlack = 0;
const byWhy = {};
const CELLS = new Array(FIRSTS.length * 2).fill(0).map(() => ({ s: 0, n: 0 }));
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const oi = Math.floor(g / 2) % FIRSTS.length;
  const opening = [FIRSTS[oi]];
  const aIsBlack = (g % 2 === 0);
  const cell = CELLS[oi * 2 + (aIsBlack ? 0 : 1)];
  if (aIsBlack) aBlack++;
  const res = playGame(A, B, opening, aIsBlack, MAXPLY);
  pliesSum += res.plies;
  byWhy[res.why] = (byWhy[res.why] || 0) + 1;
  let sc;
  if (res.winner === 0) { d++; sc = 0.5; }
  else if ((res.winner === BLACK) === aIsBlack) { w++; sc = 1; }
  else { l++; sc = 0; }
  cell.s += sc; cell.n++;
  if ((g + 1) % 20 === 0) {
    const nn = Math.max(1, w + l + d);
    let s2 = Math.min(1 - 1e-6, Math.max(1e-6, (w + 0.5 * d) / nn));
    const e2 = -400 * Math.log10(1 / s2 - 1);
    console.log('  … ' + (g + 1) + '/' + GAMES + '：A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d +
      '，' + ((Date.now() - t0) / 1000).toFixed(0) + 's  |  Elo ' + (e2 >= 0 ? '+' : '') + e2.toFixed(1));
  }
}
const dt = (Date.now() - t0) / 1000;
const n = w + l + d;
let S = (w + 0.5 * d) / n;
S = Math.min(1 - 1e-6, Math.max(1e-6, S));
const elo = -400 * Math.log10(1 / S - 1);
const means = CELLS.filter(c => c.n > 0).map(c => c.s / c.n);
const CN = means.length;
const mBar = means.reduce((a, b) => a + b, 0) / Math.max(1, CN);
const vBar = means.reduce((a, b) => a + (b - mBar) * (b - mBar), 0) / Math.max(1, CN - 1);
const seStrat = Math.sqrt(vBar / Math.max(1, CN));
const seEloStrat = (400 / Math.LN10) * seStrat / (S * (1 - S));
const loS = elo - 1.96 * seEloStrat, hiS = elo + 1.96 * seEloStrat;
const seElo = (400 / Math.LN10) * Math.sqrt(S * (1 - S) / n) / (S * (1 - S));

console.log('\n结果（A = ' + A_NAME + ' 视角）');
console.log('  A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d + '   （A 执黑 ' + aBlack + ' 局）');
console.log('  胜率 S = ' + S.toFixed(3) + '   Elo(A−B) = ' + (elo >= 0 ? '+' : '') + elo.toFixed(1));
console.log('    · naive 95% CI  [' + (elo - 1.96 * seElo).toFixed(1) + ', ' + (elo + 1.96 * seElo).toFixed(1) + ']（偏乐观）');
console.log('    · 分层 95% CI   [' + loS.toFixed(1) + ', ' + hiS.toFixed(1) + ']（' + CN + ' 格；**以它裁决**）');
console.log('  平均手数 ' + (pliesSum / n).toFixed(1) + '  结束原因 ' + JSON.stringify(byWhy) +
  '  耗时 ' + dt.toFixed(0) + 's（' + (n / dt).toFixed(3) + ' 局/秒）');
console.log('  判定：' + (loS > 0 ? 'A 显著更强' : hiS < 0 ? 'B 显著更强' : '**无显著差异（CI 含 0）**') +
  '（CI ' + ((loS > 0 || hiS < 0) ? '不含' : '包含') + ' 0）');
