/* tools/gen-book-games.js — 生成「完整棋谱」库 engine/data/book-games.js
 *
 * ★ 与 tools/gen-book-real.js 的区别（那是**旧**的线库生成器）：
 *   旧的 `book-lines.js` 只存**前 10 手**（开局片段，无胜负、无棋手）——适合"看开局频率"，
 *   但**没法当棋谱读**。本脚本改存**完整对局**（平均 40 手），并带上棋手名与结果，
 *   使「棋谱库」成为真正可阅读的资料库；同时每局保留"对齐到开局定义"的前 3 手，
 *   便于与前缀树（开局库）做**前缀关联**（见 ui/booklib.js: relatedGames）。
 *
 * 数据源：https://www.renju.net/game/download/xml/（先经 tools/parse-renjunet.js 解析为 JSON）
 *   ⚠ 许可（源库文件头明示）：仅限**离线 / 非商业**用途；禁止用于任何网站或在线系统。
 *
 * 选取规则（可用 env 覆盖）：
 *   · 只取 **Classic（RIF）** 规则；
 *   · 手数 **≥ MINPLIES（默认 25）**——更短的多是弃权/速败，作为"可读棋谱"价值低；
 *   · 每开局**上限 PEROPEN（默认 40）**，**按源库顺序（约等于年代序）取**——不做"按长度排序"这类
 *     带偏置的挑选，保证样本对局本身是**无偏**的；
 *   · 把每局对齐到开局定义的前 3 手（8 对称之一），保证 `openings.identify(moves[0..3]) === 开局`。
 *
 * 体积（实测 2026-09-22）：RIF+≥25 手共 9291 局；每开局 40 ⇒ **927 局 / 40 832 手**，
 *   packed = 8 + 2n 字符/局 ⇒ **≈ 87 KB**（裸 JSON 约 1.1 MB）⇒ 压到约 1/13。
 *
 * 段格式（每条 = `8 + 2n` 字符，长度字段在前 ⇒ 无需分隔符可流式解码）：
 *   <开局序号 1><手数 2><结果 1><黑名 2><白名 2><每手 2 字符 base36>
 *   手数 2 字符 base36 ⇒ 上限 1295（实际最长 180）；名字 2 字符 ⇒ 上限 1295 个不同棋手（实际 552）。
 *
 * 用法：node tools/gen-book-games.js [输出文件]
 *   默认写 `engine/data/book-games.js`。env：MINPLIES / PEROPEN / RENJUNET_JSON
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'engine', 'data', 'book-games.js');
const MINPLIES = parseInt(process.env.MINPLIES || '25', 10);
const PEROPEN = parseInt(process.env.PEROPEN || '40', 10);

// ★ 原始库（7 MB）刻意放在 gomoku/ 之外：许可禁止随在线系统发布，也不该进可发布目录。
const DB_PATH = process.env.RENJUNET_JSON ||
  path.join(__dirname, '..', '..', 'data-raw', 'renjunet-games.json');
const D = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const OP = require('../engine/data/openings.js');
const N = 15;
const idxOf = (x, y) => y * N + x;

/* 与 openings.js 相同的 8 种对称 */
const SYM = [
  (x, y) => [x, y], (x, y) => [14 - x, y], (x, y) => [x, 14 - y], (x, y) => [14 - x, 14 - y],
  (x, y) => [y, x], (x, y) => [14 - y, x], (x, y) => [y, 14 - x], (x, y) => [14 - y, 14 - x],
];

/* 把整局对齐到开局定义的前 3 手：找使 t[0..2] === 开局定义 的那个对称变换，施加到**全长**。
 * （比"取字典序最小规范形"更稳：直接保证 moves.slice(0,3) 与开局定义逐点相同，
 *  也与 book.test.js / openings.identify 的断言一致。） */
function alignToOpening(mv, o) {
  const want = o.moves.map(m => [m.x, m.y]);
  for (const f of SYM) {
    const t = mv.map(([x, y]) => f(x, y));
    if (want.every((w, k) => t[k] && t[k][0] === w[0] && t[k][1] === w[1])) return t;
  }
  return null;                                       // 前 3 手不匹配任何对称 ⇒ 不是合法开局
}

const ruleName = r => D.dicts.rules[String(r)] || String(r);
const games = D.games.filter(g => ruleName(g.rule) === 'Classic');
console.log('源库 RIF 局数 = ' + games.length);

/* ---------- 选取 ---------- */
const buckets = new Map();          // 开局名 → 对局数组（保持源库顺序）
let tooShort = 0, noOpen = 0, badLen = 0;
for (const g of games) {
  if (!g.moves || g.moves.length < MINPLIES || g.moves.length > 1295) { tooShort++; continue; }
  const head = g.moves.slice(0, 3).map(([x, y]) => idxOf(x, y));
  const o = OP.identify(head);
  if (!o) { noOpen++; continue; }
  const aligned = alignToOpening(g.moves, o);
  if (!aligned) { badLen++; continue; }
  if (!buckets.has(o.name)) buckets.set(o.name, []);
  const arr = buckets.get(o.name);
  if (arr.length < PEROPEN) arr.push({ o: o, mv: aligned, g: g });
}
console.log('排除：手数不足 ' + tooShort + ' / 前 3 手不成开局 ' + noOpen + ' / 对齐失败 ' + badLen);

/* ---------- 棋手名字典 ---------- */
const nameList = [], nameIdx = new Map();
function nid(n) {
  const s = n || '?';
  if (nameIdx.has(s)) return nameIdx.get(s);
  const i = nameList.length;
  if (i >= 1296) throw new Error('名字字典超出 2 字符 base36 上限');
  nameList.push(s); nameIdx.set(s, i);
  return i;
}

/* ---------- 打包 ---------- */
const A36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const c1 = v => A36[v % 36];
const c2 = v => A36[(v / 36) | 0] + A36[v % 36];
const RES = { '1': 0, '0': 1, '0.5': 2 };            // 0 = 黑胜, 1 = 白胜, 2 = 和
const openings = OP.OPENINGS.map(o => o.name);
const openIdx = new Map(openings.map((n, i) => [n, i]));

const entries = [];
for (const name of openings) {                        // 按 26 开局的固定顺序输出
  const arr = buckets.get(name) || [];
  for (const it of arr) {
    const oi = openIdx.get(name);
    if (oi === undefined) throw new Error('未知开局: ' + name);
    const r = RES[String(it.g.bresult)];
    if (r === undefined) throw new Error('未知结果: ' + it.g.bresult);
    const bi = nid(it.g.blackName), wi = nid(it.g.whiteName);
    const mv = it.mv.map(([x, y]) => c2(idxOf(x, y))).join('');
    entries.push({
      opening: name, openingIdx: oi, moves: it.mv,
      result: r, black: it.g.blackName, white: it.g.whiteName,
      sourceId: it.g.id,
    });
  }
}
// 打包串按"开局顺序 + 源库顺序"排列，与 entries 一一对应
const PACKED = entries.map(e => {
  const mv = e.moves.map(([x, y]) => c2(idxOf(x, y))).join('');
  return c1(e.openingIdx) + c2(e.moves.length) + c1(e.result) + c2(nameIdx.get(e.black)) + c2(nameIdx.get(e.white)) + mv;
}).join('');

const totalMoves = entries.reduce((s, e) => s + e.moves.length, 0);
const byRes = [0, 0, 0];
for (const e of entries) byRes[e.result]++;
const avgLen = (totalMoves / entries.length).toFixed(1);
console.log('选取：局数 = ' + entries.length + ' / 26 开局 · 总手数 = ' + totalMoves +
            ' · 平均 ' + avgLen + ' 手 · 结果(黑胜/白胜/和) = ' + byRes.join('/'));
console.log('packed = ' + PACKED.length + ' 字符 ≈ ' + (PACKED.length / 1024).toFixed(1) + ' KB' +
            ' · 名字字典 ' + nameList.length + ' 个');

/* ---------- 输出（UMD，与既有数据文件同风格） ---------- */
const namesJs = JSON.stringify(nameList);
const head = `/* engine/data/book-games.js — 棋谱库（**RenjuNet 真实对局 · 完整棋谱**，tools/gen-book-games.js 生成，请勿手改）
 * 来源：RenjuNet 真实对局数据库（Classic/RIF 规则），**只取 $MINPLIES 手以上**，每开局至多 $PEROPEN 局（按源库顺序，无偏）。
 * 规模：**${entries.length} 局 / 26 开局 · 共 ${totalMoves} 手（平均 ${avgLen} 手）**，含双方棋手与结果。
 * 编码：紧凑串 packed（每局 8 + 2n 字符 ⇒ 约裸 JSON 的 1/13），运行时由 unpack() 还原。
 * 用途：主线程「棋谱」面板的**可阅读棋谱库**；也是「开局库命中 → 相关棋谱」的关联来源。
 *   ⚠ 开局库（前缀树 book-tree.js）由**全量 ${games.length} 局**聚合成边（n/胜率），本库是它的**可读子集**：
 *     · 树回答"这个局面在库里出现过多少次、胜率多少"；
 *     · 本库回答"具体是哪几局、可以点开读"。
 *     两者同源（RenjuNet），口径不同，UI 必须分别标注（见 §12.4.5）。
 * ⚠ 许可：仅限**离线 / 非商业**用途（源库条款禁止用于任何在线系统/网站）。
 * 生成：node tools/gen-book-games.js
 */
`;
const body = `(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.G = root.G || {}; root.G.bookGames = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var NAMES = ${namesJs};
  var OPENINGS = ${JSON.stringify(openings)};
  var PACKED = ${JSON.stringify(PACKED)};
  var META = {
    version: 1, source: 'renjunet', ruleSet: 'rif',
    count: ${entries.length}, games: ${games.length}, totalMoves: ${totalMoves},
    minPlies: ${MINPLIES}, perOpening: ${PEROPEN},
    names: NAMES, openings: OPENINGS, PACKED: PACKED,
  };
  var A36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  var V36 = {}; for (var i = 0; i < 36; i++) V36[A36[i]] = i;
  var v1 = function (ch) { return V36[ch] | 0; };
  var v2 = function (a, b) { return (V36[a] | 0) * 36 + (V36[b] | 0); };
  var _e = null;
  function unpack() {
    if (_e) return _e;
    var out = [], p = 0;
    while (p + 8 <= PACKED.length) {
      var oi = v1(PACKED[p++]);
      var n = v2(PACKED[p], PACKED[p + 1]); p += 2;
      var res = v1(PACKED[p++]);
      var bi = v2(PACKED[p], PACKED[p + 1]); p += 2;
      var wi = v2(PACKED[p], PACKED[p + 1]); p += 2;
      var mv = [];
      for (var k = 0; k < n; k++) { var q = v2(PACKED[p], PACKED[p + 1]); p += 2; mv.push([q % 15, (q / 15) | 0]); }
      out.push({ opening: OPENINGS[oi], openingIdx: oi, moves: mv, n: n,
                 result: res, black: NAMES[bi] || '?', white: NAMES[wi] || '?' });
    }
    return (_e = out);
  }
  Object.defineProperty(META, 'entries', { enumerable: true, get: unpack });
  META.unpack = unpack;
  return META;
});
`;
fs.writeFileSync(OUT, head + body);
console.log('已写出 ' + OUT + '（' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB）');
