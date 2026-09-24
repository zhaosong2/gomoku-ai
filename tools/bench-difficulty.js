/* tools/bench-difficulty.js — 难度分级标定（设计 §13 / §17.2 / §17.4）
 *
 * 用法：
 *   node tools/bench-difficulty.js [局数/档] [最大手数] [模式] [档位,档位,…]
 *   默认：24 局/档  60 手  freestyle   easy,normal,hard,master
 *   例： node tools/bench-difficulty.js 40 80 freestyle normal,hard,master
 *        node tools/bench-difficulty.js 24 60 renju     easy,normal,hard
 *
 * 为什么要单独一个工具（而不是直接复用 bench-elo.js）：
 *   ① §13 要求难度按**规则分别标定**，需要同一轮里同时跑 freestyle 与 renju；
 *   ② 难度标定必须回答"**该档位在它自己的时限内实际搜到几层**"——这是"深度档位"
 *      的定义依据。bench-elo 只跑对局不给深度分布；
 *   ③ 需要"水平顺序 + 相邻显著性"一次算全（相邻两两配对的 McNemar 检验），
 *      而不是只给一个 A−B 的 Elo。
 *
 * 做法（与 bench-elo 同范式，保证可比）：
 *   · 固定开局集：26 种指定开局的前 3 手，同一开局**相邻两档各执黑一局**（消先手偏置）；
 *   · 每手落子前清空置换表，避免一方"继承"另一方搜索留下的信息；
 *   · 三次重复局面或超过最大手数判和（§33.8）；
 *   · 每档的 `hardLimit` 就是它 §13 规定的时限——这是难度定义的一部分，**不额外限时**；
 *   · 局数/随机性：本工具**无随机数**，同参数可完全复现。
 *
 * 输出：
 *   ① 每档"时限内实际到达深度"分布（标定 §13 的"深度"列）
 *   ② 每档对 A 的胜率、Elo 与 95% CI
 *   ③ 相邻档位两两 McNemar（精确二项）显著性 —— 回答"档位是否真的拉开差距"
 *   ④ 单调性检查：Elo 序列必须严格递增
 *   ⑤ 顺带跑题库通过率（§17.2 第 1 条，防止调参把杀棋能力改坏）
 */
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const OP = require('../engine/data/openings.js');
const V = require('./verify-mate.js');
const MATES = require('../engine/data/mates.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;

/* ---------- 参数 ---------- */
const GAMES = parseInt(process.argv[2] || '24', 10);       // 每个组合的对局数
const MAXPLY = parseInt(process.argv[3] || '60', 10);
const RULE = (process.argv[4] || 'freestyle').toLowerCase();
const LEVELS = (process.argv[5] || 'easy,normal,hard,master').split(',').map(s => s.trim()).filter(Boolean);
const MEASURE = parseInt(process.env.DIFF_MEASURE || '10', 10);   // 深度量测的局面数

if (['freestyle', 'renju'].indexOf(RULE) < 0) throw new Error('模式只能是 freestyle 或 renju');

/* ---------- 开局集 ---------- */
const OPENINGS = OP.OPENINGS.map(o => ({ name: o.name, moves: o.moves.map(m => [m.x, m.y]) }));
function openingOf(g) { return OPENINGS[Math.floor(g / 2) % OPENINGS.length].moves; }
function keyOf(pos) { return pos.zobHi + ':' + pos.zobLo; }

/* ---------- 配置构造：难度预设 → cfg（与 Worker 的取值路径一致） ---------- */
function cfgOf(level) {
  return Object.assign({}, SEARCH.difficultyCfg(level, RULE), {
    rule: RULE, overlineMode: 'rif', difficulty: level,
  });
}

/* ---------- 单局 ---------- */
function playGame(cfgA, cfgB, opening, aIsBlack) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const hist = new Map();
  let plies = 0;
  for (const mv of opening) {
    const x = mv[0], y = mv[1];
    if (pos.board[idxOf(x, y)] !== EMPTY) continue;
    core.makeMove(pos, x, y, pos.stm);
    plies++;
  }
  while (plies < MAXPLY) {
    if (pos.stones >= NN) return { winner: 0, plies };
    const k = keyOf(pos);
    const cnt = (hist.get(k) || 0) + 1;
    hist.set(k, cnt);
    if (cnt >= 3) return { winner: 0, plies };
    const stm = pos.stm;
    const cfg = ((stm === BLACK) === aIsBlack) ? cfgA : cfgB;
    SEARCH.ttClear();
    const r = SEARCH.think(pos, cfg);
    if (!r || !r.move) return { winner: 0, plies };
    if (pos.board[idxOf(r.move.x, r.move.y)] !== EMPTY) return { winner: 0, plies };
    core.makeMove(pos, r.move.x, r.move.y, stm);
    plies++;
    if (RU.isWin(pos.board, r.move.x, r.move.y, stm, RULE, 'rif')) return { winner: stm, plies };
  }
  return { winner: 0, plies };
}

/* ---------- 深度量测：该档位在 **自己的时限内** 实际到达几层 ----------
 * 局面来源：固定开局 + 确定性铺子（只保留无立即战术的安静中局，否则 L0/VCF 接管、
 * 根本进不了迭代加深，量不到"搜索深度"）。
 */
function mkRnd(seed) {
  let s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function genPositions(n, probeCfg) {
  const rnd = mkRnd(20260919);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 300) {
    const op = OPENINGS[(out.length * 7 + guard) % OPENINGS.length];
    const pos = core.createPosition();
    SEARCH.attachCache(pos, true);
    let t = BLACK, bad = false;
    for (const mv of op.moves) {
      if (!core.makeMove(pos, mv[0], mv[1], t)) { bad = true; break; }
      t = opp(t);
    }
    if (bad) continue;
    const extra = 8 + Math.floor(rnd() * 10);
    for (let k = 0; k < extra; k++) {
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
      const x = i % N, y = (i / N) | 0;
      core.makeMove(pos, x, y, t);
      if (RU.isWin(pos.board, x, y, t, RULE, 'rif')) { bad = true; break; }
      t = opp(t);
    }
    if (bad) continue;
    // 排除 L0 / 威胁搜索直接接管的局面（否则量到的是 depth=0 的战术着法）
    if (SEARCH.tacticalMove(pos, probeCfg)) continue;
    if (SEARCH.threatSolve(pos, Object.assign({}, probeCfg, { vcfDepth: 8, vctDepth: 6, threatMs: 200 }), Date.now())) continue;
    out.push({ board: pos.board.slice(), stm: pos.stm });
  }
  return out;
}
function measureDepth(cfg, positions) {
  const depths = [], times = [], nodes = [];
  let mates = 0;
  for (const p of positions) {
    SEARCH.ttClear();
    const pos = SEARCH.posFromBoard(p.board, p.stm);
    SEARCH.attachCache(pos, true);
    const t0 = Date.now();
    const r = SEARCH.think(pos, cfg);
    times.push(Date.now() - t0);
    if (!r) continue;
    depths.push(r.depth); nodes.push(r.nodes);
    if (Math.abs(r.score) >= 99999000) mates++;
  }
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  depths.sort((a, b) => a - b);
  return {
    n: depths.length, mean: avg(depths), min: depths[0] || 0,
    med: depths[Math.floor(depths.length / 2)] || 0, max: depths[depths.length - 1] || 0,
    meanMs: Math.round(avg(times)), maxMs: Math.max.apply(null, times.concat([0])),
    meanNodes: Math.round(avg(nodes)), mates: mates,
  };
}

/* ---------- McNemar 精确检验（相邻两档在同一开局的配对胜负） ---------- */
function binomTwoSided(k, n) {
  if (!n) return 1;
  // 精确二项检验：p = 2 * P(X <= k | n, 0.5)，在**较小的一侧**累加，避免下溢
  let sum = 0, c = 1;
  for (let i = 0; i <= n; i++) {
    if (i <= k) sum += c;
    c = c * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * sum / Math.pow(2, n));
}

/* ---------- 主流程 ---------- */
const cfgs = {}, names = LEVELS;
for (const lv of LEVELS) cfgs[lv] = cfgOf(lv);
const T0 = Date.now();
function stamp() { return '[' + ((Date.now() - T0) / 1000).toFixed(0) + 's] '; }

console.log('=== 难度分级标定（§13 / §17.2 / §17.4） ===');
console.log('模式 ' + RULE + '   每对 ' + GAMES + ' 局（同一开局相邻两档各执黑一局）   最大手数 ' + MAXPLY);
for (const lv of LEVELS) {
  const c = cfgs[lv];
  console.log('  ' + lv.padEnd(7) + ' maxDepth=' + c.maxDepth + ' hardLimit=' + c.hardLimit +
    'ms width=' + c.width + ' radius=' + c.radius + ' λ=' + c.lambda +
    ' vcf=' + (c.vcfDepth || 0) + ' vct=' + (c.vctDepth || 0) +
    (c.avoidOpp ? ' avoidOpp' : ''));
}

/* ① 深度量测——必须"排除战术局面"后再比，否则样本集合不同（bench-search 第一版的坑） */
console.log('\n① 时限内实际到达深度（§13「深度」列的标定依据）');
const probeCfg = { maxDepth: 4, hardLimit: 50, width: 14, radius: 2, ttBits: 14, rule: RULE, overlineMode: 'rif' };
const positions = genPositions(MEASURE, probeCfg);
console.log('  量测局面 ' + positions.length + ' 个安静中局（已排除 L0/威胁搜索直接接管者）');
const depthStat = {};
for (const lv of LEVELS) {
  depthStat[lv] = measureDepth(cfgs[lv], positions);
  const s = depthStat[lv];
  console.log('  ' + lv.padEnd(7) + ' 深度均 ' + s.mean.toFixed(2) + '（中位 ' + s.med + '，范围 ' +
    s.min + '–' + s.max + '）  平均 ' + s.meanMs + 'ms / 最慢 ' + s.maxMs + 'ms' +
    '  节点均 ' + s.meanNodes + '  见杀 ' + s.mates + '/' + s.n);
}

/* ② 相邻档位对战 + ③ 显著性 */
function match(cfgA, cfgB) {
  let w = 0, l = 0, d = 0, pliesSum = 0;
  const pairWins = [];        // 逐开局的配对结果（供 McNemar）
  const t0 = Date.now();
  for (let g = 0; g < GAMES; g++) {
    const opening = openingOf(g);
    const aIsBlack = (g % 2 === 0);
    const res = playGame(cfgA, cfgB, opening, aIsBlack);
    pliesSum += res.plies;
    if (res.winner === 0) { d++; pairWins.push(0); }
    else if ((res.winner === BLACK) === aIsBlack) { w++; pairWins.push(1); }
    else { l++; pairWins.push(-1); }
    if ((g + 1) % 10 === 0) {
      console.log('    ' + stamp() + cfgName(cfgA) + ' vs ' + cfgName(cfgB) + '  ' + (g + 1) + '/' + GAMES +
        ' 局：' + w + ' 胜 / ' + l + ' 负 / ' + d + ' 和，' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
    }
  }
  const n = w + l + d;
  let S = Math.min(1 - 1e-6, Math.max(1e-6, (w + 0.5 * d) / n));
  const elo = -400 * Math.log10(1 / S - 1);
  const seS = Math.sqrt(S * (1 - S) / n);
  const seElo = (400 / Math.LN10) * seS / (S * (1 - S));
  return { w: w, l: l, d: d, n: n, S: S, elo: elo, lo: elo - 1.96 * seElo, hi: elo + 1.96 * seElo,
           plies: pliesSum / n, pairA: pairWins, sec: (Date.now() - t0) / 1000 };
}
function cfgName(c) { return c.difficulty || '?'; }

console.log('\n② 相邻档位对战（A = 较强档，Elo(A−B)）');
const pairRes = [];
for (let i = 0; i < LEVELS.length - 1; i++) {
  const strong = LEVELS[i + 1], weak = LEVELS[i];
  console.log('  ' + stamp() + '开始 ' + strong + ' vs ' + weak + '…');
  const r = match(cfgs[strong], cfgs[weak]);
  pairRes.push({ strong: strong, weak: weak, r: r });
  console.log('  ' + strong + ' vs ' + weak + '：' + r.w + ' 胜 / ' + r.l + ' 负 / ' + r.d + ' 和' +
    '   Elo ' + (r.elo >= 0 ? '+' : '') + r.elo.toFixed(1) +
    '  CI [' + r.lo.toFixed(1) + ', ' + r.hi.toFixed(1) + ']' +
    '  平均手数 ' + r.plies.toFixed(1) + '  耗时 ' + r.sec.toFixed(0) + 's  ' +
    (r.lo > 0 ? '★显著强' : r.hi < 0 ? '✗反而更弱' : '不显著'));
}

console.log('\n③ 相邻档位 McNemar 精确检验（配对：同开局两色各一）');
for (const p of pairRes) {
  const pw = p.r.pairA;
  let b = 0, c = 0;                      // b：强档赢下该开局，c：弱档赢下该开局
  for (let g = 0; g < GAMES; g += 2) {
    const s0 = pw[g], s1 = (g + 1 < pw.length) ? pw[g + 1] : 0;
    const net = s0 + s1;                 // +1 强档净胜，-1 弱档净胜，0 打平不计
    if (net > 0) b++; else if (net < 0) c++;
  }
  const disc = b + c;
  const pv = disc ? binomTwoSided(Math.min(b, c), disc) : 1;
  console.log('  ' + p.strong + ' > ' + p.weak + '：胜盘 ' + b + ' / 负盘 ' + c +
    '（判别盘 ' + disc + '）  p = ' + pv.toFixed(4) + '  ' + (pv < 0.05 ? '★显著' : '不显著'));
}

/* ④ 单调性 */
console.log('\n④ 单调性检查（按难度递增，Elo 相对最低档）');
let prev = null, mono = true;
for (let i = 0; i < LEVELS.length; i++) {
  let elo = 0;
  for (let k = 0; k < i; k++) elo += pairRes[k].r.elo;
  console.log('  ' + LEVELS[i].padEnd(7) + ' Elo(相对 ' + LEVELS[0] + ') = ' +
    (elo >= 0 ? '+' : '') + elo.toFixed(1) + '   深度均 ' + depthStat[LEVELS[i]].mean.toFixed(2));
  if (prev !== null && elo <= prev + 1e-9) mono = false;
  prev = elo;
}
console.log('  → ' + (mono ? '★单调递增，档位顺序成立' : '✗存在不单调，需要重排或加大档位间距'));

/* ⑤ 题库（防止调参/标定把杀棋能力改坏） */
console.log('\n⑤ 题库通过率（§17.2 第 1 条，门槛 30/30）');
for (const lv of LEVELS) {
  const cfg = cfgs[lv];
  let pass = 0, viaSolver = 0, viaSearch = 0;
  for (const p of MATES.ATTACK) {
    // ① 正解判据：威胁求解器给出可独立复算的杀法
    const v = V.solveAndVerify(p.stones, p.atk, {
      vcfDepth: cfg.vcfDepth || 20, vcfBudget: cfg.vcfBudget || 300000,
      vctDepth: cfg.vctDepth || 16, vctBudget: cfg.vctBudget || 200000,
      useVct: (cfg.vctDepth || 0) > 0,
    });
    if (v.ok) { pass++; viaSolver++; continue; }
    // ② 兜底：限定深度的纯搜索直接看到杀分（浅档没有威胁搜索时的唯一通路）
    SEARCH.ttClear();
    const q = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), cfg);
    if (q && Math.abs(q.score) >= 99999000) { pass++; viaSearch++; }
  }
  console.log('  ' + lv.padEnd(7) + ' 进攻 ' + pass + '/' + MATES.ATTACK.length +
    '（求解器 ' + viaSolver + ' / 纯搜索 ' + viaSearch + '）');
}
console.log('  注：防守题走 test/mates.test.js；此处只防"标定把杀棋能力改坏"。');

console.log('\n完成。把 ①的深度 与 ②③的 Elo/显著 结论写回设计文档 §13 与 §32。');
