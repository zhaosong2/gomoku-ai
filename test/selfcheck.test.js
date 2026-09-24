/* test/selfcheck.test.js — A13 增量结构 `assert` 自检单测（§4.13 / §5.5.6 A13 行）
 *
 * 出口判据（施工图 §4.13）：
 *   ① 自检**必须真能爆**（故意构造不一致 ⇒ 必 fail）——防"永远绿的测试"
 *      （`test-methodology.md` §2.1 的 T1 根因）。
 *   ② **不夹带进 `worker-src`**（`worker.test.js` 扩展校验）。
 *   ③ `cfg.assertIncr` 默认 **false** ⇒ 生产路径零开销（连模块都不 require）。
 *   ④ 正常路径（增量维护正确时）**不得误报**——随机对局逐步自检 0 差异。
 *
 * ★ 关键纪律：自检挂在**两相 notifyCell 全部完成之后**（core.js:makeMove/unmakeMove 末尾）；
 *   若挂在中间会看到"半更新"状态而误报。
 * ★ 自检对象按"当前已落地"如实裁剪：`lc`（§33.3）+ `material`（A6）；
 *   `see`（A8）**未落地**（批 4 已砍）⇒ `coverage()` 显式标注，避免假安全感。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const SC = require('../engine/selfcheck.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

// 用与引擎热路径**同源**的钩子挂法（照抄 search.js:cellHook 语义，含 'pre'/'post' 两相）
function attachIncr(pos) {
  const line4 = new Int32Array(4 * 2 * PAT.NCLS);
  const lineCur = new Int32Array(PAT.NCLS);
  pos.lc = PAT.newLineCache(pos.board);
  pos.material = PAT.materialOf(pos.board);
  pos.onCell = function (p, idx, phase) {
    if (p.lc) PAT.cacheUpdate(p.lc, idx, p.board);
    if (p.material) {
      if (phase === 'pre') PAT.lines4Counts(p.board, idx, line4);
      else PAT.materialInc(p.material, idx, p.board, line4, 0, lineCur);
    }
  };
  pos.assertIncr = SC.assertIncrementalStructures;
  return pos;
}
function freshPos() { const p = core.createPosition(); attachIncr(p); return p; }

/* ---------- ④ 正常路径不得误报：随机对局逐步自检 0 差异 ---------- */
test('④ ★ 随机对局逐步自检：正确增量维护下 0 差异（不得误报）', () => {
  SC.setAssertIncr(true);
  let steps = 0, movedErr = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const p = freshPos();                       // 内部已挂 assertIncr ⇒ make/unmake 当场自检
    const rnd = core.mulberry32(seed);
    let player = BLACK;
    for (let k = 0; k < 60; k++) {
      const i = (rnd() * NN) | 0;
      if (p.board[i] !== EMPTY) continue;
      try { core.makeMove(p, i % N, (i / N) | 0, player); }
      catch (e) { movedErr++; break; }
      steps++;
      player = core.opp(player);
    }
    // 逐个撤销，同样逐步自检（往返复原守卫）
    while (p.hist.length) {
      try { core.unmakeMove(p); } catch (e) { movedErr++; break; }
    }
    const d = SC.checkIncrementalStructures(p);
    assert.equal(d.length, 0, 'seed=' + seed + ' 撤销完仍在 ' + d.length + ' 处不一致');
  }
  assert.ok(steps > 1500, '样本不足：' + steps);
  assert.equal(movedErr, 0, '正常路径不应触发自检异常，实测 ' + movedErr + ' 次');
  SC.setAssertIncr(false);
});

/* ---------- ① 自检必须真能爆：破坏 lc 增量维护 ⇒ 必 fail ---------- */
// ★ 注意两件事分开验：
//   (a) checkIncrementalStructures 能**检出**差异（直接调用，不挂钩子）
//   (b) 挂钩子后 makeMove **真的会 throw**（I-neg 的"当场爆"语义）
//   若挂钩子后再调 checkIncrementalStructures，异常早已在 makeMove 内抛出、走不到断言。
const SC_LC = 'lc';
test('① ★ I-neg(lc)：故意不维护 lc ⇒ 自检必须爆（防"永远绿的测试"）', () => {
  SC.setAssertIncr(true);
  const p = core.createPosition();
  // 先造一个必有棋型的局面（两子相邻）
  core.makeMove(p, 7, 7, BLACK); core.makeMove(p, 0, 0, WHITE); core.makeMove(p, 8, 7, BLACK);
  p.lc = PAT.newLineCache(p.board);
  p.material = null;                            // 只验 lc
  p.onCell = null;                              // ★ 故意不维护 ⇒ lc 停在"三手前"的状态
  p.assertIncr = null;                          // (a) 先看"检出能力"：不挂钩子
  // 落第 4 手成三连（必改变 lc）
  core.makeMove(p, 9, 7, BLACK);
  const d = SC.checkIncrementalStructures(p);
  assert.ok(d.length > 0, '★ 自检未爆：lc 已停更却不报错（测试是"永远绿的"）');
  assert.ok(d.every(x => String(x.what).startsWith(SC_LC)),
            '应只报 lc 类差异，实测 ' + JSON.stringify(d.slice(0, 3)));
  // (b) 挂钩子 ⇒ 同样场景必须在 makeMove 内当场 throw
  const q = core.createPosition();
  core.makeMove(q, 7, 7, BLACK); core.makeMove(q, 0, 0, WHITE); core.makeMove(q, 8, 7, BLACK);
  q.lc = PAT.newLineCache(q.board); q.material = null; q.onCell = null;
  q.assertIncr = SC.assertIncrementalStructures;
  assert.throws(() => core.makeMove(q, 9, 7, BLACK), /A13 自检失败/,
                '★ 钩子未在 makeMove 内当场抛出（I-neg 失效）');
  SC.setAssertIncr(false);
});

/* ---------- ①b 自检必须真能爆：破坏 material ⇒ 必 fail ---------- */
test('①b ★ I-neg(material)：故意不维护 material ⇒ 自检必须爆', () => {
  SC.setAssertIncr(true);
  const p = core.createPosition();
  core.makeMove(p, 5, 5, BLACK); core.makeMove(p, 0, 0, WHITE); core.makeMove(p, 6, 5, BLACK);
  p.lc = null;                                  // 只验 material
  p.material = PAT.materialOf(p.board);         // 三手后建表
  p.onCell = null;                              // ★ 故意不维护
  p.assertIncr = null;
  core.makeMove(p, 7, 5, BLACK);                // 成三连 ⇒ material 必变
  const d = SC.checkIncrementalStructures(p);
  assert.ok(d.length > 0, '★ 自检未爆：material 已停更却不报错');
  assert.ok(d.some(x => x.what === 'material'), '应报 material 类差异');
  // 挂钩子 ⇒ 必须当场 throw
  const q = core.createPosition();
  core.makeMove(q, 5, 5, BLACK); core.makeMove(q, 0, 0, WHITE); core.makeMove(q, 6, 5, BLACK);
  q.lc = null; q.material = PAT.materialOf(q.board); q.onCell = null;
  q.assertIncr = SC.assertIncrementalStructures;
  assert.throws(() => core.makeMove(q, 7, 5, BLACK), /A13 自检失败/,
                '★ 钩子未在 makeMove 内当场抛出（I-neg 失效）');
  SC.setAssertIncr(false);
});

/* ---------- ③ 默认关：不设 assertIncr ⇒ 落子不受任何影响 ---------- */
test('③ ★ 默认关：不挂 assertIncr ⇒ 落子/撤销完全不受影响（生产零开销）', () => {
  SC.setAssertIncr(false);
  const p = core.createPosition();
  p.lc = PAT.newLineCache(p.board);
  p.material = PAT.materialOf(p.board);
  p.onCell = function (q, idx, phase) { if (q.lc) PAT.cacheUpdate(q.lc, idx, q.board); };
  assert.equal(p.assertIncr, null, '新建 pos 的 assertIncr 必须为 null');
  for (let k = 0; k < 20; k++) core.makeMove(p, k % N, 0, k % 2 ? BLACK : WHITE);
  for (let k = 0; k < 20; k++) core.unmakeMove(p);
  assert.equal(p.hist.length, 0, '撤销应回到空盘');
  // 即使把开关打开，但 pos 未挂钩子 ⇒ 仍不发散
  SC.setAssertIncr(true);
  core.makeMove(p, 7, 7, BLACK);
  core.unmakeMove(p);
  SC.setAssertIncr(false);
});

/* ---------- ⑤ 自检覆盖如实标注（see 未落地不得假装覆盖） ---------- */
test('⑤ coverage 如实标注：lc/material 覆盖，see 未落地（A8 已砍）', () => {
  const c = SC.coverage();
  assert.equal(c.lc, true);
  assert.equal(c.material, true);
  assert.equal(c.see, false, '★ A8 已砍 ⇒ see 必须显式 false（防止假安全感）');
  assert.ok(/A8/.test(c.note), '备注应说明 see 未落地的原因');
});

/* ---------- ⑥ 与搜索集成：think 全程挂自检，结论不变 + 0 异常 ---------- */
test('⑥ ★ 搜索集成：think 全程挂 assertIncr ⇒ 结论不变、零异常', () => {
  const P40 = require('./data/positions40.json');
  const CFG = { difficulty: 'hard', useBook: false, rule: 'freestyle', maxDepth: 3, hardLimit: 20000,
                vcfDepth: 0, vctDepth: 0, avoidOpp: false, incr: true, incrMaterial: true };
  let ok = 0, err = 0, diff = 0;
  for (let k = 0; k < 8; k++) {
    const p = P40[k];
    // 基线（无自检）
    SEARCH.ttClear();
    const base = SEARCH.think(SEARCH.posFromBoard(Int8Array.from(p.board), p.stm, p.hist),
                              Object.assign({}, CFG));
    // 带自检：用 attachIncr 手工挂钩子 + assertIncr
    SEARCH.ttClear();
    const pos = SEARCH.posFromBoard(Int8Array.from(p.board), p.stm, p.hist);
    SEARCH.attachIncr(pos, Object.assign({}, CFG));
    pos.assertIncr = SC.assertIncrementalStructures;
    SC.setAssertIncr(true);
    let got = null;
    try { got = SEARCH.think(pos, Object.assign({}, CFG)); } catch (e) { err++; SC.setAssertIncr(false); continue; }
    SC.setAssertIncr(false);
    if (!base || !got) continue;
    ok++;
    if (base.move.x !== got.move.x || base.move.y !== got.move.y || base.score !== got.score) {
      diff++;
      console.log('  DIFF #' + k + ' base=' + JSON.stringify(base.move) + '/' + base.score +
                  ' got=' + JSON.stringify(got.move) + '/' + got.score);
    }
  }
  assert.equal(err, 0, '★ 自检在真实搜索中不应抛异常，实测 ' + err + ' 次');
  assert.equal(diff, 0, '★ 挂自检不得改变搜索结论，diff=' + diff);
  assert.ok(ok >= 6, '有效样本不足：' + ok);
});

/* ---------- ⑦ 往返复原：make→unmake 后 lc/material 与初始逐位一致 ---------- */
test('⑦ ★ 往返复原：落子后撤销，lc/material 与初始快照逐位一致', () => {
  const p = freshPos();
  const lc0 = Array.from(p.lc.tot), mat0 = Array.from(p.material);
  const rnd = core.mulberry32(20260921);
  let player = BLACK;
  const placed = [];
  for (let k = 0; k < 30; k++) {
    const i = (rnd() * NN) | 0;
    if (p.board[i] !== EMPTY) continue;
    core.makeMove(p, i % N, (i / N) | 0, player);
    placed.push(i); player = core.opp(player);
  }
  assert.ok(placed.length >= 20, '落子样本不足：' + placed.length);
  while (p.hist.length) core.unmakeMove(p);
  assert.deepEqual(Array.from(p.lc.tot), lc0, '撤销后 lc.tot 未复原');
  assert.deepEqual(Array.from(p.material), mat0, '撤销后 material 未复原');
  assert.equal(p.stones, 0, '撤销后 stones 应为 0');
});
