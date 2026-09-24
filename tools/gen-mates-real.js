/* tools/gen-mates-real.js — 从 **RenjuNet 真实对局** 提取深链杀棋题（机器证明）
 *
 * 为什么能做成（旧题源 iwzq 失败的根本原因已消除）：
 *   RenjuNet 的 <move> 直接给 **落子顺序**（空格分隔坐标串），可以逐手重放；
 *   旧题源只有"图面扫描顺序 + 手数编号"，编号并非落子顺序，无法还原 → 只能靠猜。
 *
 * 提取方法（不信任棋谱，只信任证明）：
 *   ① 胜方由棋谱的 `bresult` 定（1 黑胜 / 0 白胜 / 0.5 和，和棋跳过）。
 *      ★ 踩过的坑：曾要求"末手确实成五"——实测 **400 局里只有 6 局（1.5%）**以成五终结，
 *        绝大多数是认输/超时结束，直接把 98% 的棋谱废掉了。改用 bresult 后可用局 10391。
 *   ② 从**最早**的位置 M 起试（M = 前缀子数，下一手颜色由奇偶定）：
 *        · 双方均无成五点（排除"一步杀"与"对方先胜"）；
 *        · 用 TH.vcfWin 求 VCF；
 *        · 再用 tools/verify-mate.js 的**独立复算器**逐手重放验证；
 *   ③ 取最早的 M ⇒ 链最长（越往后离终局越近，链越短）；命中即收，不再往下试。
 *   ④ 默认**黑白双方都扫**：题的有效性只看"轮到谁走 + 该方确有强制 VCF"，
 *      与"他是不是最后的赢家"无关；对局里被错过（或对手没能防住）的杀同样是好题。
 *
 * 收录门槛 `plies >= MINPLIES`（默认 5）：这才是 M5（VCF/VCT）棋力增益能被"测出来"的关键——
 * 现有生成题库 30 题里 28 题只有 2 手，判别力不足。
 *
 * ⚠ 许可（RenjuNet 数据库文件头明示）：
 *   "allowed ... for non-commercial purposes in the forms of OFFLINE databases only.
 *    forbidden to use any contents ... in any website or ONLINE system."
 *   ⇒ 本产物**仅限离线 / 非商业**；如需嵌入在线产品须另行取得授权。
 *
 * 用法： node tools/gen-mates-real.js [目标题数] [最小链长] [最多扫局数] [时限秒] [规则名] [输出文件]
 *   例： node tools/gen-mates-real.js 30 5 0 900 Classic            # 全库扫，最多 900s
 *        node tools/gen-mates-real.js 10 5 400 300 Classic _probe    # 只扫 400 局做探针
 *
 * 默认写到 `engine/data/mates-real.js` **暂存**；确认后 `cp` 覆盖现役文件：
 *   cp engine/data/mates-real.js engine/data/mates.js
 * （现役文件已换为真实版，生成版留档 `mates-generated.js`，需要时可一条 cp 还原。
 *   实测：depth=12/budget=15000 与 depth=20/budget=60000 **产出完全相同**，但快约 3 倍——
 *   扫 1176 局 / 833s 收满 40 题。）
 */
'use strict';
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const RU = require('../engine/rules.js');
const S = require('../engine/search.js');
const V = require('./verify-mate.js');
const fs = require('fs');
const path = require('path');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

const TARGET = parseInt(process.argv[2] || '30', 10);
const MINPLIES = parseInt(process.argv[3] || '5', 10);
const MAXGAMES = parseInt(process.argv[4] || '0', 10);          // 0 = 不限
const TIME_CAP_S = parseInt(process.argv[5] || '900', 10);
const RULE_NAME = process.argv[6] || 'Classic';
const OUT_ARG = process.argv[7] || 'engine/data/mates-real.js';

const VCF_DEPTH = parseInt(process.env.VCF_DEPTH || '20', 10);
const VCF_BUDGET = parseInt(process.env.VCF_BUDGET || '60000', 10);
const MAX_TRIES = parseInt(process.env.MAX_TRIES || '30', 10);   // 每局最多做多少次 vcfWin
const MAX_STONES = parseInt(process.env.MAX_STONES || '40', 10); // 前缀子数上限（受题库格式约束）
const BOTH = process.env.BOTH !== '0';                           // 黑白双方都扫（默认开）

// ★ 原始数据库（7MB）**刻意放在 gomoku/ 之外**（wuzhiqi/data-raw/）：
//   ① 它是 RenjuNet 的原始数据，许可禁止随任何在线系统发布；② 不该进可发布目录白占 7MB。
const SRC = process.env.RENJUNET_JSON ||
  path.join(__dirname, '..', '..', 'data-raw', 'renjunet-games.json');
const DB = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const RULES = DB.dicts.rules;
const WANT_RULE = new Set(Object.keys(RULES).filter(k => RULES[k] === RULE_NAME).map(Number));

console.log('=== 从 RenjuNet 真实对局提取深链杀棋题 ===');
console.log('  目标 ' + TARGET + ' 题，链长 >= ' + MINPLIES + '，规则=' + RULE_NAME +
  '（id ' + [...WANT_RULE].join(',') + '）');
console.log('  vcfWin depth=' + VCF_DEPTH + ' budget=' + VCF_BUDGET +
  '｜每局最多试 ' + MAX_TRIES + ' 个位置｜前缀子数 <= ' + MAX_STONES);

const t0 = Date.now();
const found = [];
const seen = new Set();
let scanned = 0, usable = 0, draws = 0, tries = 0, hitAny = 0;
const histPly = {}, histStones = {}, rejectWhy = {};
let capped = false;

const games = DB.games;
for (let gi = 0; gi < games.length && found.length < TARGET; gi++) {
  if ((gi & 63) === 0 && Date.now() - t0 > TIME_CAP_S * 1000) { capped = true; break; }
  if (MAXGAMES && scanned >= MAXGAMES) break;
  const g = games[gi];
  if (!WANT_RULE.has(g.rule)) continue;
  scanned++;
  if (MAXGAMES && scanned > MAXGAMES) break;
  if (scanned % 500 === 0) {
    console.log('  … 已扫 ' + scanned + ' 局｜收录 ' + found.length + '/' + TARGET +
      '｜vcf 调用 ' + tries + '｜' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }

  /* ---- 重放 ---- */
  const stones = [];
  let p = BLACK, bad = false;
  for (const m of g.moves) {
    const x = m[0], y = m[1];
    if (!(x >= 0 && x < N && y >= 0 && y < N)) { bad = true; break; }
    stones.push([x, y, p]);
    p = core.opp(p);
  }
  if (bad || stones.length < 10) continue;
  if (V.boardOf(stones) === null) continue;               // 有重复落子 → 棋谱不可信，丢弃
  // ★ 胜方来自 bresult（1 黑胜 / 0 白胜 / 0.5 和）。不再要求"末手成五"——那会废掉 98% 的棋谱。
  const winner = g.bresult === 1 ? BLACK : (g.bresult === 0 ? WHITE : 0);
  if (!winner) { draws++; continue; }
  usable++;
  const attackers = BOTH ? [BLACK, WHITE] : [winner];

  /* ---- 从最早位置起找 VCF ---- */
  let nTry = 0;
  let picked = null;
  for (let M = 1; M < stones.length - 1 && nTry < MAX_TRIES; M++) {
    if (M > MAX_STONES) break;
    const atk = (M % 2 === 0) ? BLACK : WHITE;            // 前缀 M 子 → 下一手颜色
    if (attackers.indexOf(atk) < 0) continue;
    const def = core.opp(atk);
    const st = stones.slice(0, M);
    const b = V.boardOf(st);
    if (!b) continue;
    if (TH.hasFivePoint(b, atk) >= 0) continue;           // 一步杀 → 不算题
    if (TH.hasFivePoint(b, def) >= 0) continue;           // 对方先胜 → 局面不成立
    // ★ 预筛（可靠且便宜）：VCF 的首手必须能造四（冲四/活四），一个四都没有 ⇒ 绝无 VCF。
    //   实测这一步把"无望位置"挡掉，单局 vcfWin 次数 -70% 以上（无望位置原来会烧光整个 budget）。
    if (!TH.threatMoves(b, atk, { includeThree: false, radius: 2 }).length) continue;
    nTry++; tries++;
    let r = null;
    try { r = TH.vcfWin(S.posFromBoard(b, atk), atk, { depth: VCF_DEPTH, budget: VCF_BUDGET }); } catch (e) { }
    if (!r) continue;
    histPly[r.plies] = (histPly[r.plies] || 0) + 1;
    hitAny++;
    if (r.plies < MINPLIES) continue;
    const verdict = V.verifyPath(st, atk, r.path, { allowOpenThree: false });
    if (verdict !== 'OK') { rejectWhy[verdict] = (rejectWhy[verdict] || 0) + 1; continue; }
    // 与棋谱自身后续该方着手是否一致（仅作参考：一致=他真走了这条杀；不一致=漏掉的杀）
    const gameAtk = [];
    for (let k = M; k < stones.length; k += 2) gameAtk.push(idxOf(stones[k][0], stones[k][1]));
    const same = r.path.length === gameAtk.length && r.path.every((v, k) => v === gameAtk[k]);
    picked = {
      kind: 'vcf', plies: r.plies, atk: atk,
      stones: st.map(s => [s[0], s[1], s[2]]),
      first: [r.path[0] % N, (r.path[0] / N) | 0],
      path: r.path.map(i => [i % N, (i / N) | 0]),
      source: 'renjunet', gameId: g.id, opening: g.openingName || null,
      startPly: M, same: same, winner: winner,
    };
    break;                                                // 最早 ⇒ 最长，命中即止
  }
  if (!picked) continue;
  const key = picked.atk + '|' + picked.stones.map(s => s[0] + ',' + s[1] + ',' + s[2]).sort().join(';');
  if (seen.has(key)) continue;
  seen.add(key);
  histStones[picked.stones.length] = (histStones[picked.stones.length] || 0) + 1;
  found.push(picked);
}

found.sort((a, b) => b.plies - a.plies || a.stones.length - b.stones.length);

console.log('');
console.log('  扫过 ' + scanned + ' 局（可用 ' + usable + '，和棋跳过 ' + draws + '）' +
  (capped ? '【触发时限提前结束】' : '') + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  vcfWin 调用 ' + tries + ' 次，其中求得杀法 ' + hitAny + ' 次');
console.log('  求得链长分布（全部）: ' + JSON.stringify(histPly));
console.log('  未通过复算的原因: ' + JSON.stringify(rejectWhy));
console.log('  收录 ' + found.length + ' 题（链长 >= ' + MINPLIES + '），前缀子数分布: ' + JSON.stringify(histStones));
for (const f of found.slice(0, 40))
  console.log('    #' + f.gameId + ' ' + String(f.opening || '-').padEnd(6) +
    ' plies=' + f.plies + ' 子数=' + f.stones.length + ' 起始手=' + f.startPly +
    ' atk=' + (f.atk === BLACK ? '黑' : '白') + ' 与棋谱一致=' + f.same);

if (OUT_ARG === '_probe') { console.log('\n（探针模式：不写文件）'); process.exit(0); }

/* ---------- 输出（与 engine/data/mates.js 同格式） ---------- */
const OLD = require('../engine/data/mates.js');            // 防守题沿用已验证的生成题
const hist = {};
for (const f of found) hist['vcf' + f.plies] = (hist['vcf' + f.plies] || 0) + 1;
const outPath = path.join(__dirname, '..', OUT_ARG);
const out = [];
out.push('/* engine/data/' + path.basename(outPath) + ' — 杀棋题库（§35 MateEntry）');
out.push(' * 来源：**RenjuNet 真实对局 + 机器证明**（tools/gen-mates-real.js 生成，可重跑）。');
out.push(' *   数据：https://www.renju.net/game/download/ （' + RULE_NAME + ' 规则，落子顺序已知，可直接重放）。');
out.push(' *   提取：只取"以成五终结"的局；从最早位置起试，要求轮到胜方且双方均无成五点；');
out.push(' *         TH.vcfWin 求解 → tools/verify-mate.js 独立复算器逐手重放验证，通过才收录。');
out.push(' *   门槛：链长 >= ' + MINPLIES + ' 手（现有生成题库 30 题里 28 题仅 2 手，判别力不足）。');
out.push(' *');
out.push(' * ⚠ 许可：RenjuNet 数据库只允许 **离线 / 非商业** 使用，禁止用于任何在线系统或网站。');
out.push(' *   重新生成： node tools/gen-mates-real.js ' + TARGET + ' ' + MINPLIES + ' ' + MAXGAMES + ' ' + TIME_CAP_S + ' ' + RULE_NAME);
out.push(' */');
out.push('(function (root, factory) {');
out.push("  if (typeof module !== 'undefined' && module.exports) module.exports = factory();");
out.push('  else { root.G = root.G || {}; root.G.mates = factory(); }');
out.push("})(typeof globalThis !== 'undefined' ? globalThis : this, function () {");
out.push("  'use strict';");
out.push('  // 进攻题: { kind:\'vcf\'|\'vct\', plies, atk(1黑/2白), stones:[[x,y,c]…], first:[x,y], path:[[x,y]…] 攻方着手(根→叶) }');
out.push('  // 防守题: { kind:\'defense\', plies, atk(我方), opp, stones, safe:[[x,y]…] 全部可行着法, safeCount }');
out.push('  const ATTACK = ' + JSON.stringify(found, null, 1).replace(/\n/g, '\n  ') + ';');
out.push('  const DEFENSE = ' + JSON.stringify(OLD.DEFENSE, null, 1).replace(/\n/g, '\n  ') + ';');
out.push('  const STATS = ' + JSON.stringify({
  attack: found.length, defense: OLD.DEFENSE.length, hist: hist, deep: found.length,
  source: 'renjunet', rule: RULE_NAME, minPlies: MINPLIES, gamesScanned: scanned,
  gamesUsable: usable, gamesDraw: draws, vcfCalls: tries, bothSides: BOTH,
  generatedAt: new Date().toISOString().slice(0, 10),
}) + ';');
out.push('  return { ATTACK, DEFENSE, MATES: ATTACK.concat(DEFENSE), STATS };');
out.push('});');
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
console.log('\n已写 ' + outPath + '（' + (out.join('\n').length / 1024).toFixed(1) + ' KB，' +
  found.length + ' 进攻 + ' + OLD.DEFENSE.length + ' 防守）');
