/* engine/data/openings.js — 26 种指定开局（数据 + 对称展开）
 * 设计依据：§12 开局库 / §33.7 开局规则族
 *
 * 坐标系（与 core.js 一致）：Renju 记谱 A–O 列 → x=0..14；1–15 行（自下而上） → y=15−row。
 * 每种开局由前 3 手定义：黑1 = 天元 H8 → 白2 紧贴 → 黑3 在中央 5×5 内。
 *   · 白2 与黑1 连成横/竖 → 直指（Direct）；连成斜线 → 斜指（Indirect）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.G = root.G || {}; root.G.openings = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const N = 15;
  const idxOf = (x, y) => y * N + x;
  const R = s => ({ x: s.charCodeAt(0) - 65, y: 15 - parseInt(s.slice(1), 10) });   // H8 → {7,7}

  // [名称, 白2, 黑3]（黑1 恒为 H8）
  const DIRECT = [
    ['寒星', 'H9', 'H10'], ['溪月', 'H9', 'I10'], ['疏星', 'H9', 'J10'],
    ['花月', 'H9', 'I9'], ['残月', 'H9', 'J9'], ['雨月', 'H9', 'I8'],
    ['金星', 'H9', 'J8'], ['松月', 'H9', 'H7'], ['丘月', 'H9', 'I7'],
    ['新月', 'H9', 'J7'], ['瑞星', 'H9', 'H6'], ['山月', 'H9', 'I6'],
    ['游星', 'H9', 'J6'],
  ];
  const INDIRECT = [
    ['长星', 'I9', 'J10'], ['峡月', 'I9', 'J9'], ['恒星', 'I9', 'J8'],
    ['水月', 'I9', 'J7'], ['流星', 'I9', 'J6'], ['云月', 'I9', 'I8'],
    ['浦月', 'I9', 'I7'], ['岚月', 'I9', 'I6'], ['银月', 'I9', 'H7'],
    ['明星', 'I9', 'H6'], ['斜月', 'I9', 'G7'], ['名月', 'I9', 'G6'],
    ['彗星', 'I9', 'F6'],
  ];

  function build(list, type) {
    return list.map(function (a) {
      const w = R(a[1]), b = R(a[2]), c = R('H8');
      const moves = [c, w, b];
      return {
        name: a[0] + '局', type: type,           // 'direct' | 'indirect'
        b2: a[1], b3: a[2],                       // 记谱
        moves: moves,                             // [{x,y}×3]
        idx: moves.map(m => idxOf(m.x, m.y)),     // 落子序号
      };
    });
  }

  const OPENINGS = build(DIRECT, 'direct').concat(build(INDIRECT, 'indirect'));

  /* ---------- 8 种正方形的对称变换（dihedral group）---------- */
  const SYM = [
    (x, y) => [x, y], (x, y) => [14 - x, y], (x, y) => [x, 14 - y], (x, y) => [14 - x, 14 - y],
    (x, y) => [y, x], (x, y) => [14 - y, x], (x, y) => [y, 14 - x], (x, y) => [14 - y, 14 - x],
  ];
  // 把一条着法序列做 8 种对称，产出等价开局（实战中同名开局存在镜像/旋转变体）
  function variants(moves) {
    const out = [];
    for (const f of SYM) out.push(moves.map(m => { const p = f(m.x, m.y); return { x: p[0], y: p[1] }; }));
    return out;
  }

  // 规范键：对一条落子序列取 8 种对称下 idx 三元组的最小字典序 → 用于局面识别
  function canonKey(idxs) {
    let best = null;
    for (const f of SYM) {
      const t = idxs.map(i => { const p = f(i % N, (i / N) | 0); return idxOf(p[0], p[1]); });
      const k = t.join(',');
      if (best === null || k < best) best = k;
    }
    return best;
  }

  /* ★ 逆对称变换（前缀树要把"规范化后的着法"映回原盘面，必须用它）
   *   8 个变换里 5/6（即 (x,y)→(14−y,x) 与 (x,y)→(y,14−x)）是 **90° 旋转、4 阶**，
   *   不是对合 ⇒ 逆变换不等于自身；其余 6 个都是对合。
   *   验证：SYM[5](x,y)=(14−y,x)，令 (u,v)=(14−y,x) ⇒ y=14−u, x=v ⇒ 逆为 (u,v)→(v,14−u) = SYM[6]。
   */
  const SYM_INV = [0, 1, 2, 3, 4, 6, 5, 7];

  /* ★ 规范序列（前缀树专用）——与 canonKey 的差别：
   *   ① **按数值**比字典序（canonKey 是 join(',') 后比字符串，存在 "112,111" < "112,97" 的坑，
   *      因它两侧都错、且仍轨道不变，故识别功能不受影响；但树的 key 要可拼接，必须用数值序）；
   *   ② **返回 ti**（取的变换下标）——前缀树靠它把规范化着法映回原盘面，canonKey 只给 key 做不到。
   *
   * 可拼接性（树的正确性依赖它）：记 m(S) = 序列 S 的规范形，T(S) = {t : t(S) = m(S)}，则
   *     m(S ++ x) = m(S) ++ min_{t∈T(S)} t(x)
   * ——因为任意 t∉T(S) 都会在前面某一位就已经大于 m(S)。故"整段规范形的最后一个元素"
   *    正好等于"父规范形 + 父稳定子群下的最小像"，与逐层递归定义一致 ⇒ 边可拼接。
   * （⚠ 若改成"沿用父节点随便挑的那个 ti"，当稳定子群非平凡时（例如只有一个天元，
   *    8 个变换全部固定它）互为同形的两局会被记到**不同的子键**上 ⇒ 对称合并失效。）
   */
  function canonSeq(idxs) {
    const n = idxs.length;
    let bestArr = null, bestKey = null, ti = 0;
    const buf = new Array(n);
    for (let t = 0; t < 8; t++) {
      const f = SYM[t];
      for (let k = 0; k < n; k++) {
        const i = idxs[k], p = f(i % N, (i / N) | 0);
        buf[k] = idxOf(p[0], p[1]);
      }
      let cmp = 0;                                    // ★ 逐位比数值，不比字符串
      if (bestArr === null) cmp = -1;
      else for (let k = 0; k < n; k++) if (buf[k] !== bestArr[k]) { cmp = buf[k] < bestArr[k] ? -1 : 1; break; }
      if (cmp < 0) { bestArr = buf.slice(); bestKey = bestArr.join(','); ti = t; }
    }
    return { key: bestKey === null ? '' : bestKey, arr: bestArr || [], ti: ti };
  }

  // 由前 3 手的 idx 识别开局名（含对称）
  function identify(idxs) {
    if (idxs.length < 3) return null;
    const key = canonKey(idxs.slice(0, 3));
    for (const o of OPENINGS) if (canonKey(o.idx) === key) return o;
    return null;
  }

  /* ---------- 规则变体（§33.7）---------- */
  const RULE_SETS = ['rif', 'yamaguchi', 'soosorv', 'swap2', 'freestyle'];

  return { N, idxOf, R, OPENINGS, DIRECT, INDIRECT, SYM, SYM_INV, variants, canonKey, canonSeq, identify, RULE_SETS };
});
