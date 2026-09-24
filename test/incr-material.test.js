/* test/incr-material.test.js — A6 增量材料表单测（§4.7 / §5.5.6 A6 行）
 *
 * 出口判据（施工图 §5 第 3 批 / §5.5.6）：
 *   ① 与全量重数**逐局面一致**（不一致 == 0，**硬红线**）
 *   ② make/unmake 往返后缓存**完全复原**
 *   ③ **I-neg**：故意破坏一个计数 ⇒ 自检必须爆（防"永远绿的测试"）
 *   另加：口径与 lc.tot / countBoth 逐位一致（三口径互证）、renju 无副作用、
 *        cfg.incrMaterial 默认关（现状零开销）、搜索端节点数不退化。
 *
 * ★ 实测踩坑留档（2026-09-20，本测试即为回归护栏）：
 *   首版 `materialIncFrom` 把"变化前/变化后"两次读取都放在棋盘**已更新**之后，
 *   两次读到同一份内容 ⇒ 净变化恒为 0 ⇒ 缓存单向漂移（2400 步里 2026 步偏离）。
 *   根因是 `pos.onCell` 只有单一相位（变化后）。修复 = core.js 给钩子
 *   `'pre'`/`'post'` 两相、cellHook 在 pre 存快照、post 求差。
 *   本文件用例 ① / ⑤ 精确覆盖该缺陷（旧实现必挂）。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const NCLS = PAT.NCLS;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
// 材料表 → 与 countBoth 同构的对象，便于逐类断言
const matOf = (m, p) => {
  const off = p === BLACK ? 0 : NCLS, c = {};
  ['five', 'overline', 'openFour', 'four', 'openThree', 'sleepThree', 'openTwo', 'sleepTwo']
    .forEach((k, t) => { c[k] = m[off + t]; });
  return c;
};
const eqFull = (m, board, tag) => {
  const both = PAT.countBoth(board);
  for (const p of [BLACK, WHITE]) {
    const a = matOf(m, p), b = both[p];
    for (const k of Object.keys(b)) assert.equal(a[k], b[k], tag + ' ' + (p === BLACK ? '黑' : '白') + '.' + k);
  }
};

test('① 全量建表 materialOf == countBoth == 全量线扫描（逐位）', () => {
  const boards = [
    boardOf([]),
    boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK]]),
    boardOf([[5, 5, BLACK], [6, 6, BLACK], [7, 7, BLACK], [8, 8, BLACK], [9, 9, WHITE]]),
    boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, WHITE], [7, 7, BLACK]]),
  ];
  for (let s = 0; s < 200; s++) {
    const b = new Int8Array(NN), rnd = core.mulberry32(s);
    const n = (rnd() * 30) | 0;
    for (let k = 0; k < n; k++) { const i = (rnd() * NN) | 0; if (b[i] === EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE; }
    boards.push(b);
  }
  for (let bi = 0; bi < boards.length; bi++) {
    const b = boards[bi];
    eqFull(PAT.materialOf(b), b, '局面' + bi);
    // 与 lc.tot 同布局 ⇒ 必须逐位相等（两套结构同口径的硬证据）
    const lc = PAT.newLineCache(b), m = PAT.materialOf(b);
    for (let t = 0; t < 2 * NCLS; t++) assert.equal(m[t], lc.tot[t], '局面' + bi + ' lc.tot[' + t + ']');
  }
});

test('② ★ 增量维护 == 全量重数（逐局面一致，硬红线）', () => {
  const buf = new Int32Array(4 * 2 * NCLS);
  let bad = 0, steps = 0;
  for (let seed = 0; seed < 40; seed++) {
    const pos = core.createPosition();
    pos.material = PAT.materialOf(pos.board);
    const rnd = core.mulberry32(seed);
    for (let k = 0; k < 60; k++) {
      let i = (rnd() * NN) | 0, guard = 0;
      while (pos.board[i] !== EMPTY && guard++ < 999) i = (rnd() * NN) | 0;
      if (pos.board[i] !== EMPTY) break;
      // 与 cellHook 同口径的手工维护（pre 快照 → make → 求差）
      PAT.lines4Counts(pos.board, i, buf);
      core.makeMove(pos, i % N, (i / N) | 0, pos.stm);
      PAT.materialInc(pos.material, i, pos.board, buf, 0);
      steps++;
      const full = PAT.materialOf(pos.board);
      for (let t = 0; t < 2 * NCLS; t++) if (pos.material[t] !== full[t]) { bad++; break; }
    }
  }
  console.log('     [效应量] 增量 vs 全量：不一致 ' + bad + '/' + steps + ' 步（硬红线必须 0）');
  assert.equal(bad, 0, '增量材料计数与全量重数不一致：' + bad);
});

test('③ make/unmake 往返后材料表完全复原', () => {
  const buf = new Int32Array(4 * 2 * NCLS);
  let fail = 0;
  for (let seed = 0; seed < 40; seed++) {
    const pos = core.createPosition();
    pos.material = PAT.materialOf(pos.board);
    const base = Array.from(pos.material);
    const rnd = core.mulberry32(seed);
    const seq = [];
    for (let k = 0; k < 50; k++) {
      let i = (rnd() * NN) | 0, guard = 0;
      while (pos.board[i] !== EMPTY && guard++ < 999) i = (rnd() * NN) | 0;
      if (pos.board[i] !== EMPTY) break;
      PAT.lines4Counts(pos.board, i, buf);
      core.makeMove(pos, i % N, (i / N) | 0, pos.stm);
      PAT.materialInc(pos.material, i, pos.board, buf, 0);
      seq.push(i);
    }
    for (let k = seq.length - 1; k >= 0; k--) {
      const i = seq[k];
      PAT.lines4Counts(pos.board, i, buf);
      core.unmakeMove(pos);
      PAT.materialInc(pos.material, i, pos.board, buf, 0);
    }
    const now = Array.from(pos.material);
    if (now.join(',') !== base.join(',')) fail++;
  }
  assert.equal(fail, 0, '往返后材料表未复原的种子数：' + fail);
});

test('④ ★ I-neg：故意破坏一个计数 ⇒ 自检必须捕获（防永远绿的测试）', () => {
  // 自检 = "增量 vs 全量"，与 §4.13 / A13 同构（此处以断言形式内联，便于独立跑）
  const buf = new Int32Array(4 * 2 * NCLS);
  const pos = core.createPosition();
  pos.material = PAT.materialOf(pos.board);
  const seq = [[7, 7], [7, 6], [8, 6], [6, 6]];
  for (const [x, y] of seq) {
    const i = idxOf(x, y);
    PAT.lines4Counts(pos.board, i, buf);
    core.makeMove(pos, x, y, pos.stm);
    PAT.materialInc(pos.material, i, pos.board, buf, 0);
  }
  const check = () => {
    const full = PAT.materialOf(pos.board);
    for (let t = 0; t < 2 * NCLS; t++) if (pos.material[t] !== full[t]) return t;
    return -1;
  };
  assert.equal(check(), -1, '前置：正常维护时不应有偏差');

  // 人为破坏：把"活二"计数 +1（模拟漂移）
  const victim = matOf(pos.material, BLACK).openTwo !== undefined ? 2 : 2;   // 槽位 2 = 活二
  pos.material[victim] += 1;
  const t = check();
  assert.notEqual(t, -1, '★ 自检必须爆：被破坏的计数未被捕获 ⇒ 测试是"永远绿"的废测试');
  assert.equal(t, victim, '应变在被动过的槽位上');

  // 复原后应重新一致
  pos.material[victim] -= 1;
  assert.equal(check(), -1, '复原后应重新一致');
});

test('⑤ ★ 回归：白子之间的空点被黑填掉时，白活二必须消失（首版漂移缺陷）', () => {
  // 场景：对角线上白(10,8)、白(11,9) 相间留空（12,10）；黑落 (12,10) 后白活二应消失。
  // 首版（两次读取都在棋盘已更新后）净变化恒 0 ⇒ 这里会留下错误的 +1。
  const pos = core.createPosition();
  const setup = [[10, 8, WHITE], [11, 9, WHITE], [0, 0, BLACK]];
  for (const [x, y, c] of setup) { pos.board[idxOf(x, y)] = c; pos.stones++; }
  pos.material = PAT.materialOf(pos.board);
  const before = matOf(pos.material, WHITE).openTwo;
  assert.ok(before >= 1, '前置：白应有活二，实测 ' + before);

  const buf = new Int32Array(4 * 2 * NCLS);
  const i = idxOf(10, 8);                       // 用已有白子所在点无关；这里直接填 (12,10)
  const j = idxOf(12, 10);
  PAT.lines4Counts(pos.board, j, buf);
  core.makeMove(pos, 12, 10, BLACK);
  PAT.materialInc(pos.material, j, pos.board, buf, 0);
  void i;

  eqFull(pos.material, pos.board, '填子后');
  const after = matOf(pos.material, WHITE).openTwo;
  assert.ok(after < before, '白活二应减少：' + before + ' → ' + after);
});

test('⑥ cfg.incrMaterial 默认关：不挂 material 且搜索选点/节点逐位不变', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK],
                     [6, 7, WHITE], [6, 5, BLACK], [9, 7, WHITE], [10, 7, BLACK], [5, 8, WHITE]]);
  const cfg = { maxDepth: 6, width: 14, hardLimit: 20000, ttBits: 18 };
  SEARCH.ttClear();
  const pOff = SEARCH.posFromBoard(b, BLACK);
  const off = SEARCH.think(pOff, Object.assign({}, cfg, { incrMaterial: false }));
  assert.equal(pOff.material, null, '默认不应挂 material');

  SEARCH.ttClear();
  const pOn = SEARCH.posFromBoard(b, BLACK);
  const on = SEARCH.think(pOn, Object.assign({}, cfg, { incrMaterial: true }));
  assert.ok(pOn.material instanceof Int32Array, '开启后应挂 material');
  eqFull(pOn.material, pOn.board, 'think 后');

  console.log('     [效应量] 选点 ' + JSON.stringify(off.move) + ' vs ' + JSON.stringify(on.move) +
    '；节点 ' + off.nodes + ' vs ' + on.nodes);
  assert.deepEqual(on.move, off.move, '选点应一致（材料表不改评估真值）');
  assert.equal(on.nodes, off.nodes, '节点数应一致');
});

test('⑦ 与 lc 共存：同一次 make/unmake 下两套结构都复原，且互不影响', () => {
  const buf = new Int32Array(4 * 2 * NCLS);
  const pos = SEARCH.posFromBoard(boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK]]), WHITE);
  SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
  assert.ok(pos.lc && pos.material, '两套缓存都应挂上');
  const lc0 = Array.from(pos.lc.tot), mat0 = Array.from(pos.material);

  // 走子 → 用钩子自动维护（不经手工 materialInc）
  const seq = [[6, 8], [9, 9], [5, 5], [10, 10]];
  for (const [x, y] of seq) core.makeMove(pos, x, y, pos.stm);
  eqFull(pos.material, pos.board, '钩子维护后');
  for (let t = 0; t < 2 * PAT.NT; t++) assert.equal(pos.lc.tot[t], PAT.newLineCache(pos.board).tot[t], 'lc 同步');
  while (pos.hist.length) core.unmakeMove(pos);

  assert.equal(Array.from(pos.lc.tot).join(','), lc0.join(','), 'lc 应复原');
  assert.equal(Array.from(pos.material).join(','), mat0.join(','), 'material 应复原');
});

test('⑧ renju 全流程：think + 全空点落子/撤销，材料表始终与全量一致', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK], [6, 7, WHITE]]);
  SEARCH.ttClear();
  const pos = SEARCH.posFromBoard(b, BLACK);
  SEARCH.think(pos, { maxDepth: 4, hardLimit: 3000, ttBits: 12, incrMaterial: true, rule: 'renju' });
  eqFull(pos.material, pos.board, 'renju think 后');
  // 空点遍历：每个空点做一次"落子→撤销"，材料表必须始终一致
  for (let i = 0; i < NN; i++) {
    if (pos.board[i] !== EMPTY) continue;
    core.makeMove(pos, i % N, (i / N) | 0, pos.stm);
    eqFull(pos.material, pos.board, 'renju 落子 ' + i);
    core.unmakeMove(pos);
    eqFull(pos.material, pos.board, 'renju 撤销 ' + i);
  }
});

test('⑨ ★ 钩子抛异常时（A13 自检失败）棋盘必须复原为自洽状态', () => {
  // 动机：A13 `assertIncr` 的自检是在 onCell 的 'post' 相位 throw 的。若只把异常抛出去
  // 而不复原棋盘，该 pos 会卡在"棋盘半更新"状态（hist/stones/zob 已改），
  // 后续任何 make/unmake 都级联出错。★ 判据必须看"hist 末尾是否就是 i"而不能看 phase
  // （两个 phase 里"棋盘相对该手的状态"正好相反）。本用例覆盖全部 4 个（动作 × 相位）组合。
  const snap = p => [Array.from(p.board).join(','), p.zobHi, p.zobLo, p.stones,
    p.hist.join(','), p.stm].join('|');
  const consistent = p => {
    const n = Array.from(p.board).filter(v => v).length;
    return n === p.stones && n === p.hist.length;
  };
  const cases = [
    ['make+post', false, 'post'], ['make+pre', false, 'pre'],
    ['unmake+pre', true, 'pre'], ['unmake+post', true, 'post'],
  ];
  for (const [tag, mkPre, phase] of cases) {
    const pos = core.createPosition();
    const base = snap(pos);                       // 基线 = 落子前的空盘
    let armed = false;
    pos.onCell = (p, i, ph) => { if (armed && ph === phase) throw new Error('assert fail'); };
    if (mkPre) core.makeMove(pos, 7, 7, BLACK);
    armed = true;
    let threw = false;
    try { if (mkPre) core.unmakeMove(pos); else core.makeMove(pos, 7, 7, BLACK); }
    catch (e) { threw = true; }
    assert.ok(threw, tag + '：异常必须原样抛出（否则自检形同虚设）');
    assert.equal(snap(pos), base, tag + '：必须回到落子前基线');
    assert.ok(consistent(pos), tag + '：board/stones/hist 必须自洽（否则后续操作级联出错）');
    // 复原后该 pos 必须仍可正常使用（★ 先撤掉故障注入，否则会再抛）
    pos.onCell = null;
    core.makeMove(pos, 3, 3, BLACK);
    assert.ok(consistent(pos), tag + '：复原后仍应可继续落子');
  }
});

