/* test/wld.test.js — A5 `wldOf` O(1) 胜负判定单测（§4.8）
 *
 * 出口判据（施工图 §5 第 3 批 / §5.5.6 A5 行）：
 *   ① 与"全量扫描版胜负判定"**逐局面对拍 100% 一致**（**硬红线**，含 renju 边界）
 *   ② `cfg.wldFast` 默认关 ⇒ `staticEval` / `staticEvalPos` 逐位不变
 *   ③ renju 禁手终判仍走 `forbiddenCore`（本函数不越权）
 *   ④ `offset` 语义正确（0 已结束 / 1 己方下一步胜 / 2 对方下一步胜 / 3 己方主动）
 *
 * ★ 参考实现（`wldSlowScan`）**刻意独立于 material**：它直接读棋盘、按
 *   `eval.staticEval` 的原始判据逐条扫描，作为"全量版"对拍基线。
 *   若两者只是同一段代码抄两遍，测试就没有意义 —— 故此处的扫描路径用
 *   `countBoth`（线式全量计数）而非 `material`（增量表）。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');
const SEARCH = require('../engine/search.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;
const NCLS = PAT.NCLS;

/* ---------- 参考实现：全量扫描版（与 staticEval 的判据逐条同序） ---------- */
function wldSlowScan(board, stm, rule) {
  const o = opp(stm);
  const both = PAT.countBoth(board);
  const S = both[stm], O = both[o];
  const bkS = (rule === 'renju' && stm === BLACK), bkO = (rule === 'renju' && o === BLACK);

  if (S.five > 0) return { winner: stm, offset: 0, wld: 'W' };
  if (S.overline > 0) return bkS ? { winner: o, offset: 0, wld: 'L' } : { winner: stm, offset: 0, wld: 'W' };
  if (S.openFour > 0 || S.four >= 1) return { winner: stm, offset: 1, wld: 'W' };

  if (O.five > 0) return { winner: o, offset: 0, wld: 'L' };
  if (O.overline > 0) return bkO ? { winner: stm, offset: 0, wld: 'W' } : { winner: o, offset: 0, wld: 'L' };
  if (O.openFour > 0 || O.four >= 2) return { winner: o, offset: 2, wld: 'L' };

  if (S.openThree > 0 && O.openFour === 0 && O.four === 0) return { winner: 0, offset: 3, wld: 'D' };
  return { winner: 0, offset: 0, wld: 'D' };
}

// 用 material 版 wldOf 与 全量扫描版 逐位对拍
function cmp(board, stm, rule, tag) {
  const a = PAT.wldOf({ stm: stm, board: board, material: null }, board, rule);
  const b = wldSlowScan(board, stm, rule || 'freestyle');
  assert.equal(a.wld, b.wld, tag + ' wld');
  assert.equal(a.offset, b.offset, tag + ' offset');
  assert.equal(a.winner, b.winner, tag + ' winner');
}

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}

/* ---------- ① 硬红线：26 开局前缀 + 随机序列，逐局面 100% 一致 ---------- */
test('① ★ 对拍：开局前缀逐局面一致（freestyle + renju 双规则，硬红线）', () => {
  const OP = require('../engine/data/openings.js');
  let n = 0, bad = 0;
  for (const rule of ['freestyle', 'renju']) {
    for (const o of OP.OPENINGS) {
      const pos = core.createPosition();
      for (const mv of o.moves) {
        const x = mv.x, y = mv.y;
        if (pos.board[idxOf(x, y)] !== EMPTY) continue;
        core.makeMove(pos, x, y, pos.stm);
        n++;
        try { cmp(pos.board, pos.stm, rule, rule + '/opening ' + (o.name || '') + ' #' + n); }
        catch (e) { bad++; }
      }
    }
  }
  assert.ok(n > 100, '样本量应 > 100，实际 ' + n);
  assert.equal(bad, 0, '不一致 ' + bad + ' / ' + n + '（必须为 0）');
});

/* ---------- ② 随机序列对拍（含终局局面），并用 material 增量表 ---------- */
test('② ★ 对拍：随机对局逐步一致（3000 步，材料表增量维护路径）', () => {
  const rnd = core.mulberry32(20260920);
  let n = 0, bad = 0;
  for (let seed = 0; seed < 30; seed++) {
    const pos = core.createPosition();
    SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
    for (let k = 0; k < 100; k++) {
      // 在已有棋子邻域随机落子，制造各种棋型
      const idxs = [];
      for (let i = 0; i < NN; i++) if (pos.board[i] !== EMPTY) idxs.push(i);
      let x, y;
      if (!idxs.length) { x = 7; y = 7; }
      else {
        const c = idxs[(rnd() * idxs.length) | 0];
        const cx = c % N, cy = (c / N) | 0;
        x = Math.min(14, Math.max(0, cx + ((rnd() * 5) | 0) - 2));
        y = Math.min(14, Math.max(0, cy + ((rnd() * 5) | 0) - 2));
      }
      if (pos.board[idxOf(x, y)] !== EMPTY) continue;
      core.makeMove(pos, x, y, pos.stm);
      n++;
      // pos.material 走的是增量维护路径（与 wldSlowScan 的 countBoth 独立）
      const a = PAT.wldOf(pos);
      const b = wldSlowScan(pos.board, pos.stm, 'freestyle');
      if (a.wld !== b.wld || a.offset !== b.offset || a.winner !== b.winner) {
        bad++;
        if (bad <= 3) console.error('[mismatch] step', n, 'a=', JSON.stringify(a), 'b=', JSON.stringify(b));
      }
    }
  }
  assert.ok(n >= 1800, '样本量应 ≥ 1800，实际 ' + n);
  assert.equal(bad, 0, '不一致 ' + bad + ' / ' + n + '（必须为 0）');
});

/* ---------- ③ 语义用例：offset 四档逐个构造 ---------- */
test('③ offset 语义：0 已结束 / 1 己方一步胜 / 2 对方一步胜 / 3 己方主动', () => {
  // 己方（黑）活四 → offset 1
  let b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK]]);
  let r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 1, '活四应 offset=1'); assert.equal(r.wld, 'W');

  // 对方（白）活四 → 黑 view offset 2 / wld L
  b = boardOf([[3, 7, WHITE], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE]]);
  r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 2, '对方活四应 offset=2'); assert.equal(r.wld, 'L'); assert.equal(r.winner, WHITE);

  // 己方（黑）活三且对方无四 → offset 3
  b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK]]);
  r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 3, '活三应 offset=3'); assert.equal(r.wld, 'D');

  // 己方五连 → offset 0 / W
  b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK]]);
  r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 0); assert.equal(r.wld, 'W');

  // 双四（对方）→ offset 2
  b = boardOf([[3, 7, WHITE], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE],
               [7, 3, WHITE], [7, 4, WHITE], [7, 5, WHITE], [7, 6, WHITE]]);
  r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 2, '对方双四应 offset=2'); assert.equal(r.wld, 'L');
});

/* ---------- ④ ★ renju：黑长连 = 禁手负（与 staticEval 同构） ---------- */
test('④ renju 边界：黑长连记负 / 白长连记胜；freestyle 双方长连都记胜', () => {
  const over = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                        [7, 7, BLACK], [8, 7, BLACK]]);                 // 黑 6 子长连
  // wldOf 本身只按材料计数，Renju-黑长连 = 负
  let r = PAT.wldOf({ stm: BLACK, board: over, material: null }, over, 'renju');
  assert.equal(r.wld, 'L', 'renju 下黑长连应记负');
  assert.equal(r.winner, WHITE);

  // 白长连 → 黑 view 记负（白胜）
  const overW = boardOf([[3, 7, WHITE], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE],
                         [7, 7, WHITE], [8, 7, WHITE]]);
  r = PAT.wldOf({ stm: BLACK, board: overW, material: null }, overW, 'renju');
  assert.equal(r.wld, 'L');
  // 白 view 看自己长连 = 胜（无禁手规则下长连算胜）
  r = PAT.wldOf({ stm: WHITE, board: overW, material: null }, overW, 'renju');
  assert.equal(r.wld, 'W');
});

/* ---------- ⑤ ★ 默认关：cfg.wldFast 未传 ⇒ staticEval/staticEvalPos 逐位不变 ---------- */
test('⑤ cfg.wldFast 默认关：staticEval / staticEvalPos 逐位不变（回归护栏）', () => {
  const rnd = core.mulberry32(777);
  let n = 0;
  for (let seed = 0; seed < 20; seed++) {
    const pos = core.createPosition();
    SEARCH.attachIncr(pos, { incr: true, incrMaterial: false });   // 只开 lc（默认态）
    for (let k = 0; k < 60; k++) {
      const idxs = [];
      for (let i = 0; i < NN; i++) if (pos.board[i] !== EMPTY) idxs.push(i);
      let x, y;
      if (!idxs.length) { x = 7; y = 7; }
      else {
        const c = idxs[(rnd() * idxs.length) | 0];
        x = Math.min(14, Math.max(0, (c % N) + ((rnd() * 5) | 0) - 2));
        y = Math.min(14, Math.max(0, ((c / N) | 0) + ((rnd() * 5) | 0) - 2));
      }
      if (pos.board[idxOf(x, y)] !== EMPTY) continue;
      core.makeMove(pos, x, y, pos.stm);
      n++;
      // 默认关（cfg 无 wldFast）
      const vOff = EV.staticEvalPos(pos, { rule: 'freestyle' });
      // 显式 false 也应逐位相同
      const vFalse = EV.staticEvalPos(pos, { rule: 'freestyle', wldFast: false });
      assert.equal(vOff, vFalse, '默认应等于显式 false（step ' + n + '）');
      // staticEval 与 staticEvalPos 在默认态本就应一致
      const vA = EV.staticEval(pos.board, pos.stm, { rule: 'freestyle' });
      assert.equal(vOff, vA, 'staticEvalPos 应 == staticEval（默认态，step ' + n + '）');
    }
  }
  assert.ok(n >= 800, '样本量应 ≥ 800，实际 ' + n);
});

/* ---------- ⑥ 开启 wldFast 后：终局局面返回值与默认路径**逐位一致** ---------- */
test('⑥ 开启 wldFast：终局局面返回值与默认路径逐位一致', () => {
  const rnd = core.mulberry32(4242);
  let n = 0, terminal = 0;
  for (let seed = 0; seed < 20; seed++) {
    const pos = core.createPosition();
    SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
    for (let k = 0; k < 80; k++) {
      const idxs = [];
      for (let i = 0; i < NN; i++) if (pos.board[i] !== EMPTY) idxs.push(i);
      let x, y;
      if (!idxs.length) { x = 7; y = 7; }
      else {
        const c = idxs[(rnd() * idxs.length) | 0];
        x = Math.min(14, Math.max(0, (c % N) + ((rnd() * 5) | 0) - 2));
        y = Math.min(14, Math.max(0, ((c / N) | 0) + ((rnd() * 5) | 0) - 2));
      }
      if (pos.board[idxOf(x, y)] !== EMPTY) continue;
      core.makeMove(pos, x, y, pos.stm);
      n++;
      const off = EV.staticEval(pos.board, pos.stm, { rule: 'freestyle' });
      const on = EV.staticEval(pos.board, pos.stm, { rule: 'freestyle', wldFast: true });
      if (Math.abs(off) >= PAT.WIN) terminal++;
      assert.equal(on, off, '开启 wldFast 后终端值必须与默认一致（step ' + n + '，off=' + off + '）');
    }
  }
  assert.ok(n >= 800, '样本量应 ≥ 800，实际 ' + n);
  assert.ok(terminal > 0, '样本里应至少出现 1 个终局局面（实际 ' + terminal + '）——否则用例未覆盖短路');
});

/* ---------- ⑦ renju：开启 wldFast 的 staticEval 与默认路径逐位一致 ---------- */
test('⑦ renju 下开启 wldFast：staticEval 与默认路径逐位一致（含黑长连边界）', () => {
  // 直接构造 renju 边界局面集
  const cases = [
    boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK]]),         // 五连
    boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK]]), // 长连
    boardOf([[3, 7, WHITE], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE]]),                        // 白活四
    boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK]]),                                       // 黑活三
    boardOf([[3, 7, WHITE], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE],
             [7, 3, WHITE], [7, 4, WHITE], [7, 5, WHITE], [7, 6, WHITE]]),                        // 白双四
    boardOf([[0, 0, BLACK], [1, 1, WHITE], [2, 2, BLACK]]),                                       // 普通
  ];
  for (const b of cases) {
    for (const stm of [BLACK, WHITE]) {
      const off = EV.staticEval(b, stm, { rule: 'renju' });
      const on = EV.staticEval(b, stm, { rule: 'renju', wldFast: true });
      assert.equal(on, off, 'renju stm=' + stm + ' 不一致：off=' + off + ' on=' + on);
    }
  }
});

/* ---------- ⑧ 与 staticEval 的"终局短路"逐条同值（材料 vs 全量三口径互证） ---------- */
test('⑧ material 增量路径与 countBoth 全量路径对 wldOf 结论等价', () => {
  const rnd = core.mulberry32(31337);
  let n = 0;
  for (let seed = 0; seed < 15; seed++) {
    const pos = core.createPosition();
    SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
    for (let k = 0; k < 60; k++) {
      const idxs = [];
      for (let i = 0; i < NN; i++) if (pos.board[i] !== EMPTY) idxs.push(i);
      let x, y;
      if (!idxs.length) { x = 7; y = 7; }
      else {
        const c = idxs[(rnd() * idxs.length) | 0];
        x = Math.min(14, Math.max(0, (c % N) + ((rnd() * 5) | 0) - 2));
        y = Math.min(14, Math.max(0, ((c / N) | 0) + ((rnd() * 5) | 0) - 2));
      }
      if (pos.board[idxOf(x, y)] !== EMPTY) continue;
      core.makeMove(pos, x, y, pos.stm);
      n++;
      // 路径 A：读 pos.material（增量）
      const a = PAT.wldOf(pos);
      // 路径 B：忽略 material，全量建表
      const b = PAT.wldOf({ stm: pos.stm, board: pos.board, material: null }, pos.board);
      assert.equal(a.wld + a.offset + a.winner, b.wld + b.offset + b.winner,
        '增量 vs 全量 wldOf 不一致（step ' + n + '）');
    }
  }
  assert.ok(n >= 600, '样本量应 ≥ 600，实际 ' + n);
});

/* ---------- ⑨ I-neg：故意造错 ⇒ 用例必须能咬（防"永远绿的测试"） ---------- */
test('⑨ I-neg：把 material 改坏 ⇒ ① 类对拍必须能发现（自检有效性）', () => {
  const pos = core.createPosition();
  SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
  core.makeMove(pos, 3, 7, BLACK); core.makeMove(pos, 0, 0, WHITE);
  core.makeMove(pos, 4, 7, BLACK); core.makeMove(pos, 0, 1, WHITE);
  core.makeMove(pos, 5, 7, BLACK); core.makeMove(pos, 0, 2, WHITE);
  // 真实：黑活三 ⇒ wldOf offset=3
  const good = PAT.wldOf(pos);
  assert.equal(good.offset, 3, '构造局面应为黑活三');
  // 篡改：把黑活三计数抹成 0 ⇒ 结论必须变化（说明该用例确实在读 material）
  const sb = pos.stm === BLACK ? 0 : NCLS;
  const saved = pos.material[sb + 4];
  pos.material[sb + 4] = 0;
  const broken = PAT.wldOf(pos);
  pos.material[sb + 4] = saved;                       // 复原
  assert.notEqual(broken.offset, good.offset, '篡改 material 后结论必须变化（否则用例没咬到增量表）');
  assert.equal(PAT.wldOf(pos).offset, 3, '复原后应回到 3');
});

/* ---------- ⑩ wldOf 不做禁手终判（#33 铁律） ---------- */
test('⑩ wldOf 不越权：双四等禁手形态由材料计数判定，不替代 forbiddenCore', () => {
  // 黑双四：wldOf 按"己方有双四 ⇒ offset 1"（下一步成五），
  // 但该点在 Renju 下可能同时是禁手 —— 那必须由 forbiddenCore 另判，
  // wldOf 只反映"材料层面有一手成五"。
  const b = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                     [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]]);
  const r = PAT.wldOf({ stm: BLACK, board: b, material: null }, b, 'freestyle');
  assert.equal(r.offset, 1, '黑双四 ⇒ offset 1');
  // 语义边界：wldOf 的返回值不应被当作禁手结论 —— 断言它没有 forbid 字段
  assert.equal(r.forbid, undefined, 'wldOf 不返回禁手结论（禁手必须走 forbiddenCore）');
});

/* ---------- ⑪ wldCode（零分配热路径）与 wldOf（对象版）必须逐位同值 ---------- */
test('⑪ wldCode 零分配版与 wldOf 对象版逐局面一致（含终局/长连边界）', () => {
  const rnd = core.mulberry32(5566);
  let n = 0;
  const check = (pos, tag) => {
    const c = PAT.wldCode(pos, null, 'freestyle');
    const o = PAT.wldOf(pos, null, 'freestyle');
    const exp = c > 0 ? 'W' : (c < 0 ? 'L' : 'D');
    assert.equal(o.wld, exp, tag + ' wld：code=' + c + ' of=' + JSON.stringify(o));
    if (c > 0 && c < PAT.WLD_END) assert.equal(o.offset, c, tag + ' offset');
    if (c < 0 && -c < PAT.WLD_END) assert.equal(o.offset, -c, tag + ' offset');
    const b = wldSlowScan(pos.board, pos.stm, 'freestyle');
    assert.equal(exp, b.wld, tag + ' wldCode vs slowScan');
  };
  for (let seed = 0; seed < 20; seed++) {
    const pos = core.createPosition();
    SEARCH.attachIncr(pos, { incr: true, incrMaterial: true });
    for (let k = 0; k < 70; k++) {
      const idxs = [];
      for (let i = 0; i < NN; i++) if (pos.board[i] !== EMPTY) idxs.push(i);
      let x, y;
      if (!idxs.length) { x = 7; y = 7; }
      else {
        const cc = idxs[(rnd() * idxs.length) | 0];
        x = Math.min(14, Math.max(0, (cc % N) + ((rnd() * 5) | 0) - 2));
        y = Math.min(14, Math.max(0, ((cc / N) | 0) + ((rnd() * 5) | 0) - 2));
      }
      if (pos.board[idxOf(x, y)] !== EMPTY) continue;
      core.makeMove(pos, x, y, pos.stm);
      n++;
      check(pos, 'step ' + n);
    }
  }
  const over = boardOf([[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK], [8, 7, BLACK]]);
  // freestyle：黑已有长连 = 黑已胜 ⇒ 黑视角记胜、白视角记负
  assert.ok(PAT.wldCode({ stm: BLACK, board: over, material: null }, null, 'freestyle') > 0, 'freestyle 黑视角长连应记胜');
  assert.ok(PAT.wldCode({ stm: WHITE, board: over, material: null }, null, 'freestyle') < 0, 'freestyle 白视角看黑长连应记负');
  // renju：黑长连 = 禁手负 ⇒ 黑视角记负、白视角记胜
  assert.ok(PAT.wldCode({ stm: BLACK, board: over, material: null }, null, 'renju') < 0, 'renju 黑视角长连应记负');
  assert.ok(PAT.wldCode({ stm: WHITE, board: over, material: null }, null, 'renju') > 0, 'renju 白视角看黑长连应记胜');
  assert.ok(n >= 900, '样本量应 ≥ 900，实际 ' + n);
});

/* ---------- ⑫ wldCode 零分配：返回值必须是 number（不得是对象） ---------- */
test('⑫ wldCode 返回 number（零分配契约）', () => {
  const pos = core.createPosition();
  core.makeMove(pos, 7, 7, BLACK);
  core.makeMove(pos, 0, 0, WHITE);
  const c = PAT.wldCode(pos, null, 'freestyle');
  assert.equal(typeof c, 'number', 'wldCode 必须返回 number（对象版请用 wldOf）');
});
