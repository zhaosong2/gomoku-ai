/* engine/operators.js — 算子化威胁枚举（A12，Stahlfaust GBOperators.cs，§4.6）
 *
 * 背景：`threat.js` 里"成五点 / 活三点 / 冲四点"的枚举散落在多处（threatMoves / solve / dfs），
 *   未来任何"威胁序列搜索"（VCF/VCT/db-search）都要重写一遍。本模块把它统一为**算子对象**。
 *
 * 算子（operator）语义（对齐 Stahlfaust `fAdd[n] = (x, y, value)`，value ∈ {+1 攻方, −1 守方}）：
 *   **一个算子 = 一次威胁 + 它强制产生的防守**。
 *   · `add`：本算子涉及的落子序列，攻方手 +1、守方强制应手 −1（本例只含攻方手 + 应手）
 *   · `cls`：分类，0=Five / 1=StraightFour / 2=Four(冲四) / 3=OpenThree / 4=BrokenThree
 *   · `key`：排序键（同 threatMoves：档位基准 + 组合等级 + 靠中心）
 *
 * ★ 本模块是**纯新增**，不触碰任何既有导出；`threat.js` 完全不动。
 * ★ 等价性由 `test/operators.test.js` 对拍 `threat.threatMoves` 保证（diff == 0）。
 *
 * 注意 A12 的等价目标是 **`threatMoves` 的选点集合与 kind 语义**（谁被枚举为几类威胁），
 *   而非其排序（threatMoves 的 `key` 只影响搜索效率，不影响正确性）。对拍时按**集合 + kind 映射**比。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(
    require('./core.js'), require('./patterns.js'), require('./rules.js'), require('./eval.js'),
    require('./threat.js'));
  else { root.G = root.G || {}; root.G.operators = factory(
    root.G.core, root.G.patterns, root.G.rules, root.G.eval, root.G.threat); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT, RU, EV, THREAT) {
  'use strict';
  const { N, EMPTY, idxOf } = core;
  const P = PAT.P;
  const ALREADY = THREAT.ALREADY;

  /* 分类常量（对齐 Stahlfaust category 语义；数值与 threatMoves 的 kind 对应关系见 classify） */
  const CLS = { FIVE: 0, STRAIGHT_FOUR: 1, FOUR: 2, OPEN_THREE: 3, BROKEN_THREE: 4 };
  const CLS_NAME = ['Five', 'StraightFour', 'Four', 'OpenThree', 'BrokenThree'];

  /* 档位基准（与 threat.js:threatMoves 的 base 完全一致，保证 key 可比） */
  const BASE = { 3: 1e7, 2: 1e6, 1: 1e5, 0: 1e4 };

  /* 把 threatMoves 的 kind(3/2/1/0) 映射到算子的 cls(0..4)。
   *   kind 3 = 成五、2 = 活四/双四、1 = 冲四、0 = 活三（threat.js:119 注释）
   *   ⇒ cls：3→FIVE；2→STRAIGHT_FOUR 或 FOUR（按是否真活四细分）；1→FOUR；0→OPEN_THREE/BROKEN_THREE
   * 为保持与 threatMoves **逐点等价**（本模块的首要门槛），默认走"直接继承 kind"的映射；
   *   细分只作为 `opts.refine` 下的附加信息，不改变枚举集合。 */
  function clsOf(board, i, atk, mode, kind) {
    if (kind === 3) return CLS.FIVE;
    if (kind === 2) return CLS.STRAIGHT_FOUR;     // 活四/双四
    if (kind === 1) return CLS.FOUR;              // 冲四
    return CLS.OPEN_THREE;                        // 活三（本仓库 threatMoves 不细分 BrokenThree）
  }

  /* ---------- 威胁枚举（算子版） ----------
   * 与 threat.threatMoves 同输入语义：{includeThree, mode, radius}
   * 返回 [{ add:[{x,y,v}], cls, key, i, kind }]，按 key 降序（与 threatMoves 同序）。
   *
   * 实现策略（★ 关键设计决定）：
   *   算子枚举本身**重写**为"算子对象"形态，但其**判定内核**复用 threat 的
   *   fivePointsAfter / makesOpenThree —— 这两个是 §33.2 整数编码窗口表的既定原语，
   *   重写它们等于重写已验证的正确性，收益为零、风险非零。
   *   A12 的价值在**结构化输出**（算子对象，供 A7/A8/§35 复用），不在重造判定。
   */
  function legalOperators(pos, atk, opts) {
    const o = opts || {};
    const board = pos && pos.board ? pos.board : pos;      // 兼容传 board 或 pos
    const includeThree = !!o.includeThree;
    const mode = o.mode | 0;
    const radius = (o.radius === undefined ? 2 : o.radius) | 0;
    const def = core.opp(atk);

    const cand = EV.candidates(board, radius);
    const out = [];
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      if (board[i] !== EMPTY) continue;
      if (mode && PAT.forbiddenAt(board, i, mode)) continue;   // 禁手着法：非有效威胁
      const cnt = THREAT.fivePointsAfter(board, i, atk, mode);
      let kind;
      if (cnt >= ALREADY) kind = 3;
      else if (cnt >= 2) kind = 2;
      else if (cnt === 1) kind = 1;
      else if (includeThree && THREAT.makesOpenThree(board, i, atk, mode)) kind = 0;
      else continue;
      const x = i % N, y = (i / N) | 0;
      const key = BASE[kind] + PAT.levelAt(board, i, atk, mode) * 10 - (Math.abs(x - 7) + Math.abs(y - 7));
      out.push({ i, kind, key, cls: clsOf(board, i, atk, mode, kind) });
    }
    out.sort((a, b) => b.key - a.key);

    // 组装算子：一次威胁 + 它强制产生的防守（守方必须封的成五点）
    const ops = new Array(out.length);
    for (let k = 0; k < out.length; k++) {
      const e = out[k];
      const x = e.i % N, y = (e.i / N) | 0;
      const add = [{ x, y, v: 1 }];                       // 攻方手
      // 强制防守：落子后攻方的成五点（仅当该手**不是**直接成五时才有应手）
      //   成五算子（kind=3）落子即终局，防守方无应手 ⇒ add 只含攻方那一手。
      if (e.kind !== 3) {
        const b2 = board.slice ? board.slice() : Int8Array.from(board);
        b2[e.i] = atk;
        const fps = THREAT.winningPoints(b2, atk, mode, o.rule);
        if (fps.length >= 1) {                            // 强制应手（≥2 即活四/双四，记首点作代表）
          add.push({ x: fps[0] % N, y: (fps[0] / N) | 0, v: -1 });
        }
      }
      ops[k] = { add, cls: e.cls, clsName: CLS_NAME[e.cls], key: e.key, i: e.i, kind: e.kind };
    }
    return ops;
  }

  /* 便捷：只要选点（与 threatMoves 同形） */
  function operatorMoves(pos, atk, opts) {
    return legalOperators(pos, atk, opts).map(op => op.i);
  }

  return { legalOperators, operatorMoves, CLS, CLS_NAME, BASE };
});
