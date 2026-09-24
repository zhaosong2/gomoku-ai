/* tools/bench-elo.js — 自对弈 Elo 基准（设计 §17.2 第 2 条）
 *
 * 用法：
 *   node tools/bench-elo.js <配置A> <配置B> [局数] [最大手数]
 * 配置串： <难度>[-vcf0][-navoid][-i<每手时限ms>][-w<宽度>][-d<最大深度>]
 *   例： hard            = 困难（威胁搜索按 §13/§32 预设开启）
 *       hard-vcf0       = 困难但关闭 VCF/VCT（用于对比"威胁搜索是否带来提升"）
 *       master-i300     = 大师参数、每手限时 300ms（跑得快些）
 *       normal-w10      = 中等、候选宽度 10
 *       hard-h0         = M7 启发式全部关闭（对照组的"M7 前"行为）
 *       hard-h2-min2    = 只开 H_LMRF，且 LMR 削减下限设为 2
 *       hard-nobook     = 关闭开局库（§12.4），用于对比"开局库是否带来提升"
 *       hard-s42        = 开局库抽样用固定种子 42（默认种子 20260919，**结果可复现**）
 *
 * 做法（保证可比）：
 *   · 固定开局集：取 26 种指定开局的前 3 手，第 g 局用第 (g/2)%26 号开局 → 同开局双色各一局；
 *   · 每手落子前 **清空置换表**，避免一方"继承"另一方搜索留下的信息；
 *   · 三次重复局面或超过最大手数判和（§33.8）；
 *   · 固定种子 → 结果可复现。
 * 输出：A 视角的胜负和、胜率 S、Elo 差与 **95% 置信区间**，并给出"能否分辨 20 Elo"的判断。
 */
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const OP = require('../engine/data/openings.js');
const V = require('./verify-mate.js');
const MATES = require('../engine/data/mates.js');
const { N, NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;

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
    else if (/^h\d+$/.test(t)) cfg.h = parseInt(t.slice(1), 10);          // M7 启发式位开关
    else if (/^min\d+$/.test(t)) cfg.lmrMin = parseInt(t.slice(3), 10);   // LMR 削减下限
    else if (/^iid\d+$/.test(t)) cfg.iidMode = parseInt(t.slice(3), 10);  // IID 闸门模式
    else if (t === 'nobook') cfg.useBook = false;            // §12.4 开局库开关
    else if (t === 'book1') cfg.useBook = true;
    else if (/^s\d+$/.test(t)) cfg.rnd = mulberry32(parseInt(t.slice(1), 10));
    else throw new Error('无法识别配置项：' + t);
  }
  return cfg;
}

// ★ 开局库抽样的随机源必须是**可复现**的（否则同一份配置两次跑出不同结果，无法复盘争议局）
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 固定开局集：26 种指定开局的前 3 手（黑1 H8 + 白2 + 黑3）
const OPENINGS = OP.OPENINGS.map(o => ({
  name: o.name,
  moves: o.moves.map(m => [m.x, m.y]),
}));
const MAXOPEN = OPENINGS.length;

function keyOf(pos) { return pos.zobHi + ':' + pos.zobLo; }

// ★ 开局库"用药量"统计：先回答"到底出得上几手书招"再谈棋力。
//   若对手不按书走（本 A/B 里 B 就是搜索方），第 5 手起历史多半已经偏离，
//   A 可能整局只吃到 1~2 手书招 —— 那"有提升"就必须打上大大的折扣。
const BK = { a: 0, b: 0 };

function playGame(cfgA, cfgB, opening, aIsBlack, maxPlies) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const hist = new Map();
  const trace = [];                       // ★ D-1（duel-methodology §3.2.1）：逐手轨迹，纯旁路不改对局逻辑
  let plies = 0;
  for (const [x, y] of opening) {
    if (pos.board[idxOf(x, y)] !== EMPTY) continue;
    core.makeMove(pos, x, y, pos.stm);
    plies++;
  }
  while (plies < maxPlies) {
    if (pos.stones >= NN) return { winner: 0, plies, why: 'full', trace };
    const k = keyOf(pos);
    const cnt = (hist.get(k) || 0) + 1;
    hist.set(k, cnt);
    if (cnt >= 3) return { winner: 0, plies, why: 'repeat3', trace };
    const stm = pos.stm;
    const isA = ((stm === BLACK) === aIsBlack);
    const cfg = isA ? cfgA : cfgB;
    SEARCH.ttClear();                       // ★ 每手清 TT，保证双方互不"借力"
    const r = SEARCH.think(pos, cfg);
    if (r && r.via === 'book') { if (isA) BK.a++; else BK.b++; }
    if (!r || !r.move) return { winner: 0, plies, why: 'nomove', trace };
    if (pos.board[idxOf(r.move.x, r.move.y)] !== EMPTY) return { winner: 0, plies, why: 'illegal', trace };
    // ★ D-1（duel-methodology §3.2.1）：逐手轨迹。scoreBlack = 黑方视角归一
    //   （think().score 是轮走方视角）；book 手的 ms/nodes/depth 无搜索含义，分析侧须排除。
    trace.push({
      ply: plies, stm: stm, side: isA ? 'A' : 'B',
      x: r.move.x, y: r.move.y,
      ms: r.timeMs, nodes: r.nodes, depth: r.depth,
      scoreBlack: (stm === BLACK) ? r.score : -(r.score),
      via: r.via || 'search', book: r.via === 'book',
      fb: r.fallbackLevel,              // ★ L1 兜底识别（duel-methodology §3.2.2）：仅主搜索分支有值，1 = 一层都没搜完
    });
    core.makeMove(pos, r.move.x, r.move.y, stm);
    plies++;
    if (RU.isWin(pos.board, r.move.x, r.move.y, stm)) return { winner: stm, plies, why: 'win', trace };
  }
  return { winner: 0, plies, why: 'maxplies', trace };
}

function mateSetRate(cfg) {
  let pass = 0, total = 0;
  for (const p of MATES.ATTACK) {
    total++;
    let ok = false;
    if (cfg.vcfDepth !== 0) {
      ok = V.solveAndVerify(p.stones, p.atk, {
        vcfDepth: 20, vcfBudget: 300000, vctDepth: 16, vctBudget: 200000, useVct: true,
      }).ok;
    }
    if (!ok) {
      // 关闭威胁搜索（或求解器未找到）时，用**限定深度的纯搜索**判断能否看到杀
      SEARCH.ttClear();
      const q = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), cfg);
      ok = !!q && Math.abs(q.score) >= 99999000;
    }
    if (ok) pass++;
  }
  return pass + '/' + total;
}

// ★ D-2（duel-methodology §3.2.1）：--trace 开启后逐局写 _duel-trace.jsonl（每局一行 append，
//   落盘间隔 << 任务时长，进程被回收也留得下已完成的局）。默认关：不影响常规 Elo 跑分。
const fs = require('fs');
const path = require('path');
const TRACE_OUT = process.argv.includes('--trace');
const TRACE_PATH = path.join(__dirname, '..', '_duel-trace.jsonl');

// ★ 位置参数与 flag 分离：--trace 这类 flag 也占 argv 槽位，若不滤掉，
//   parseInt('--trace') = NaN 会把 MAXPLY 变 NaN（每局只打开局 3 手即止）——实测踩坑 2026-09-20
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const A = parseCfg(ARGS[0] || 'hard');
const B = parseCfg(ARGS[1] || 'hard-vcf0');
const GAMES = parseInt(ARGS[2] || '40', 10);
const MAXPLY = parseInt(ARGS[3] || '80', 10);
const A_NAME = ARGS[0] || 'hard', B_NAME = ARGS[1] || 'hard-vcf0';

// 默认给双方各一条**互不干扰**的可复现随机流（仅供开局库抽样），SEED 可用环境变量覆盖
const SEED = parseInt(process.env.SEED || '20260919', 10);
if (!A.rnd) A.rnd = mulberry32(SEED);
if (!B.rnd) B.rnd = mulberry32((SEED ^ 0x9e3779b9) >>> 0);

console.log('=== 自对弈 Elo 基准（§17.2） ===');
if (TRACE_OUT) {
  fs.writeFileSync(TRACE_PATH, '');       // 起跑截断旧文件：一次跑对应一份完整 trace
  console.log('  trace → ' + TRACE_PATH + '（每局一行，已截断旧文件）');
}
console.log('A = ' + A_NAME + '  ' + JSON.stringify(A));
console.log('B = ' + B_NAME + '  ' + JSON.stringify(B));
console.log('局数 ' + GAMES + '（每局双色各一，固定开局集 ' + OPENINGS.length + ' 种）  最大手数 ' + MAXPLY);

let w = 0, l = 0, d = 0, pliesSum = 0, aBlack = 0;
const byWhy = {};
// ★ 分层（cluster）稳健方差：格子 = (开局, A 执黑/执白)，共 MAXOPEN×2 = 52 格。
//   必须做这一步的理由：搜索是**确定性**的，A 与 B 唯一差别是开局那几手书招，
//   所以同一格子内的多局高度重复（只有加权抽样的运气不同）→ 局之间**不独立**。
//   若照搬二项分布算 CI，区间会偏窄、容易假阳性。这里以「格子均值」为抽样单位。
const CELLS = new Array(MAXOPEN * 2).fill(0).map(() => ({ s: 0, n: 0, bk: 0 }));
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const oi = Math.floor(g / 2) % OPENINGS.length;
  const opening = OPENINGS[oi].moves;
  const aIsBlack = (g % 2 === 0);
  const cell = CELLS[oi * 2 + (aIsBlack ? 0 : 1)];
  const bkBefore = BK.a + BK.b;
  if (aIsBlack) aBlack++;
  const res = playGame(A, B, opening, aIsBlack, MAXPLY);
  if (TRACE_OUT) {                        // ★ D-2：每局一落盘（append），含完整逐手轨迹
    fs.appendFileSync(TRACE_PATH, JSON.stringify({
      game: g, opening: OPENINGS[oi].name, aIsBlack: aIsBlack,
      winner: res.winner, plies: res.plies, why: res.why,
      names: { A: A_NAME, B: B_NAME },
      trace: res.trace || [],
    }) + '\n');
  }
  cell.bk += (BK.a + BK.b) - bkBefore;
  pliesSum += res.plies;
  byWhy[res.why] = (byWhy[res.why] || 0) + 1;
  let sc;
  if (res.winner === 0) { d++; sc = 0.5; }
  else if ((res.winner === BLACK) === aIsBlack) { w++; sc = 1; }
  else { l++; sc = 0; }
  cell.s += sc; cell.n++;
  /**
   * 滚动快照：每 20 局打印一次带 CI 的当前结果。
   * ★ 长任务必须"边跑边落人话进度"——本机历史上多次出现跑到一半进程被回收、
   *   日志里零可用结果的情况（见 §35 工具环境备忘）。有了它，中断也留得下有效数据。
   */
  function snap() {
    const ww = w, ll = l, dd = d;
    const nn = Math.max(1, ww + ll + dd);
    let sc = Math.min(1 - 1e-6, Math.max(1e-6, (ww + 0.5 * dd) / nn));
    const e = -400 * Math.log10(1 / sc - 1);
    const ms = CELLS.filter(c2 => c2.n > 0).map(c2 => c2.s / c2.n);
    const nc = Math.max(1, ms.length);
    const mb = ms.reduce((a2, b2) => a2 + b2, 0) / nc;
    const vb = ms.reduce((a2, b2) => a2 + (b2 - mb) * (b2 - mb), 0) / Math.max(1, nc - 1);
    const se = Math.sqrt(vb / nc);
    const seE = (400 / Math.LN10) * se / (sc * (1 - sc));
    return 'Elo ' + (e >= 0 ? '+' : '') + e.toFixed(1) + '  分层CI [' +
      (e - 1.96 * seE).toFixed(1) + ', ' + (e + 1.96 * seE).toFixed(1) + ']  每格 ' +
      (nn / Math.max(1, ms.length)).toFixed(1) + ' 局  书招/局 ' +
      ((BK.a + BK.b) / nn).toFixed(2);
  }
  if ((g + 1) % 20 === 0) {
    console.log('  … ' + (g + 1) + '/' + GAMES + ' 局：A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d +
      '，' + ((Date.now() - t0) / 1000).toFixed(0) + 's  |  ' + snap());
  }
}
const dt = (Date.now() - t0) / 1000;
const n = w + l + d;
let S = (w + 0.5 * d) / n;
S = Math.min(1 - 1e-6, Math.max(1e-6, S));
const elo = -400 * Math.log10(1 / S - 1);
const seS = Math.sqrt(S * (1 - S) / n);
const seElo = (400 / Math.LN10) * seS / (S * (1 - S));
const lo = elo - 1.96 * seElo, hi = elo + 1.96 * seElo;
// 分辨 20 Elo 所需局数（粗略：CI 半宽 ≈ 20）
const need = Math.ceil(Math.pow(1.96 * (400 / Math.LN10) * 0.5 / (0.25 * 20), 2));

// ★ 分层稳健 CI：以 52 个「格子均值」为抽样单位（局间不独立 ⇒ 这才是该用的那个数）
const means = CELLS.filter(c => c.n > 0).map(c => c.s / c.n);
const CN = means.length;
const mBar = means.reduce((a, b) => a + b, 0) / Math.max(1, CN);
const vBar = means.reduce((a, b) => a + (b - mBar) * (b - mBar), 0) / Math.max(1, CN - 1);
const seStrat = Math.sqrt(vBar / Math.max(1, CN));
const seEloStrat = (400 / Math.LN10) * seStrat / (S * (1 - S));
const loS = elo - 1.96 * seEloStrat, hiS = elo + 1.96 * seEloStrat;

console.log('\n结果（A = ' + A_NAME + ' 视角）');
console.log('  A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d + '   （A 执黑 ' + aBlack + ' 局）');
console.log('  胜率 S = ' + S.toFixed(3) + '   Elo(A−B) = ' + (elo >= 0 ? '+' : '') + elo.toFixed(1));
console.log('    · naive 95% CI   [' + lo.toFixed(1) + ', ' + hi.toFixed(1) + ']（把每局当独立样本——偏乐观）');
console.log('    · 分层 95% CI    [' + loS.toFixed(1) + ', ' + hiS.toFixed(1) + ']（以 ' + CN +
  ' 个"开局×执色"格子的均值为抽样单位——**以它裁决**）');
console.log('  平均手数 ' + (pliesSum / n).toFixed(1) + '  结束原因 ' + JSON.stringify(byWhy) +
  '  耗时 ' + dt.toFixed(0) + 's（' + (n / dt).toFixed(2) + ' 局/秒）');
console.log('  开局库用量：A ' + BK.a + ' 手 / B ' + BK.b + ' 手，合每局 ' +
  ((BK.a + BK.b) / Math.max(1, n)).toFixed(2) + ' 手');
console.log('  判定（按分层 CI）：' + (loS > 0 ? 'A 显著更强' : hiS < 0 ? 'B 显著更强' : '无显著差异') +
  '（分层 CI ' + (loS > 0 || hiS < 0 ? '不含' : '包含') + ' 0）');
console.log('  注：按分层方差要分辨 20 Elo 约需 ' +
  Math.max(need, Math.ceil(need * Math.pow(seEloStrat / Math.max(1e-9, seElo), 2))) +
  ' 局；本样本 ' + n + ' 局，' + (Math.abs(elo) < seEloStrat * 1.96 ? '尚不足以定论' : '已达显著'));
console.log('\n题库通过率：A(' + A_NAME + ') = ' + mateSetRate(A) + '，B(' + B_NAME + ') = ' + mateSetRate(B));
