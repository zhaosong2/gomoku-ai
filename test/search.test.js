/* test/search.test.js — M3 搜索单测
 * 覆盖：立即取胜 / 必应封堵 / 强制取胜 / 时限降级 / 棋盘复原不变量 / TT 确定性 / bestMoves 兼容
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');

const { NN, EMPTY, BLACK, WHITE, idxOf } = core;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
function posOf(stones, stm) { return SEARCH.posFromBoard(boardOf(stones), stm); }

test('立即取胜（L0）：一步成五直接返回', () => {
  const pos = posOf([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [3, 7, WHITE]], BLACK);
  const r = SEARCH.think(pos, { maxDepth: 4, hardLimit: 1000, ttBits: 12 });
  assert.deepEqual(r.move, { x: 8, y: 7 });
  assert.ok(r.score >= PAT.WIN - 10);
});

test('必应封堵（L0）：对方一子成五，必须封唯一成五点', () => {
  const pos = posOf([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [3, 7, WHITE]], WHITE);
  const r = SEARCH.think(pos, { maxDepth: 2, hardLimit: 1000, ttBits: 12 });
  assert.deepEqual(r.move, { x: 8, y: 7 });
});

test('强制取胜：活三 → 活四 → 成五（depth 4 内可见）', () => {
  const pos = posOf([[5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [0, 0, WHITE], [1, 0, WHITE]], BLACK);
  const r = SEARCH.think(pos, { maxDepth: 6, hardLimit: 5000, width: 12, ttBits: 14 });
  assert.ok(r.score >= PAT.WIN - 100, '应看到必胜，实际 score=' + r.score + ' depth=' + r.depth);
  const b = boardOf([]);
  assert.ok(r.move.x >= 0 && r.move.x < 15 && r.move.y >= 0 && r.move.y < 15);
});

test('时限降级：极短时限仍返回合法空点且迅速返回', () => {
  const pos = posOf([[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK]], BLACK);
  const t0 = Date.now();
  const r = SEARCH.think(pos, { maxDepth: 10, hardLimit: 1, ttBits: 12 });
  const dt = Date.now() - t0;
  assert.ok(r && r.move, '必须返回着法（不允许空手）');
  assert.equal(pos.board[idxOf(r.move.x, r.move.y)], EMPTY, '必须落在空点');
  assert.ok(dt < 500, '应迅速返回，实际 ' + dt + 'ms');
});

test('不变量：think 后棋盘必须完全复原', () => {
  const stones = [[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK], [6, 6, WHITE]];
  const pos = posOf(stones, BLACK);
  const before = Array.from(pos.board);
  SEARCH.think(pos, { maxDepth: 4, hardLimit: 2000, ttBits: 12 });
  assert.deepEqual(Array.from(pos.board), before, '搜索不得残留落子');
  assert.equal(pos.stm, BLACK, '走子方应复原');
});

test('确定性：同局面同参数两次搜索给出一致着法', () => {
  const stones = [[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK], [6, 6, WHITE], [8, 6, BLACK]];
  const a = SEARCH.think(posOf(stones, WHITE), { maxDepth: 4, hardLimit: 3000, ttBits: 14 });
  const b = SEARCH.think(posOf(stones, WHITE), { maxDepth: 4, hardLimit: 3000, ttBits: 14 });
  assert.deepEqual(a.move, b.move);
  assert.ok(a.nodes > 0, '应有节点访问');
});

test('bestMoves（兼容接口）首位为取胜着法', () => {
  const b = boardOf([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [3, 7, WHITE]]);
  const list = SEARCH.bestMoves(b, BLACK, { depth: 2, width: 8, ttBits: 12 }, 3);
  assert.ok(list.length > 0);
  assert.equal(list[0].x, 8);
  assert.equal(list[0].y, 7);
});

test('回归：不得出现"假杀"分值（防守紧要手必须进入候选）', () => {
  // 曾经的 bug：排序把防守项压成噪声 → 唯一的堵点被宽度裁剪丢掉 → 搜索误判必败
  const seq = [[7, 7], [7, 6], [8, 6], [6, 6], [8, 8], [6, 7]];
  const pos = core.createPosition();
  let t = BLACK;
  for (const m of seq) { core.makeMove(pos, m[0], m[1], t); t = core.opp(t); }
  const list = SEARCH.bestMoves(pos.board, pos.stm, { depth: 2, width: 10, ttBits: 12 }, 6);
  for (const m of list) {
    assert.ok(Math.abs(m.v) < PAT.WIN - 1000, '不应出现假杀：(' + m.x + ',' + m.y + ')=' + m.v);
  }
  // 黑落 (8,5) 后白方必须能找到防守（不能全负）
  const b2 = pos.board.slice();
  b2[idxOf(8, 5)] = BLACK;
  const wl = SEARCH.bestMoves(b2, WHITE, { depth: 2, width: 12, ttBits: 12 }, 6);
  assert.ok(wl[0].v > -(PAT.WIN - 1000), '白方应能防住，实际最优=' + wl[0].v);
});

test('winningPoints：正确识别成五点', () => {
  const b = boardOf([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [3, 7, WHITE]]);
  const w = SEARCH.winningPoints(b, BLACK);
  assert.deepEqual(w, [idxOf(8, 7)]);
});
