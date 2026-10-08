/* engine/patterns.js — 棋型识别与评分表（M2）
 * 设计依据：§23.2 单棋型真值表 / §23.3 组合定级 / §23.4 唯一数值表 / §33.2 预计算表
 *  · 点式（窗口）分类用于「着法/威胁级」，含跳型，结果 memo 化。
 *  · 线式（run）计数用于「叶子静态评估」，只统计直线棋型（跳型由点式覆盖）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'));
  else { root.G = root.G || {}; root.G.patterns = factory(root.G.core); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  const { N, NN, EMPTY, BLACK, WHITE, DIRS, idxOf, inBoard, opp } = core;

  /* ---------- 单棋型 ---------- */
  const P = { NONE: 0, SLEEP_TWO: 1, OPEN_TWO: 2, SLEEP_THREE: 3, OPEN_THREE: 4, FOUR: 5, OPEN_FOUR: 6, FIVE: 7, OVERLINE: 8 };
  const PNAME = ['无', '眠二', '活二', '眠三', '活三', '冲四', '活四', '连五', '长连'];

  /* ---------- 组合等级（数值越大越强，便于比较）---------- */
  const L = {
    DEAD: 0, SLEEP_TWO: 1, OPEN_TWO: 2, TWO_MIX: 3, SLEEP_THREE: 4, DOUBLE_TWO: 5,
    OPEN_THREE: 6, OPEN_THREE_SLEEP: 7, FOUR: 8, DOUBLE_THREE: 9, FOUR_THREE: 10,
    DOUBLE_FOUR: 11, OPEN_FOUR: 12, WIN: 13, OVERLINE: 14,
  };
  const LNAME = ['死棋', '眠二', '活二', '活二+眠二', '眠三', '双活二', '活三', '活三+眠三',
    '冲四', '双活三', '四三', '双四', '活四', '连五', '长连'];

  const WIN = 1e8;
  const FORBIDDEN = -1e9;                 // 禁手惩罚（§4.6：量级 > 一切胜分）

  // 走子方基准值 M(L)
  const LEVEL_M = { 0: -5, 1: 5, 2: 20, 3: 50, 4: 200, 5: 500, 6: 1000, 7: 5000, 8: 1e4, 9: 5e4, 10: 1e5, 11: 1.2e5, 12: 1e6, 13: WIN, 14: WIN };
  // 手番因子 t(L)：V_opp = round(t·M)
  const LEVEL_T = { 8: 0.5, 7: 0.6, 6: 0.6, 5: 0.8, 4: 0.75, 3: 0.75, 2: 0.75, 1: 0.8 };

  /* ---------- ★ 调参钩子（§17.4）----------
   * 上面的表是**出厂基准值**，本文件内所有取值都走下面的"M/T 解析"，而解析会
   * 先查 `TUNE`。这样离线调参工具（tools/bench-tune.js）可以只覆盖若干项做局部
   * 搜索，而不必修改引擎源码；调参胜出的数值再手工回写到上面的表，然后
   * `resetTune()` 即可保证"线上跑的就是标定值"。
   *
   * 为什么不直接在 LEVEL_M 上改：① 这些表被多处闭包直接引用，就地改写会造成
   * "读到一半是新值是旧值"的隐性不一致；② `test/patterns.test.js` 会核对出厂
   * 真值，必须能一条语句还原。
   *
   * 约束（§17.4）：**胜负分与长度排序不可调**——把 WIN / FORBIDDEN 或"长连>连五"
   * 这类关系调反会让引擎违反规则，任何调参都必须保持下列不变量：
   *   FIVE = OVERLINE = WIN；FOUR > OPEN_THREE；SLEEP_THREE > OPEN_TWO；
   *   OPEN_FOUR > DOUBLE_THREE(组合 L 级，由 LEVEL_M 保证)。
   */
  const TUNE = { m: null, t: null, level: null };
  // ★ 代际计数：setTune/resetTune 每次变更自增，供下游派生缓存判断是否陈旧。
  //   起因：eval.coeffOf 曾是永久缓存而 singleScore 含调参钩子 ⇒ 调参后
  //   staticEvalPos（搜索热路径）无视 setTune，与 staticEval 行为分叉。
  let TUNE_GEN = 0;
  function setTune(patch) {
    const p = patch || {};
    TUNE.m = p.singleM ? Object.assign({}, SINGLE_M, p.singleM) : null;
    TUNE.t = p.singleT ? Object.assign({}, SINGLE_T, p.singleT) : null;
    TUNE.level = p.levelM ? Object.assign({}, LEVEL_M, p.levelM) : null;
    TUNE_GEN++;
  }
  function resetTune() { TUNE.m = null; TUNE.t = null; TUNE.level = null; TUNE_GEN++; }
  function tuneState() { return { singleM: TUNE.m, singleT: TUNE.t, levelM: TUNE.level, gen: TUNE_GEN }; }
  const Mof = p => (TUNE.m && TUNE.m[p] !== undefined) ? TUNE.m[p] : SINGLE_M[p];
  const Tof = p => (TUNE.t && TUNE.t[p] !== undefined) ? TUNE.t[p] : SINGLE_T[p];
  const Lof = l => (TUNE.level && TUNE.level[l] !== undefined) ? TUNE.level[l] : LEVEL_M[l];

  // 叶子用「单棋型」值
  const SINGLE_M = { 1: 5, 2: 20, 3: 200, 4: 1000, 5: 1e4, 6: 1e6, 7: WIN, 8: WIN };
  const SINGLE_T = { 1: 0.8, 2: 0.75, 3: 0.75, 4: 0.6, 5: 0.5 };

  const colorRole = c => (c === BLACK ? 'black' : 'white');

  /* ---------- 组合定级（§23.3，优先级自上而下）---------- */
  // 由四方向单棋型直接定级（无数组分配，热路径用）
  // mode：0 = 无禁手 / 白棋；1 = Renju 黑（RIF，五长连判胜）；2 = Renju 黑（strict，长连一律负）
  function decideOf(a, b, c, d, mode) {
    let five = 0, over = 0, openFour = 0, four = 0, openThree = 0, sleepThree = 0, openTwo = 0, sleepTwo = 0;
    let v = a;
    for (let k = 0; k < 4; k++) {
      if (k === 1) v = b; else if (k === 2) v = c; else if (k === 3) v = d;
      if (v === P.FIVE) five++;
      else if (v === P.OVERLINE) over++;
      else if (v === P.OPEN_FOUR) openFour++;
      else if (v === P.FOUR) four++;
      else if (v === P.OPEN_THREE) openThree++;
      else if (v === P.SLEEP_THREE) sleepThree++;
      else if (v === P.OPEN_TWO) openTwo++;
      else if (v === P.SLEEP_TWO) sleepTwo++;
    }
    const m = mode | 0;
    const fourTotal = openFour + four;              // ★ 活四也是"四"（§26.2：四四 = 任意两个四）
    if (m > 0) {                                    // ★ Renju-黑：禁手语境（§7.3 / §26）
      // 长连：rif 下"同时成恰好五"则失效（五长连判胜）；strict 下长连一律负
      if (over > 0 && (m === 2 || five === 0)) return L.OVERLINE;
      if (five > 0) return L.WIN;                   // 恰好五连优先（五三三 / 五四四 / 五长连）
      if (fourTotal >= 2) return L.DOUBLE_FOUR;     // 四四禁手（含 活四+冲四）
      if (openThree >= 2) return L.DOUBLE_THREE;    // 三三禁手（含 一四两活三）
      if (openFour > 0) return L.OPEN_FOUR;         // 活四：合法必胜
      if (fourTotal >= 1 && openThree >= 1) return L.FOUR_THREE;   // 四三：合法必胜
      if (fourTotal >= 1) return L.FOUR;
    } else {                                        // 无禁手 / 白棋
      if (five > 0) return L.WIN;
      if (over > 0) return L.OVERLINE;              // 长连算胜
      if (openFour > 0) return L.OPEN_FOUR;
      if (four >= 2) return L.DOUBLE_FOUR;
      if (four >= 1 && openThree >= 1) return L.FOUR_THREE;
      if (openThree >= 2) return L.DOUBLE_THREE;
      if (four >= 1) return L.FOUR;
    }
    if (openThree >= 1 && sleepThree >= 1) return L.OPEN_THREE_SLEEP;
    if (openThree >= 1) return L.OPEN_THREE;
    if (openTwo >= 2) return L.DOUBLE_TWO;
    if (sleepThree >= 1) return L.SLEEP_THREE;
    if (openTwo >= 1 && sleepTwo >= 1) return L.TWO_MIX;
    if (openTwo >= 1) return L.OPEN_TWO;
    if (sleepTwo >= 1) return L.SLEEP_TWO;
    return L.DEAD;
  }

  function decideLevel(dirs) { return decideOf(dirs[0], dirs[1], dirs[2], dirs[3]); }

  /* ---------- 点式（窗口）分类：含跳型，结果 memo 化 ---------- */
  const MEMO = new Map();

  function winPoints(w) {                       // w 中再加一子能成五的空点数
    let c = 0;
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== '.') continue;
      if ((w.slice(0, i) + 'o' + w.slice(i + 1)).indexOf('ooooo') !== -1) c++;
    }
    return c;
  }

  function rawClassify(w) {
    if (w.indexOf('oooooo') !== -1) return P.OVERLINE;
    if (w.indexOf('ooooo') !== -1) return P.FIVE;
    const wp = winPoints(w);
    if (wp >= 2) return P.OPEN_FOUR;            // 两个成五点 = 活四
    if (wp === 1) return P.FOUR;                // 一个成五点 = 冲四
    let openThree = false, sleepThree = false, openTwo = false, sleepTwo = false;
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== '.') continue;
      const t = w.slice(0, i) + 'o' + w.slice(i + 1);
      const wp2 = winPoints(t);
      if (wp2 >= 2) { openThree = true; continue; }   // 能一步成活四 → 活三
      if (wp2 === 1) { sleepThree = true; continue; } // 只能一步成冲四 → 眠三
      for (let j = 0; j < t.length; j++) {
        if (t[j] !== '.') continue;
        const u = t.slice(0, j) + 'o' + t.slice(j + 1);
        const wp3 = winPoints(u);
        if (wp3 >= 2) openTwo = true;                 // 能两步成活四 → 活二
        else if (wp3 === 1) sleepTwo = true;
      }
    }
    if (openThree) return P.OPEN_THREE;
    if (sleepThree) return P.SLEEP_THREE;
    if (openTwo) return P.OPEN_TWO;
    if (sleepTwo) return P.SLEEP_TWO;
    return P.NONE;
  }
  function classifyWindow(w) {
    let v = MEMO.get(w);
    if (v === undefined) { v = rawClassify(w); MEMO.set(w, v); }
    return v;
  }

  // 以 (x,y) 为中心、半径 4 的窗口串（中心强制为 'o'；须保证 (x,y) 为空点）
  function windowAt(board, x, y, player, dx, dy, radius) {
    const r = radius === undefined ? 4 : radius;
    let s = '';
    for (let k = -r; k <= r; k++) {
      if (k === 0) { s += 'o'; continue; }
      const nx = x + dx * k, ny = y + dy * k;
      if (!inBoard(nx, ny)) { s += 'x'; continue; }
      const v = board[idxOf(nx, ny)];
      s += v === EMPTY ? '.' : (v === player ? 'o' : 'x');
    }
    return s;
  }
  // 假设 player 在 (x,y) 落子，返回四方向的单棋型
  function classifyAt(board, x, y, player) {
    const out = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) out[d] = classifyWindow(windowAt(board, x, y, player, DIRS[d][0], DIRS[d][1], 4));
    return out;
  }
  function gradeAt(board, x, y, player, mode) {
    const dirs = classifyAt(board, x, y, player);
    const lv = mode ? levelAt(board, idxOf(x, y), player, mode) : decideLevel(dirs);
    return { dirs, level: lv };
  }

  /* ---------- 整数编码窗口查表（§33.2 热路径版：零字符串分配） ---------- */
  const W3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];
  const WCODE_N = 19683;                                   // 3^9

  // (idx,dir) → 9 个窗口格点下标（-1 = 出界）
  const W9 = (function () {
    const a = new Int32Array(NN * 4 * 9);
    for (let idx = 0; idx < NN; idx++) {
      const x = idx % N, y = (idx / N) | 0;
      for (let d = 0; d < 4; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1], base = (idx * 4 + d) * 9;
        for (let p = 0; p < 9; p++) {
          const k = p - 4;
          if (k === 0) { a[base + p] = idx; continue; }
          const nx = x + dx * k, ny = y + dy * k;
          a[base + p] = inBoard(nx, ny) ? idxOf(nx, ny) : -1;
        }
      }
    }
    return a;
  })();

  // 三进制编码：0 = 空、1 = 我方、2 = 阻挡（对手或出界）；中心恒为 1
  function codeAt(board, idx, dir, player) {
    const base = (idx * 4 + dir) * 9;
    let code = W3[4];
    for (let p = 0; p < 9; p++) {
      if (p === 4) continue;
      const c = W9[base + p];
      let v;
      if (c < 0) v = 2;
      else { const b = board[c]; v = b === EMPTY ? 0 : (b === player ? 1 : 2); }
      code += v * W3[p];
    }
    return code;
  }
  function decode9(code) {
    let s = '';
    for (let p = 0; p < 9; p++) { s += (code % 3 === 0 ? '.' : (code % 3 === 1 ? 'o' : 'x')); code = (code / 3) | 0; }
    return s;
  }
  const WCLS = new Int8Array(WCODE_N).fill(-1);            // 惰性填充的棋型表（-1 = 未算）
  function classifyCode(code) {
    let v = WCLS[code];
    if (v < 0) { v = rawClassify(decode9(code)); WCLS[code] = v; }
    return v;
  }
  // 热路径入口：假设 player 落 idx，返回该方向单棋型
  function classifyIdx(board, idx, dir, player) { return classifyCode(codeAt(board, idx, dir, player)); }
  function dirsAt(board, idx, player, out) {
    out[0] = classifyIdx(board, idx, 0, player);
    out[1] = classifyIdx(board, idx, 1, player);
    out[2] = classifyIdx(board, idx, 2, player);
    out[3] = classifyIdx(board, idx, 3, player);
    return out;
  }
  /* ---------- 严格禁手判定（§26，仅 Renju 黑棋）----------
   * ★ 为什么禁用"廉价预检"（曾经的错误认知，勿重走）：
   *   曾假设"窗口模型判三/四只会多判不会漏判，可当廉价预检"——**实测是错的**：
   *   `forbiddenAt` 判定的禁手点里 **≈20~24%** 被 `levelAt` 的旧预检判成**合法等级并给正分**
   *   （"双活三→四三"、"长连→连五(+1e8)"等）⇒ 引擎会真的走出禁手点自败。
   *   根因：窗口模型 `classifyIdx` **每方向只报一个最强型**，而严格判定
   *   `isFourDir`/`isOpenThreeDir` **逐方向独立计数**。当同一方向严格**同时**是"四"与
   *   "活三"时，窗口只报"冲四"⇒ 活三被隐藏 ⇒ 三的计数少一 ⇒ 达不到门槛 ⇒ 严格判定被跳过。
   *   ⚠ 放宽"三"的计数口径也修不好（仍漏 9~11%）——窗口模型与严格谓词本质不同。
   *   ⇒ 要 sound 只能无条件调严格算法（见下方 levelAt）。
   */
  const FD_NONE = 0;

  // 过 idx 沿 dir 的连续**黑**段长度（禁手只判黑棋）
  function runDirB(board, idx, d) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    const x0 = idx % N, y0 = (idx / N) | 0;
    let len = 1;
    for (let s = 1; ; s++) { const nx = x0 + dx * s, ny = y0 + dy * s; if (!inBoard(nx, ny) || board[idxOf(nx, ny)] !== BLACK) break; len++; }
    for (let s = 1; ; s++) { const nx = x0 - dx * s, ny = y0 - dy * s; if (!inBoard(nx, ny) || board[idxOf(nx, ny)] !== BLACK) break; len++; }
    return len;
  }

  // 该方向是否"四"：存在空点补一子后**该方向**形成"恰好五连"（§26.2：四 = 能成五）
  function isFourDir(board, idx, d) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    const x0 = idx % N, y0 = (idx / N) | 0;
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const nx = x0 + dx * k, ny = y0 + dy * k;
      if (!inBoard(nx, ny)) continue;
      const c = idxOf(nx, ny);
      if (board[c] !== EMPTY) continue;
      board[c] = BLACK;
      const len = runDirB(board, c, d);
      board[c] = EMPTY;
      if (len === 5) return true;
    }
    return false;
  }

  // 该方向是否"活三"：补一子能形成**活四**，且该补点不因长连失效（§26.2 伪活三排除）
  function isOpenThreeDir(board, idx, d) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    const x0 = idx % N, y0 = (idx / N) | 0;
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const nx = x0 + dx * k, ny = y0 + dy * k;
      if (!inBoard(nx, ny)) continue;
      const c = idxOf(nx, ny);
      if (board[c] !== EMPTY) continue;
      board[c] = BLACK;
      let live4 = false;
      try {
        let over = false;                                  // 补点致长连 → 该补点是禁手，不能形成有效活四
        // ★ runDirB 签名是 (board, idx, d)；必须传补点 c 的**索引**，不是坐标
        for (let dd = 0; dd < 4; dd++) if (runDirB(board, c, dd) >= 6) { over = true; break; }
        if (!over && runDirB(board, c, d) === 4) {
          let sx = nx, sy = ny;
          while (inBoard(sx - dx, sy - dy) && board[idxOf(sx - dx, sy - dy)] === BLACK) { sx -= dx; sy -= dy; }
          let ex = nx, ey = ny;
          while (inBoard(ex + dx, ey + dy) && board[idxOf(ex + dx, ey + dy)] === BLACK) { ex += dx; ey += dy; }
          const lOk = inBoard(sx - dx, sy - dy) && board[idxOf(sx - dx, sy - dy)] === EMPTY;
          const rOk = inBoard(ex + dx, ey + dy) && board[idxOf(ex + dx, ey + dy)] === EMPTY;
          live4 = lOk && rOk;                              // 四子且两端空 = 活四
        }
      } finally { board[c] = EMPTY; }
      if (live4) return true;
    }
    return false;
  }

  // 假定 board[idx] === BLACK（已模拟落子）；返回禁手等级 L.OVERLINE / L.DOUBLE_FOUR / L.DOUBLE_THREE，合法返回 0
  function forbiddenCore(board, idx, mode) {
    let hasFive = false, maxR = 0;
    for (let d = 0; d < 4; d++) {
      const len = runDirB(board, idx, d);
      if (len === 5) hasFive = true;
      if (len > maxR) maxR = len;
    }
    if (maxR >= 6 && (mode === 2 || !hasFive)) return L.OVERLINE;   // 长连（rif 下"未同时成恰好五"才算）
    if (hasFive) return FD_NONE;                                    // 恰好五连优先 → 非禁手（胜）
    let fours = 0;
    for (let d = 0; d < 4; d++) if (isFourDir(board, idx, d)) fours++;
    if (fours >= 2) return L.DOUBLE_FOUR;
    let threes = 0;
    for (let d = 0; d < 4; d++) if (isOpenThreeDir(board, idx, d)) threes++;
    if (threes >= 2) return L.DOUBLE_THREE;
    return FD_NONE;
  }

  // 对外：判"黑棋落 idx"是否禁手（mode: 0/1/2）
  // ★ A11：`FORBID_MEMO_ON` 打开时走缓存（`forbiddenAtCached` 同语义）；默认关 = 直接计算。
  //   **只有一个入口**是故意的——search/threat/eval/coach 各处调用无需改一行即可受益。
  function forbiddenAt(board, idx, mode) {
    if (FORBID_MEMO_ON) return forbiddenAtCached(board, idx, mode);
    const m = mode | 0;
    if (!m || board[idx] !== EMPTY) return FD_NONE;
    board[idx] = BLACK;
    let r;
    try { r = forbiddenCore(board, idx, m); } finally { board[idx] = EMPTY; }
    return r;
  }

  /* ---------- A11 禁手评估缓存（§4.12，纯缓存层）----------
  * ★★ 键设计（改这条前必须读）：**不可**用 `board.join('')` 做键——
  *   实测端到端反而慢 1.415×：键构造 3.87µs 比 `forbiddenCore` 裸算 3.67µs **还贵**。
  *   ⇒ 用**局部窗整数哈希键**：结论只依赖 idx 周围 R 内格子（58674 次真实调用 0 冲突；
  *     五连/四/活三判定半径 ≤5，取 R=5=121 格留余量）。双 32 位哈希（FNV-1a ⊕ 混合器）
  *     ≈64 bit，构造 0.56µs ⇒ 端到端 0.794×（省 20.6%）。
  *   ⚠ **哈希碰撞会静默给错禁手结论**是本条最危险失效模式 ⇒ 由"关态 vs 开态 diff==0"
  *     + 局部性护栏双双守住（见 test/forbid-memo.test.js）。
  * ★ 绝不把结果写进棋盘结构（undo 失效）——只用外部 Map；容量策略照抄 LINE_MEMO（超限整表 clear，O(1) 不 OOM）。
  * ★ 门控：search 的 think() 依 cfg.forbidMemo 调 forbidMemoSet；默认 false=现状（每次重算，逐位不变）。
   *   `forbiddenAt` 是唯一入口 ⇒ search/threat/eval/coach 各处调用无需改一行即可受益。
   */
  const FORBID_MEMO = new Map();
  const FORBID_MEMO_MAX = 300000;
  let FORBID_MEMO_ON = false;
  let FM_HIT = 0, FM_MISS = 0;                              // A11 观测计数（只读导出）
  const FM_R = 5, FM_SPAN = 2 * FM_R + 1;                   // R=5 ⇒ 11×11 = 121 格
  const FM_OFF = (function () {                             // 预展开 121 个 (dx,dy) 偏移
    const a = new Int32Array(FM_SPAN * FM_SPAN * 2); let k = 0;
    for (let dy = -FM_R; dy <= FM_R; dy++) for (let dx = -FM_R; dx <= FM_R; dx++) { a[k++] = dx; a[k++] = dy; }
    return a;
  })();

  function forbidMemoSet(on) {                              // search.js 每次 think 调用
    const v = on === true;
    if (v && !FORBID_MEMO_ON) { FM_HIT = 0; FM_MISS = 0; }   // 冷启动：从关→开时清零，便于观测
    FORBID_MEMO_ON = v;
    return FORBID_MEMO_ON;
  }
  function forbidMemoClear() { FORBID_MEMO.clear(); return FORBID_MEMO.size; }
  function forbidMemoStats() { return { hit: FM_HIT, miss: FM_MISS, size: FORBID_MEMO.size, on: FORBID_MEMO_ON, R: FM_R }; }

  // 局部窗双 32 位哈希键（FNV-1a ⊕ 混合器）⇒ ~64 bit 安全串
  function forbidKey(board, idx, mode) {
    const x = idx % N, y = (idx / N) | 0;
    let h1 = 0x811c9dc5 | 0, h2 = 0x9e3779b9 | 0;
    for (let k = 0; k < FM_OFF.length; k += 2) {
      const nx = x + FM_OFF[k], ny = y + FM_OFF[k + 1];
      const v = (nx < 0 || nx >= N || ny < 0 || ny >= N) ? 3 : board[ny * N + nx];
      h1 = (Math.imul(h1 ^ v, 16777619)) | 0;
      h2 = (Math.imul(h2 + v, 0x85ebca6b)) | 0;
    }
    return h1 + ',' + h2 + ',' + mode;
  }

  // 对外的"带缓存"入口：语义与 forbiddenAt 完全一致（同样的前置短路 / 同结果）
  function forbiddenAtCached(board, idx, mode) {
    const m = mode | 0;
    if (!m || board[idx] !== EMPTY) return FD_NONE;
    const key = forbidKey(board, idx, m);
    let r = FORBID_MEMO.get(key);
    if (r === undefined) {
      FM_MISS++;
      board[idx] = BLACK;
      try { r = forbiddenCore(board, idx, m); } finally { board[idx] = EMPTY; }
      if (FORBID_MEMO.size > FORBID_MEMO_MAX) FORBID_MEMO.clear();
      FORBID_MEMO.set(key, r);
    } else FM_HIT++;
    return r;
  }

  // 统一入口：由 (player, rule, overlineMode) 决定禁手语境
  function forbidMode(player, rule, overlineMode) {
    if (rule !== 'renju' || player !== BLACK) return 0;
    return overlineMode === 'strict' ? 2 : 1;
  }

  // 热路径入口：假设 player 落 idx，直接返回组合等级（无任何堆分配）
  //
  // ★ Renju-黑（mode>0）时**无条件调用严格算法**：曾用"廉价预检"跳过大多数点，
  //   但该预检**双向不可靠**——
  //     · 假阴 19.5~23.7%：把必败点判成合法并给**正分**（长连甚至 +1e8=WIN），
  //       实测导致引擎**真的走出禁手点自败**；
  //     · 假阳：decideOf 用**窗口**计数重判禁手，与 forbiddenCore 的**严格**口径
  //       不一致 → 引擎拒绝走合法好着。
  //   且存在"窗口最强型=活二、严格=活三"的形态 ⇒ 任何基于窗口输出的门槛都无法
  //   sound ⇒ 唯一 100% sound 的做法是恒调严格算法。
  //   代价可接受：levelAt 单次 0.33→5.5µs，但真实搜索节点数与深度不变、耗时 +25%。
  //
  // ★ 语义约定：mode>0 时返回值为**严格判定结果**——
  //   禁手 ⇒ OVERLINE / DOUBLE_FOUR / DOUBLE_THREE；合法 ⇒ **绝不返回这三个值**
  //   （否则调用方无法用"等级是否属于禁手集"来区分真假禁手）。
  //   故合法时用 `decideOf(...,0)` 后**再把禁手等级降为等价的合法等级**。
  function levelAt(board, idx, player, mode) {
    const a = classifyIdx(board, idx, 0, player), b = classifyIdx(board, idx, 1, player),
          c = classifyIdx(board, idx, 2, player), d = classifyIdx(board, idx, 3, player);
    const m = mode | 0;
    if (m > 0) {
      const placed = board[idx] === BLACK;
      if (!placed) board[idx] = BLACK;
      let st = 0;
      try { st = forbiddenCore(board, idx, m); } finally { if (!placed) board[idx] = EMPTY; }
      if (st) return st;              // 严格判定为禁手 → 用禁手等级（评分 −1e9）
      // 严格判定为"合法"：按无禁手口径取等级，并把仅由窗口组合得到的
      // 禁手等级降级（双四→活四/冲四，双三→活三），避免与"真禁手"混淆。
      const lv = decideOf(a, b, c, d, 0);
      if (lv === L.DOUBLE_FOUR) return (a === P.OPEN_FOUR || b === P.OPEN_FOUR ||
                                        c === P.OPEN_FOUR || d === P.OPEN_FOUR) ? L.OPEN_FOUR : L.FOUR;
      if (lv === L.DOUBLE_THREE) return L.OPEN_THREE;
      if (lv === L.OVERLINE) return L.WIN;          // rif 下"同时成恰好五"⇒ 合法胜
      return lv;
    }
    return decideOf(a, b, c, d, m);
  }

  /* ---------- 线式计数（叶子评估用，直线棋型）---------- */
  const LINES = (function buildLines() {
    const out = [];
    for (let y = 0; y < N; y++) { const ln = []; for (let x = 0; x < N; x++) ln.push(idxOf(x, y)); out.push(ln); }
    for (let x = 0; x < N; x++) { const ln = []; for (let y = 0; y < N; y++) ln.push(idxOf(x, y)); out.push(ln); }
    for (let s = -N + 5; s <= N - 5; s++) { const ln = []; for (let y = 0; y < N; y++) { const x = y + s; if (x >= 0 && x < N) ln.push(idxOf(x, y)); } if (ln.length >= 5) out.push(ln); }
    for (let s = 4; s <= 2 * N - 6; s++) { const ln = []; for (let y = 0; y < N; y++) { const x = s - y; if (x >= 0 && x < N) ln.push(idxOf(x, y)); } if (ln.length >= 5) out.push(ln); }
    return out;
  })();

  function scanRuns(s) {
    const c = { five: 0, overline: 0, openFour: 0, four: 0, openThree: 0, sleepThree: 0, openTwo: 0, sleepTwo: 0 };
    let i = 0;
    while (i < s.length) {
      if (s[i] !== 'o') { i++; continue; }
      let j = i; while (j < s.length && s[j] === 'o') j++;
      const len = j - i;
      const lo = i - 1 >= 0 && s[i - 1] === '.';
      const ro = j < s.length && s[j] === '.';
      if (len >= 6) c.overline++;
      else if (len === 5) c.five++;
      else if (len === 4) { if (lo && ro) c.openFour++; else if (lo || ro) c.four++; }
      else if (len === 3) { if (lo && ro) c.openThree++; else if (lo || ro) c.sleepThree++; }
      else if (len === 2) { if (lo && ro) c.openTwo++; else if (lo || ro) c.sleepTwo++; }
      i = j;
    }
    return c;
  }

  /* ---------- 增量线分缓存（§33.3，P0 性能关键） ---------- */
  // 固定类型顺序（缓存槽位下标），下标 t 对应的单棋型见 P_OF_T
  const NT = 8;
  const P_OF_T = [P.FIVE, P.OVERLINE, P.OPEN_FOUR, P.FOUR, P.OPEN_THREE, P.SLEEP_THREE, P.OPEN_TWO, P.SLEEP_TWO];
  const sideOff = p => (p === BLACK ? 0 : NT);          // 全局计数布局：[0..7]=黑 [8..15]=白

  // 每个格点所属的 4 条线（§33.3：落子只影响过该点的 4 条线）
  const CELL_LINES = (function () {
    const a = new Int32Array(NN * 4).fill(-1);
    for (let li = 0; li < LINES.length; li++) {
      const line = LINES[li];
      for (let k = 0; k < line.length; k++) {
        const b = line[k] * 4;
        for (let s = 0; s < 4; s++) if (a[b + s] === -1) { a[b + s] = li; break; }
      }
    }
    return a;
  })();

  // 沿线统计 player 的棋型（等价 scanRuns，但直接读棋盘、零字符串分配）
  function scanLineInto(line, board, player, out, off) {
    const n = line.length;
    let five = 0, over = 0, of = 0, fo = 0, ot = 0, st = 0, otwo = 0, stwo = 0;
    let i = 0;
    while (i < n) {
      if (board[line[i]] !== player) { i++; continue; }
      let j = i; while (j < n && board[line[j]] === player) j++;
      const len = j - i;
      const lo = i - 1 >= 0 && board[line[i - 1]] === EMPTY;
      const ro = j < n && board[line[j]] === EMPTY;
      if (len >= 6) over++;
      else if (len === 5) five++;
      else if (len === 4) { if (lo && ro) of++; else if (lo || ro) fo++; }
      else if (len === 3) { if (lo && ro) ot++; else if (lo || ro) st++; }
      else if (len === 2) { if (lo && ro) otwo++; else if (lo || ro) stwo++; }
      i = j;
    }
    out[off] = five; out[off + 1] = over; out[off + 2] = of; out[off + 3] = fo;
    out[off + 4] = ot; out[off + 5] = st; out[off + 6] = otwo; out[off + 7] = stwo;
  }

  // 全量建缓存（搜索开始前一次）
  function newLineCache(board) {
    const nL = LINES.length;
    const lines = new Int32Array(nL * 2 * NT);
    const tot = new Int32Array(2 * NT);
    for (let li = 0; li < nL; li++) {
      const line = LINES[li], off = li * 2 * NT;
      scanLineInto(line, board, BLACK, lines, off);
      scanLineInto(line, board, WHITE, lines, off + NT);
      for (let t = 0; t < NT; t++) { tot[t] += lines[off + t]; tot[NT + t] += lines[off + NT + t]; }
    }
    return { lines: lines, tot: tot, nLines: nL };
  }

  // 增量更新：重算过 idx 的 4 条线，修正全局合计（make/unmake 后均可调用，自校正）
  function cacheUpdate(lc, idx, board) {
    const lines = lc.lines, tot = lc.tot, base = idx * 4;
    for (let k = 0; k < 4; k++) {
      const li = CELL_LINES[base + k];
      if (li < 0) continue;
      const line = LINES[li], off = li * 2 * NT;
      for (let t = 0; t < NT; t++) { tot[t] -= lines[off + t]; tot[NT + t] -= lines[off + NT + t]; }
      scanLineInto(line, board, BLACK, lines, off);
      scanLineInto(line, board, WHITE, lines, off + NT);
      for (let t = 0; t < NT; t++) { tot[t] += lines[off + t]; tot[NT + t] += lines[off + NT + t]; }
    }
  }

  // 线内容 → 双方棋型计数（线级 memo：同一条线内容只扫一次，§33.2 预计算思想）
  const LINE_MEMO = new Map();
  function zeroCounts() { return { five: 0, overline: 0, openFour: 0, four: 0, openThree: 0, sleepThree: 0, openTwo: 0, sleepTwo: 0 }; }
  function addInto(dst, src) {
    dst.five += src.five; dst.overline += src.overline; dst.openFour += src.openFour; dst.four += src.four;
    dst.openThree += src.openThree; dst.sleepThree += src.sleepThree; dst.openTwo += src.openTwo; dst.sleepTwo += src.sleepTwo;
  }
  function scanLine(line, board) {
    let sB = '', sW = '';
    for (let k = 0; k < line.length; k++) {
      const v = board[line[k]];
      sB += v === EMPTY ? '.' : (v === BLACK ? 'o' : 'x');
      sW += v === EMPTY ? '.' : (v === WHITE ? 'o' : 'x');
    }
    return { 1: scanRuns(sB), 2: scanRuns(sW) };
  }
  function lineKey(line, board) {
    let key = line.length;
    for (let k = 0; k < line.length; k++) key = key * 3 + board[line[k]];
    return key;
  }
  function countBoth(board) {
    const tb = zeroCounts(), tw = zeroCounts();
    for (let li = 0; li < LINES.length; li++) {
      const line = LINES[li];
      const key = lineKey(line, board);
      let c = LINE_MEMO.get(key);
      if (c === undefined) {
        c = scanLine(line, board);
        if (LINE_MEMO.size > 300000) LINE_MEMO.clear();
        LINE_MEMO.set(key, c);
      }
      addInto(tb, c[1]); addInto(tw, c[2]);
    }
    return { 1: tb, 2: tw };
  }
  function countAll(board, player) { return countBoth(board)[player]; }

  /* ---------- A6 增量材料表（§4.7，只做计数，不做 see 位掩码） ----------
   * 目标：O(1) 摊销地维护「全盘材料计数」（双方各 8 个单棋型计数），
   *       供 A5 `wldOf` 做 3 次比较判定胜负。
   *
   * ★ 口径纪律：
   *   **不缓存"等级计数"**（`levelAt` 的等级有 规则/角色/手番 三维），
   *   **只缓存"单棋型计数"**这类规则无关的事实。这与 `scanLineInto` / `countBoth`
   *   的既有口径**完全一致** ⇒ 与 `lc.tot` 是同一个量，可逐位对拍。
   *
   * ★ 与 `lc`（§33.3 线分缓存）的关系：**同源但独立**
   *   · 相同：都只统计"直线 run 棋型"，都不含跳型（跳型由点式窗口覆盖）。
   *   · 不同：`lc` 按**线**聚合（72 线 × 双方），`material` 按**方**聚合并**原地递增**。
   *   · 都能被同一个 `pos.onCell` 钩子维护 ⇒ **不引入第二套钩子机制**（§4.7 要求）。
   *
   * ★ 实现方式：**原地 `+= delta`，不换数组引用**。
   *   原因：`eval.staticEvalPos` 每次热路径取 `pos.lc.tot` 生成新 `Int32Array`
   *   会额外触发一次分配（实测 makeMove 0.873→2.0µs，−2.3×），改完后 1.102µs。
   *   ⇒ 增量结构必须**原地改**；为此 `core.unmakeMove` 也补上了 `onCell` 通知
   *   （线段内容由棋盘唯一决定 ⇒ 重算即复原，自校正、幂等）。
   */
  const NCLS = NT;                       // 与线分缓存共用槽位布局（见 P_OF_T）
  const P_OF_CLS = P_OF_T;               // 槽位 t ↔ 单棋型

  // 过格点 idx 的 4 条线的**线号**。
  // ★ 评审：此处曾是 CELL_LINES 的逐字复制（同构造、同"首次出现即归属"），
  //   只因名字不同而重复构建；改了 CELL_LINES 不会改它 ⇒ 增量缓存静默漂移风险。
  //   A6 本就要求与 lc 逐位一致，故直接别名共用。
  const CELL_LINES4 = CELL_LINES;

  // 统计**单方** player 在"过 idx 的 4 条线"上的棋型计数（写进 out[off..off+7]）
  // 注意：这不是"该点的局部棋型"，而是 A6 增量算法真正需要的量——
  //       每次 make/unmake 重算这 4 条线的**双方**计数并取差，即得 material 的 delta。
  function scanLine4(board, idx, player, out, off) {
    let five = 0, over = 0, of = 0, fo = 0, ot = 0, st = 0, otwo = 0, stwo = 0;
    const base = idx * 4;
    for (let k = 0; k < 4; k++) {
      const li = CELL_LINES4[base + k];
      if (li < 0) continue;
      const line = LINES[li], n = line.length;
      let i = 0;
      while (i < n) {
        if (board[line[i]] !== player) { i++; continue; }
        let j = i; while (j < n && board[line[j]] === player) j++;
        const len = j - i;
        const lo = i - 1 >= 0 && board[line[i - 1]] === EMPTY;
        const ro = j < n && board[line[j]] === EMPTY;
        if (len >= 6) over++;
        else if (len === 5) five++;
        else if (len === 4) { if (lo && ro) of++; else if (lo || ro) fo++; }
        else if (len === 3) { if (lo && ro) ot++; else if (lo || ro) st++; }
        else if (len === 2) { if (lo && ro) otwo++; else if (lo || ro) stwo++; }
        i = j;
      }
    }
    out[off] = five; out[off + 1] = over; out[off + 2] = of; out[off + 3] = fo;
    out[off + 4] = ot; out[off + 5] = st; out[off + 6] = otwo; out[off + 7] = stwo;
  }

  // 方向归属偏移：material 槽位 = playerOff + cls，与 sideOff/NT 布局同构
  const matOff = (player, cls) => (player === BLACK ? 0 : NCLS) + cls;

  // 全量建表（搜索开始前 / attach 时一次）：material[p][cls]
  function materialOf(board) {
    const m = new Int32Array(2 * NCLS);
    const scratch = new Int32Array(NCLS);
    for (let p = 1; p <= 2; p++) {
      const off = p === BLACK ? 0 : NCLS;
      for (let li = 0; li < LINES.length; li++) {
        scanLineInto(LINES[li], board, p, scratch, 0);
        for (let t = 0; t < NCLS; t++) m[off + t] += scratch[t];
      }
    }
    return m;
  }

  // 线内容 → 双方 8 类计数（写进 out[off] 与 out[off+NT] 两段）
  function lineCounts(line, board, out, off) {
    scanLineInto(line, board, BLACK, out, off);
    scanLineInto(line, board, WHITE, out, off + NCLS);
  }

  // 增量：重算过 idx 的 4 条线，原地修正 material（**必须原地**，见上方注释）。
  //
  // ★ 语义（易错）：**调用时棋盘处于"该手已落"的状态**（post 相位），
  //   而 `before` 是"该手落子前"这 4 条线的计数快照（cellHook 在 pre 相位采集）。
  //   算法：逐线 `mat += (当前线计数 − before 里的线计数)`；每一步都与 `lc` 同构
  //   （同一条线跨状态取差），故 `material` 与 `lc.tot` 天然逐位一致（对拍为 0）。
  //   ⚠ 首版把两次读取都放在"棋盘已更新"之后 ⇒ 差恒为 0 ⇒ 缓存单向漂移，
  //     实测 2400 步里 2026 步偏离（典型：把两只白子之间的空点填黑，白活二本该消失，
  //     差分里却从未记录它出现过）。**切勿**再写成那样。
  //   `cur` 由调用方提供（cellHook 传模块级 scratch），避免热路径每节点分配。
  function materialInc(mat, idx, board, before, beforeOff, cur) {
    const base = idx * 4;
    const bo = beforeOff | 0;
    const c = cur || new Int32Array(NCLS);
    for (let k = 0; k < 4; k++) {
      const li = CELL_LINES4[base + k];
      if (li < 0) continue;
      const line = LINES[li];
      for (let p = 1; p <= 2; p++) {
        const off = p === BLACK ? 0 : NCLS;
        scanLineInto(line, board, p, c, 0);
        for (let t = 0; t < NCLS; t++) {
          mat[off + t] += c[t] - (before[bo + k * 2 * NCLS + off + t] | 0);
        }
      }
    }
  }

  // 取某格点 4 条线（双方）的当前计数快照（布局 [k][黑8][白8] → 索引 k*2*NCLS + off）
  function lines4Counts(board, idx, out) {
    const base = idx * 4;
    const o = out || new Int32Array(4 * 2 * NCLS);
    for (let k = 0; k < 4; k++) {
      const li = CELL_LINES4[base + k];
      if (li < 0) { for (let t = 0; t < 2 * NCLS; t++) o[k * 2 * NCLS + t] = 0; continue; }
      lineCounts(LINES[li], board, o, k * 2 * NCLS);
    }
    return o;
  }

  /* ---------- 取分（规则 × 手番）---------- */
  // 组合等级取分；relation: 'stm' 走子方 / 'opp' 非走子方
  function levelScore(level, rule, role, relation) {
    if (rule === 'renju' && role === 'black') {
      if (level === L.DOUBLE_FOUR || level === L.DOUBLE_THREE || level === L.OVERLINE) return FORBIDDEN;
    }
    if (level === L.WIN) return WIN;
    if (level === L.OVERLINE) return WIN;                     // 无禁手/白方：长连算胜
    if (level === L.DEAD) return relation === 'stm' ? -5 : 5;
    const m = Lof(level);
    if (relation !== 'opp') return m;
    const t = LEVEL_T[level] === undefined ? 1 : LEVEL_T[level];
    return Math.round(m * t);
  }
  // 单棋型取分（叶子）
  function singleScore(p, rule, role, relation) {
    if (rule === 'renju' && role === 'black' && p === P.OVERLINE) return FORBIDDEN;
    if (p === P.FIVE) return WIN;
    if (p === P.OVERLINE) return WIN;                          // 无禁手/白方长连算胜
    const m = Mof(p) || 0;
    if (relation !== 'opp') return m;
    const t = Tof(p) === undefined ? 1 : Tof(p);
    return Math.round(m * t);
  }

  /* ---------- A5：O(1) 胜负判定（§4.8）----------
   * 判据与 staticEval 的终局短路逐位同一套："四"=冲四或活四；对手双四=openFour||four>=2；
   * **长连仅 Renju 下对黑是禁手负**（缺陷 #36）。renju 禁手终判必须另走 forbiddenCore（#33）。
   * 编码（零分配热路径）：+100 己胜 / -100 己负（五连、长连）；+1 己方有"四"（一步胜）；
   * -2 对方活四或双四（必负）；**0 = 未知（含 offset 3 主动）**——主动不能编成正数，
   * 否则 `c>0` 被误读成"已胜"（缺陷 #37）。要 offset 语义用 `wldOf`。 */
  const WLD_W = 'W', WLD_L = 'L', WLD_D = 'D';
  const WLD_END = 100;

  function wldCode(pos, boardOverride, rule) {
    const board = boardOverride || pos.board;
    const rl = rule || (pos.rule || 'freestyle');
    const stm = pos.stm, o = stm === BLACK ? WHITE : BLACK;
    const m = pos.material || materialOf(board);
    const sb = stm === BLACK ? 0 : NCLS, ob = o === BLACK ? 0 : NCLS;

    if (m[sb + 0] > 0) return WLD_END;                                  // 己方五连
    if (m[sb + 1] > 0) return (rl === 'renju' && stm === BLACK) ? -WLD_END : WLD_END;
    if (m[sb + 2] > 0 || m[sb + 3] >= 1) return 1;                      // 己方有"四"
    if (m[ob + 0] > 0) return -WLD_END;                                 // 对方五连
    if (m[ob + 1] > 0) return (rl === 'renju' && o === BLACK) ? WLD_END : -WLD_END;
    if (m[ob + 2] > 0 || m[ob + 3] >= 2) return -2;                     // 对方活四/双四
    return 0;
  }

  // 对象版（会分配；热路径用 wldCode）。offset: 0 已结束 / 1 己方一步胜 / 2 对方一步胜 / 3 主动。
  function wldOf(pos, boardOverride, rule) {
    const board = boardOverride || pos.board;
    const c = wldCode({ stm: pos.stm, board: board, material: pos.material }, board, rule);
    const stm = pos.stm, o = stm === BLACK ? WHITE : BLACK;
    if (c > 0) return { winner: stm, offset: c >= WLD_END ? 0 : c, wld: WLD_W };
    if (c < 0) return { winner: o, offset: -c >= WLD_END ? 0 : -c, wld: WLD_L };
    const m = pos.material || materialOf(board);
    const sb = stm === BLACK ? 0 : NCLS, ob = o === BLACK ? 0 : NCLS;
    if (m[sb + 4] > 0 && m[ob + 2] === 0 && m[ob + 3] === 0) return { winner: 0, offset: 3, wld: WLD_D };
    return { winner: 0, offset: 0, wld: WLD_D };
  }

  return {
    P, PNAME, L, LNAME, WIN, FORBIDDEN,
    LEVEL_M, LEVEL_T, SINGLE_M, SINGLE_T,
    // §17.4 调参钩子（离线局部搜索用；线上默认全为 null，取值即出厂表）
    setTune, resetTune, tuneState, tuneGen: () => TUNE_GEN,
    colorRole, decideLevel, decideOf, classifyAt, classifyWindow, gradeAt, windowAt,
    // §26 严格禁手判定（Renju 黑）
    FD_NONE, forbiddenAt, forbiddenCore, forbidMode, isFourDir, isOpenThreeDir,
    // A11 禁手评估缓存（§4.12）：纯缓存层，语义与 forbiddenAt 逐位一致
    forbiddenAtCached, forbidMemoSet, forbidMemoClear, forbidMemoStats,
    // 整数编码热路径（§33.2）
    WCODE_N, codeAt, decode9, classifyCode, classifyIdx, dirsAt, levelAt, W9,
    LINES, scanRuns, countAll, countBoth, zeroCounts, levelScore, singleScore,
    // §33.3 增量线分缓存
    NT, P_OF_T, sideOff, CELL_LINES, scanLineInto, newLineCache, cacheUpdate,
    // A6 增量材料表（§4.7）：只做计数，口径与 countBoth / lc.tot 逐位一致
    NCLS, P_OF_CLS, CELL_LINES4, scanLine4, matOff, materialOf, materialInc, lines4Counts, lineCounts,
    // A5 O(1) 胜负判定（§4.8）：依赖 A6 的材料计数
    wldOf, wldCode, WLD_W, WLD_L, WLD_D, WLD_END,
  };
});
