/* engine/selfcheck.js — A13 增量结构 `assert` 自检（§4.13，Carbon A8 / Stahlfaust A8）
 *
 * 动机
 *   Carbon 每次 `_move`/`undo` 前后 `assert(check())`，用"全盘重数 vs 增量维护"发现不一致
 *   （`AICarbonMove.cpp:406-420`）。本项目有**两次**"增量与全量不一致"的踩坑史
 *   （#35 单相位漂移 2400 步里 2026 步偏离；A6 首版净变化恒 0）。
 *   ⇒ 需要一条**开发/测试期**的自检，把"静默不一致"变成"当场抛出"。
 *
 * ★★ 生产纪律（§4.13 / C-11）
 *   · 本模块**绝不进 `worker-src` 打包**——`tools/build-worker-src.js` 的 `FILES` 白名单
 *     **不包含** `engine/selfcheck.js`（同 Carbon 的 `NDEBUG` 裁剪，我们用打包白名单）。
 *   · `assertIncr` 默认 **false** ⇒ 生产路径**零开销**（连本模块都不会被 require）。
 *   · 由 `test/worker.test.js` 扩展校验"产物不得夹带本模块"（防白名单被误加回）。
 *
 * 用法
 *   const SC = require('./selfcheck.js');
 *   SC.setAssertIncr(true);          // 仅在 dev/test
 *   SC.assertIncrementalStructures(pos);   // 不一致 → throw
 *   SC.checkIncrementalStructures(pos);    // 不一致 → 返回差异数组（不抛；供测试取详情）
 *
 * ★ 自检对象（§4.13 的三项，按"当前已落地"如实裁剪）
 *   ① `pos.lc`（§33.3 线分缓存）：`lc.lines` / `lc.tot` == 从棋盘全量重算
 *   ② `pos.material`（A6 增量材料表）：== `PAT.materialOf(board)` / `PAT.countBoth(board)`
 *   ③ `pos.see`（A8）：**未实现**（A8 已在批 4 裁决砍掉）⇒ 本自检**不含**此项，
 *      但在报告里显式标注 "see: n/a（A8 未落地）"，避免"以为覆盖了"的假安全感。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'), require('./patterns.js'));
  } else { root.G = root.G || {}; root.G.selfcheck = factory(root.G.core, root.G.patterns); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT) {
  'use strict';

  let ASSERT_ON = false;                      // 默认关（生产/常规路径零开销）

  /* ---------- 开关 ---------- */
  function setAssertIncr(on) { ASSERT_ON = on === true; return ASSERT_ON; }
  function assertIncrOn() { return ASSERT_ON; }

  /* ---------- ① 线分缓存 ---------- */
  // 从棋盘全量重建 lc，与增量维护的 lc 逐位比较。
  // 复用 PAT.newLineCache（与增量路径**同源**构造：同一 CELL_LINES / scanLineInto），
  // ⇒ 差异只可能来自"增量维护漏更新/错更新"，不会来自"两个不同实现的口径差"。
  function checkLineCache(pos) {
    const diffs = [];
    const lc = pos.lc;
    if (!lc) return diffs;                     // 未挂缓存 ⇒ 无事可查
    const ref = PAT.newLineCache(pos.board);
    if (ref.nLines !== lc.nLines) {
      diffs.push({ what: 'lc.nLines', got: lc.nLines, want: ref.nLines });
      return diffs;                            // 维度都不同，逐位比较无意义
    }
    const L = lc.lines, R = ref.lines;
    for (let k = 0; k < L.length; k++) {
      if (L[k] !== R[k]) diffs.push({ what: 'lc.lines', at: k, got: L[k], want: R[k] });
    }
    const T = lc.tot, RT = ref.tot;
    for (let k = 0; k < T.length; k++) {
      if (T[k] !== RT[k]) diffs.push({ what: 'lc.tot', at: k, got: T[k], want: RT[k] });
    }
    return diffs;
  }

  /* ---------- ② 材料表（A6） ---------- */
  // 与 PAT.materialOf(board)（全量）逐位比较；可选再与 PAT.countBoth(board) 三口径互证。
  function checkMaterial(pos) {
    const diffs = [];
    const m = pos.material;
    if (!m) return diffs;                      // A6 未开 ⇒ 无事可查
    const ref = PAT.materialOf(pos.board);
    if (ref.length !== m.length) {
      diffs.push({ what: 'material.length', got: m.length, want: ref.length });
      return diffs;
    }
    for (let k = 0; k < m.length; k++) {
      if (m[k] !== ref[k]) diffs.push({ what: 'material', at: k, got: m[k], want: ref[k] });
    }
    return diffs;
  }

  /* ---------- ③ see（A8，未落地） ---------- */
  function checkSee(pos) { return []; }        // A8 已砍 ⇒ 显式空实现，见文件头注

  /* ---------- 汇总 ---------- */
  function checkIncrementalStructures(pos) {
    const d = [];
    const a = checkLineCache(pos); if (a.length) d.push.apply(d, a);
    const b = checkMaterial(pos);  if (b.length) d.push.apply(d, b);
    const c = checkSee(pos);       if (c.length) d.push.apply(d, c);
    return d;
  }

  function assertIncrementalStructures(pos) {
    if (!ASSERT_ON) return true;               // 默认关 ⇒ 不发散、零成本
    const d = checkIncrementalStructures(pos);
    if (d.length) {
      const head = d.slice(0, 8).map(x =>
        '  ' + x.what + (x.at !== undefined ? '[' + x.at + ']' : '') +
        ' got=' + x.got + ' want=' + x.want).join('\n');
      throw new Error('A13 自检失败：增量结构与全量重算不一致（共 ' + d.length + ' 处）\n' + head);
    }
    return true;
  }

  // 供工具/测试打印：报告当前"实际被覆盖的自检项"
  function coverage() {
    return { lc: true, material: true, see: false, note: 'see: n/a（A8 未落地，批 4 已砍）' };
  }

  return { setAssertIncr, assertIncrOn, assertIncrementalStructures, checkIncrementalStructures,
           checkLineCache, checkMaterial, checkSee, coverage };
});
