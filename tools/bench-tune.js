/* tools/bench-tune.js — 权重调参（设计 §17.4）
 *
 * 用法：
 *   node tools/bench-tune.js [模式] [每步局数] [最大手数] [步数上限]
 *   默认：freestyle  16 局  60 手  12 步
 *   例： node tools/bench-tune.js freestyle 20 60 10
 *        node tools/bench-tune.js renju     20 60 10
 *
 * 目标函数（§17.4："用自对弈 + 局部搜索标定棋型分值、λ、…"）：
 *   对每个候选参数组 P，跑 **当前基线 B vs P** 的自对弈，取 P 视角胜率。
 *   `fitness(P) = S(P vs B)`（S > 0.5 即候选更强）。这是"爬山"最常用的
 *   "挑战基线"形式：它天然自校准（不像 Elo 需要换算），也不要求固定基线可解。
 *
 * 为什么不是"两个候选互打"：那样每步都要重跑基线，成本翻倍且结论不含基线锚点。
 *
 * 约束（§17.4 + §17.2，**硬性**）：
 *   ① 题库不得退化：候选参数下的题库通过率必须 ≥ 基线（30/30 门槛）；
 *   ② 不破坏长度序不变量：FOUR > OPEN_THREE、SLEEP_THREE > OPEN_TWO、
 *      OPEN_FOUR > DOUBLE_THREE，且 FIVE = OVERLINE = WIN、FORBIDDEN 不可动；
 *   ③ 胜率必须显著（二项检验 p < 0.05）才接受该步——否则只是噪声。
 *
 * ★★ 【必读】每步局数必须与判定门槛匹配，否则本工具**注定返回"未达标"**。
 *   2026-09-19 首次完整跑（freestyle，25 候选 × 4 局/步 ≈117 分钟）实测：
 *     邻域最好候选 S = 0.875 却 p = 0.1250 → 0 个候选达 p<0.05 → 提前收敛。
 *   原因不是参数差，而是**判别力不足**：4 局里 3 胜 1 和（S=0.875）仍 p=0.125；
 *   **4 局全胜才 p = 0.0625，依然过不了 0.05**。也就是说 —— 默认 `GAMES=16`
 *   下，只有当候选**近乎全胜**才可能被接受，任何"中等幅度"的真实改进都会被拒。
 *
 *   所需局数（二项检验，单尾 p<0.05，检出真实胜率 S）：
 *     S = 0.90 → 约 15 局    S = 0.75 → 约 35 局
 *     S = 0.80 → 约 25 局    S = 0.70 → 约 60 局    S = 0.65 → 约 100 局
 *   （S=0.65 ≈ +107 Elo。故"想检出 +100 Elo 量级的调参收益"必须每步 ≥80–100 局。）
 *
 *   ⚠ 成本现实：实测约 **0.1–0.3 局/秒**（随难度档升高而降低）。每步 100 局
 *     ≈ 6–17 分钟；7 个旋钮 × 4 个步长 = 28 个候选/步 → 单步就要 **3–8 小时**。
 *     **故本工具当前形态只适合"验证巨幅改进"或"粗筛"，不适合精细标定。**
 *     提升性价比的正当途径（按优先级）：
 *       ① 先用**小局数**粗筛（如 8 局）淘汰明显更差的候选，只对存活者用大局数确认；
 *       ② 换更快的评估口径（固定较小 `hardLimit` / 较低难度档做基线，缩短单局）；
 *       ③ 减少旋钮（先只调影响最大的一两个，再做逐维细化）；
 *       ④ 提速搜索本体（位棋盘 / 多 Worker）——这也是 §13 "让大师更深"的唯一途径。
 *  *
 * 做法（保证可比，与 bench-elo / bench-difficulty 同范式）：
 *   · 固定开局集：26 种指定开局前 3 手，同一开局**挑战者与基线各执黑一局**；
 *   · 每手落子前清空置换表；三次重复或超手数判和；
 *   · 无随机数，同参数完全可复现。
 *
 * 输出：逐步日志（步号 / 候选 / 胜率 / p 值 / 是否接受）+ 最终参数组，
 *       可直接回写到 engine/patterns.js 的 SINGLE_M / LEVEL_M / λ。
 */
const fs = require('fs');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const OP = require('../engine/data/openings.js');
const V = require('./verify-mate.js');
const MATES = require('../engine/data/mates.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

const RULE = (process.argv[2] || 'freestyle').toLowerCase();
const GAMES = parseInt(process.argv[3] || '16', 10);
const MAXPLY = parseInt(process.argv[4] || '60', 10);
const MAXSTEP = parseInt(process.argv[5] || '12', 10);
if (['freestyle', 'renju'].indexOf(RULE) < 0) throw new Error('模式只能是 freestyle 或 renju');

/* ---------- 基线参数（= §13 的"大师"档，§17.4 要求分别标定 → 用各自模式的强档做基线） ---------- */
const LEVEL = process.env.TUNE_LEVEL || 'master';
function cfgOf() {
  return Object.assign({}, SEARCH.difficultyCfg(LEVEL, RULE), {
    rule: RULE, overlineMode: 'rif', difficulty: LEVEL,
  });
}
const BASE_CFG = cfgOf();

/* ---------- 开局集 ---------- */
const OPENINGS = OP.OPENINGS.map(o => ({ name: o.name, moves: o.moves.map(m => [m.x, m.y]) }));
function openingOf(g) { return OPENINGS[Math.floor(g / 2) % OPENINGS.length].moves; }
function keyOf(pos) { return pos.zobHi + ':' + pos.zobLo; }
function playGame(cfgA, cfgB, opening, aIsBlack) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const hist = new Map();
  let plies = 0;
  for (const mv of opening) {
    if (pos.board[idxOf(mv[0], mv[1])] !== EMPTY) continue;
    core.makeMove(pos, mv[0], mv[1], pos.stm); plies++;
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
    core.makeMove(pos, r.move.x, r.move.y, stm); plies++;
    if (RU.isWin(pos.board, r.move.x, r.move.y, stm, RULE, 'rif')) return { winner: stm, plies };
  }
  return { winner: 0, plies };
}

/* ---------- 目标函数 ---------- */
function duel(candCfg) {
  let w = 0, l = 0, d = 0;
  for (let g = 0; g < GAMES; g++) {
    const aIsBlack = (g % 2 === 0);
    const res = playGame(candCfg, BASE_CFG, openingOf(g), aIsBlack);
    if (res.winner === 0) d++;
    else if ((res.winner === BLACK) === aIsBlack) w++;
    else l++;
  }
  const n = w + l + d;
  return { w: w, l: l, d: d, n: n, S: n ? (w + 0.5 * d) / n : 0.5 };
}

/* 精确二项检验（单侧：挑战者是否显著优于基线） */
function binomP(k, n) {
  if (!n) return 1;
  let sum = 0, c = 1;
  for (let i = 0; i <= n; i++) {
    if (i <= k) sum += c;
    c = c * (n - i) / (i + 1);
  }
  return Math.min(1, sum / Math.pow(2, n));
}

/* ---------- 题库（硬约束①） ---------- */
function matePass(cfg) {
  let pass = 0;
  for (const p of MATES.ATTACK) {
    const v = V.solveAndVerify(p.stones, p.atk, {
      vcfDepth: cfg.vcfDepth || 20, vcfBudget: cfg.vcfBudget || 300000,
      vctDepth: cfg.vctDepth || 16, vctBudget: cfg.vctBudget || 200000,
      useVct: (cfg.vctDepth || 0) > 0,
    });
    if (v.ok) { pass++; continue; }
    SEARCH.ttClear();
    const q = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), cfg);
    if (q && Math.abs(q.score) >= 99999000) pass++;
  }
  return pass;
}

/* ---------- 长度序不变量（硬约束②） ---------- */
function invariantsOk(patch) {
  const m = Object.assign({}, PAT.SINGLE_M, patch.singleM || {});
  const lm = Object.assign({}, PAT.LEVEL_M, patch.levelM || {});
  if (!(m[PAT.P.FOUR] > m[PAT.P.OPEN_THREE])) return 'FOUR 必须 > OPEN_THREE';
  if (!(m[PAT.P.OPEN_THREE] > m[PAT.P.SLEEP_THREE])) return 'OPEN_THREE 必须 > SLEEP_THREE';
  if (!(m[PAT.P.SLEEP_THREE] > m[PAT.P.OPEN_TWO])) return 'SLEEP_THREE 必须 > OPEN_TWO';
  if (!(m[PAT.P.OPEN_FOUR] > m[PAT.P.FOUR])) return 'OPEN_FOUR 必须 > FOUR';
  if (!(m[PAT.P.OPEN_TWO] > m[PAT.P.SLEEP_TWO])) return 'OPEN_TWO 必须 > SLEEP_TWO';
  if (!(lm[PAT.L.FOUR_THREE] > lm[PAT.L.DOUBLE_THREE])) return '四三 必须 > 双活三';
  if (!(lm[PAT.L.DOUBLE_THREE] > lm[PAT.L.FOUR])) return '双活三 必须 > 冲四';
  return null;
}
// λ 走 cfg，不进 patterns.js；单独校验区间
function lambdaOk(v) { return v > 0.5 && v < 1.3; }

/* ---------- 候选生成（爬山邻域） ---------- */
const P = PAT.P;
const BASE_SINGLE = Object.assign({}, PAT.SINGLE_M);
const BASE_LEVEL = Object.assign({}, PAT.LEVEL_M);
const BASE_LAMBDA = BASE_CFG.lambda;

// 可调项：只开放"真值不确定"的几个——活三 / 冲四 / 眠三 / 活二 的相对权重，
// 组合级的双活三 / 四三，以及 λ。连五/长连/禁手**永不开放**。
const KNOBS = [
  { kind: 'singleM', key: P.OPEN_THREE, name: '活三' },
  { kind: 'singleM', key: P.FOUR, name: '冲四' },
  { kind: 'singleM', key: P.SLEEP_THREE, name: '眠三' },
  { kind: 'singleM', key: P.OPEN_TWO, name: '活二' },
  { kind: 'levelM', key: PAT.L.DOUBLE_THREE, name: '双活三' },
  { kind: 'levelM', key: PAT.L.FOUR_THREE, name: '四三' },
  { kind: 'lambda', key: null, name: 'λ' },
];
const STEPS = [0.7, 0.85, 1.18, 1.4];        // 乘性步长（>1 放大，<1 缩小）

function applyPatch(patch) {
  PAT.setTune({ singleM: patch.singleM, levelM: patch.levelM });
}
function clonePatch(p) {
  return { singleM: Object.assign({}, p.singleM), levelM: Object.assign({}, p.levelM),
           lambda: p.lambda };
}
function patchValue(p, knob) {
  if (knob.kind === 'lambda') return p.lambda;
  const src = knob.kind === 'singleM' ? p.singleM : p.levelM;
  const base = knob.kind === 'singleM' ? BASE_SINGLE : BASE_LEVEL;
  return (src && src[knob.key] !== undefined) ? src[knob.key] : base[knob.key];
}
function patchSet(p, knob, v) {
  if (knob.kind === 'lambda') { p.lambda = v; return; }
  const dst = knob.kind === 'singleM' ? p.singleM : p.levelM;
  if (!dst) { if (knob.kind === 'singleM') p.singleM = {}; else p.levelM = {}; }
  (knob.kind === 'singleM' ? p.singleM : p.levelM)[knob.key] = Math.max(1, Math.round(v));
}

/* ---------- 主循环 ---------- */
const T0 = Date.now();
function stamp() { return '[' + ((Date.now() - T0) / 1000).toFixed(0) + 's] '; }

console.log('=== 权重调参（§17.4，模式 = ' + RULE + '） ===');
console.log('基线：' + LEVEL + '  ' + JSON.stringify({ maxDepth: BASE_CFG.maxDepth, hardLimit: BASE_CFG.hardLimit,
  width: BASE_CFG.width, radius: BASE_CFG.radius, lambda: BASE_CFG.lambda,
  vcf: BASE_CFG.vcfDepth, vct: BASE_CFG.vctDepth }));
console.log('每步 ' + GAMES + ' 局（同开局双方各执黑一局）  最大手数 ' + MAXPLY + '  步数上限 ' + MAXSTEP);
console.log('目标函数：候选 vs 基线的胜率（>0.5 更强），接受需 ①显著 p<0.05 ②题库不退化\n');

/* ★ 判别力自检：每步局数太少时，工具**只能接受近乎全胜的候选**，
 *   跑完必然打印"未达标"——那是局数不足，不是参数不好。提前告警，别白跑几小时。
 *   门槛：二项检验下"全胜"的最小 p = 0.5^GAMES，须 < 0.05 ⟹ GAMES ≥ 5。 */
if (GAMES < 5) {
  console.log('  ⛔ 致命：每步 ' + GAMES + ' 局时，**即便候选全胜也过不了 p<0.05**');
  console.log('     （' + GAMES + ' 局全胜的 p = 0.5^' + GAMES + ' = ' + Math.pow(0.5, GAMES).toFixed(4) + '）。');
  console.log('     本跑**不可能**接受任何候选，请提高每步局数后重跑。停止。\n');
  process.exit(2);
}
if (GAMES < 20) {
  console.log('  ⚠ 判别力不足：每步 ' + GAMES + ' 局只能可靠检出 S≥0.9 量级的巨幅改进。');
  console.log('     想检出 S≈0.65（≈+107 Elo）需约 100 局/步（详见本文件头部说明）。');
  console.log('     本次结果若为"未达标"，**不能据此判定参数不好**，只能判定"未检出"。\n');
}

const baseMat = (function () {
  const pinned = BASE_CFG.lambda;
  PAT.resetTune();
  return matePass(BASE_CFG);
})();
console.log(stamp() + '基线题库通过率 ' + baseMat + '/' + MATES.ATTACK.length + '\n');

let cur = { singleM: {}, levelM: {}, lambda: BASE_LAMBDA };
let curWins = 0, curFights = 0;         // 累计"挑战成功"仅作日志
const history = [];

for (let step = 0; step < MAXSTEP; step++) {
  // 逐个旋钮、逐个步长尝试；取第一个通过全部门槛（显著 + 题库不退化 + 不变量）的候选
  let accepted = null;
  for (const knob of KNOBS) {
    for (const f of STEPS) {
      const cand = clonePatch(cur);
      const v0 = patchValue(cur, knob);
      const v1 = knob.kind === 'lambda' ? Math.round(v0 * f * 1000) / 1000
        : Math.max(1, Math.round(v0 * f));
      if (v1 === v0) continue;
      patchSet(cand, knob, v1);
      if (knob.kind === 'lambda' && !lambdaOk(cand.lambda)) continue;
      const bad = invariantsOk(cand);
      if (bad) { console.log(stamp() + '跳过 ' + knob.name + '×' + f + '：' + bad); continue; }

      applyPatch(cand);
      const cc = Object.assign({}, BASE_CFG, { lambda: cand.lambda });
      const mp = matePass(cc);
      if (mp < baseMat) {
        console.log(stamp() + '跳过 ' + knob.name + '×' + f + '：题库 ' + mp + ' < ' + baseMat);
        continue;
      }
      const r = duel(cc);
      const bw = r.l, bl = r.w;                 // 基线视角（McNemar 用较小侧）
      const disc = r.w + r.l;
      const p = disc ? binomP(Math.min(r.w, r.l), disc) : 1;
      console.log(stamp() + knob.name + '×' + f + ' → ' +
        (knob.kind === 'lambda' ? cand.lambda : v1) +
        '：候选 ' + r.w + ' 胜 / ' + r.l + ' 负 / ' + r.d + ' 和  S = ' + r.S.toFixed(3) +
        '  p = ' + p.toFixed(4) + '  题库 ' + mp + '/' + MATES.ATTACK.length);
      if (r.S > 0.5 && p < 0.05) { accepted = { cand: cand, knob: knob, v: v1, r: r, p: p, mp: mp }; break; }
    }
    if (accepted) break;
    PAT.resetTune();                            // 该旋钮无收获 → 复位再试下一个
  }
  if (!accepted) {
    console.log('\n' + stamp() + '第 ' + (step + 1) + ' 步：邻域内无显著更优候选 → 提前收敛');
    break;
  }
  cur = accepted.cand;
  history.push(accepted);
  console.log('  ★ 接受：' + accepted.knob.name + ' → ' +
    (accepted.knob.kind === 'lambda' ? cur.lambda : patchValue(cur, accepted.knob)) +
    '（S = ' + accepted.r.S.toFixed(3) + '，p = ' + accepted.p.toFixed(4) + '）\n');
}

/* ---------- 收敛后与出厂基线做一次"总复算"，避免多步累积的乐观偏差 ---------- */
applyPatch({ singleM: {}, levelM: {} });        // 回到出厂
console.log('\n' + stamp() + '最终候选全量复算（防止逐步调整的累积乐观偏差）');
applyPatch(cur);
const finalCfg = Object.assign({}, BASE_CFG, { lambda: cur.lambda });
const finalMat = matePass(finalCfg);
const big = duel(finalCfg);
const bigP = (big.w + big.l) ? binomP(Math.min(big.w, big.l), big.w + big.l) : 1;

console.log('\n=== 结果（模式 ' + RULE + '） ===');
console.log('出厂参数：' + JSON.stringify({ singleM: BASE_SINGLE, levelM: BASE_LEVEL, lambda: BASE_LAMBDA }));
console.log('调参后　：' + JSON.stringify({ singleM: cur.singleM, levelM: cur.levelM, lambda: cur.lambda }));
console.log('确认对局：' + big.w + ' 胜 / ' + big.l + ' 负 / ' + big.d + ' 和  S = ' + big.S.toFixed(3) +
  '  p = ' + bigP.toFixed(4));
console.log('题库：出厂 ' + baseMat + '/' + MATES.ATTACK.length +
  ' → 调参后 ' + finalMat + '/' + MATES.ATTACK.length);
console.log('判定：' + (big.S > 0.5 && bigP < 0.05
  ? '★显著优于出厂（p<0.05）——可作为合入候选'
  : '无可证提升 —— **照实记录为未达标，不合入**'));
console.log('\n回写方式：把上面 singleM / levelM 并入 engine/patterns.js 的 SINGLE_M / LEVEL_M，');
console.log('          λ 写入该模式难度档的 lambda 字段；然后重跑 test/patterns.test.js 与题库。');

fs.writeFileSync(__dirname + '/../_tune-' + RULE + '.json',
  JSON.stringify({ rule: RULE, level: LEVEL, base: { singleM: BASE_SINGLE, levelM: BASE_LEVEL, lambda: BASE_LAMBDA },
    tuned: cur, confirm: big, p: bigP, baseMate: baseMat, tunedMate: finalMat, steps: history.length }, null, 2), 'utf8');
PAT.resetTune();
