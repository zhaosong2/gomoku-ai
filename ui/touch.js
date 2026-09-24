/* ui/touch.js — 触屏（小屏）落子判定：**纯函数**，无 DOM、无状态
 *
 * 为什么单独立一个模块（而不是写进 ui/main.js）：
 *   ① 「点选确认 / 拖动释放」这套判定是**最容易出错、也最需要被测试钉住**的地方
 *      —— 判错的后果是"没想落的那一子落下去了"（比崩溃更糟：棋局被改坏且无提示）。
 *   ② main.js 是 IIFE + 全量 DOM 依赖，Node 里根本 require 不进来 ⇒ 判定逻辑一旦写在
 *      里面就只能靠浏览器实跑去测（贵、慢、易假失败）。抽成 UMD 纯函数后，
 *      边界（阈值上下、同点、划出盘外）可以在 `test/touch.test.js` 里**穷举**。
 *   ③ **单一真相源**：`isDrag()` 全仓库只此一份。main.js 的 pointermove（打拖动标记）
 *      与 pointerup（决定落子还是确认）都调它 ⇒ 不会出现"移动时算拖动、松手时算轻点"
 *      这种两处口径不一致（R8 教训：两处各写一份的实现必然跑偏）。
 *
 * 交互语义（用户需求："确认后落子或拖动释放落子"）：
 *   · 轻点（按下与松手基本同一点）→ **不立即落子**，进入待确认态（棋盘画幽灵子，底部出现确认条）。
 *   · 按住拖动到另一点再松手   → **直接落子**（拖动本身已是一次明确表达）。
 *   · 松手处不在交点上 / 手势被系统取消 → 什么都不做（取消）。
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.G = root.G || {}; root.G.touch = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 小屏阈值（CSS px）。为什么是 600：
   *   · 手机竖屏 320–430、横屏 640–930 —— 横屏时靠 `coarse` 命中，不靠宽度；
   *   · 纯桌面窗口极少 <600，不会被宽度这条误伤（误伤的代价是"鼠标点击也要确认"，很烦）；
   *   · 宽度这条主要兜两种漏网：桌面浏览器的响应式/窄窗调试、以及少数把主指针报成 fine 的设备。 */
  const MAX_W = 600;

  /* "拖动"判定阈值：与按下点的位移 ≥ SLOP 格。
   * 为什么用格而不是像素：棋盘有 15 格，小屏下 1 格只有 ~24px，用固定像素会在
   * 大屏上"过灵敏"、在小屏上"拖不动"。用格距作单位 ⇒ 手感与棋盘缩放无关。 */
  const SLOP = 0.75;

  /** 自动判定（mode==='auto' 时用）：主指针是粗的（触屏），或视口窄到手机量级。 */
  function autoOn(env) {
    env = env || {};
    if (env.coarse) return true;
    const w = env.width | 0;
    return w > 0 && w <= (env.maxWidth || MAX_W);
  }

  /** 偏好（'auto'|'on'|'off'）+ 环境 → 是否启用触屏落子。'on'/'off' 是用户的显式选择，压过自动。 */
  function resolve(mode, env) {
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return autoOn(env);
  }

  /**
   * 这次手势算不算"拖动"？
   * g = { from:{x,y}|null（按下点）, to:{x,y}|null（当前点）, dist（位移，棋盘坐标系）,
   *       cell（格距）, slop（默认 0.75） }
   * ★ 两个条件**都要**满足：位移够远 **且** 目标交点变了。
   *   只看位移 ⇒ 手指在同一点上抖动 0.75 格就会"直接落子"，把确认机制架空；
   *   只看交点变化 ⇒ 轻点时的舍入抖动可能落到邻点，同样会误落。
   */
  function isDrag(g) {
    g = g || {};
    if (!g.from || !g.to) return false;
    const same = (g.to.x === g.from.x && g.to.y === g.from.y);
    const far = (g.dist || 0) >= (g.slop === undefined ? SLOP : g.slop) * (g.cell || 1);
    return far && !same;
  }

  /**
   * 松手时该怎么收尾？
   *   'place'   → 直接落子在 `to`
   *   'confirm' → 进入待确认态（不落子）
   *   'cancel'  → 什么都不做
   * `dragging` 由调用方在 pointermove 期间用 isDrag() 打上（**粘性**：一旦拖出去过，
   * 即使又拖回原点松手，仍按拖动处理 —— 那是用户的完整表达）。
   */
  function decide(g) {
    g = g || {};
    if (!g.to || !g.from) return 'cancel';
    return (g.dragging || isDrag(g)) ? 'place' : 'confirm';
  }

  return { autoOn: autoOn, resolve: resolve, isDrag: isDrag, decide: decide, MAX_W: MAX_W, SLOP: SLOP };
});
