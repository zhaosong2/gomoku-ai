/* ui/menu.js — 侧栏折叠分组（accordion）：分类归置 + 分层展开
 *
 * 设计依据：§14 UI（分组归置）、§29.2 交互状态机（偏好持久化）、§29.4 可访问性。
 *
 * 动机（用户需求"菜单分类归置、分层展开"）：
 *   原侧栏把 5 个 `.sec` 块平铺，加上棋谱/棋谱库两个大面板全部常驻展开 ⇒
 *   面板极长、要滚很久才能找到东西；而且**动作按钮与结果面板互不感知**——
 *   点「提示」只往屏幕外的盒子里写内容，用户看不到反馈。
 *
 * ★ 本模块的职责边界（与 panels/record/booklib 不重叠）：
 *   · 只管"**分组的开合**"这一件事；不碰任何业务数据、不发请求、不改对局状态。
 *   · 分组状态是**纯 UI 偏好** ⇒ 走 prefs 持久化（`groups` 键），刷新后恢复。
 *   · 提供 `openFor(id)` 供动作按钮调用：**幂等展开**（已开则不重复写盘）。
 *
 * ★ 为什么用 <button> 做分组头而不是 <summary>：
 *   ① `<details>` 的开合状态由浏览器托管，**无法可靠地持久化**（改 open 属性会触发
 *      toggle 事件、与"恢复状态"互相触发，边界情况多）；
 *   ② 需要"折叠时仍然显示摘要"（例如形势判断折叠后仍能看到"黑胜率 62%"）——
 *      `<summary>` 里的内容在折叠时也可见，但无法把动态摘要从 body 里搬出来；
 *   ③ 原生 button + aria-expanded/aria-controls 的可访问性等价，且行为完全可控。
 *
 * ★ 隐藏方式用 `hidden` 属性而不是 CSS class：
 *   `hidden` 会被 `getComputedStyle().display === 'none'` 反映，且**同时**让内容
 *   从可访问性树中移除（读屏不会念到折叠区），也便于自动化断言。
 */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  /** 默认展开的分组（其余默认折叠，保持首屏精简）。 */
  const DEFAULT_OPEN = ['game'];

  /** 已知分组 id 白名单（顺序即 DOM 顺序）——防止把任意字符串写进 prefs。
   *  v3.35：原独立分组 `book`（棋谱库）已并入 `record`（棋谱），不再单列。 */
  const KNOWN = ['game', 'display', 'hint', 'judge', 'record', 'help'];

  function create(opts) {
    const o = opts || {};
    const P = o.prefs || null;

    /** id → { root, head, body } */
    const map = new Map();
    const openSet = new Set();
    let ready = false;                     // 初始化期间不写盘

    function scan() {
      const nodes = document.querySelectorAll('[data-grp]');
      for (let i = 0; i < nodes.length; i++) {
        const root = nodes[i];
        const id = root.getAttribute('data-grp');
        if (!id) continue;
        const head = root.querySelector('.grp-btn');
        const body = root.querySelector('.grp-body');
        if (!head || !body) continue;
        if (!body.id) body.id = 'grp-body-' + id;
        head.setAttribute('aria-controls', body.id);
        map.set(id, { root: root, head: head, body: body });
        head.addEventListener('click', function () { toggle(id); });
      }
    }

    /** 把开合状态写进 DOM（唯一的视觉真相源）。 */
    function paint(id) {
      const g = map.get(id);
      if (!g) return;
      const open = openSet.has(id);
      g.root.classList.toggle('open', open);
      g.root.setAttribute('data-open', open ? '1' : '0');
      g.head.setAttribute('aria-expanded', open ? 'true' : 'false');
      g.body.hidden = !open;
      // 折叠时把 body 标记为不可聚焦区域内的元素：button/input 在 hidden 下
      // 本身就不参与 Tab 序列，无需额外处理（这里仅保留语义注释）。
    }

    function save() {
      if (!ready || !P) return;
      // 白名单过滤：只写已知分组，避免脏键污染 prefs
      const arr = KNOWN.filter(function (id) { return openSet.has(id); });
      P.patch({ groups: arr });
      if (o.onPersist) o.onPersist(arr);
    }

    function open(id, silent) {
      if (!map.has(id) || openSet.has(id)) return false;
      openSet.add(id); paint(id);
      if (!silent) save();
      if (o.onToggle) o.onToggle(id, true);
      return true;
    }
    function close(id, silent) {
      if (!map.has(id) || !openSet.has(id)) return false;
      openSet.delete(id); paint(id);
      if (!silent) save();
      if (o.onToggle) o.onToggle(id, false);
      return true;
    }
    function toggle(id) {
      if (!map.has(id)) return false;
      return openSet.has(id) ? close(id) : open(id);
    }
    /** 幂等展开：已开时**不重复写盘**（动作按钮每次点击都会调它）。 */
    function openFor(id) { return open(id, true) || openSet.has(id); }

    /* ---------- 初始化：先读 prefs，无值时用默认集 ---------- */
    function init() {
      scan();
      const st = (P && P.all && P.all()) || {};
      const saved = Object.prototype.hasOwnProperty.call(st, 'groups') ? st.groups : null;
      const use = Array.isArray(saved) ? saved : DEFAULT_OPEN;
      openSet.clear();
      for (const id of use) if (map.has(id)) openSet.add(id);
      /* ★ 恢复出的开合状态也必须**广播一次**：`paint` 只改 DOM，不走 onToggle ⇒
       *   「棋谱」分组若在上次会话里是打开的，刷新后分组开着、而 #btnRecord 的
       *   aria-pressed 仍是 false（状态与显示脱钩，正是本项目反复踩的一类）。 */
      for (const id of map.keys()) {
        const on = openSet.has(id);
        paint(id);
        if (o.onToggle) o.onToggle(id, on);
      }
      ready = true;
      // 首次运行（prefs 里没有 groups）时把默认集落盘，保证"改了就有"的一致性
      if (!Array.isArray(saved)) save();
    }

    /* ---------- 摘要徽标：分组头右侧的即时状态（如"黑胜率 62%""行棋中锁定"） ---------- */
    function setNote(id, text, cls) {
      const g = map.get(id);
      if (!g) return;
      let slot = g.head.querySelector('.grp-note');
      if (!slot) {
        slot = document.createElement('span');
        slot.className = 'grp-note';
        g.head.appendChild(slot);
      }
      slot.textContent = text == null ? '' : String(text);
      slot.className = 'grp-note' + (cls ? ' ' + cls : '');
      slot.hidden = !text;
    }
    function getNote(id) {
      const g = map.get(id);
      if (!g) return '';
      const slot = g.head.querySelector('.grp-note');
      return slot ? slot.textContent : '';
    }

    return {
      init: init,
      open: open, close: close, toggle: toggle, openFor: openFor,
      isOpen: function (id) { return openSet.has(id); },
      ids: function () { return Array.from(map.keys()); },
      state: function () {
        const out = {};
        for (const id of map.keys()) out[id] = openSet.has(id);
        return out;
      },
      openIds: function () { return KNOWN.filter(function (id) { return openSet.has(id); }); },
      setNote: setNote, getNote: getNote,
      expandAll: function () { for (const id of map.keys()) open(id, true); save(); },
      collapseAll: function () { for (const id of map.keys()) close(id, true); save(); },
    };
  }

  window.G.menu = { create: create, DEFAULT_OPEN: DEFAULT_OPEN, KNOWN: KNOWN };
})();
