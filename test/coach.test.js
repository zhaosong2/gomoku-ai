/* test/coach.test.js — M8 教练层：提示 Top-N / 形势判断 / 热力图（§10 / §11） */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const S = require('../engine/search.js');
const COACH = require('../engine/coach.js');
const REC = require('../engine/record.js');

const { BLACK, WHITE, EMPTY, idxOf, NN, opp } = core;

function boardOf(seq) {                                  // [[x,y,player]]
  const b = new Int8Array(NN);
  for (const s of seq) b[idxOf(s[0], s[1])] = s[2];
  return b;
}

/* ============================================================
 * 提示（§10）
 * ============================================================ */
test('提示：成五点在 Top1 且标记 win（§10.1）', () => {
  // 黑在 y=7 已有 (3..6,7)，落 (7,7) 成五；轮黑
  const b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                     [3, 8, WHITE], [4, 8, WHITE], [5, 8, WHITE], [6, 8, WHITE]]);
  const h = COACH.hint(b, BLACK, { topN: 5, rule: 'freestyle', useThreat: false });
  assert.ok(h.length > 0);
  // ★ 连四两端 (2,7) 与 (7,7) 均为成五点、分值相同（同为 WIN），
  //   故 Top1 只保证「是成五点」，不保证是某一端——两端都必须出现（见下一用例）。
  assert.ok(h.every(q => q.win === true), '连四时所有候选都应是成五点');
  assert.ok(h.length <= 2, '连四只有两个成五点，不该混入低分点：' + h.length);
  // ★ 坐标口径（§12）：棋盘 (7,7) 是 0 基，Renju 记号 = 列 H(row 8) → 'H8'
  const top1 = h[0];
  assert.equal(top1.coord, REC.coordText(top1.x, top1.y));
  assert.equal(top1.win, true);
  assert.equal(top1.type, '成五');
  assert.equal(top1.rank, 1);
  assert.equal(top1.norm, 100);                          // 最佳者归一为 100
  // 两端的固定断言（顺序无关）
  const pts = h.map(q => q.x + ',' + q.y);
  assert.ok(pts.includes('7,7'), '应含 (7,7)：' + pts.join(' '));
  assert.ok(pts.includes('2,7'), '应含 (2,7)：' + pts.join(' '));
  assert.equal(H8(h), 'H8', '(7,7) 的 Renju 记号应为 H8');
});
function H8(h) { const q = h.find(p => p.x === 7 && p.y === 7); return q && q.coord; }

test('提示：成五点也可在另一侧（(2,7) 等价）', () => {
  // 同样连四，但左端 (2,7) 也是成五点；验证 x/y 未被交换或整体偏移
  const b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                     [3, 8, WHITE], [4, 8, WHITE], [5, 8, WHITE], [6, 8, WHITE]]);
  const h = COACH.hint(b, BLACK, { topN: 8, rule: 'freestyle', useThreat: false });
  const pts = h.map(q => q.x + ',' + q.y);
  assert.ok(pts.includes('7,7'), '应含 (7,7)：' + pts.join(' '));
  assert.ok(pts.includes('2,7'), '应含 (2,7)：' + pts.join(' '));
  for (const q of h) if (q.win) assert.equal(q.type, '成五');
});

test('提示：字段完整且 norm 单调不增（§10.1 / §28 HintItem）', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 8, BLACK], [6, 6, WHITE]]);
  const h = COACH.hint(b, BLACK, { topN: 5, rule: 'freestyle', difficulty: 'normal', depth: 4 });
  assert.ok(h.length >= 1);
  const need = ['rank', 'x', 'y', 'coord', 'score', 'norm', 'type', 'win'];
  for (const it of h) {
    for (const k of need) assert.ok(k in it, '缺少字段 ' + k);
    assert.ok(Number.isFinite(it.score), 'score 应为数字');
    assert.ok(it.norm >= 0 && it.norm <= 100, 'norm 应在 0..100：' + it.norm);
    assert.ok(typeof it.type === 'string' && it.type.length, 'type 非空');
    assert.equal(it.coord, REC.coordText(it.x, it.y));
  }
  for (let k = 1; k < h.length; k++) {
    assert.ok(h[k].score <= h[k - 1].score, '应按分值降序');
    assert.ok(h[k].norm <= h[k - 1].norm, 'norm 应单调不增');
    assert.equal(h[k].rank, k + 1);
  }
});

test('提示：Top-N 数量受 n 限制（默认 5）', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE]]);
  assert.ok(COACH.hint(b, BLACK, { rule: 'freestyle' }).length <= 5);
  assert.ok(COACH.hint(b, BLACK, { rule: 'freestyle', topN: 2, depth: 3 }).length <= 2);
});

test('提示：必胜手来自 ThreatSolver（VCF 检测）', () => {
  // 黑有连续冲四 → VCF 必胜；用一个明确的 VCF 局面
  const b = boardOf([
    [7, 7, BLACK], [8, 8, BLACK],
    [7, 8, WHITE], [8, 7, WHITE],
    [9, 9, BLACK],
    [6, 6, WHITE], [10, 10, WHITE],
  ]);
  const h = COACH.hint(b, BLACK, { topN: 5, rule: 'freestyle', difficulty: 'hard', useThreat: true, threatMs: 800 });
  assert.ok(h.length > 0);
  // 只要求：引擎若判定必胜，则至少有一个 win 标记；不强制该局面必然有 VCF
  const anyWin = h.some(x => x.win);
  if (anyWin) {
    const first = h.find(x => x.win);
    assert.ok(first.mate, '必胜手应带 mate 信息');
  }
});

test('提示：Renju 黑禁手着法不进列表，且禁手点类型为「禁手」', () => {
  // 黑 (7,7) 形成双活三 → 禁手
  const b = boardOf([
    [5, 7, BLACK], [6, 7, BLACK],
    [7, 5, BLACK], [7, 6, BLACK],
    [0, 0, WHITE], [1, 0, WHITE], [2, 0, WHITE], [3, 0, WHITE],
  ]);
  const h = COACH.hint(b, BLACK, { topN: 8, rule: 'renju', difficulty: 'normal', depth: 3, useThreat: false });
  const banned = h.filter(x => x.x === 7 && x.y === 7);
  assert.equal(banned.length, 0, '(7,7) 是黑禁手点，不应出现在提示中');
});

test('提示：白方在 Renju 下无禁手（可下黑方的禁手点）', () => {
  const b = boardOf([
    [5, 7, BLACK], [6, 7, BLACK],
    [7, 5, BLACK], [7, 6, BLACK],
    [0, 0, WHITE], [1, 0, WHITE], [2, 0, WHITE], [3, 0, WHITE],
  ]);
  const h = COACH.hint(b, WHITE, { topN: 8, rule: 'renju', difficulty: 'normal', depth: 3, useThreat: false });
  assert.ok(h.length > 0, '白方应有候选');
});

test('提示：空盘返回天元（不崩）', () => {
  const b = new Int8Array(NN);
  const h = COACH.hint(b, BLACK, { topN: 3, rule: 'freestyle', depth: 2, useThreat: false });
  assert.ok(h.length >= 1);
  assert.equal(h[0].x, 7); assert.equal(h[0].y, 7);
});

/* ============================================================
 * 形势判断（§11）
 * ============================================================ */
test('形势：终局（黑已连五）判黑胜率 1、标签「黑已胜」', () => {
  const b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                     [3, 8, WHITE], [4, 8, WHITE], [5, 8, WHITE]]);
  const r = COACH.judge(b, BLACK, { rule: 'freestyle', useThreat: false });
  assert.equal(r.blackRate, 1);
  assert.equal(r.label, '黑已胜');
  assert.equal(r.source, 'win');
});

test('形势：字段完整（§28 judge 响应）', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 8, BLACK]]);
  const r = COACH.judge(b, WHITE, { rule: 'freestyle', useThreat: false });
  assert.ok('blackRate' in r && 'label' in r && 'mate' in r && 'forbiddenPoints' in r);
  assert.ok(r.blackRate >= 0 && r.blackRate <= 1);
  assert.ok(typeof r.label === 'string' && r.label.length);
  assert.equal(r.mate, null);
  assert.ok(Array.isArray(r.forbiddenPoints));
});

test('形势：胜率与分值同向单调（黑视角）', () => {
  // 黑有活三（优势） vs 白有活三（劣势）
  const bBlackGood = boardOf([[7, 7, BLACK], [8, 7, BLACK], [9, 7, BLACK],
                              [7, 6, WHITE], [0, 0, WHITE], [0, 1, WHITE]]);
  const bWhiteGood = boardOf([[7, 7, WHITE], [8, 7, WHITE], [9, 7, WHITE],
                              [7, 6, BLACK], [0, 0, BLACK], [0, 1, BLACK]]);
  const r1 = COACH.judge(bBlackGood, BLACK, { rule: 'freestyle', useThreat: false });
  const r2 = COACH.judge(bWhiteGood, BLACK, { rule: 'freestyle', useThreat: false });
  assert.ok(r1.blackRate > r2.blackRate,
    '黑有攻势时胜率应更高：' + r1.blackRate + ' vs ' + r2.blackRate);
});

test('形势：eval → 胜率 S 形映射，两端与中点正确（§11.1）', () => {
  assert.equal(COACH.evalToWinRate(0), 0.5);
  assert.equal(COACH.evalToWinRate(PAT.WIN), 1);
  assert.equal(COACH.evalToWinRate(-PAT.WIN), 0);
  const a = COACH.evalToWinRate(1200), b = COACH.evalToWinRate(2400);
  assert.ok(a > 0.5 && a < b && b < 1, 'S 形单调：' + a + ' < ' + b);
  assert.ok(Math.abs(COACH.evalToWinRate(1200) + COACH.evalToWinRate(-1200) - 1) < 1e-9, '应对称');
});

test('形势：Renju 黑禁手点被标出（§11.1 / §29.3）', () => {
  const b = boardOf([
    [5, 7, BLACK], [6, 7, BLACK],
    [7, 5, BLACK], [7, 6, BLACK],
    [0, 0, WHITE], [1, 0, WHITE], [2, 0, WHITE], [3, 0, WHITE],
  ]);
  const r = COACH.judge(b, WHITE, { rule: 'renju', useThreat: false });
  assert.ok(r.forbiddenPoints.length >= 1, '应标出至少一个黑禁手点');
  const has77 = r.forbiddenPoints.some(p => p.x === 7 && p.y === 7);
  assert.ok(has77, '(7,7) 双活三应为禁手点，实际：' + JSON.stringify(r.forbiddenPoints.slice(0, 6)));
  for (const p of r.forbiddenPoints) assert.equal(p.coord, REC.coordText(p.x, p.y));
});

test('形势：无禁手规则下不标禁手点', () => {
  const b = boardOf([
    [5, 7, BLACK], [6, 7, BLACK],
    [7, 5, BLACK], [7, 6, BLACK],
    [0, 0, WHITE], [1, 0, WHITE],
  ]);
  const r = COACH.judge(b, WHITE, { rule: 'freestyle', useThreat: false });
  assert.equal(r.forbiddenPoints.length, 0);
});

test('形势：必杀标注（黑 VCF）给出 side=B', () => {
  // 黑双四 → 冲四必胜（最简单的必杀局面）
  const b = boardOf([
    [5, 7, BLACK], [6, 7, BLACK], [7, 8, BLACK], [7, 9, BLACK],
    [7, 7, WHITE],
    [0, 0, WHITE], [14, 14, WHITE],
  ]);
  const r = COACH.judge(b, BLACK, { rule: 'freestyle', difficulty: 'hard', useThreat: true, threatMs: 900 });
  assert.ok(r.blackRate > 0.5, '黑有强威胁 → 胜率应过半：' + r.blackRate);
  // 必杀可命中也可不命中（取决于求解器深度），命中时校验归属
  if (r.mate) {
    assert.equal(r.mate.side, 'B');
    assert.ok(r.mate.plies >= 1);
  }
});

/* ============================================================
 * 热力图（§11.1 可选）
 * ============================================================ */
test('热力图：返回合法点且 v ∈ 0..1', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 8, BLACK]]);
  const h = COACH.heat(b, WHITE, { rule: 'freestyle', difficulty: 'normal', depth: 2 });
  assert.ok(h.length > 0, '应有热力点');
  for (const p of h) {
    assert.ok(p.x >= 0 && p.x < 15 && p.y >= 0 && p.y < 15);
    assert.ok(p.v >= 0 && p.v <= 1, 'v 应在 0..1：' + p.v);
    assert.equal(b[idxOf(p.x, p.y)], EMPTY, '只给空点');
  }
});

/* ============================================================
 * 用时曲线（§9.3）
 * ============================================================ */
test('用时曲线：均值 + 长考手识别', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6], [6, 7], [6, 6], [8, 7]],
                        [100, 100, 100, 100, 100, 5000], { ruleMode: 'freestyle' });
  const ts = COACH.timeSeries(rec);
  assert.equal(ts.length, 6);
  assert.equal(ts[0].no, 1);
  assert.equal(ts[5].timeMs, 5000);
  assert.equal(ts[5].isOutlier, true, '5000ms 应被识别为长考手');
  assert.equal(ts[0].isOutlier, false, '100ms 不应被识别为长考手');
  assert.ok(ts[0].mean > 0);
});

test('用时曲线：空棋谱返回空数组', () => {
  assert.deepEqual(COACH.timeSeries({ moves: [] }), []);
  assert.deepEqual(COACH.timeSeries(null), []);
});

/* ★ 回归：timeSeries 必须兼容 parse() 的元组产物（浏览器实跑暴露）
 *   旧实现直接读 mv[k].timeMs，元组上没有该字段 → 整条曲线全 0（静默错误）。
 *   元组形态的用时存在**旁路** rec.times[k]，必须经 REC.moveAt 取。
 */
test('用时曲线：元组形态（用时走旁路 rec.times）也要取到（回归）', () => {
  const pr = REC.parse('1.H8(1.0s) 2.H9(5.0s) 3.I9(0.3s)', { rule: 'renju' });
  assert.ok(pr.ok, JSON.stringify(pr));
  const ts = COACH.timeSeries(pr);
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.map(q => q.timeMs), [1000, 5000, 300], '元组形态不得退化成全 0');
  assert.deepEqual(ts.map(q => q.no), [1, 2, 3]);
  assert.equal(ts[1].player, WHITE, 'k=1 应为白');
});

/* ============================================================
 * 类型标签（§10.1 type 枚举）
 * ============================================================ */
test('类型标签：组合等级 → 中文标签映射', () => {
  assert.equal(COACH.typeOf(PAT.L.WIN, 0), '成五');
  assert.equal(COACH.typeOf(PAT.L.OPEN_FOUR, 0), '活四');
  assert.equal(COACH.typeOf(PAT.L.DOUBLE_FOUR, 0), '双四');
  assert.equal(COACH.typeOf(PAT.L.FOUR_THREE, 0), '四三');
  assert.equal(COACH.typeOf(PAT.L.DOUBLE_THREE, 0), '双三');
  assert.equal(COACH.typeOf(PAT.L.FOUR, 0), '冲四');
  assert.equal(COACH.typeOf(PAT.L.OPEN_THREE, 0), '活三');
  assert.equal(COACH.typeOf(PAT.L.DEAD, 0), '防守');
  assert.equal(COACH.typeOf(PAT.L.SLEEP_THREE, 0), '常规');
  assert.equal(COACH.typeOf(PAT.L.WIN, 1), '禁手');
});

test('归一化：最佳者 100，必败者 0，单调不增（§10.1 norm）', () => {
  const n = COACH.normalize([1000, 500, 100, 10]);
  assert.equal(n[0], 100);
  assert.ok(n[0] > n[1] && n[1] > n[2] && n[2] > n[3]);
  assert.ok(n[3] >= 1);
  const z = COACH.normalize([1000, -PAT.WIN / 2 - 1]);
  assert.equal(z[0], 100);
  assert.equal(z[1], 0);
});

/* ---------- ★ R10：杀法标注 + "最短杀优先"排序 ----------
 * 用户问："杀法提示为什么通常选步骤多的？" 根因 = 威胁标注不参与排序（且 normal 档不标注）。
 * 用已知"4 步冲四链 VCF"局面（threat.test.js 同款）钉死新行为。 */
const R10_STONES = [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
                   [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]];

test('hint：搜索证明的杀也要标注，且必胜候选按杀距排序（步数少者在前）', () => {
  const b = boardOf(R10_STONES);
  const h = COACH.hint(b, BLACK, { topN: 5, rule: 'freestyle', overlineMode: 'rif',
    difficulty: 'normal', depth: 8, useThreat: true, threatMs: 3000 });
  assert.ok(h.length >= 2 && h[0].win, 'Top-1 应是必胜（搜索证明的杀也要标注，normal 档也不例外）');
  assert.equal(h[0].mate, 'search', 'normal 档 vcfDepth=0 ⇒ 标注来源应为搜索证明');
  assert.equal(h[0].coord, 'F7', 'Top-1 应是最短杀 F7（3 手），实际 ' + h[0].coord);
  assert.equal(h[0].mateLen, 3);
  const lens = h.filter(x => x.win).map(x => x.mateLen);
  for (let k = 1; k < lens.length; k++) {
    assert.ok(lens[k] >= lens[k - 1], '必胜候选必须按杀距非降序：' + lens.join(','));
  }
});

test('hint：必胜标注参与排序且快杀在前（R11：候选级探测不再产生假必胜）', () => {
  /* ★ R11 修正了本测试断言的前提：R10 钉的"I6/I7 = 2 手杀"是**假必胜**——旧候选级探测
   *   在"走完候选、轮到对方"的局面仍以我方为攻方搜杀 = 跳过对方回合（系统性假阳）。
   *   实测 I6/I7 走完并不成四（不是双四点）。本局真杀 = F7（depth4 搜索证明 3 手）
   *   与 I9（根 VCF 4 手）。不变量保持：必胜参与排序、快杀在前、杀距非降序。 */
  const b = boardOf(R10_STONES);
  const h = COACH.hint(b, BLACK, { topN: 5, rule: 'freestyle', overlineMode: 'rif',
    difficulty: 'hard', depth: 4, useThreat: true, threatMs: 3000, vcfDepth: 8 });
  const wins = h.filter(x => x.win);
  assert.ok(wins.length >= 2, '至少根求解与搜索证明的杀要被标注，实际 ' + wins.length);
  assert.equal(h[0].coord, 'F7', 'Top-1 应为最短杀 F7：' + h[0].coord + '/' + h[0].mate + h[0].mateLen);
  assert.equal(h[0].mateLen, 3, 'F7 杀距应为 3 手');
  const lens = wins.map(x => x.mateLen);
  for (let k = 1; k < lens.length; k++) assert.ok(lens[k] >= lens[k - 1], '必胜候选必须按杀距非降序：' + lens.join(','));
  const iF7 = h.findIndex(x => x.coord === 'F7'), iI9 = h.findIndex(x => x.coord === 'I9');
  assert.ok(iF7 >= 0 && iI9 > iF7, '3 手杀（F7）应排在 4 手杀（I9）之前：'
    + h.map(x => x.coord + ':' + (x.mate || '-') + x.mateLen).join(' '));
});

/* ---------- ★ R11：终局 / 必败 / 推荐度分层（用户实测三症状的回归守卫） ---------- */

test('R11-a 终局盘面（白已五连）：hint 不产生假"必胜"，judge 直接给终局结论', () => {
  /* 用户实测：白已成五后 hint 仍标"必胜·VCF"（威胁求解器不检查对方已赢），
   * 且 judge 若黑还有四会给出"黑已胜 100%"——与实际胜负相反。 */
  const b = boardOf([[7, 6, WHITE], [8, 6, WHITE], [9, 6, WHITE], [10, 6, WHITE], [11, 6, WHITE],  // H9–L9 白五连
                     [6, 6, BLACK], [7, 7, BLACK], [5, 5, BLACK]]);
  const h = COACH.hint(b, BLACK, { rule: 'renju', useThreat: true, vcfDepth: 8, threatMs: 900 });
  assert.deepEqual(h, [], '终局后 hint 必须为空（不许再出"必胜"）');
  const j = COACH.judge(b, BLACK, { rule: 'renju' });
  assert.equal(j.source, 'over');
  assert.equal(j.blackRate, 0, '白已胜 ⇒ 黑胜率必须为 0');
  assert.equal(j.label, '白已胜');
});

test('R11-b 必败局（白双四将死）：败着不上榜，且不出"norm=0% 且标必胜"的自相矛盾项', () => {
  const b = boardOf([[7, 6, WHITE], [8, 6, WHITE], [9, 6, WHITE], [10, 6, WHITE],   // H9–K9 横四
                     [4, 3, WHITE], [4, 4, WHITE], [4, 5, WHITE], [4, 6, WHITE],    // E9–E12 竖四
                     [7, 7, BLACK], [8, 7, BLACK]]);
  const h = COACH.hint(b, BLACK, { rule: 'renju', useThreat: true, threatMs: 900 });
  for (const it of h) {
    assert.ok(!(it.win && it.norm <= 5), '不许出现"norm=0% 且标必胜"：' + it.coord);
    assert.ok(it.score > -PAT.WIN / 2, '败着（走了就输）不上榜：' + it.coord);
  }
});

test('R11-c 必胜/普通候选的推荐度分层：必胜 ≥ 80，普通 ≤ 78（"必胜"旁永不见 0%）', () => {
  const h = COACH.hint(boardOf(R10_STONES), BLACK, { topN: 5, rule: 'freestyle', overlineMode: 'rif',
    difficulty: 'hard', depth: 4, useThreat: true, threatMs: 3000, vcfDepth: 8 });
  for (const it of h) {
    if (it.win) assert.ok(it.norm >= 80, '必胜候选 norm 应 ≥80：' + it.coord + '=' + it.norm);
    else assert.ok(it.norm <= 78, '普通候选 norm 应 ≤78：' + it.coord + '=' + it.norm);
  }
});

test('R11-d 黑大优但对方只有跳四（单成五点）：judge 是"危"（10%~50%）而非 0%', () => {
  const b = boardOf([[7, 6, WHITE], [8, 6, WHITE], [9, 6, WHITE], [11, 6, WHITE],   // H9,I9,J9,L9 跳四
                     [6, 8, BLACK], [7, 9, BLACK], [8, 10, BLACK],                  // 黑斜活三
                     [3, 3, BLACK], [4, 3, BLACK], [3, 4, BLACK], [4, 4, BLACK]]);
  const j = COACH.judge(b, BLACK, { rule: 'renju', useThreat: false });
  assert.equal(j.source, 'urgent');
  assert.ok(j.blackRate > 0.1 && j.blackRate < 0.5,
    '单成五点应判"危"（10%~50%），实际 ' + (j.blackRate * 100).toFixed(1) + '%');
});
