/* tools/bench-book-pos.js —— 开局库 A/B：**从真实对局的中间局面取样**
 *
 * 用法：
 *   node tools/bench-book-pos.js <难度[-i<ms>]> [局数] [最大手数]
 *   例： node tools/bench-book-pos.js hard-i400 400 70
 *
 * ★ 为什么要有这个脚本（不能只用 bench-elo）：
 *   `bench-elo` 固定只用 **26 种开局的前 3 手**起步，且搜索是**确定性**的 ⇒
 *   同一 (开局, 执色) 格子里的多局几乎重复 ⇒ 局之间不独立，有效样本 ≈ 52 个格子，
 *   naive 二项 CI 偏乐观（已在 bench-elo 里补了分层 CI 兜底，但判别力已经丢掉了）。
 *
 *   本脚本改为：**从 RenjuNet 真实对局的第 4~9 手局面随机取样，每个局面只跑 1 局**
 *   ⇒ 局与局来自不同起点 ⇒ **近似独立** ⇒ 有效样本 ≈ 局数，判别力回到 N
 *   （这里 naive 二项 CI 就是可用的那个，另给 bootstrap CI 交叉验证）。
 *
 *   顺带的好处：起点更接近"对手已经偏离定式之后"的真实处境，而不再是"开局标准形"。
 *
 * 取样约束（缺一不入池）：
 *   ① Classic(RIF) 规则；② 该局面尚未出解开胜负（双方都**没有**立即成五点，否则
 *      两个引擎都会走 L0，测不出差异，只增加方差）；③ **开局库确实有这一手可出**
 *      （否则这局根本没用到被测特性，白白稀释效果）；④ 按 hist 前缀去重。
 *
 * 输出：A（开库）视角胜负和、Elo、**二项 95%CI + bootstrap 95%CI**、开局库用药量、逐{N}局滚动快照。
 */
const fs = require('node:fs');
const path = require('node:path');
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');
const BOOK = require('../engine/book.js');
const { EMPTY, BLACK, WHITE, idxOf } = core;

const ROOT = path.join(__dirname, '..');
const JSON_PATH = process.env.RENJUNET_JSON ||
  path.join(ROOT, '..', 'data-raw', 'renjunet-games.json');

/* ---------- 参数 ---------- */
const base = process.argv[2] || 'hard-i400';
const GAMES = parseInt(process.argv[3] || '400', 10);
const MAXPLY = parseInt(process.argv[4] || '70', 10);
const MINP = parseInt(process.env.MINP || '4', 10);       // 取样局面最少已有几手
const MAXP = parseInt(process.env.MAXP || '9', 10);       // 最多几手（须 < cfg.bookPly）
const SEED = parseInt(process.env.SEED || '20260919', 10);

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCfg(str) {
  const parts = String(str).split('-').filter(Boolean);
  const lvl = parts.shift() || 'hard';
  const cfg = { difficulty: lvl, rule: 'freestyle' };
  for (const t of parts) {
    if (/^i\d+$/.test(t)) cfg.hardLimit = parseInt(t.slice(1), 10);
    else if (/^nobook/.test(t)) cfg.useBook = false;
    else if (/^(tree|line|auto)$/.test(t)) cfg.bookModel = t;
    else throw new Error('无法识别配置项：' + t);
  }
  return cfg;
}

/* ★ B 侧口径（env BMODEL）决定这次 A/B 到底在问什么问题：
 *   · nobook（默认）：开库 vs 关库。
 *     ⚠ 判别力天然很差 —— 对手（关库侧）第 5 手起就偏离定式，开库侧随即脱书，
 *       实测**每局只用到 1~2 手书招**，Effect 被稀释到测不出。
 *   · line：**树（胜率选点）vs 线库（频次抽样）**，两侧剂量相同 ⇒ 差异可直接归因到
 *     "选点规则"，这才是本次改动该做的对照。
 */
const A = parseCfg(base);
const BMODEL = process.env.BMODEL || 'nobook';
const B = BMODEL === 'line'
  ? Object.assign({}, A, { bookModel: 'line' })
  : Object.assign({}, A, { useBook: false });
const A_NAME = base + (A.bookModel ? '-' + A.bookModel : ''), B_NAME = base + '-' + BMODEL;

/* ---------- 取样：真实对局的中间局面 ---------- */
const D = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const ruleName = r => D.dicts.rules[String(r)] || String(r);
const allGames = D.games.filter(g => ruleName(g.rule) === 'Classic');

const rnd = mulberry32(SEED);
const pool = [];
const seen = new Set();
for (const g of allGames) {
  const mv = g.moves || [];
  if (mv.length < MAXP + 2) continue;
  const p = MINP + Math.floor(rnd() * (MAXP - MINP + 1));   // 取前 p 手作为真实局面
  const pos = core.createPosition();
  let ok = true;
  for (let k = 0; k < p; k++) {
    const x = mv[k][0], y = mv[k][1];
    if (pos.board[idxOf(x, y)] !== EMPTY) { ok = false; break; }
    core.makeMove(pos, x, y, pos.stm);
  }
  if (!ok) continue;
  const key = pos.hist.join(',');
  if (seen.has(key)) continue;

  // ② 双方都没有立即成五点（有则两引擎都走 L0，测不出差异）
  if (SEARCH.winningPoints(pos.board, BLACK, 0, A.rule).length) continue;
  if (SEARCH.winningPoints(pos.board, WHITE, 0, A.rule).length) continue;

  // ③ 开局库必须确实可为该走子方出一手
  // §12.4.3：现役开局库是前缀树；树不可用时才回落到线库
  const probe = (BOOK.defaultTreeMove && BOOK.defaultTreeMove(pos.hist, {})) ||
    BOOK.defaultMove(pos.hist, { ruleSet: 'freestyle', topK: 8, rnd: function () { return 0; } });
  if (!probe || pos.board[idxOf(probe.x, probe.y)] !== EMPTY) continue;
  /* ★ BMODEL=line 时必须**两侧都有书招**才入池。
   *   否则会出现"A 走书招、B 没书招被迫搜索"的剂量不对称 —— 那测的是"有没有书"，
   *   不是"选点规则好不好"，本次改动的效果会被稀释成测不出。 */
  if (BMODEL === 'line') {
    const pb = BOOK.defaultMove(pos.hist, { ruleSet: 'freestyle', topK: 8, rnd: function () { return 0; } });
    if (!pb || pos.board[idxOf(pb.x, pb.y)] !== EMPTY) continue;
  }

  seen.add(key);
  pool.push({ name: g.openingName || '', hist: pos.hist.slice(), board: pos.board.slice(), stm: pos.stm });
}

// 洗牌后取前 GAMES 个（每个局面只用一次 ⇒ 局间独立）
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
}
const used = pool.slice(0, GAMES);

function keyOf(pos) { return pos.zobHi + ':' + pos.zobLo; }

function playGame(start, aIsBlack) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  pos.board.set(start.board);
  pos.stm = start.stm;
  let stones = 0;
  for (let i = 0; i < 225; i++) if (pos.board[i]) stones++;
  pos.stones = stones;
  pos.hist = start.hist.slice();
  const hist = new Map();
  let plies = 0, bookA = 0, bookB = 0;
  while (plies < MAXPLY) {
    if (pos.stones >= 225) return { winner: 0, plies, why: 'full', bookA, bookB };
    const k = keyOf(pos);
    const cnt = (hist.get(k) || 0) + 1;
    hist.set(k, cnt);
    if (cnt >= 3) return { winner: 0, plies, why: 'repeat3', bookA, bookB };
    const stm = pos.stm;
    const cfg = ((stm === BLACK) === aIsBlack) ? A : B;
    SEARCH.ttClear();
    const r = SEARCH.think(pos, cfg);
    if (r && r.via === 'book') { if ((stm === BLACK) === aIsBlack) bookA++; else bookB++; }
    if (!r || !r.move) return { winner: 0, plies, why: 'nomove', bookA, bookB };
    if (pos.board[idxOf(r.move.x, r.move.y)] !== EMPTY) return { winner: 0, plies, why: 'illegal', bookA, bookB };
    core.makeMove(pos, r.move.x, r.move.y, stm);
    plies++;
    if (RU.isWin(pos.board, r.move.x, r.move.y, stm)) return { winner: stm, plies, why: 'win', bookA, bookB };
  }
  return { winner: 0, plies, why: 'maxplies', bookA, bookB };
}

console.log('=== 开局库 A/B：真实对局中间局面取样（独立起点的 U/Lockey 设计） ===');
console.log('A = ' + A_NAME + '  ' + JSON.stringify(A));
console.log('B = ' + B_NAME + '  ' + JSON.stringify(B));
console.log('候选局面池 ' + pool.length + ' 个，实跑 ' + used.length + ' 局，每条起点只用一次（⇒ 局间独立）');
console.log('取样口径：Classic 规则、前 ' + MINP + '~' + MAXP + ' 手、双方无立即成五点、开局库确有应手\n');

let w = 0, l = 0, d = 0, pliesSum = 0, bkA = 0, bkB = 0;
const scores = [];
const byWhy = {};
const t0 = Date.now();
for (let i = 0; i < used.length; i++) {
  const aIsBlack = rnd() < 0.5;
  const res = playGame(used[i], aIsBlack);
  pliesSum += res.plies; bkA += res.bookA; bkB += res.bookB;
  byWhy[res.why] = (byWhy[res.why] || 0) + 1;
  let sc;
  if (res.winner === 0) { d++; sc = 0.5; }
  else if ((res.winner === BLACK) === aIsBlack) { w++; sc = 1; }
  else { l++; sc = 0; }
  scores.push(sc);
  if ((i + 1) % 25 === 0) {
    const n2 = w + l + d;
    let s2 = Math.min(1 - 1e-6, Math.max(1e-6, (w + 0.5 * d) / n2));
    const e2 = -400 * Math.log10(1 / s2 - 1);
    const se2 = (400 / Math.LN10) * Math.sqrt(s2 * (1 - s2) / n2) / (s2 * (1 - s2));
    console.log('  … ' + (i + 1) + '/' + used.length + ' 局：A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d +
      '，' + ((Date.now() - t0) / 1000).toFixed(0) + 's  |  Elo ' + (e2 >= 0 ? '+' : '') + e2.toFixed(1) +
      '  95%CI [' + (e2 - 1.96 * se2).toFixed(1) + ', ' + (e2 + 1.96 * se2).toFixed(1) +
      ']  书招/局 ' + ((bkA + bkB) / n2).toFixed(2));
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

// bootstrap（对局基本独立 ⇒ 直接重抽 `$scores`）
const br = mulberry32(SEED ^ 0x5bf03635);
const boots = [];
for (let b = 0; b < 2000; b++) {
  let acc = 0;
  for (let k = 0; k < n; k++) acc += scores[Math.floor(br() * n)];
  boots.push(acc / n);
}
boots.sort((x, y) => x - y);
const bLo = -400 * Math.log10(1 / boots[Math.floor(0.975 * boots.length)] - 1);
const bHi = -400 * Math.log10(1 / boots[Math.floor(0.025 * boots.length)] - 1);

console.log('\n结果（A = ' + A_NAME + ' 视角）');
console.log('  A 胜 ' + w + ' / B 胜 ' + l + ' / 和 ' + d);
console.log('  胜率 S = ' + S.toFixed(3) + '   Elo(A−B) = ' + (elo >= 0 ? '+' : '') + elo.toFixed(1));
console.log('  二项 95%CI     [' + lo.toFixed(1) + ', ' + hi.toFixed(1) + ']');
console.log('  bootstrap 95%CI [' + Math.min(bLo, bHi).toFixed(1) + ', ' + Math.max(bLo, bHi).toFixed(1) + ']（2000 次重抽）');
console.log('  平均手数 ' + (pliesSum / n).toFixed(1) + '  结束原因 ' + JSON.stringify(byWhy) +
  '  耗时 ' + dt.toFixed(0) + 's（' + (n / dt).toFixed(2) + ' 局/秒）');
console.log('  开局库用量：A ' + bkA + ' 手 / B ' + bkB + ' 手  合每局 ' + ((bkA + bkB) / n).toFixed(2) + ' 手');
const pick = (Math.min(bLo, bHi), Math.max(bLo, bHi));
const loO = Math.min(lo, Math.min(bLo, bHi)), hiO = Math.max(hi, Math.max(bLo, bHi));
console.log('  判定（两套 CI 取并集）：' + (loO > 0 ? 'A 显著更强' : hiO < 0 ? 'B 显著更强' : '无显著差异') +
  '（并集区间 ' + (loO > 0 || hiO < 0 ? '不含' : '包含') + ' 0）');
