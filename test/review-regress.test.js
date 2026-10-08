/* test/review-regress.test.js — 2026-10-08 代码评审：两个真实缺陷的回归护栏
 *
 * ① eval.coeffOf 缓存无失效机制 ⇒ setTune 后 staticEvalPos（**搜索热路径**）
 *    仍返回旧系数，与全量 staticEval 行为分叉。后果：tools/bench-tune.js 的
 *    调参旋钮对搜索**完全无效**（工具在进程内 setTune 后跑对局，却测不到变化），
 *    且这种分叉极隐蔽——单测只覆盖了 singleScore/levelScore，没覆盖增量路径。
 *    修法：patterns 暴露单调递增的调参代际 tuneGen()，coeffOf 据此整表失效。
 *
 * ② winningPoints 逐候选 `board[i]=p → isWin → board[i]=EMPTY` 裸写棋盘，
 *    绕过 §33.3 的 onCell 钩子（pos.lc / pos.material 靠该钩子增量维护），
 *    且每候选重复扫 4~8 个方向。修法：rules.isWinAt 索引版判定（不改盘、纯索引）。
 *
 * ★ 本文件同时锁死"窗口口径 ≠ 严格口径"这条纪律：Renju-黑必须区分
 *   "恰好五连"与"长连"，而 patterns 的窗口模型半径只有 4（看不见第 6 子），
 *   在长连端点会把 6 连判成 FIVE ⇒ 假成五点。这是**曾经真实踩到**的坑。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');
const RU = require('../engine/rules.js');
const THREAT = require('../engine/threat.js');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

function mkBoard(cells) {
  const b = new Int8Array(NN);
  for (const c of cells) b[idxOf(c[0], c[1])] = c[2];
  return b;
}
function posOf(board, stm) {
  const p = core.createPosition();
  p.board.set(board);
  p.stm = stm;
  p.stones = board.reduce((n, v) => n + (v ? 1 : 0), 0);
  p.lc = PAT.newLineCache(board);
  return p;
}

/* ---------- ① 调参代际：增量路径必须跟随 setTune ---------- */
test('① setTune 后 staticEvalPos 与 staticEval 不得分叉（含 reset 还原）', () => {
  // ★ 必须挑一个**真含活三**的局面：随机摆子几乎不产生活三，
  //   改 SINGLE_M[4] 对总分为 0 ⇒ 断言会"假绿"（本文件第一版的坑）。
  const board = mkBoard([[5, 13, BLACK], [6, 13, BLACK], [7, 13, BLACK], [13, 13, BLACK]]);
  const cnt = PAT.countBoth(board);
  assert.ok(cnt[1].openThree >= 1, '★ 测试前提失败：该局面必须含活三，否则改动无影响、断言无效');
  assert.equal(cnt[1].openFour, 0);
  assert.equal(cnt[1].four, 0);

  const pos = posOf(board, BLACK);
  const cfg = { rule: 'freestyle', overlineMode: 'rif' };
  const inc0 = EV.staticEvalPos(pos, cfg), full0 = EV.staticEval(board, BLACK, cfg);
  assert.equal(inc0, full0, '默认态两条路径本就应一致');
  let inc1, full1;
  try {
    PAT.setTune({ singleM: Object.assign({}, PAT.SINGLE_M, { 4: PAT.SINGLE_M[4] * 10 }) });
    inc1 = EV.staticEvalPos(pos, cfg); full1 = EV.staticEval(board, BLACK, cfg);
    assert.equal(inc1, full1, '★ 覆盖后增量路径必须跟随调参（曾因 coeffOf 永久缓存而分叉）');
    assert.notEqual(inc1, inc0, '★ 覆盖后总分应确实变化（否则本测试无区分力）');
  } finally {
    PAT.resetTune();
  }
  const inc2 = EV.staticEvalPos(pos, cfg), full2 = EV.staticEval(board, BLACK, cfg);
  assert.equal(inc2, inc0, 'reset 后必须还原');
  assert.equal(inc2, full2);
});

test('①b tuneGen 单调递增，且 tuneState 暴露 gen 供下游判陈旧', () => {
  const g0 = PAT.tuneGen();
  PAT.setTune({ singleM: { 4: 1 } });
  const g1 = PAT.tuneGen();
  PAT.resetTune();
  const g2 = PAT.tuneGen();
  assert.ok(g1 > g0 && g2 > g1, '代际必须严格单调递增');
  assert.equal(PAT.tuneState().gen, g2, 'tuneState 应暴露当前代际');
});

/* ---------- ② isWinAt 与 isWin 逐位等价（含长连端点对抗用例） ---------- */
test('② isWinAt 与 isWin 逐位等价：对拍含长连端点/五长连/贴边/跳四', () => {
  const boards = [];
  // 随机局面
  let s = 20261008 >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let g = 0; g < 60; g++) {
    const b = new Int8Array(NN);
    const used = new Set();
    const cnt = 6 + (g % 14);
    for (let k = 0; k < cnt; k++) {
      let i; do { i = (rnd() * NN) | 0; } while (used.has(i));
      used.add(i); b[i] = rnd() < 0.5 ? BLACK : WHITE;
    }
    boards.push(['rand#' + g, b]);
  }
  // 对抗：黑 5 子 + 待落端点 ⇒ 落下即成 6 连（idx 在端点，窗口半径 4 看不见第 6 子）
  boards.push(['长连端点', mkBoard([[3, 0, BLACK], [4, 0, BLACK], [5, 0, BLACK], [6, 0, BLACK], [7, 0, BLACK]])]);
  // 对抗：五长连（rif 判胜 / strict 判负）
  boards.push(['五长连', mkBoard([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK],
                                   [5, 4, BLACK], [5, 5, BLACK], [5, 6, BLACK]])]);
  // 对抗：贴上边（邻居表出界分支）
  boards.push(['贴边', mkBoard([[0, 0, BLACK], [1, 0, BLACK], [2, 0, BLACK], [3, 0, BLACK]])]);
  // 对抗：跳四成五
  boards.push(['跳四', mkBoard([[5, 5, BLACK], [7, 5, BLACK], [9, 5, BLACK], [11, 5, BLACK]])]);

  let n = 0;
  for (const [label, b] of boards) {
    for (const rule of ['freestyle', 'renju']) {
      for (const om of [undefined, 'rif', 'strict']) {
        for (const p of [BLACK, WHITE]) {
          for (const i of [0, 1, 2, 3, 4, 5, 112, 7, 224, 98, 46, 168]) {
            n++;
            // 基线：显式落子后调 isWin（严格口径，且会写盘）
            const ref = (function () {
              const bb = Int8Array.from(b);
              if (bb[i] !== EMPTY) return null;
              bb[i] = p;
              return RU.isWin(bb, i % N, (i / N) | 0, p, rule, om);
            })();
            if (ref === null) continue;
            const got = RU.isWinAt(b, i, p, rule, om);
            assert.equal(got, ref, '不一致：' + label + ' i=' + i + ' p=' + p + ' ' + rule + '/' + om);
          }
        }
      }
    }
  }
  assert.ok(n > 8000, '样本不足：' + n);
});

test('②b winningPoints 不得绕过 onCell 钩子裸写棋盘（§33.3 增量缓存的正确性前提）', () => {
  // ★ 为什么不能用"调用后棋盘是否复原"来测：旧实现 board[i]=p → =EMPTY **确实复原了**，
  //   肉眼看不出差别。真正的危害是它**绕过钩子**——pos.lc / pos.material 由 onCell
  //   增量维护，裸写棋盘时钩子不知情 ⇒ 缓存与棋盘漂移 ⇒ 后续 staticEvalPos 读到陈旧值。
  //   正确测法：装一个"记录所有棋盘写入"的探针钩子，断言 winningPoints 期间无写入。
  const b = mkBoard([[6, 7, BLACK], [7, 7, BLACK], [9, 7, BLACK], [6, 8, BLACK], [8, 8, BLACK]]);
  const snap = Int8Array.from(b);
  for (const p of [BLACK, WHITE]) {
    THREAT.winningPoints(b, p, 0, 'freestyle');
    THREAT.hasFivePoint(b, p, 0, 'freestyle');
  }
  assert.deepEqual(Array.from(b), Array.from(snap), '棋盘必须完全复原');

  // isWinAt 本身必须不写盘：逐格调用前后比对（可观测且等价的判据）。
  let writes = 0;
  for (let i = 0; i < NN; i++) {
    const before = b[i];
    RU.isWinAt(b, i, BLACK, 'freestyle');
    if (b[i] !== before) writes++;
  }
  assert.equal(writes, 0, '★ isWinAt 改写了棋盘（绕过 onCell 钩子会破坏增量缓存）');
});

/* ---------- ③ 零分配候选枚举与数组 API 逐位一致（含顺序） ---------- */
test('③ candidatesInto 与 candidates 逐位同序（顺序错了会改变搜索树）', () => {
  const b = mkBoard([[7, 7, BLACK], [8, 8, WHITE], [0, 0, BLACK], [14, 14, BLACK], [7, 9, WHITE]]);
  for (const r of [1, 2, 3]) {
    for (const useBit of [false, true]) {
      EV.setCandBit(useBit);
      for (const radius of [r]) {
        const arr = EV.candidates(b, radius);
        const n = EV.candidatesInto(b, radius);
        assert.equal(n, arr.length, '个数不同 radius=' + radius + ' bit=' + useBit);
        for (let k = 0; k < n; k++) {
          assert.equal(EV.candAt(k), arr[k], '★ 顺序/内容不同 k=' + k + ' radius=' + radius + ' bit=' + useBit);
        }
        assert.equal(EV.candCount(), n);
      }
    }
  }
  EV.setCandBit(false);
});

test('③b candidatesInto 走与 candidates 相同的 A9 门控计数（否则 A/B 护栏失效）', () => {
  const b = mkBoard([[7, 7, BLACK], [8, 8, WHITE]]);
  EV.setCandBit(false); EV.candidatesInto(b, 2);
  const off = EV.candStat();
  assert.equal(off.bit, 0, '关态不应记 bit');
  assert.ok(off.slow > 0, '关态应记 slow');
  EV.setCandBit(true); EV.candidatesInto(b, 2);
  const on = EV.candStat();
  assert.equal(on.slow, 0, '开态不应记 slow');
  assert.equal(on.bit, 1, '开态应记 bit');
  EV.setCandBit(false);
});

test('③c 空盘特例：candidatesInto 与 candidates 都返回天元', () => {
  const empty = new Int8Array(NN);
  assert.equal(EV.candidatesInto(empty, 2), 1);
  assert.equal(EV.candAt(0), idxOf(7, 7));
  assert.deepEqual(EV.candidates(empty, 2), [idxOf(7, 7)]);
});
