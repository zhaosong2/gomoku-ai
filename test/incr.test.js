/* test/incr.test.js — M3b 增量评估（§33.3）单测
 * 核心不变量：增量结果必须与「全量线扫描」**逐位等价**；
 *            make/unmake 往返后缓存必须完全复原。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');
const SEARCH = require('../engine/search.js');

const { NN, N, EMPTY, BLACK, WHITE, idxOf } = core;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
const totSum = lc => Array.from(lc.tot).join(',');
const cnt = (c, k) => c[k];

test('线索引：CELL_LINES 与 LINES 完全一致', () => {
  assert.equal(PAT.LINES.length, 15 + 15 + 21 + 21, '横15+竖15+主斜21+副斜21（长度<5 的斜线被过滤）');
  const expect = new Map();
  for (let li = 0; li < PAT.LINES.length; li++) {
    for (const idx of PAT.LINES[li]) {
      if (!expect.has(idx)) expect.set(idx, []);
      expect.get(idx).push(li);
    }
  }
  for (let i = 0; i < NN; i++) {
    const want = (expect.get(i) || []).slice().sort((a, b) => a - b);
    const got = [];
    for (let s = 0; s < 4; s++) { const v = PAT.CELL_LINES[i * 4 + s]; if (v >= 0) got.push(v); }
    got.sort((a, b) => a - b);
    assert.deepEqual(got, want, '格点 ' + i + ' 归属线不一致');
  }
});

test('缓存合计 == 全量扫描（空盘 / 固定局面）', () => {
  const boards = [
    boardOf([]),
    boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK]]),
    boardOf([[5, 5, BLACK], [6, 6, BLACK], [7, 7, BLACK], [8, 8, BLACK], [9, 9, WHITE]]),
  ];
  for (const b of boards) {
    const lc = PAT.newLineCache(b);
    const both = PAT.countBoth(b);
    for (let p = 1; p <= 2; p++) {
      const off = PAT.sideOff(p), c = both[p];
      assert.equal(lc.tot[off + 0], c.five, 'five');
      assert.equal(lc.tot[off + 1], c.overline, 'overline');
      assert.equal(lc.tot[off + 2], c.openFour, 'openFour');
      assert.equal(lc.tot[off + 3], c.four, 'four');
      assert.equal(lc.tot[off + 4], c.openThree, 'openThree');
      assert.equal(lc.tot[off + 5], c.sleepThree, 'sleepThree');
      assert.equal(lc.tot[off + 6], c.openTwo, 'openTwo');
      assert.equal(lc.tot[off + 7], c.sleepTwo, 'sleepTwo');
    }
  }
});

test('随机对局逐步核对：增量合计 == 全量扫描，且 staticEvalPos == staticEval', () => {
  const rnd = core.mulberry32(12345);
  const pos = core.createPosition();
  SEARCH.attachCache(pos);
  const seq = [];
  for (let step = 0; step < 120; step++) {
    const empties = [];
    for (let i = 0; i < NN; i++) if (pos.board[i] === EMPTY) empties.push(i);
    if (!empties.length) break;
    const pick = empties[(rnd() * empties.length) | 0];
    const x = pick % N, y = (pick / N) | 0, player = pos.stm;
    core.makeMove(pos, x, y, player);
    seq.push([x, y]);

    // ① 计数逐位一致
    const both = PAT.countBoth(pos.board);
    for (let p = 1; p <= 2; p++) {
      const off = PAT.sideOff(p), c = both[p];
      assert.equal(pos.lc.tot[off + 0], c.five, 'step' + step + ' five');
      assert.equal(pos.lc.tot[off + 1], c.overline, 'step' + step + ' overline');
      assert.equal(pos.lc.tot[off + 2], c.openFour, 'step' + step + ' openFour');
      assert.equal(pos.lc.tot[off + 3], c.four, 'step' + step + ' four');
      assert.equal(pos.lc.tot[off + 4], c.openThree, 'step' + step + ' openThree');
      assert.equal(pos.lc.tot[off + 5], c.sleepThree, 'step' + step + ' sleepThree');
      assert.equal(pos.lc.tot[off + 6], c.openTwo, 'step' + step + ' openTwo');
      assert.equal(pos.lc.tot[off + 7], c.sleepTwo, 'step' + step + ' sleepTwo');
    }
    // ② 叶子评估一致（手番视角由 pos.stm 决定）
    for (const rule of ['freestyle', 'renju']) {
      assert.equal(
        EV.staticEvalPos(pos, { rule: rule }),
        EV.staticEval(pos.board, pos.stm, { rule: rule }),
        'step' + step + ' rule=' + rule);
    }
  }
  // ③ 全部回退后缓存必须复原
  const before = totSum(pos.lc);
  assert.equal(before, totSum(PAT.newLineCache(pos.board)), '回退前应一致');
  while (pos.hist.length) core.unmakeMove(pos);
  assert.equal(totSum(pos.lc), totSum(PAT.newLineCache(pos.board)), 'unmake 后必须复原');
});

test('unmake 往返：缓存字节级复原', () => {
  const pos = SEARCH.posFromBoard(boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK]]), WHITE);
  const snap = Array.from(pos.lc.lines).join(',');
  core.makeMove(pos, 6, 8, WHITE);
  core.makeMove(pos, 9, 9, BLACK);
  core.unmakeMove(pos);
  core.unmakeMove(pos);
  assert.equal(Array.from(pos.lc.lines).join(','), snap, 'lines 应完全复原');
});

test('增量评估不得改变搜索结论（回归）', () => {
  const seq = [[7, 7], [7, 6], [8, 6], [6, 6], [8, 8], [6, 7]];
  const pos = core.createPosition();
  let t = BLACK;
  for (const m of seq) { core.makeMove(pos, m[0], m[1], t); t = core.opp(t); }
  const list = SEARCH.bestMoves(pos.board, pos.stm, { depth: 2, width: 10, ttBits: 12 }, 6);
  for (const m of list) {
    assert.ok(Math.abs(m.v) < PAT.WIN - 1000, '不应出现假杀：(' + m.x + ',' + m.y + ')=' + m.v);
  }
  // 一步成五仍然必取
  const win = SEARCH.think(SEARCH.posFromBoard(
    boardOf([[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [3, 7, WHITE]]), BLACK),
    { maxDepth: 4, hardLimit: 1000, ttBits: 12 });
  assert.deepEqual(win.move, { x: 8, y: 7 });
});

test('不变量：带缓存的 think 后棋盘与缓存都复原', () => {
  const stones = [[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK], [6, 6, WHITE]];
  const pos = SEARCH.posFromBoard(boardOf(stones), BLACK);
  const before = Array.from(pos.board);
  SEARCH.think(pos, { maxDepth: 4, hardLimit: 2000, ttBits: 12 });
  assert.deepEqual(Array.from(pos.board), before, '棋盘应复原');
  assert.equal(pos.stm, BLACK, '走子方应复原');
  assert.equal(totSum(pos.lc), totSum(PAT.newLineCache(pos.board)), '缓存应复原');
});

test('性能：叶子评估提速 + 搜索不退化', () => {
  const stones = [[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK],
                  [6, 7, WHITE], [6, 5, BLACK], [9, 7, WHITE], [10, 7, BLACK], [5, 8, WHITE]];
  const b = boardOf(stones);

  // ① 叶子评估：增量应显著快于全量扫描（这是 M3b 的核心指标）
  const pos = SEARCH.posFromBoard(b, BLACK);
  const R = 100000;
  EV.staticEval(b, BLACK, { rule: 'freestyle' });
  EV.staticEvalPos(pos, { rule: 'freestyle' });
  let t0 = Date.now();
  for (let k = 0; k < R; k++) EV.staticEval(b, BLACK, { rule: 'freestyle' });
  const tFull = Date.now() - t0;
  t0 = Date.now();
  for (let k = 0; k < R; k++) EV.staticEvalPos(pos, { rule: 'freestyle' });
  const tIncr = Date.now() - t0;
  console.log('     叶子评估 x' + R + '：全量 ' + tFull + 'ms / 增量 ' + tIncr + 'ms（' +
    (tFull / Math.max(1, tIncr)).toFixed(1) + 'x）');
  assert.ok(tIncr * 3 < tFull, '增量叶子评估应快 3 倍以上：' + tIncr + 'ms vs ' + tFull + 'ms');

  // ② 搜索端到端：节点数必须完全一致（评估等价 ⇒ 树相同）
  //    注：用浅深度 + 充裕时限，避免并行跑测试时争抢 CPU 触发超时导致树不同（曾出现过 flaky）
  const cfg = { maxDepth: 6, width: 14, hardLimit: 20000, ttBits: 18 };
  // ★ 两次运行前都必须清 TT：ttInit 在同尺寸下会复用旧表，否则结果不可比
  SEARCH.ttClear();
  const off = SEARCH.think(SEARCH.posFromBoard(b, BLACK), Object.assign({}, cfg, { incr: false }));
  SEARCH.ttClear();
  const on = SEARCH.think(SEARCH.posFromBoard(b, BLACK), cfg);
  console.log('     incr=false: ' + off.timeMs + 'ms / ' + off.nodes + '节点 / depth ' + off.depth +
    ' | incr=true: ' + on.timeMs + 'ms / ' + on.nodes + '节点 / depth ' + on.depth);
  assert.equal(on.nodes, off.nodes, '节点数应一致');
  assert.equal(on.depth, off.depth, '到达深度应一致');
  // 端到端耗时只做宽容检查（并行环境下墙钟噪声大，不作为严格指标）
  assert.ok(on.timeMs <= off.timeMs * 1.5, '增量不应明显变慢：' + on.timeMs + 'ms vs ' + off.timeMs + 'ms');
});
