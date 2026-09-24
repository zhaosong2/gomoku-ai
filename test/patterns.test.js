/* test/patterns.test.js — M2 棋型/评估单测
 * 运行： node --test gomoku/test/patterns.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');

const { EMPTY, BLACK, WHITE, idxOf, NN } = core;
const L = PAT.L, P = PAT.P;

function mk(stones) {
  const b = new Int8Array(NN);
  for (const [x, y, c] of stones) b[idxOf(x, y)] = c;
  return b;
}
function put(b, x, y, c) { b[idxOf(x, y)] = c; return b; }

test('活四 / 冲四 识别（点式窗口）', () => {
  const b = mk([[6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK]]);   // .BBB.
  assert.equal(PAT.gradeAt(b, 5, 7, BLACK).level, L.OPEN_FOUR);  // 接成 .BBBB.
  assert.equal(PAT.gradeAt(b, 9, 7, BLACK).level, L.OPEN_FOUR);
  assert.equal(PAT.gradeAt(b, 4, 7, BLACK).level, L.FOUR);       // 隔一格 → 跳四(冲四)
});

test('双活三 识别', () => {
  const b = mk([[6, 7, BLACK], [8, 7, BLACK], [7, 6, BLACK], [7, 8, BLACK]]);
  const g = PAT.gradeAt(b, 7, 7, BLACK);
  assert.equal(g.level, L.DOUBLE_THREE);
  assert.equal(g.dirs[0], P.OPEN_THREE);
  assert.equal(g.dirs[1], P.OPEN_THREE);
});

test('四三 > 双活三（组合优先级）', () => {
  // 横向冲四 + 纵向活三
  const b = mk([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],  // 横：_BBB → 接 (7,7) 成 BBBB(冲四)
                [8, 8, BLACK], [8, 9, BLACK]]);               // 纵：o.o oo 待补
  const g = PAT.gradeAt(b, 7, 7, BLACK);
  assert.ok(g.level >= L.FOUR_THREE, '应为四三或更强，实际=' + PAT.LNAME[g.level]);
});

test('禁手惩罚：Renju-黑 三三/四四/长连 → FORBIDDEN', () => {
  assert.equal(PAT.levelScore(L.DOUBLE_THREE, 'renju', 'black', 'stm'), PAT.FORBIDDEN);
  assert.equal(PAT.levelScore(L.DOUBLE_FOUR, 'renju', 'black', 'stm'), PAT.FORBIDDEN);
  assert.equal(PAT.levelScore(L.OVERLINE, 'renju', 'black', 'stm'), PAT.FORBIDDEN);
  // 无禁手下同样是高分
  assert.ok(PAT.levelScore(L.DOUBLE_THREE, 'freestyle', 'black', 'stm') > 0);
  // 四三 在 Renju-黑 下合法（不是禁手）
  assert.ok(PAT.levelScore(L.FOUR_THREE, 'renju', 'black', 'stm') > 0);
});

test('组合等级严格单调（走子方列）', () => {
  for (let k = 0; k <= 11; k++) {
    assert.ok(PAT.levelScore(k, 'freestyle', 'black', 'stm') < PAT.levelScore(k + 1, 'freestyle', 'black', 'stm'),
      '等级 ' + k + ' 应 < ' + (k + 1));
  }
});

test('手番双栏：V_stm ≥ V_opp', () => {
  for (let k = 1; k <= 8; k++) {
    const s = PAT.levelScore(k, 'freestyle', 'black', 'stm');
    const o = PAT.levelScore(k, 'freestyle', 'black', 'opp');
    assert.ok(s >= o, '等级 ' + k + ' 应满足 V_stm >= V_opp');
  }
});

test('countAll：叶子用直线棋型计数', () => {
  const b = mk([[6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK]]);   // 黑活三
  const c = PAT.countAll(b, BLACK);
  assert.equal(c.openThree, 1);
  assert.equal(c.four, 0);
  const w = PAT.countAll(b, WHITE);
  assert.equal(w.openThree, 0);
});

test('staticEval 手番短路：走子方有活四即胜', () => {
  const b = mk([[6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK], [9, 7, BLACK]]);
  assert.equal(EV.staticEval(b, BLACK), PAT.WIN);
  assert.equal(EV.staticEval(b, WHITE), -PAT.WIN);
});

test('staticEval 手番不对称：双方各一活三 → 走子方占优', () => {
  const b = mk([[5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK],   // 黑活三
                [5, 8, WHITE], [6, 8, WHITE], [7, 8, WHITE]]); // 白活三
  const vb = EV.staticEval(b, BLACK);
  const vw = EV.staticEval(b, WHITE);
  assert.ok(vb > 0 && vw > 0, '走子方因手番占优（两侧视角都应为正）');
  assert.equal(vb, 1000 - 600);   // V_stm(活三) - V_opp(活三)
  assert.equal(vw, vb);
});

test('evaluateMove：能成五的着法得分最高', () => {
  const b = mk([[6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK], [9, 7, BLACK]]);
  const winMove = EV.evaluateMove(b, 5, 7, BLACK);
  const far = EV.evaluateMove(b, 0, 0, BLACK);
  assert.ok(winMove > far, '成五着法应远高于无关点');
  assert.ok(winMove >= PAT.WIN, 'Atk 应达 WIN 量级，实际=' + winMove);
});

test('candidates：空盘给天元，否则只给邻域', () => {
  const e = mk([]);
  assert.deepEqual(EV.candidates(e, 2), [idxOf(7, 7)]);
  const b = put(mk([]), 7, 7, BLACK);
  const list = EV.candidates(b, 1);
  assert.ok(list.includes(idxOf(7, 7)) === false, '已落子点不应在候选内');
  assert.equal(list.length, 8, '半径1邻域应为 8 个空点');
});

/* ---------- §17.4 调参钩子（M9）----------
 * 契约：默认（未被工具覆盖时）必须**逐位等价于出厂表**；覆盖后生效；resetTune 后还原。
 * 还锁死两条安全不变量：连五/长连/禁手**不可调**（调它等于让引擎违反规则）。
 * 之所以必须有这组测试：tools/bench-tune.js 会在进程内改写这些表来跑对局，
 * 若钩子有泄漏（未还原/覆盖到不该覆盖的项），线上引擎会悄悄跑在调参中间态上。
 */
test('调参钩子：默认等价出厂，覆盖生效，reset 还原', () => {
  const s = PAT.tuneState();
  assert.equal(s.singleM, null, '初始不得有覆盖');
  assert.equal(s.singleT, null);
  assert.equal(s.levelM, null);

  const base = PAT.singleScore(PAT.P.OPEN_THREE, 'freestyle', 'black', 'stm');
  assert.equal(base, 1000, '出厂活三分值');

  PAT.setTune({ singleM: { 4: 3000 } });
  assert.equal(PAT.singleScore(PAT.P.OPEN_THREE, 'freestyle', 'black', 'stm'), 3000, '覆盖后生效');

  PAT.resetTune();
  assert.equal(PAT.singleScore(PAT.P.OPEN_THREE, 'freestyle', 'black', 'stm'), base, 'reset 后还原');
  assert.equal(PAT.tuneState().singleM, null);
});

test('调参钩子：连五/长连/禁手不可调（安全不变量）', () => {
  // 即便硬写进覆盖表，singleScore/levelScore 的短路也必须优先
  PAT.setTune({ singleM: { 7: 1, 8: 1 }, levelM: { 13: 1, 14: 1 } });
  assert.equal(PAT.singleScore(PAT.P.FIVE, 'freestyle', 'black', 'stm'), PAT.WIN);
  assert.equal(PAT.singleScore(PAT.P.OVERLINE, 'freestyle', 'black', 'stm'), PAT.WIN);
  assert.equal(PAT.singleScore(PAT.P.OVERLINE, 'renju', 'black', 'stm'), PAT.FORBIDDEN);
  assert.equal(PAT.levelScore(PAT.L.WIN, 'freestyle', 'black', 'stm'), PAT.WIN);
  assert.equal(PAT.levelScore(PAT.L.OVERLINE, 'renju', 'black', 'stm'), PAT.FORBIDDEN);
  PAT.resetTune();

  // LEVEL_M 覆盖生效并还原
  const m0 = PAT.levelScore(PAT.L.OPEN_THREE, 'freestyle', 'black', 'stm');
  PAT.setTune({ levelM: { 6: 7777 } });
  assert.equal(PAT.levelScore(PAT.L.OPEN_THREE, 'freestyle', 'black', 'stm'), 7777);
  PAT.resetTune();
  assert.equal(PAT.levelScore(PAT.L.OPEN_THREE, 'freestyle', 'black', 'stm'), m0);
});

test('调参钩子：staticEval 随覆盖变化且 reset 后逐位还原', () => {
  // 黑横活三 ×2（远处），白横活三 ×1；无人有四 → 不触发终局短路
  const b = mk([[7, 7, BLACK], [8, 7, BLACK], [9, 7, BLACK],
                [5, 12, BLACK], [4, 12, BLACK], [3, 12, BLACK],
                [7, 3, WHITE], [8, 3, WHITE], [9, 3, WHITE]]);
  const cfg = { rule: 'freestyle', overlineMode: 'rif' };
  const v0 = EV.staticEval(b, BLACK, cfg);
  assert.ok(Math.abs(v0) < PAT.WIN, '该局面不应触发终局短路，实际=' + v0);
  PAT.setTune({ singleM: { 4: 3000 } });
  const v1 = EV.staticEval(b, BLACK, cfg);
  assert.ok(v1 > v0, '提高活三价值后黑方评估应上升：' + v0 + ' -> ' + v1);
  PAT.resetTune();
  assert.equal(EV.staticEval(b, BLACK, cfg), v0, 'reset 后必须逐位还原');
});
