/* tools/gen-positions40.js —— 生成局面集（test/data/positions40.json / positions-renjunet.json）
 * 用法：node tools/gen-positions40.js [N=40] [--out=<path>]
 *   N > 200 且未指定 --out 时默认写 positions-renjunet.json（S2 的 1000+ 档）
 * 口径（test-methodology.md §4.2 / verdict-time-budget.md V9，只做一次）：
 *   ① RenjuNet Classic（rule==1）+ 长度 >= PLY+8 手
 *   ② 取第 PLY=13 手后的局面（hist.length=13 >= bookPly=12 ⇒ 开局库自动不命中）
 *   ③ 排除"任一方有立即五连"的局面（否则节点数只反映 L0/VCF，污染 E2）
 *   ④ 排除"任一方有立即 VCF"的局面（同上；小预算"有无"判定）
 *   ⑤ 等距抽稀（避免全部来自同一开局），Zobrist 去重
 * 对 §4.2 骨架的两处 API 修正（实施时核对 engine 源码得出）：
 *   · THREAT.winningPoints 是 board 基：(board, p, mode, rule)，第三参为禁手模式
 *     （search.js:212 的 winningPoints 只是 THREAT 同名函数的别名，非 pos 基包装）
 *   · THREAT.solve/vcfWin 读 o.depth/o.budget（非 vcfDepth/vcfBudget），pos 基；
 *     dfs 全程显式传色、不读 pos.stm ⇒ 同一 pos 可先查 stm 再查 opp 侧
 */
'use strict';
const fs = require('fs'), path = require('path');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const THREAT = require('../engine/threat.js');
const SEARCH = require('../engine/search.js');
const { idxOf, NN, BLACK, WHITE, opp } = core;

const PLY = 13;
let TARGET = 40, OUT = '';
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) OUT = a.slice(6);
  else if (/^\d+$/.test(a)) TARGET = +a;
}
if (!OUT) {
  OUT = path.join(__dirname, '..', 'test', 'data',
    TARGET > 200 ? 'positions-renjunet.json' : 'positions40.json');
}

const RAW = path.join(__dirname, '..', '..', 'data-raw', 'renjunet-games.json');
const games = require(RAW).games.filter(g => g.rule === 1 && g.moves.length >= PLY + 8);
console.log('候选局数（Classic 且 >= ' + (PLY + 8) + ' 手）:', games.length);

const RULE = 'freestyle';                                    // RenjuNet Classic ⇒ freestyle（长连算胜、无禁手）
const MODE_B = PAT.forbidMode(BLACK, RULE, 'rif');           // freestyle 下应为无禁手模式
const MODE_W = PAT.forbidMode(WHITE, RULE, 'rif');
const quick = { depth: 6, budget: 3000, rule: RULE };        // VCF"有无"判定的小预算

function tryGame(g) {                                        // 返回局面对象或 null
  const mv = g.moves.slice(0, PLY);
  const board = new Int8Array(NN);
  for (let k = 0; k < mv.length; k++) {
    board[idxOf(mv[k][0], mv[k][1])] = (k % 2 === 0) ? BLACK : WHITE;
  }
  const stm = (PLY % 2 === 0) ? BLACK : WHITE;               // 第 13 手后轮白
  const pos = SEARCH.posFromBoard(board, stm, mv);
  const zob = pos.zobHi + ':' + pos.zobLo;                   // VCF 前取（dfs 内 make/unmake 会动 zob，配对后恢复）
  // ③ 立即五连（board 基；第三参=禁手模式）
  const modeStm = (stm === BLACK) ? MODE_B : MODE_W;
  const modeOpp = (stm === BLACK) ? MODE_W : MODE_B;
  if (THREAT.winningPoints(board, stm, modeStm, RULE).length) return null;
  if (THREAT.winningPoints(board, opp(stm), modeOpp, RULE).length) return null;
  // ④ 立即 VCF（两侧都查；dfs 不读 pos.stm，复用同一 pos 安全）
  if (THREAT.vcfWin(pos, stm, quick) || THREAT.vcfWin(pos, opp(stm), quick)) return null;
  return { id: g.id, opening: g.opening, openingName: g.openingName, stm, hist: mv, board: Array.from(board), zob };
}

const seen = new Set(), usedIds = new Set(), out = [];
let scanned = 0;
function collect(step) {
  for (let gi = 0; gi < games.length && out.length < TARGET; gi += step) {
    const g = games[gi];
    if (usedIds.has(g.id)) continue;
    scanned++;
    const p = tryGame(g);
    if (!p || seen.has(p.zob)) continue;
    seen.add(p.zob); usedIds.add(g.id);
    delete p.zob;
    out.push(p);
    if (out.length % 100 === 0) console.log('  已收', out.length, '/', TARGET, '（扫', scanned, '局）');
  }
}

const step = Math.max(1, Math.floor(games.length / (TARGET * 30)));
console.log('等距抽稀步长:', step);
collect(step);
if (out.length < TARGET && step > 1) {                       // 兜底：抽稀收不满就细扫补齐（口径不变）
  console.log('第一遍收', out.length, '，改步长 1 补扫…');
  collect(1);
}

if (!out.length) { console.error('✘ 未收集到任何局面'); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(out, null, TARGET > 200 ? 0 : 1); // 大档紧凑（几 MB），小档缩进可读
fs.writeFileSync(OUT, json);
const stmDist = out.reduce((a, p) => (a[p.stm] = (a[p.stm] || 0) + 1, a), {});
console.log('✔ 写出', out.length, '/', TARGET, '个局面 →', OUT,
  '（', (json.length / 1048576).toFixed(2), 'MB ）');
console.log('opening 去重数:', new Set(out.map(p => p.opening)).size, '；stm 分布:', stmDist);
if (out.length < TARGET) console.warn('⚠ 候选池耗尽，只收集到', out.length, '/', TARGET);
