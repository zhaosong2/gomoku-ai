/* engine/core.js — 棋盘状态与基础工具（M1）
 * 浏览器：挂到 window.G.core；Node：module.exports
 * 设计依据：§3 / §22.1 / §22.2 / §34.4（Zobrist 用双 uint32，不用 BigInt）
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.G = root.G || {}; root.G.core = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const N = 15, NN = 225;
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // → ↓ ↘ ↙

  const idxOf = (x, y) => y * N + x;
  const xOf = i => i % N;
  const yOf = i => (i / N) | 0;
  const inBoard = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
  const opp = p => (p === BLACK ? WHITE : BLACK);

  // 种子化 PRNG（§34.3），用于生成 Zobrist 表，保证可复现
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildZobrist(seed) {
    const rnd = mulberry32(seed >>> 0);
    const r32 = () => (rnd() * 4294967296) >>> 0;
    const z = [new Array(NN), new Array(NN)];
    for (let p = 0; p < 2; p++) for (let i = 0; i < NN; i++) z[p][i] = [r32(), r32()];
    return { z, turn: [r32(), r32()] };
  }
  const ZOB = buildZobrist(20260918);

  function createPosition() {
    return { board: new Int8Array(NN), stm: BLACK, stones: 0, zobHi: 0, zobLo: 0, hist: [],
             lc: null, onCell: null,      // lc/onCell：§33.3 增量线分缓存（可选）
             material: null,              // material：A6 增量材料计数（可选，口径见 patterns.materialOf）
             assertIncr: null };          // ★ A13 自检钩子（可选；仅 dev/test 由 tools 注入，默认 null）
  }

  // 过格点 idx 的 4 条线（含不足 5 格因而不在 LINES 里的边界线）。
  // A6 增量材料表复用 §33.3 缓存的构造逻辑（同源实现，diff 可对拍为 0）。
  function dirLinesAt(idx) {
    const x = idx % N, y = (idx / N) | 0;
    const a = new Array(4);
    for (let d = 0; d < 4; d++) {
      const dx = DIRS[d][0], dy = DIRS[d][1];
      let sx = x, sy = y, ex = x, ey = y;
      while (inBoard(sx - dx, sy - dy)) { sx -= dx; sy -= dy; }
      while (inBoard(ex + dx, ey + dy)) { ex += dx; ey += dy; }
      const len = Math.max(Math.abs(ex - sx), Math.abs(ey - sy)) + 1;
      const ln = new Array(len);
      for (let k = 0; k < len; k++) ln[k] = idxOf(sx + dx * k, sy + dy * k);
      a[d] = ln;
    }
    return a;
  }
  function xorZob(pos, arr) { pos.zobHi ^= arr[0]; pos.zobLo ^= arr[1]; }

  // ★ 钩子事件约定（A6，2026-09-20）：`pos.onCell(pos, idx, phase)`
  //   phase = 'pre'  该手**尚未**落到棋盘（紧邻 makeMove 之前 / unmakeMove 之后）
  //   phase = 'post' 该手**已**落到棋盘（makeMove 之后 / 紧邻 unmakeMove 之前）
  //   为什么需要两相：原地递增型增量结构（material）必须在"变化前后各读一次"才能求差；
  //   只有一个 post 相位时，`before` 只能从"上一次 post"里拿——而**其他落子会改变同一条线**，
  //   于是差值与真值漂移（实测 2026/2400 步：把两只白子之间的空点填黑，白活二本该消失，
  //   差分里却从未记录它出现过）。原 §33.3 的 `lc` 用"物化新数组 + 换引用"绕开了这个问题
  //   （cellHook 用 `old || pos.board` 当旧内容），A6 换成原地递增后必须显式给 pre 相位。
  function notifyCell(pos, i, phase) {
    if (!pos.onCell) return;
    try {
      pos.onCell(pos, i, phase);
    } catch (e) {
      // ★ 抛异常时（如 A13 `assertIncr` 自检失败）必须把棋盘复原，否则该 pos 会卡在
      //   "棋盘半更新"状态（hist/stones/zob 已改而这一手实际没落成），后续任何
      //   make/unmake 都级联出错。★ 判据**不能用 phase**（两个 phase 里"棋盘相对该手的状态"
      //   正好相反），必须看"当期 hist 末尾是否就是 i"：
      //     · make 发 'post' / unmake 发 'pre' ⇒ 该手在盘上 ⇒ 撤销它；
      //     · make 发 'pre' / unmake 发 'post' ⇒ 该手不在盘上 ⇒ 无须动棋盘。
      const isLast = pos.hist.length > 0 && pos.hist[pos.hist.length - 1] === i;
      if (isLast) {
        const player = pos.board[i];
        if (player) {
          pos.board[i] = EMPTY; pos.stones--; pos.hist.pop();
          xorZob(pos, ZOB.z[player - 1][i]); xorZob(pos, ZOB.turn); pos.stm = player;
        }
      }
      throw e;
    }
  }
  function makeMove(pos, x, y, player) {
    const i = idxOf(x, y);
    if (pos.board[i] !== EMPTY) return false;
    notifyCell(pos, i, 'pre');                    // 增量缓存：记下变化前的内容
    pos.board[i] = player;
    pos.stones++;
    xorZob(pos, ZOB.z[player - 1][i]);
    xorZob(pos, ZOB.turn);            // 手番翻转
    pos.stm = opp(player);
    pos.hist.push(i);
    notifyCell(pos, i, 'post');                   // 增量缓存：同步到变化后（§33.3 / A6）
    // ★ A13 自检（§4.13）：**必须放在两相 notifyCell 全部完成之后**，否则会看到"半更新"状态。
    //   默认无钩子 ⇒ 零开销。★ 判据用**真值**而非 `!== null`：selfcheck 文档写"默认 false"，
    //   按文档写 `pos.assertIncr = false` 会变成 `false(pos)` 直接崩。
    if (pos.assertIncr) pos.assertIncr(pos);
    return true;
  }

  function unmakeMove(pos) {
    const i = pos.hist[pos.hist.length - 1];
    if (i === undefined) return false;
    const player = pos.board[i];
    // ★ 先发 'pre'（此时**尚未** pop hist、棋盘上还有这手）⇒ 该相位的快照语义严格等于
    //   "撤销前"，且 `notifyCell` 的异常回滚判据 `hist 末尾 === i` 恰好成立。
    notifyCell(pos, i, 'pre');
    pos.hist.pop();
    pos.board[i] = EMPTY;
    pos.stones--;
    xorZob(pos, ZOB.z[player - 1][i]);
    xorZob(pos, ZOB.turn);
    pos.stm = player;
    notifyCell(pos, i, 'post');                   // 变化后（已撤销）
    // ★ A13 自检：撤销后同样必须一致（往返复原的守卫）。
    if (pos.assertIncr) pos.assertIncr(pos);
    return true;
  }

  return { N, NN, EMPTY, BLACK, WHITE, DIRS, idxOf, xOf, yOf, inBoard, opp, dirLinesAt,
           createPosition, makeMove, unmakeMove, mulberry32, ZOB };
});
