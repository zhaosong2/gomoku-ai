/* test/rules.test.js — M1 单元测试（引擎零依赖，Node 内置 test runner）
 * 运行： node --test gomoku/test/rules.test.js
 * 设计依据：§31 测试用例、§34.9
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const rules = require('../engine/rules.js');

// 交替落子（从黑开始），返回最后一手的走子方与坐标
function playAlternating(seq) {
  const pos = core.createPosition();
  let turn = core.BLACK;
  let last = null;
  for (const [x, y] of seq) {
    assert.ok(core.makeMove(pos, x, y, turn), 'illegal move ' + x + ',' + y);
    last = { x, y, player: turn };
    turn = core.opp(turn);
  }
  return { pos, last };
}

test('横向五连判胜 + 连线长度正确', () => {
  const { pos, last } = playAlternating([
    [3, 7], [3, 8],
    [4, 7], [4, 8],
    [5, 7], [5, 8],
    [6, 7], [6, 8],
    [7, 7],
  ]);
  assert.equal(last.player, core.BLACK);
  assert.ok(rules.isWin(pos.board, 7, 7, core.BLACK));
  assert.equal(rules.winningLine(pos.board, 7, 7, core.BLACK).length, 5);
});

test('纵向五连判胜', () => {
  const { pos } = playAlternating([
    [7, 1], [0, 0],
    [7, 2], [1, 0],
    [7, 3], [2, 0],
    [7, 4], [3, 0],
    [7, 5],
  ]);
  assert.ok(rules.isWin(pos.board, 7, 5, core.BLACK));
});

test('斜向↘五连判胜', () => {
  const { pos } = playAlternating([
    [2, 2], [0, 14],
    [3, 3], [1, 14],
    [4, 4], [2, 14],
    [5, 5], [3, 14],
    [6, 6],
  ]);
  assert.ok(rules.isWin(pos.board, 6, 6, core.BLACK));
});

test('斜向↙五连判胜', () => {
  const { pos } = playAlternating([
    [6, 2], [0, 14],
    [5, 3], [1, 14],
    [4, 4], [2, 14],
    [3, 5], [3, 14],
    [2, 6],
  ]);
  assert.ok(rules.isWin(pos.board, 2, 6, core.BLACK));
});

test('四连不判胜', () => {
  const { pos } = playAlternating([
    [3, 7], [3, 8],
    [4, 7], [4, 8],
    [5, 7], [5, 8],
    [6, 7],
  ]);
  assert.equal(rules.maxRun(pos.board, 6, 7, core.BLACK), 4);
  assert.ok(!rules.isWin(pos.board, 6, 7, core.BLACK));
  assert.equal(rules.winningLine(pos.board, 6, 7, core.BLACK), null);
});

test('无禁手：长连(6)亦判胜', () => {
  const { pos } = playAlternating([
    [3, 7], [0, 0],
    [4, 7], [1, 0],
    [5, 7], [2, 0],
    [6, 7], [0, 1],
    [7, 7], [1, 1],
    [8, 7],
  ]);
  assert.equal(rules.maxRun(pos.board, 8, 7, core.BLACK), 6);
  assert.ok(rules.isWin(pos.board, 8, 7, core.BLACK));
  assert.equal(rules.winningLine(pos.board, 8, 7, core.BLACK).length, 6);
});

test('make/unmake 正确回滚（手数 / 走子方 / Zobrist）', () => {
  const pos = core.createPosition();
  const init = { hi: pos.zobHi, lo: pos.zobLo };
  core.makeMove(pos, 7, 7, core.BLACK);
  const after = { hi: pos.zobHi, lo: pos.zobLo };
  assert.equal(pos.stones, 1);
  assert.equal(pos.stm, core.WHITE);
  assert.notEqual(after.hi === init.hi && after.lo === init.lo, true, 'Zobrist 应发生变化');

  core.unmakeMove(pos);
  assert.equal(pos.stones, 0);
  assert.equal(pos.stm, core.BLACK);
  assert.equal(pos.zobHi, init.hi);
  assert.equal(pos.zobLo, init.lo);
});

test('Zobrist 与落子顺序无关（可交换局面哈希一致）', () => {
  const a = core.createPosition();
  core.makeMove(a, 3, 3, core.BLACK);
  core.makeMove(a, 4, 4, core.WHITE);
  const b = core.createPosition();
  core.makeMove(b, 4, 4, core.WHITE);
  core.makeMove(b, 3, 3, core.BLACK);
  assert.equal(a.zobHi, b.zobHi);
  assert.equal(a.zobLo, b.zobLo);
});

test('重复落子被拒绝', () => {
  const pos = core.createPosition();
  assert.ok(core.makeMove(pos, 7, 7, core.BLACK));
  assert.equal(core.makeMove(pos, 7, 7, core.WHITE), false);
});
