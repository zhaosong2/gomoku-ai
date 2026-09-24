/* engine/eval.js — 评估（M2）
 * 设计依据：§4.4 着法级评分（仅排序）/ §4.5+§4.7 手番感知静态评估
 *  · evaluateMove：落子前的启发式，**只用于着法排序**，参考系=我方。
 *  · staticEval  ：叶子静态评估，参考系=走子方，手番双栏 + 终局短路。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'), require('./patterns.js'));
  else { root.G = root.G || {}; root.G.eval = factory(root.G.core, root.G.patterns); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT) {
  'use strict';
  const { N, NN, EMPTY, BLACK, WHITE, DIRS, idxOf, inBoard, opp } = core;
  const DEFAULT = { rule: 'freestyle', overlineMode: 'rif', lambda: 0.9, wldFast: false, candBit: false };

  // ★ 排序层禁手降幅（§13 ⑤(e) 方案 C，2026-09-20，#33）
  //   `PAT.FORBIDDEN`（−1e9）是 `levelScore` 的公开契约（`patterns.test.js:44-46` 依赖），
  //   故**不改** `levelScore` 的返回值；只在**排序分** `atk` 项把它缩到 −1e5。
  //   理由：−1e9 与"活四"(1e6) 差 1e15（同尺度断层），会让深搜为了躲一个远期禁手
  //   而弃掉眼前的胜势着法。缩到 −1e5 后：
  //     · 仍严格低于所有合法着法的最小分（实测 −9.5，`_probe-planC22.js`）；
  //     · 与"活四"(1e6) 比 10 倍（与出厂"双四/活四"的 8.3 倍同量级）。
  //   **不改** `eval.js` 第 62-64 行"对手禁手点威胁归零"（§7.3 有意设计，逼禁之源）。
  const FORBID_SORT = PAT.FORBIDDEN * 1e-4;   // = −1e5

  // 候选点：距已有棋子 <= radius 的空点；空盘返回天元
  // 复用 scratch 缓冲 + 代数戳，避免每次调用分配 225 字节（§33.8 减 GC 抖动）
  //
  // ★ A9 候选位图（§4.10，`cfg.candBit`）：收集阶段改用 `Uint32Array(8)` 位图（225 bit），
  //   迭代时**跳过全零 word**，省掉"225 格逐格比对代数戳"的一部分开销。
  //   实测（`tools/_a9-bitmap.js`，24 个真实局面）：**3.23 → 2.71 µs（快 16%）**，
  //   且**输出顺序逐位一致**（位图按 word 升序、word 内按 bit 升序 ⇒ 与 `i` 升序同序，
  //   这是调用方依赖的契约，**最容易漏的坑**）。
  //   ★ 两条被实测否掉的替代方案（勿重走）：
  //     ① `bbox` 矩形裁剪：朴素版 **3.88 µs（更慢）**——逐候选再验"是否邻域"比代数戳贵；
  //     ② 预展开 5×5 偏移数组：**4.03 µs（慢 48%）**——V8 对双层 for 的边界消除
  //        远优于数组索引寻址。故保留局部 `dy/dx` 双层循环。
  //   默认 **false = 现状**（代数戳路径）；回滚 = 不传 `cfg.candBit`。
  const _mark = new Int32Array(NN);
  let _gen = 0;
  const _candBM = new Uint32Array(8);               // A9：225 bit 位图（8×32=256 ≥ 225）
  function candidatesSlow(board, radius) {          // 旧路径（保留：对拍基线 + 默认关时使用）
    const r = radius === undefined ? 2 : radius;
    const out = [];
    if (_gen > 1e9) { _mark.fill(0); _gen = 0; }
    const g = ++_gen;
    for (let i = 0; i < NN; i++) {
      if (board[i] === EMPTY) continue;
      const x = i % N, y = (i / N) | 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= N) continue;
        const row = ny * N;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= N) continue;
          const j = row + nx;
          if (board[j] === EMPTY) _mark[j] = g;
        }
      }
    }
    for (let i = 0; i < NN; i++) if (_mark[i] === g) out.push(i);
    if (!out.length) return [idxOf(7, 7)];      // 空盘
    return out;
  }
  function candidatesBit(board, radius) {           // A9：位图收集版（同序）
    const r = radius === undefined ? 2 : radius;
    const bm = _candBM;
    bm[0] = bm[1] = bm[2] = bm[3] = bm[4] = bm[5] = bm[6] = bm[7] = 0;
    for (let i = 0; i < NN; i++) {
      if (board[i] === EMPTY) continue;
      const x = i % N, y = (i / N) | 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= N) continue;
        const row = ny * N;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= N) continue;
          const j = row + nx;
          if (board[j] === EMPTY) bm[j >> 5] |= (1 << (j & 31));
        }
      }
    }
    const out = [];
    for (let w = 0; w < 8; w++) {
      let bits = bm[w];
      if (!bits) continue;                          // 跳过全零 word（A9 的主要收益点）
      const base = w << 5;
      while (bits) {
        const b = bits & -bits;                     // 取最低位
        out.push(base + (31 - Math.clz32(b)));
        bits ^= b;
      }
    }
    if (!out.length) return [idxOf(7, 7)];      // 空盘
    return out;
  }
  // 门控：`_candBit` 由 `sortedMoves` 依 `cfg.candBit` 设置（默认关 ⇒ 走旧路径，逐位不变）
  //   ★ 观测计数（§4.10 验收）：分别记录两版被实际调用的次数，供 `candStat()` 读取。
  //   `setCandBit` 采用**冷启动清零**语义（与 `forbidMemoSet` 一致）：
  //   每次调用都清零计数 ⇒ 便于「设一次 → 跑一段 → 读一次」地观测单次 run 的走向。
  let _candBit = false;
  let _csSlow = 0, _csBit = 0;
  function setCandBit(on) { _candBit = on === true; _csSlow = 0; _csBit = 0; return _candBit; }
  function candidates(board, radius) {
    if (_candBit) { _csBit++; return candidatesBit(board, radius); }
    _csSlow++; return candidatesSlow(board, radius);
  }
  function candStat() { return { slow: _csSlow, bit: _csBit, on: _candBit }; }

  // 着法级评分（§4.4）：attack + λ·defend + 中心微调。**仅排序用**
  // out（可选）会被写入 { level, forbid }，供调用方复用同一次定级（避免重复计算）
  //
  // ★ 禁手判定口径（2026-09-20，#33）：`out.forbid` **必须**取自严格判定
  //   （`forbiddenAt`，§26），**不能**再从 `la` 是否等于 DOUBLE_*/OVERLINE 推断
  //   ——`levelAt` 的 `decideOf` 会用**窗口**计数给出 DOUBLE_THREE/DOUBLE_FOUR，
  //   而窗口口径与严格口径在 ≈0.01% 的点上不一致（`_probe-planC16.js` 假阳），
  //   会把合法着法误标为禁手、进而被排序踢到最后（拒绝走好着）。
  function moveScoreAt(board, i, player, cfg, out) {
    const c = cfg || DEFAULT;
    const ifEmpty = board[i] !== EMPTY;
    if (ifEmpty) { if (out) { out.level = PAT.L.DEAD; out.forbid = 0; } return -Infinity; }
    const o = opp(player);
    const mP = PAT.forbidMode(player, c.rule, c.overlineMode);      // 我方禁手语境（§7.3）
    const mO = PAT.forbidMode(o, c.rule, c.overlineMode);
    const la = PAT.levelAt(board, i, player, mP);
    const ld = PAT.levelAt(board, i, o, mO);
    // ★ 严格禁手真值（唯一权威口径）；mP=0（无禁手规则/白方）时恒 0
    const forbidP = mP > 0 ? PAT.forbiddenAt(board, i, mP) : 0;
    const forbidO = mO > 0 ? PAT.forbiddenAt(board, i, mO) : 0;
    const atk = forbidP ? FORBID_SORT : PAT.levelScore(la, c.rule, PAT.colorRole(player), 'stm');
    // ★ 对手的禁手点**不构成威胁**（对手走则判负）→ 防守项计 0。
    //   这正是白方"逼禁"能自然涌现的原因：黑棋解围点若全是禁手，其威胁值归零（§7.3）。
    const def = forbidO ? 0 : PAT.levelScore(ld, c.rule, PAT.colorRole(o), 'stm');
    const x = i % N, y = (i / N) | 0;
    const center = 14 - (Math.abs(x - 7) + Math.abs(y - 7));
    if (out) { out.level = la; out.forbid = forbidP; }
    return atk + c.lambda * def + center;
  }
  function evaluateMove(board, x, y, player, cfg) {
    return moveScoreAt(board, idxOf(x, y), player, cfg, null);
  }

  function sortedMoves(board, player, cfg) {
    const c = cfg || DEFAULT;
    // ★ A9（§4.10）：按 cfg.candBit 切换候选收集实现（默认关 ⇒ 逐位不变）
    setCandBit(c.candBit === true);
    const list = candidates(board, c.radius);
    const scored = list.map(i => ({ i, x: i % N, y: (i / N) | 0, s: evaluateMove(board, i % N, (i / N) | 0, player, c) }));
    scored.sort((a, b) => b.s - a.s);
    return scored;
  }

  // 叶子静态评估（§4.5/§4.7）：返回**走子方 stm 视角**分值
  function staticEval(board, stm, cfg) {
    const rule = (cfg && cfg.rule) || DEFAULT.rule;
    const o = opp(stm);
    const both = PAT.countBoth(board);
    const S = both[stm], O = both[o];
    const rs = PAT.colorRole(stm), ro = PAT.colorRole(o);

    // 终局 / 手番短路（§4.7(2a)）；规则感知：Renju 下**黑棋长连是负**，白棋长连是胜（§7.3）
    // ★ A5（§4.8，`cfg.wldFast`）：改走 `wldCode` 的 3 次比较，返回**同一套胜负值**。
    //   默认关（`wldFast` 未传 = false）⇒ 走下面原路径，逐位不变。
    //   ★ 用 `wldCode`（零分配）而非 `wldOf`（构造对象）——后者在叶子热路径会分配临时对象。
    const bkS = (rule === 'renju' && stm === BLACK), bkO = (rule === 'renju' && o === BLACK);
    if (cfg && cfg.wldFast === true) {
      // 无 pos ⇒ material 为 null ⇒ 全量建表（仅影响速度，不影响结论）
      const c = PAT.wldCode({ stm: stm, board: board, material: null }, board, rule);
      if (c > 0) return PAT.WIN;
      if (c < 0) return -PAT.WIN;
    } else {
    if (S.five > 0) return PAT.WIN;                         // 恰好五连：双方都是胜
    if (S.overline > 0) return bkS ? -PAT.WIN : PAT.WIN;    // 黑长连=禁手负
    if (S.openFour > 0 || S.four >= 1) return PAT.WIN;      // 走子方有任何"四" ⇒ 立即胜
    if (O.five > 0) return -PAT.WIN;
    if (O.overline > 0) return bkO ? PAT.WIN : -PAT.WIN;    // 对手（黑）长连 ⇒ 我方胜
    if (O.openFour > 0 || O.four >= 2) return -PAT.WIN;     // 对方活四 / 双四 ⇒ 必负
    }

    const sum = (c, role, rel) =>
      c.five * PAT.singleScore(PAT.P.FIVE, rule, role, rel) +
      c.overline * PAT.singleScore(PAT.P.OVERLINE, rule, role, rel) +
      c.openFour * PAT.singleScore(PAT.P.OPEN_FOUR, rule, role, rel) +
      c.four * PAT.singleScore(PAT.P.FOUR, rule, role, rel) +
      c.openThree * PAT.singleScore(PAT.P.OPEN_THREE, rule, role, rel) +
      c.sleepThree * PAT.singleScore(PAT.P.SLEEP_THREE, rule, role, rel) +
      c.openTwo * PAT.singleScore(PAT.P.OPEN_TWO, rule, role, rel) +
      c.sleepTwo * PAT.singleScore(PAT.P.SLEEP_TWO, rule, role, rel);

    return sum(S, rs, 'stm') - sum(O, ro, 'opp');           // 手番双栏：V_stm − V_opp
  }

  /* ---------- 增量叶子评估（§33.3，O(1) 摊还） ---------- */
  // 取分系数预计算：singleScore 对计数是线性的 ⇒ 叶子只需点积
  const COEF = new Map();
  function coeffOf(rule, role, rel) {
    const k = rule + '|' + role + '|' + rel;
    let c = COEF.get(k);
    if (!c) {
      const NT = PAT.NT;
      c = new Int32Array(NT);
      for (let t = 0; t < NT; t++) c[t] = PAT.singleScore(PAT.P_OF_T[t], rule, role, rel);
      COEF.set(k, c);
    }
    return c;
  }

  // 与 staticEval 逐位等价，但读 pos.lc 的增量合计（无 pos.lc 时回退全量扫描）
  function staticEvalPos(pos, cfg) {
    const lc = pos.lc;
    if (!lc) return staticEval(pos.board, pos.stm, cfg);
    const rule = (cfg && cfg.rule) || DEFAULT.rule;
    const stm = pos.stm, o = opp(stm), tot = lc.tot;
    const NT = PAT.NT, sb = PAT.sideOff(stm), ob = sb ^ NT;

    // 终局 / 手番短路（§4.7(2a)）——走位与 staticEval 完全一致（含 Renju 黑长连=负）
    // ★ A5 说明：本函数读 `lc.tot` 已是 **O(1)**，`wldCode` 在此**无速度收益**
    //   （实测 0.027 → 0.050 µs，多一次调用开销）⇒ **不接 wldFast**。
    //   A5 的收益在 `staticEval`（无增量表时 `countBoth` 要 9.3 µs）+ `coach.judge` 的
    //   `offset` 语义；见 §4.8 实施记录。
    const bkS = (rule === 'renju' && stm === BLACK), bkO = (rule === 'renju' && o === BLACK);
    if (tot[sb] > 0) return PAT.WIN;                               // S 恰好五连
    if (tot[sb + 1] > 0) return bkS ? -PAT.WIN : PAT.WIN;          // S 长连：黑=禁手负 / 白=胜
    if (tot[sb + 2] > 0 || tot[sb + 3] >= 1) return PAT.WIN;       // S 有活四 / 任何"四"
    if (tot[ob] > 0) return -PAT.WIN;                              // O 恰好五连
    if (tot[ob + 1] > 0) return bkO ? PAT.WIN : -PAT.WIN;          // O 长连：黑=我方胜
    if (tot[ob + 2] > 0 || tot[ob + 3] >= 2) return -PAT.WIN;      // O 活四 / 双四

    const cs = coeffOf(rule, PAT.colorRole(stm), 'stm');
    const co = coeffOf(rule, PAT.colorRole(o), 'opp');
    let v = 0;
    for (let t = 0; t < NT; t++) v += tot[sb + t] * cs[t];
    for (let t = 0; t < NT; t++) v -= tot[ob + t] * co[t];
    return v;
  }

  return { DEFAULT, candidates, candidatesSlow, candidatesBit, setCandBit, candStat,
           evaluateMove, moveScoreAt, sortedMoves, staticEval, staticEvalPos };
});
