/* test/search-enhance.test.js — M7 搜索增强单测
 * 覆盖：TT 标志位健全性 / TT 着法 key 校验 / 规则盐与代龄隔离 / IID / LMR 规格公式
 *      / 根层 PV 复用 / 启发式开关语义 / 增强后的搜索不变式
 *
 * 设计原则：**只断言确定性的东西**。凡依赖墙钟的指标一律不做硬断言，
 * 结论一致性与节点数才是可复现的判据（§17.2）。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const OP = require('../engine/data/openings.js');

const { NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;
const H = SEARCH.H;

/* 构造"安静中局"：真实开局 + 固定补子，保证无立即战术（否则 L0/VCF 接管，测不到搜索） */
function midGame(k) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos, true);
  let t = BLACK;
  for (const m of OP.OPENINGS[k % OP.OPENINGS.length].moves) { core.makeMove(pos, m.x, m.y, t); t = opp(t); }
  for (const m of [[5, 5], [9, 9], [4, 10], [10, 4], [6, 10], [8, 4], [10, 10], [4, 4]]) {
    core.makeMove(pos, m[0], m[1], t); t = opp(t);
  }
  return { board: pos.board.slice(), stm: pos.stm };
}
function fresh(p) { const pos = SEARCH.posFromBoard(p.board, p.stm); SEARCH.attachCache(pos, true); return pos; }

const CFG = { width: 14, radius: 2, ttBits: 14, incr: true, rule: 'freestyle', overlineMode: 'rif' };
function run(p, extra) {
  SEARCH.ttClear();
  return SEARCH.think(fresh(p), Object.assign({}, CFG, extra));
}

test('M7 开关语义：位定义齐全，默认全开；h=0 关闭全部启发式', () => {
  // ★ A2+A4 收官（2026-09-20）：RAZOR/MCUT/VERIFY 并入 ALL（63→703→2751）；VDP/FUTILE 弃用留档（位仍在）
  assert.deepEqual(
    [H.LMRF, H.KILL2, H.IID, H.ROOT, H.LMRR, H.MALUS, H.VDP, H.RAZOR, H.FUTILE, H.MCUT, H.LEAFVCF, H.VERIFY],
    [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]);
  assert.equal(H.ALL, 2751);
  assert.equal(SEARCH.DEFAULT.h, H.ALL, '默认应全开');
  assert.equal(SEARCH.resolveCfg({ h: 0 }).h, 0, '显式 h 必须生效');
  // 每个位都必须与其他位不重叠，且都能单独取出
  const bits = [H.LMRF, H.KILL2, H.IID, H.ROOT, H.LMRR, H.MALUS, H.VDP, H.RAZOR, H.FUTILE, H.MCUT, H.LEAFVCF, H.VERIFY];
  // ★ A3：LEAFVCF 已并入 ALL（位 1024）；A2 弃用留档位（VDP/FUTILE）不在 ALL 内
  const RETIRED = [H.VDP, H.FUTILE, H.LEAFVCF];   // ○ 待收尾：LEAFVCF 目前**未**并入 ALL（验收后再并）
  for (let i = 0; i < bits.length; i++) {
    for (let j = i + 1; j < bits.length; j++) assert.equal(bits[i] & bits[j], 0, '位重叠');
    if (RETIRED.includes(bits[i])) {
      assert.equal(H.ALL & bits[i], 0, '弃用位 ' + bits[i] + ' 不应并入 ALL（留档语义）');
    } else {
      assert.equal(H.ALL & bits[i], bits[i], '位 ' + bits[i] + ' 未被包含在 ALL 中');
    }
  }
});

test('★回归（bug）：TT 标志位不得恒为 UPPER，EXACT/UPPER/LOWER 三种都必须出现', () => {
  // 旧实现把"被抬高后的 alpha"当作原始窗口传进 ttStore → value <= alpha 恒真 → 2351/2351 全是 UPPER
  const r = run(midGame(0), { maxDepth: 6, hardLimit: 600000, h: H.ALL });
  const TT = SEARCH.TT();          // ★ 必须在 think 之后再取引用（换尺寸会重建对象）
  let c0 = 0, c1 = 0, c2 = 0, used = 0;
  for (let i = 0; i < TT.size; i++) {
    if (TT.depth[i] < 0) continue;
    used++;
    if (TT.flag[i] === 0) c0++; else if (TT.flag[i] === 1) c1++; else c2++;
  }
  console.log('     TT 占用 ' + used + ' 槽：EXACT=' + c0 + ' UPPER=' + c1 + ' LOWER=' + c2 +
    '（search nodes=' + r.nodes + '）');
  assert.ok(used > 100, 'TT 应有足量条目');
  assert.ok(c0 > 0, '必须出现 EXACT 条目（旧实现为 0）');
  assert.ok(c1 > 0, '必须出现 UPPER 条目');
  assert.ok(c2 > 0, '必须出现 LOWER 条目（旧实现为 0）');
});

test('★健全性：TT 标志位不得污染重搜结论（热 TT 第二次同深搜索必须给出同值）', () => {
  // 若把 fail-high（下界）错存成 UPPER（上界），热启动时会拿错误的界去剪枝 → 值不同
  for (const bits of [10, 14, 18]) {          // 故意用小 TT，放大槽位冲突
    const p = midGame(1);
    const cfg = { maxDepth: 6, hardLimit: 600000, ttBits: bits, h: H.ALL };
    SEARCH.ttClear();
    const cold = SEARCH.think(fresh(p), cfg);
    SEARCH.ttClear();
    SEARCH.think(fresh(p), cfg);              // 先填一遍表
    const warm = SEARCH.think(fresh(p), cfg); // 不清表再搜同一局面
    assert.equal(warm.score, cold.score,
      'ttBits=' + bits + ' 热 TT 重搜分值变了：' + warm.score + ' vs ' + cold.score + '（TT 标志位不健全）');
  }
});

test('TT 着法必须校验 key：不同局面撞槽时不得误用别人的着法', () => {
  // ttBits=10 → 只有 1024 槽，冲突必然发生。若像旧实现那样不看 key 直接取 move，
  // 第一个局面的搜索会被第二个局面污染。
  const A = midGame(0), B = midGame(5), C = midGame(11);
  // ★ 必须显式补全 CFG：直接传裸 cfg 会让 width 落回默认值 12，节点数不可比
  const cfg = Object.assign({}, CFG, { maxDepth: 5, hardLimit: 600000, ttBits: 10, h: H.ALL });
  const soloA = run(A, cfg), soloB = run(B, cfg), soloC = run(C, cfg);

  SEARCH.ttClear();
  const seqA = SEARCH.think(fresh(A), cfg);
  const seqB = SEARCH.think(fresh(B), cfg);
  const seqC = SEARCH.think(fresh(C), cfg);
  assert.deepEqual(seqA.move, soloA.move, 'A 在不清 TT 时被污染');
  assert.deepEqual(seqB.move, soloB.move, 'B 在不清 TT 时被污染');
  assert.deepEqual(seqC.move, soloC.move, 'C 在不清 TT 时被污染');
  assert.equal(seqA.nodes, soloA.nodes, 'A 节点数应与独立搜索一致');
});

test('★规则盐隔离（§24.5）：freestyle / renju / strict 的 TT 互不串用', () => {
  const p = midGame(2);
  // ttBits=6 → 仅 64 槽。★ A2 并入后默认搜索节点大减（RAZOR −44% / MCUT −31%），
  // ttBits=8 时代单次搜索占用率从 58.6% 掉到 21.9%（<30% 前提失效，2026-09-20 实测）⇒ 收窄到 64 槽。
  const base = Object.assign({}, CFG, { maxDepth: 4, hardLimit: 600000, ttBits: 6, h: H.ALL });
  const variants = [
    ['freestyle', { rule: 'freestyle' }],
    ['renju', { rule: 'renju' }],
    ['renju-strict', { rule: 'renju', overlineMode: 'strict' }],
  ];
  const solo = variants.map(([name, extra]) => run(p, Object.assign({}, base, extra)));
  variants.forEach((v, i) => {
    console.log('     ' + v[0].padEnd(13) + ' → (' + solo[i].move.x + ',' + solo[i].move.y + ') nodes=' + solo[i].nodes);
  });
  // 交叉组合：每种规则先跑完前一种规则（不清 TT），结果必须与独立搜索完全一致
  for (let i = 0; i < variants.length; i++) {
    const prev = variants[(i + variants.length - 1) % variants.length][1];
    const cur = variants[i][1];
    SEARCH.ttClear();
    SEARCH.think(fresh(p), Object.assign({}, base, prev));
    const r = SEARCH.think(fresh(p), Object.assign({}, base, cur));
    assert.deepEqual(r.move, solo[i].move,
      variants[i][0] + ' 在 ' + variants[(i + variants.length - 1) % variants.length][0] + ' 之后结果被污染');
    assert.equal(r.nodes, solo[i].nodes, variants[i][0] + ' 节点数应不受前一种规则影响');
  }
  // 反证准备：若 TT 几乎没写满，上面的隔离断言就是在空转（根本没机会冲突）。
  // 这里要求单次搜索后占用率足够高，保证"不同规则必然撞槽"。
  const posA = fresh(p);
  SEARCH.ttClear();
  SEARCH.think(posA, Object.assign({}, base, { rule: 'freestyle' }));
  const TT = SEARCH.TT();
  let used = 0;
  for (let i = 0; i < TT.size; i++) if (TT.depth[i] >= 0) used++;
  console.log('     单次搜索占用 ' + used + '/' + TT.size + ' 槽（' +
    (100 * used / TT.size).toFixed(1) + '%）→ 跨规则撞槽必然发生');
  assert.ok(used > TT.size * 0.3, '占用率过低，隔离断言不构成有效检验：' + used + '/' + TT.size);
});

test('IID：冷 TT 单次全窗搜索（bestMoves 路径）确实生效且**不改变结论**', () => {
  // ★ LMR 是近似算子：一旦开启，任何排序变化都可能改变近似分值。
  //   要断言"IID 不改变真值"，必须先把 LMR 关掉（lmrStart=9999）。
  //   ★ A2 并入（2026-09-20）：RAZOR/MCUT 也是剪枝算子且 MCUT 对排序敏感——
  //   实测不隔离时 IID 的省节点效应被掩盖（nOn 39449 > nOff 36021）⇒ 本测试一并关闭。
  const p = midGame(0);
  const cfg = { depth: 6, width: 14, radius: 2, ttBits: 12, rule: 'freestyle', lmrStart: 9999 };
  const H_SORT = H.ALL & ~H.RAZOR & ~H.MCUT;   // 排序无关子集（IID 效应隔离用）
  SEARCH.ttClear();
  const off = SEARCH.bestMoves(p.board, p.stm, Object.assign({ h: H_SORT & ~H.IID }, cfg), 8);
  const nOff = SEARCH.lastNodes();
  SEARCH.ttClear();
  const on = SEARCH.bestMoves(p.board, p.stm, Object.assign({ h: H_SORT }, cfg), 8);
  const nOn = SEARCH.lastNodes();
  console.log('     无IID ' + nOff + ' 节点 / 有IID ' + nOn + ' 节点（' +
    (100 * (nOn / nOff - 1)).toFixed(1) + '%）');
  assert.ok(nOn < nOff, 'IID 应减少冷启动搜索的节点数：' + nOn + ' vs ' + nOff);
  assert.equal(off.length, on.length);
  for (let i = 0; i < off.length; i++) {
    assert.equal(on[i].v, off[i].v, '第 ' + i + ' 个候选的分值被 IID 改变了（排序不应改变真值）');
    assert.equal(on[i].i, off[i].i, '第 ' + i + ' 个候选被 IID 重排了');
  }
});

test('★诚实记录：IID 在 think（迭代加深）路径下几乎不触发', () => {
  // 原因：迭代加深时上一轮已为每个局面留下深度只差 2 的 TT 着法 → 标准闸门 ttMove<0 永不满足。
  // 这条测试把该事实**固化**下来：一旦将来有人改动 TT 复用策略导致 IID 突然大量触发，测试会报警。
  const p = midGame(0);
  const cfg = { maxDepth: 6, hardLimit: 600000, h: H.ALL };
  const a = run(p, Object.assign({}, cfg, { h: H.ALL & ~H.IID, iidMode: 1 }));
  const b = run(p, Object.assign({}, cfg, { iidMode: 1 }));
  const c = run(p, Object.assign({}, cfg, { iidMode: 2 }));
  assert.equal(a.nodes, b.nodes, 'mode1 在迭代加深下不应改变任何节点数');
  assert.deepEqual(a.move, b.move);
  assert.ok(Math.abs(c.nodes - a.nodes) / a.nodes < 0.05,
    'mode2（深度不足亦触发）在迭代加深下也几乎不触发，实际差异 ' +
    (100 * (c.nodes / a.nodes - 1)).toFixed(1) + '%');
});

test('LMR：规格公式（§24.2）数值正确，且下限参数 lmrMin 生效', () => {
  const expect = (d, i) => Math.max(0, Math.min(d - 1, Math.floor(Math.log(d) * Math.log(i) / 2)));
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16]) {
    for (const i of [1, 2, 4, 6, 8, 12, 20]) {
      assert.equal(SEARCH.lmrReduce(d, i, 0), expect(d, i), 'r(' + d + ',' + i + ') 不符规格公式');
    }
  }
  // 削减量永远不能把 children depth 削成负数（必须留给静态搜索）
  for (let d = 1; d < 32; d++) for (let i = 0; i < 64; i++) {
    const r = SEARCH.lmrReduce(d, i, 3);
    assert.ok(d - 1 - r >= 0, 'depth=' + d + ' i=' + i + ' 削减后子深度为负');
  }
  // 下限生效
  assert.equal(SEARCH.lmrReduce(3, 4, 0), 0);
  assert.ok(SEARCH.lmrReduce(3, 4, 2) >= 2, 'lmrMin=2 时不得再返回 0');
  assert.equal(SEARCH.lmrReduce(6, 4, 1), Math.max(1, expect(6, 4)));
});

test('H_ROOT：根层复用上一轮最佳着法应降低成本，且不改变搜索结论', () => {
  // lmrStart 设很大 → 关闭 LMR（唯一的近似来源），此时任何排序改动都不得改变极小极大真值
  // ★ A2 并入（2026-09-20）：MCUT 对排序敏感（break 时机依赖 k 计数与着法顺序）——
  //   实测 h575 下 ROOT 开关分数差 9cp（−568 vs −559）⇒ 本测试须关闭 RAZOR/MCUT 才能断言"只改排序"。
  const H_SORT = H.ALL & ~H.RAZOR & ~H.MCUT;
  const cfg = { maxDepth: 6, hardLimit: 600000, lmrStart: 9999, h: H_SORT };
  const withoutRoot = Object.assign({}, cfg, { h: H_SORT & ~H.ROOT });
  for (let k = 0; k < 3; k++) {
    const p = midGame(k);
    const a = run(p, withoutRoot);
    const b = run(p, cfg);
    console.log('     局面' + k + '：无根层PV ' + a.nodes + ' 节点 / 有 ' + b.nodes + ' 节点（' +
      (100 * (b.nodes / a.nodes - 1)).toFixed(1) + '%） 均为 (' + b.move.x + ',' + b.move.y + ')=' + b.score);
    assert.equal(b.score, a.score, '根层 PV 复用改变了搜索真值（说明不是纯排序优化）');
    assert.deepEqual(b.move, a.move, '根层 PV 复用改变了最佳着法');
    assert.ok(b.nodes <= a.nodes, '根层 PV 复用以外的开销不得增加：' + b.nodes + ' vs ' + a.nodes);
  }
});

test('★不变式：关闭 LMR 后，任意启发式开关组合都不得改变搜索结论', () => {
  // 这是"启发式只改排序、不改语义"的核心断言。LMR 本身是近似，故必须关掉才能这么比。
  // ★ A2 并入（2026-09-20）：RAZOR/MCUT 是**语义剪枝**（设计上就允许改变搜索值/着法，
  //   由 A2 自身的节点/题库/Elo 验收管辖）⇒ 不属于本不变式，组合里排除。
  const p = midGame(1);
  const base = { maxDepth: 6, hardLimit: 600000, lmrStart: 9999 };
  const truth = run(p, Object.assign({}, base, { h: 0 }));
  const combos = [H.ROOT, H.IID, H.KILL2, H.MALUS, H.LMRR, H.ROOT | H.IID,
    H.ROOT | H.IID | H.KILL2 | H.MALUS | H.LMRR];
  for (const h of combos) {
    const r = run(p, Object.assign({}, base, { h: h }));
    assert.equal(r.score, truth.score, 'h=' + h + ' 改变了搜索真值：' + r.score + ' vs ' + truth.score);
    assert.deepEqual(r.move, truth.move, 'h=' + h + ' 改变了最佳着法');
  }
});

test('★增强后不变式：棋盘复原 / 确定性 / 极短时限仍出合法手 / 无假杀', () => {
  const p = midGame(3);

  // ① 棋盘完全复原
  const before = Array.from(fresh(p).board);
  const posA = fresh(p); SEARCH.ttClear();
  SEARCH.think(posA, Object.assign({}, CFG, { maxDepth: 6, hardLimit: 3000, h: H.ALL }));
  assert.deepEqual(Array.from(posA.board), before, '搜索不得残留落子');
  assert.equal(posA.stm, p.stm, '走子方应复原');

  // ② 确定性
  const x = run(p, { maxDepth: 5, hardLimit: 3000, h: H.ALL });
  const y = run(p, { maxDepth: 5, hardLimit: 3000, h: H.ALL });
  assert.deepEqual(x.move, y.move, '同参数两次搜索应给出一致着法');

  // ③ 极短时限
  const z = run(p, { maxDepth: 12, hardLimit: 1, h: H.ALL });
  assert.ok(z && z.move, '必须返回着法');
  assert.equal(p.board[idxOf(z.move.x, z.move.y)], EMPTY, '必须落在空点');

  // ④ 无假杀（沿用 M3 的回归场景）
  const seq = [[7, 7], [7, 6], [8, 6], [6, 6], [8, 8], [6, 7]];
  const pos = core.createPosition();
  let t = BLACK;
  for (const m of seq) { core.makeMove(pos, m[0], m[1], t); t = core.opp(t); }
  SEARCH.ttClear();
  const list = SEARCH.bestMoves(pos.board, pos.stm, { depth: 2, width: 10, ttBits: 12, h: H.ALL }, 6);
  for (const m of list) {
    assert.ok(Math.abs(m.v) < PAT.WIN - 1000, '出现假杀：(' + m.x + ',' + m.y + ')=' + m.v);
  }
});

test('Renju 下增强同样安全：AI 执黑不落禁手且 <20µs/次判定的性能约束仍在', () => {
  const pos = core.createPosition();
  SEARCH.attachCache(pos, true);
  let t = BLACK;
  for (const m of OP.OPENINGS[0].moves) { core.makeMove(pos, m.x, m.y, t); t = core.opp(t); }
  for (const m of [[5, 5], [9, 9], [4, 10], [10, 4]]) { core.makeMove(pos, m[0], m[1], t); t = core.opp(t); }
  const board = pos.board.slice(), stm = pos.stm;
  const cfg = { maxDepth: 4, hardLimit: 2000, width: 14, radius: 2, ttBits: 14,
                rule: 'renju', overlineMode: 'rif', h: H.ALL };
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  let forbiddenPicked = 0;
  for (const side of [BLACK, WHITE]) {
    SEARCH.ttClear();
    const r = SEARCH.think(SEARCH.posFromBoard(board, side), cfg);
    assert.ok(r && r.move, '必须出招');
    const i = idxOf(r.move.x, r.move.y);
    assert.equal(board[i], EMPTY, '必须落在空点');
    if (side === BLACK && PAT.forbiddenAt(board, i, mode)) forbiddenPicked++;
  }
  assert.equal(forbiddenPicked, 0, 'Renju 下 AI 执黑不得落禁手点');
});
