/* tools/gen-book-real.js — 用 **RenjuNet 真实对局** 生成开局库（替换 AI 生成的 book-lines.js）
 *
 * 数据源：https://www.renju.net/game/download/xml/  （先经 tools/parse-renjunet.js 解析）
 *   实测 2026-09-18 版：可解析 16533 局，其中 **Classic（RIF）规则 11522 局** —— 本脚本只取 Classic。
 *
 * 方法：
 *   1) 取每局前 `maxPlies` 手（默认 8，与现有 book-lines.js 对齐）；
 *   2) 用**前 3 手**经 openings.js 的 `canonKey`（8 种对称规范形）匹配到 26 种开局之一；
 *      —— 必须归一化，否则同一开局的镜像/旋转变体会分散频率，Top-N 会被变体占满；
 *   3) 按「规范化的完整前 N 手序列」统计出现次数 → weight；
 *   4) 每个开局保留出现最多的 `perOpening` 条（默认 6）。
 *
 * ★ 与旧库（tools/gen-book.js，AI 自对弈生成）的区别：
 *   旧库 source='generated'，是引擎自己搜出来的着法；本库 source='renjunet'，是**人类职业/业余对局的
 *   实战频率**——更贴近"人类会怎么走"，用于开局推荐与迷惑性更合理。
 *
 * ⚠ 许可（RenjuNet 数据库文件头明示）：
 *   "allowed ... for non-commercial purposes in the forms of OFFLINE databases only.
 *    forbidden to use any contents ... in any website or ONLINE system."
 *   ⇒ 产物仅限**离线 / 非商业**用途；若要嵌入在线产品须另行取得授权。文件头已注明来源。
 *
 * 用法：node tools/gen-book-real.js [maxPlies=8] [perOpening=6] [输出文件]
 *   默认写到 `engine/data/book-lines-real.js` **暂存**；确认后 `cp` 覆盖现役文件：
 *     cp engine/data/book-lines-real.js engine/data/book-lines.js
 *   （现役文件已换为真实版，AI 生成版留档 `book-lines-generated.js`，需要时可一条 cp 还原。）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAXPLIES = +(process.argv[2] || 8);
const PEROPEN = +(process.argv[3] || 6);
const OUT = process.argv[4] || path.join(__dirname, '..', 'engine', 'data', 'book-lines-real.js');

// ★ 原始数据库（7MB）**刻意放在 gomoku/ 之外**（wuzhiqi/data-raw/）：
//   ① 它是 RenjuNet 的原始数据，许可禁止随任何在线系统发布；② 不该进可发布目录白占 7MB。
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
// ⚠ 坑：键必须按**数值**比较。曾写成 idx.join(',') 后直接比字符串，
//    "112,111,128" < "112,97,128"（'1'<'9'）→ 选错对称像 → 前 3 手与开局定义不符（book.test.js 挂）。
const keyOf = mv => mv.map(([x, y]) => String(idxOf(x, y)).padStart(3, '0')).join(',');
function canonMoves(mv) {
  let best = null, bestK = null;
  for (const f of SYM) {
    const t = mv.map(([x, y]) => f(x, y));
    const k = keyOf(t);
    if (bestK === null || k < bestK) { bestK = k; best = t; }
  }
  return best;
}
// 把整条线对齐到开局定义的前 3 手：找使 t[0..2] === 开局定义的那个对称变换并施加到全长。
// （比"取字典序最小规范形"更稳：直接保证 e.moves.slice(0,3) === o.moves，与 book.test.js 的断言一致。）
function alignToOpening(mv, o) {
  const want = o.moves.map(m => [m.x, m.y]);
  for (const f of SYM) {
    const t = mv.map(([x, y]) => f(x, y));
    if (want.every((w, k) => t[k] && t[k][0] === w[0] && t[k][1] === w[1])) return t;
  }
  return mv;
}

/* 26 种开局 → 规范键 索引 */
const openByKey = new Map();
for (const o of OP.OPENINGS) openByKey.set(OP.canonKey(o.idx), o);

const ruleName = r => D.dicts.rules[String(r)] || String(r);
const games = D.games.filter(g => ruleName(g.rule) === 'Classic');

/* 统计 */
const buckets = new Map();      // openingName → Map(seqKey → {mv, n})
let used = 0, tooShort = 0, noOpen = 0;
for (const g of games) {
  if (g.moves.length < Math.max(3, MAXPLIES)) { tooShort++; continue; }
  const head = g.moves.slice(0, MAXPLIES);
  // 前 3 手定位开局（规范形）
  const o = openByKey.get(OP.canonKey(head.slice(0, 3).map(([x, y]) => idxOf(x, y))));
  if (!o) { noOpen++; continue; }
  const cm = alignToOpening(canonMoves(head), o);
  const key = keyOf(cm);
  if (!buckets.has(o.name)) buckets.set(o.name, new Map());
  const b = buckets.get(o.name);
  if (!b.has(key)) b.set(key, { mv: cm, n: 0 });
  b.get(key).n++;
  used++;
}

/* 组装：★ 覆盖率自适应选取（替代固定 Top-N）
 *   固定 Top-6 的毛病：**冷门开局全是 weight=1 的噪声**（如花月/彗星 6 条全是 1），
 *   而热门开局却漏掉大量实战数据（瑞星 2308 局只取到约 1966）。
 *   改为：按频次降序累加，**覆盖到该开局总局数的 coverage 比例即止**（上限 cap 条）。
 */
const COVER = parseFloat(process.env.COVER || '0.9');
const CAP = parseInt(process.env.CAP || '24', 10);
const entries = [];
for (const [name, b] of buckets) {
  const all = [...b.values()].sort((p, q) => q.n - p.n);
  const totalN = all.reduce((s, t) => s + t.n, 0);
  let acc = 0, take = 0;
  for (const t of all) {
    if (take >= CAP) break;
    if (acc >= totalN * COVER && take >= 1) break;      // 已覆盖足够比例 ⇒ 尾巴是噪声，不收
    acc += t.n; take++;
  }
  for (const t of all.slice(0, take))
    entries.push({ ruleSet: 'rif', opening: name, moves: t.mv, weight: t.n, source: 'renjunet' });
}
entries.sort((a, c) => (a.opening < c.opening ? -1 : a.opening > c.opening ? 1 : c.weight - a.weight));

/* ---------- 紧凑编码（★ 直面 volume 约束：worker bundle 上限 200 KB）----------
 * 裸 JSON 每条线 ~138 字节（`{"ruleSet":"rif","opening":"疏星局","moves":[[7,7],…],…}`）；
 * 压到 **2n+5 字符/条**（8 手 = 21 字符），**体积约 1/7**，省出的空间正好拿来装更多实战数据。
 * 段格式： <开局序号 1 字符><手数 1 字符><每手 2 字符 base36><权重 3 字符 base36>
 *   长度字段在前 ⇒ 无需分隔符即可流式解码。
 */
const A36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const c1 = v => A36[v];
const c2 = v => A36[(v / 36) | 0] + A36[v % 36];
const names = OP.OPENINGS.map(o => o.name);
const nameIdx = new Map(names.map((n, i) => [n, i]));
const PACKED = entries.map(e => {
  const ni = nameIdx.get(e.opening);
  if (ni === undefined) throw new Error('未知开局名: ' + e.opening);
  const mv = e.moves.map(([x, y]) => c2(idxOf(x, y))).join('');
  const w = Math.min(46655, e.weight);                      // 3 字符 base36 上限 = 36^3-1
  const w3 = A36[(w / 1296) | 0] + A36[((w / 36) | 0) % 36] + A36[w % 36];
  return c1(ni) + c1(e.moves.length) + mv + w3;
}).join('');

const payload = {
  version: 2,
  ruleSet: 'rif',
  source: 'renjunet — real games from https://www.renju.net/game/download/xml/ (Classic rule)',
  license: 'OFFLINE / non-commercial only per source database terms',
  config: { maxPlies: MAXPLIES, cover: COVER, cap: CAP, canonicalized: true, packed: true },
  generatedAt: new Date().toISOString(),
  sourceGames: used,
  count: entries.length,
  names: names,
};

const head = '/* engine/data/book-lines' + (OUT.indexOf('generated') >= 0 ? '-generated' : '') +
  '.js — 开局库数据（**RenjuNet 真实对局**版，tools/gen-book-real.js 生成，请勿手改）\n' +
  ' * 来源：RenjuNet 真实对局数据库（Classic/RIF 规则 ' + used + ' 局），前 ' + MAXPLIES + ' 手，8 种对称归一。\n' +
  ' * 选取：按实战频次降序累加至覆盖 ' + (COVER * 100).toFixed(0) + '%（每条开局上限 ' + CAP + ' 条）→ ' +
  entries.length + ' 条。\n' +
  ' * 编码：**紧凑串** packed（每条 2n+5 字符，约裸 JSON 的 1/7），运行时由 unpack() 还原为 entries。\n' +
  ' * ⚠ 许可：仅限**离线 / 非商业**用途（源库条款禁止用于任何在线系统/网站）。\n' +
  ' * 生成：node tools/gen-book-real.js ' + MAXPLIES + ' ' + PEROPEN + '\n' +
  ' */\n';
const body = head +
  '(function (root, factory) {\n' +
  "  if (typeof module !== 'undefined' && module.exports) module.exports = factory();\n" +
  '  else { root.G = root.G || {}; root.G.bookLines = factory(); }\n' +
  "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n" +
  "  'use strict';\n" +
  '  var PACKED = ' + JSON.stringify(PACKED) + ';\n' +
  '  var NAMES = ' + JSON.stringify(names) + ';\n' +
  '  var A36 = ' + JSON.stringify(A36) + ';\n' +
  '  var META = ' + JSON.stringify(payload) + ';\n' +
  '  var _e = null;\n' +
  '  function unpack() {\n' +
  '    if (_e) return _e;\n' +
  '    var v = {};\n' +
  '    for (var k = 0; k < A36.length; k++) v[A36[k]] = k;\n' +
  '    var out = [], p = 0;\n' +
  '    while (p + 2 <= PACKED.length) {\n' +
  '      var o = v[PACKED[p++]], n = v[PACKED[p++]], mv = [];\n' +
  '      for (var k2 = 0; k2 < n; k2++) { var i = v[PACKED[p]] * 36 + v[PACKED[p + 1]]; p += 2; mv.push([i % 15, (i / 15) | 0]); }\n' +
  '      var w = v[PACKED[p]] * 1296 + v[PACKED[p + 1]] * 36 + v[PACKED[p + 2]]; p += 3;\n' +
  '      out.push({ ruleSet: \'rif\', opening: NAMES[o], moves: mv, weight: w, source: \'renjunet\' });\n' +
  '    }\n' +
  '    return (_e = out);\n' +
  '  }\n' +
  '  Object.defineProperty(META, \'entries\', { get: unpack, enumerable: true });\n' +
  '  META.unpack = unpack; META.PACKED = PACKED;\n' +
  '  return META;\n' +
  '});\n';
fs.writeFileSync(OUT, body);

console.log('=== 真实对局开局库生成 ===');
console.log('  Classic 局数: ' + games.length + '   采用: ' + used + '   过短: ' + tooShort + '   前3手非标准开局: ' + noOpen);
console.log('  开局种类: ' + buckets.size + '   产出线条: ' + entries.length + '（覆盖 ' + (COVER * 100).toFixed(0) + '% / 上限 ' + CAP + '）');
console.log('  packed ' + (PACKED.length / 1024).toFixed(1) + ' KB（裸 JSON 约 ' +
  (JSON.stringify(entries).length / 1024).toFixed(1) + ' KB，压缩比 ' +
  (JSON.stringify(entries).length / PACKED.length).toFixed(1) + '×）');
console.log('  已写出: ' + OUT + '  (' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
console.log('');
console.log('  每种开局保留条数 / 该开局总局数（覆盖 ' + (COVER * 100).toFixed(0) + '%）:');
for (const [name, b] of [...buckets].sort()) {
  const all = [...b.values()].sort((p, q) => q.n - p.n);
  const totalN = all.reduce((s, t) => s + t.n, 0);
  let acc = 0, take = 0;
  for (const t of all) { if (take >= CAP) break; if (acc >= totalN * COVER && take >= 1) break; acc += t.n; take++; }
  console.log('    ' + name.padEnd(8) + String(take).padStart(3) + ' 条 / 总局 ' + String(totalN).padStart(5) +
    '   频次 ' + all.slice(0, 4).map(t => t.n).join('/') + (all.length > 4 ? '/…' : ''));
}
