/* tools/gen-book-tree.js — 生成**前缀匹配树**开局库（§12.4.3）
 *
 * 与旧线库（gen-book-real.js）的模型差别：
 *   旧：存若干条"完整开局线"，按实战**频次**随机抽一条 → 只有频率，没有胜负信息。
 *   新：**前缀树**。节点 = 规范化后的落子前缀；边 = 该前缀下实战出现过的下一手，
 *       携带 (n 出现次数, r 走这一手的一方最终胜率)。
 *   用法（§12.4.3）：从已下 2 手起逐层下探 → 命中约 26 个第 3 手候选 → 看各自胜率，
 *       取收缩估计最高的那个；再以 3 手下探（约 100~200 个候选），以此类推，**直到匹配不上**。
 *
 * ★ 规范化：**每层取 canon(完整前缀) 的最后一个元素**作为边（不是"父 key + 某个 ti"）。
 *   原因与证明见 openings.js 的 canonSeq 注释（稳定子群非平凡时后一种做法会让同形分家）。
 *
 * ★ 胜负归属：第 p 手（0 基）由黑走 ⇔ p 为偶 ⇒ 该手一方的胜率 = bresult；否则 = 1 − bresult。
 *
 * 编码（紧凑串，DFS 先序，运行时线性解码）：
 *   节点 := <子节点数 2 字符>  ×  (边 := <着法 idx 2 字符><n 2 字符><胜率×1295 2 字符> 子树)
 *   共 6 字符/边 + 2 字符/节点。n 截断到 1295（收缩系数 K≈12 时早已饱和，无信息损失）。
 *
 * ⚠ 许可（RenjuNet 数据库文件头明示）：仅**离线 / 非商业**用途，禁止用于任何在线系统。
 *
 * 用法：node tools/gen-book-tree.js [maxDepth=12] [minLeaf=2] [输出文件]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAXD = +(process.argv[2] || 12);
const MINLEAF = +(process.argv[3] || 2);
const OUT = process.argv[4] || path.join(__dirname, '..', 'engine', 'data', 'book-tree.js');

// ★ 原始数据库（7MB）刻意放在 gomoku/ 之外（wuzhiqi/data-raw/）：许可禁止随在线系统发布
const DB_PATH = process.env.RENJUNET_JSON ||
  path.join(__dirname, '..', '..', 'data-raw', 'renjunet-games.json');
const D = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const OP = require('../engine/data/openings.js');
const N = 15, idxOf = (x, y) => y * N + x;

/* ---------- 1. 建树 ---------- */
const root = { n: 0, s: 0, ch: new Map() };       // 根：前缀为空，ch 即"第 1 手"候选
const ruleName = r => D.dicts.rules[String(r)] || String(r);
const games = D.games.filter(g => ruleName(g.rule) === 'Classic');
let used = 0, noResult = 0;

for (const g of games) {
  const mv = g.moves || [], R = g.bresult;
  if (R == null) { noResult++; continue; }
  if (!mv.length) continue;
  used++;
  const lim = Math.min(mv.length, MAXD);
  const seq = [];
  let node = root;
  for (let p = 0; p < lim; p++) {
    seq.push(idxOf(mv[p][0], mv[p][1]));
    const c = OP.canonSeq(seq);                     // ★ 每层取"整段前缀的规范形"
    const m = c.arr[c.arr.length - 1];              // 该层要走的那一手（规范坐标系）
    const outc = (p % 2 === 0) ? R : (1 - R);       // 走这一手的一方，其胜率
    let e = node.ch.get(m);
    if (!e) { e = { n: 0, s: 0, ch: new Map() }; node.ch.set(m, e); }
    e.n++; e.s += outc;
    node = e;                                       // 下探（可拼接性由 canonSeq 注释保证）
  }
}

/* ---------- 2. 剪枝（n < MINLEAF 的边连同其子树删除）----------
 * ★ 分层门槛：越深的节点越具体、越该要求更多证据，故 `depth >= DEEP_FROM` 起用 DEEP_LEAF。
 *   同时这是**体积杠杆**——深层边占了大头（depth≥6 有 3900+ 条），抬高门槛能省一半字节。
 */
const DEEP_FROM = +(process.env.DEEP_FROM || 6);
const DEEP_LEAF = +(process.env.DEEP_LEAF || MINLEAF);
const leafAt = d => (d >= DEEP_FROM ? DEEP_LEAF : MINLEAF);
let nodes = 0, edges = 0;
const depthNodes = {}, depthEdges = {}, depthN = {};
function prune(node, d) {
  const kids = [...node.ch.entries()]
    .filter(kv => kv[1].n >= leafAt(d))
    .sort((a, b) => b[1].n - a[1].n || a[0] - b[0]);   // 稳定：频次降序
  node.ch = new Map(kids);
  nodes++; edges += kids.length;
  depthNodes[d] = (depthNodes[d] || 0) + 1;
  depthEdges[d] = (depthEdges[d] || 0) + kids.length;
  depthN[d] = (depthN[d] || 0) + kids.reduce((s, k) => s + k[1].n, 0);
  for (const [, e] of kids) prune(e, d + 1);
}
prune(root, 0);

/* ---------- 3. 编码 ---------- */
const A36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const c2 = v => A36[(v / 36) | 0] + A36[v % 36];
const out = [];
// 边需要 (move, n, r)：move 是 Map 的 **key**，n/r 在 value 上 ⇒ 必须 entries() 而不是 values()
function enc2(node) {
  const kids = [...node.ch.entries()];
  out.push(c2(kids.length));
  for (const [m, e] of kids) {
    const n = Math.min(1295, e.n);
    const r = Math.min(1295, Math.round(e.s / e.n * 1295));
    out.push(c2(m), c2(n), c2(r));
  }
  for (const [, e] of kids) enc2(e);                 // ★ 先写完本层所有边，再逐个递归
}
enc2(root);
const PACKED = out.join('');

/* ---------- 4. 组装（含运行时解码器）---------- */
const meta = {
  version: 1,
  kind: 'prefix-tree',
  ruleSet: 'rif',
  source: 'renjunet — real games from https://www.renjunet.net/game/download/xml/ (Classic rule)',
  license: 'OFFLINE / non-commercial only per source database terms',
  config: { maxDepth: MAXD, minLeaf: MINLEAF, deepFrom: DEEP_FROM, deepLeaf: DEEP_LEAF,
            canonicalized: true, packed: true, rateScale: 1295, nCap: 1295 },
  generatedAt: new Date().toISOString(),
  sourceGames: used,
  nodes: nodes, edges: edges,
};

const head =
  '/* engine/data/book-tree.js — 开局库**前缀匹配树**（tools/gen-book-tree.js 生成，请勿手改）\n' +
  ' * 来源：RenjuNet 真实对局（Classic/RIF ' + used + ' 局），8 种对称归一（openings.canonSeq）。\n' +
  ' * 结构：节点 = 规范化落子前缀；边 = 该前缀下实战出现过的下一手，含 (n 频次, r 胜率)。\n' +
  ' * 用法：从已下 2 手起逐层下探，取胜率收缩估计最高的一手，**直到匹配不上**为止（§12.4.3）。\n' +
  ' * 参数：maxDepth=' + MAXD + '  minLeaf=' + MINLEAF + '（depth≥' + DEEP_FROM + ' 起 ' + DEEP_LEAF +
  '）  → 节点 ' + nodes + ' / 边 ' + edges + '\n' +
  ' * 编码：DFS 先序紧凑串 base36（6 字符/边 + 2 字符/节点），运行时由 unpack() 线性解码。\n' +
  ' * ⚠ 许可：仅限**离线 / 非商业**用途（源库条款禁止用于任何在线系统/网站）。\n' +
  ' * 生成：node tools/gen-book-tree.js ' + MAXD + ' ' + MINLEAF + '\n' +
  ' */\n';

const body = head +
  '(function (root, factory) {\n' +
  "  if (typeof module !== 'undefined' && module.exports) module.exports = factory();\n" +
  '  else { root.G = root.G || {}; root.G.bookTree = factory(); }\n' +
  "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n" +
  "  'use strict';\n" +
  '  var PACKED = ' + JSON.stringify(PACKED) + ';\n' +
  '  var A36 = ' + JSON.stringify(A36) + ';\n' +
  '  var META = ' + JSON.stringify(meta) + ';\n' +
  '  var RS = 1295;\n' +                                  // 胜率量化刻度
  '  var _t = null;\n' +
  '  /** 解码：节点 = Map(着法idx → {n, r, c})；r 为走该手一方的历史胜率，c 为子树 */\n' +
  '  function unpack() {\n' +
  '    if (_t) return _t;\n' +
  '    var v = {};\n' +
  '    for (var k = 0; k < A36.length; k++) v[A36[k]] = k;\n' +
  '    var p = 0;\n' +
  '    function rd2() { var a = v[PACKED[p++]] * 36 + v[PACKED[p++]]; return a; }\n' +
  '    function node() {\n' +
  '      var cnt = rd2(), c = new Map(), kids = new Array(cnt), e, i2;\n' +
  '      for (var i = 0; i < cnt; i++) { var m = rd2(), n = rd2(), r = rd2(); e = { n: n, r: r / RS, c: null }; c.set(m, e); kids[i] = e; }\n' +
  '      for (i2 = 0; i2 < cnt; i2++) kids[i2].c = node();   // ★ 本层边读完后再递归，指针才对得上\n' +
  '      return c;\n' +
  '    }\n' +
  '    return (_t = node());\n' +
  '  }\n' +
  '  Object.defineProperty(META, \'tree\', { get: unpack, enumerable: true });\n' +
  '  META.unpack = unpack; META.PACKED = PACKED;\n' +
  '  return META;\n' +
  '});\n';
fs.writeFileSync(OUT, body);

/* ---------- 5. 报告 ---------- */
console.log('=== 前缀匹配树开局库 ===');
console.log('  Classic 局数 ' + games.length + '   采用 ' + used + '   无结果 ' + noResult +
  '   maxDepth=' + MAXD + ' minLeaf=' + MINLEAF);
console.log('  剪枝后：节点 ' + nodes + '   边 ' + edges + '  （minLeaf=' + MINLEAF +
  '，depth≥' + DEEP_FROM + ' 起 ' + DEEP_LEAF + '）' +
  '   packed ' + (PACKED.length / 1024).toFixed(1) + ' KB' +
  '   文件 ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log('');
console.log('  深度 = 已下手数（该层节点给出"下一手"的候选）：');
console.log('   深度   节点    候选    总局数   平均每候选局数');
for (const d of Object.keys(depthNodes).map(Number).sort((a, b) => a - b)) {
  const avg = (depthN[d] / Math.max(1, depthEdges[d])).toFixed(0);
  console.log('   ' + String(d).padStart(3) + String(depthNodes[d]).padStart(7) +
    String(depthEdges[d]).padStart(8) + String(depthN[d]).padStart(10) + String(avg).padStart(13));
}
console.log('\n  已写出: ' + OUT);
