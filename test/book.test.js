/* test/book.test.js — 开局库格式 / 解析 / 索引 / 查询 可用性验证
 *   · 前半：棋谱解析 + **线库**（BookLine 格式，v3.22 起退役，Node 侧仍保留供校验/工具使用）
 *   · 后半：§12.4.3 **前缀匹配树**（现役开局库，按实战胜率选点）
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const OP = require('../engine/data/openings.js');
const BOOK = require('../engine/book.js');
const DATA = require('../engine/data/book-lines.js');       // 退役的线库（仅 Node 侧）
const TREE = require('../engine/data/book-tree.js');        // §12.4.3 现役：前缀匹配树

const { EMPTY, BLACK, WHITE, idxOf, NN } = core;
const idx = (x, y) => idxOf(x, y);

test('棋谱解析：Renju 记谱', () => {
  const r = BOOK.parseRecord('1.H8 2.I9 3.I7');
  assert.ok(r.ok);
  assert.equal(r.mode, 'renju');
  assert.deepEqual(r.moves, [[7, 7], [8, 6], [8, 8]]);
});

test('棋谱解析：坐标对（0 基 / 1 基自动嗅探）', () => {
  assert.deepEqual(BOOK.parseRecord('0,0 1,0').moves, [[0, 0], [1, 0]]);   // 含 0 → 0 基
  assert.deepEqual(BOOK.parseRecord('8,8 8,7').moves, [[7, 7], [7, 6]]);   // 无 0 → 1 基
  assert.equal(BOOK.parseRecord('H8 X9').ok, false);                       // 非法标记
});

test('Line 校验：越界 / 重复', () => {
  assert.equal(BOOK.validateLine({ moves: [[7, 7], [7, 6], [8, 6]] }), null);
  assert.equal(BOOK.validateLine({ moves: [[7, 7], [7, 6], [8, 15]] }), 'E_RANGE');
  assert.equal(BOOK.validateLine({ moves: [[7, 7], [7, 7], [8, 6]] }), 'E_OCCUPIED');
  assert.equal(BOOK.validateLine({ moves: [[7, 7]] }), 'E_LINE');
});

test('索引与查询：花月开局第 4 手可命中', () => {
  const entries = [{ ruleSet: 'freestyle', opening: '花月局', moves: [[7, 7], [7, 6], [8, 6], [6, 7]], weight: 1 }];
  const { index, rejected } = BOOK.build(entries);
  assert.equal(rejected.length, 0);
  const hit = BOOK.bookMove(index, [idx(7, 7), idx(7, 6), idx(8, 6)], { rnd: () => 0.01 });
  assert.ok(hit, '应命中候选');
  assert.ok([6, 8].includes(hit.x) && hit.y === 7 || true, '坐标应合法');
  assert.equal(hit.x, 6); assert.equal(hit.y, 7);
});

test('对称：镜像前缀命中镜像着法', () => {
  const entries = [{ ruleSet: 'freestyle', opening: 'X', moves: [[7, 7], [7, 6], [8, 6], [6, 7]], weight: 1 }];
  const { index } = BOOK.build(entries);
  // 前缀左右镜像：H8(7,7) H9(7,6) → 查询时命中 (6,7) 的镜像 (8,7)
  const hit = BOOK.bookMove(index, [idx(7, 7), idx(7, 6), idx(8, 6)], { rnd: () => 0.5 });
  assert.ok(hit && [6, 8].includes(hit.x), '应为 6 或 8（含镜像）');
});

test('生成数据：全部合法且以开局 3 手起手', () => {
  assert.ok(DATA.entries.length > 0, '应有数据');
  let checked = 0;
  for (const e of DATA.entries) {
    assert.equal(BOOK.validateLine(e), null, e.opening + ' 应合法');
    const o = OP.OPENINGS.find(x => x.name === e.opening);
    assert.ok(o, '开局名应有效: ' + e.opening);
    assert.deepEqual(e.moves.slice(0, 3), o.moves.map(m => [m.x, m.y]), e.opening + ' 前 3 手应等于开局定义');
    checked++;
  }
  assert.equal(checked, DATA.entries.length);
});

test('生成数据：索引可查 + 返回空点', () => {
  const { index } = BOOK.build(DATA.entries);
  const op = OP.OPENINGS.find(x => x.name === '花月局');
  const hist = op.idx.slice();
  const hit = BOOK.bookMove(index, hist, { ruleSet: 'freestyle', rnd: () => 0.42 });
  assert.ok(hit, '生成库应能命中');
  const board = new Int8Array(NN);
  for (const i of hist) board[i] = 1;
  assert.equal(board[idx(hit.x, hit.y)], EMPTY, '返回点应为空点');
});

test('棋谱解析 → 入库 → 查询 全链路', () => {
  const r = BOOK.parseRecord('1.H8 2.H9 3.I9 4.G7 5.I7');
  assert.ok(r.ok);
  const { index } = BOOK.build([{ ruleSet: 'freestyle', opening: '花月局', moves: r.moves, weight: 1 }]);
  const hist = BOOK.historyIdxsOf(r.moves.slice(0, 3));
  const hit = BOOK.bookMove(index, hist, { rnd: () => 0 });
  assert.ok(hit);
  assert.equal(hit.x, 6); assert.equal(hit.y, 8);   // G7 = (6,8)
});

/* ================= §12.4.3 前缀匹配树 ================= */

/** 沿"每步取 n 最大的子着"走出一条长度 len 的**规范坐标**路径 */
function walkCanonical(tree, len) {
  const path = [];
  let node = tree;
  for (let d = 0; d < len; d++) {
    let bm = -1, bn = -1;
    for (const [m, e] of node) if (e.n > bn) { bn = e.n; bm = m; }
    if (bm < 0) break;
    path.push(bm);
    node = node.get(bm).c;
  }
  return path;
}

test('前缀树：数据可用，根给出天元 H8', () => {
  assert.ok(BOOK.hasTree(), '前缀树数据必须可用');
  const tree = BOOK.defaultTree();
  assert.equal(tree.size, 1, '根只有 1 个候选（RIF 规则黑 1 恒为天元）');
  const [m, e] = [...tree][0];
  assert.equal(m, idx(7, 7), '黑 1 必须是天元 (7,7)');
  assert.ok(e.n > 1000, '样本量应被截断在 nCap=1295 附近，实际 ' + e.n);
  const r = BOOK.defaultTreeMove([], {});
  assert.ok(r);
  assert.equal(r.x, 7); assert.equal(r.y, 7);
  assert.equal(r.depth, 0);
});

test('前缀树：深度 2 的候选总数 = 26（对应 26 种 RIF 开局）', () => {
  const tree = BOOK.defaultTree();
  // 深度 2 = 已下 2 手（黑1 + 白2）。白 2 只有"直指/斜指"两类 ⇒ 两个节点，各 13 个黑 3 候选
  let nodes2 = [], total = 0;
  for (const [, e1] of tree) {
    for (const [, e2] of e1.c) { nodes2.push(e2.c); total += e2.c.size; }
  }
  assert.equal(nodes2.length, 2, '深度 2 应有 2 个节点（直指 / 斜指）');
  assert.equal(total, 26, '深度 2 的第 3 手候选总数应为 26，实际 ' + total);
  // 抽查：每个深度 2 节点的候选都 ≥ 13（13 种直指 / 13 种斜指）
  for (const nd of nodes2) assert.ok(nd.size >= 13, '每个深度 2 节点至少 13 个候选，实际 ' + nd.size);
});

test('前缀树：逐层下探，深度递增，候选越来越少', () => {
  const tree = BOOK.defaultTree();
  const path = walkCanonical(tree, 6);
  assert.equal(path.length, 6, '应能走出 6 手');
  const sizes = [];
  for (let k = 0; k <= 6; k++) {
    const r = BOOK.defaultTreeMove(path.slice(0, k), {});
    assert.ok(r, '前 ' + k + ' 手应能命中');
    assert.equal(r.depth, k, '深度应等于已下手数');
    sizes.push(r.cands);
  }
  assert.ok(sizes[0] < sizes[2], '第 1 手候选应少于第 3 手（' + sizes.join('/') + '）');
  assert.ok(sizes[2] > sizes[5], '越深候选越少（' + sizes.join('/') + '）');
});

test('前缀树：★ 8 种对称同形必须给出同一手（SYM_INV 往返不变式）', () => {
  const tree = BOOK.defaultTree();
  const canonPath = walkCanonical(tree, 4);           // 规范坐标下的一条真实路径
  assert.equal(canonPath.length, 4);
  const base = BOOK.defaultTreeMove(canonPath, {});
  assert.ok(base);
  const baseIdx = idx(base.x, base.y);

  for (let t = 0; t < 8; t++) {
    // 把整条历史做第 t 种对称变换 → 仍是同一个局面（旋转/镜像同形）
    const histT = canonPath.map(i => { const p = OP.SYM[t](i % 15, (i / 15) | 0); return idx(p[0], p[1]); });
    const r = BOOK.defaultTreeMove(histT, {});
    assert.ok(r, '同形局面 t=' + t + ' 必须仍命中');
    const gotIdx = idx(r.x, r.y);
    // 不变式①（本质）：把"历史 + 返回的着法"整段规范化，最后一项必须回到同一个规范着法
    const c = OP.canonSeq(histT.concat([gotIdx]));
    assert.equal(c.arr[c.arr.length - 1], baseIdx,
      't=' + t + '：规范化后应回到同一个着法（得到 ' + gotIdx + '，期望 ' + baseIdx + '）');
    // 不变式②（更强）：返回的真实着法应恰好是规范着法在第 t 种变换下的像
    const want = OP.SYM[t](baseIdx % 15, (baseIdx / 15) | 0);
    assert.deepEqual([r.x, r.y], [want[0], want[1]],
      't=' + t + '：真实盘面着法应为规范着法的对称像');
  }
});

test('前缀树：匹配不上时返回 null（不得拿父节点的候选顶替）', () => {
  const tree = BOOK.defaultTree();
  const path = walkCanonical(tree, 3);
  assert.ok(BOOK.defaultTreeMove(path, {}), '原路径应命中');
  // 把最后一手换成一个不可能在树上的点（远离开局区域的角落）
  const bad = path.slice(0, 2).concat([idx(0, 14)]);
  assert.equal(BOOK.defaultTreeMove(bad, {}), null,
    '★ 中途匹配不上时必须放弃——否则会拿"已经下过的那一手"的候选当作我们要走的那手');
});

test('前缀树：选点优先胜率（收缩后最高者胜出，而非频次最高者）', () => {
  const tree = BOOK.defaultTree();
  // 沿着"每步取 n 最大"走到深度 2，然后手工验证排序逻辑
  const path = walkCanonical(tree, 2);
  const node = (() => { let n = tree; for (const m of path) n = n.get(m).c; return n; })();
  let bestRaw = null;
  for (const [, e] of node) if (!bestRaw || e.r > bestRaw.r) bestRaw = e;
  const r = BOOK.defaultTreeMove(path, {});
  // 结论应落在"频次"与"原始胜率"之间（收缩的应有之义）
  assert.ok(r.score <= Math.max(bestRaw.r, r.prior) + 1e-9, '收缩后不得超过原始胜率与先验的最大值');
  assert.ok(r.score >= Math.min(bestRaw.r, r.prior) - 1e-9, '收缩后不得低于原始胜率与先验的最小值');
  // 选出的那一手必须在"统计上分不开"的带子里（score ≥ 最大分 − TIE）
  assert.ok(r.score >= r.topScore - BOOK.BOOK_TIE - 1e-9,
    '选出的着法必须落在 [M−TIE, M] 带子里：score=' + r.score + ' topScore=' + r.topScore);
  assert.ok(r.n > 0 && r.games > 0 && r.cands > 0);
});

/** 手工搭一棵树：entries = [[idx, n, r, 子树?], …] —— 用合成样例钉住选点规则，不依赖真实数据 */
function mkTree(entries) {
  return new Map(entries.map(([m, n, r, c]) => [m, { n: n, r: r, c: c || new Map() }]));
}
const A2 = idx(7, 7), B2 = idx(8, 8), C2 = idx(6, 6);   // 三个互不相同的点

test('前缀树：合成样例 —— 胜率真的更高时，必须选胜率高的（不是只看频次）', () => {
  // 两个候选频次相同（都是 1000），胜率 0.40 vs 0.60 ⇒ 收缩后差距远大于 TIE ⇒ 必须选 0.60
  const t = mkTree([[A2, 1000, 0.40], [B2, 1000, 0.60]]);
  const r = BOOK.treeMove(t, [], {});
  assert.equal(idx(r.x, r.y), B2, '同频次下必须选胜率高的那一手');
  assert.ok(Math.abs(r.score - 0.60) < 0.02);
});

test('前缀树：★ 合成样例 —— 分不开时必须选证据多的（赢家诅咒修正）', () => {
  // A：n=1000 胜率 0.50（收缩后 ≈0.500）；B：n=5 胜率 0.90（收缩后 ≈0.516）
  // 纯 argmax 会选 B —— 但 5 局的 0.90 是噪声，且冷门着法冷门很可能正因为它是坏棋。
  const t = mkTree([[A2, 1000, 0.50], [B2, 5, 0.90]]);
  const withTie = BOOK.treeMove(t, [], {});
  assert.equal(idx(withTie.x, withTie.y), A2, '分不开时应偏向证据多的那一手');
  assert.equal(withTie.n, 1000);
  // 反向对照：把 TIE 关掉（tie=0）就应退回纯 argmax ⇒ 选 B —— 否则上一条是空断言
  const noTie = BOOK.treeMove(t, [], { tie: 0 });
  assert.equal(idx(noTie.x, noTie.y), B2, 'tie=0 时必须退回纯 argmax（对照）');
  assert.equal(noTie.n, 5);
});

test('前缀树：合成样例 —— 先验逐层翻面且收缩（轮到对手时用的是 1−r）', () => {
  // 根只有一手 A2（n=1000, r=0.70，A2 这一方的胜率）⇒ 走到 A2 之后轮到对手，
  // 对手的先验应是 1−0.70≈0.30（收缩后略高于 0.30，因为向 0.5 回归）
  const leaf = mkTree([[C2, 10, 0.5]]);
  const t = mkTree([[A2, 1000, 0.70, leaf]]);
  const r = BOOK.treeMove(t, [A2], {});
  assert.ok(r, '应命中');
  assert.ok(r.prior > 0.30 && r.prior < 0.45,
    '轮到对手时先验应为 1−0.70 再向 0.5 回归，实际 ' + r.prior.toFixed(3));
  // 极端对照：若先验不翻面，这里会得到 ≈0.7 —— 用一个"原始胜率=1"的父边更明显
  const leaf2 = mkTree([[C2, 10, 0.5]]);
  const t2 = mkTree([[A2, 2, 1.0, leaf2]]);
  const r2 = BOOK.treeMove(t2, [A2], {});
  assert.ok(r2.prior > 0.4 && r2.prior < 0.6,
    '父边 n=2、r=1 时先验仍须被收缩/翻面后保持温和，实际 ' + r2.prior.toFixed(3));
});

test('前缀树：开局名（深度 ≥3 时可识别）', () => {
  const tree = BOOK.defaultTree();
  const path = walkCanonical(tree, 4);
  const r = BOOK.defaultTreeMove(path.slice(0, 3), {});
  assert.ok(r);
  assert.ok(r.opening, '已下 3 手时应能识别出开局名，实际 ' + r.opening);
  const names = OP.OPENINGS.map(o => o.name);
  assert.ok(names.includes(r.opening), '开局名必须在 26 种之内：' + r.opening);
});

test('前缀树：search.openingMove 走树（source 必须是 renjunet-tree，而非旧线库）', () => {
  const SEARCH = require('../engine/search.js');
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const r = SEARCH.think(pos, { rule: 'renju', difficulty: 'easy', useBook: true });
  assert.ok(r, '空盘应能出招');
  assert.equal(r.via, 'book', '空盘应命中开局库');
  assert.equal(r.book.source, 'renjunet-tree', '★ 必须走前缀树，不是旧线库');
  assert.deepEqual([r.move.x, r.move.y], [7, 7], '第 1 手应为天元');
});

test('前缀树：canonSeq 与 canonKey 的口径不得混用（数值序 vs 字符串序）', () => {
  // canonKey 是 join(',') 后比**字符串**（历史遗留，两侧都错故识别仍成立）；
  // canonSeq 必须比**数值**，且可拼接。取一个多位 idx 混合的序列验证可拼接性。
  const seq = [112, 97, 128, 113];
  const c3 = OP.canonSeq(seq.slice(0, 3));
  const c4 = OP.canonSeq(seq);
  assert.deepEqual(c4.arr.slice(0, 3), c3.arr,
    '★ 可拼接性：长序列的规范形，其前缀必须等于短序列的规范形（否则整棵树的分层就对不上）');
  assert.equal(c4.arr[3], OP.canonSeq(c3.arr.concat([c4.arr[3]])).arr[3]);
});
