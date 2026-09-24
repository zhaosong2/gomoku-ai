/* ui/prefs.js — 偏好持久化（localStorage，§29.2 状态恢复）
 * 设计依据：用户需求「开关状态需要持久化，刷新/重开后被保留」。
 *
 * 三条硬约束：
 *   1) **降级必须安全**：file:// 下、隐私模式、配额满都可能让 localStorage 抛异常。
 *      任何读写都 try/catch，失败即退化为"本次会话内存态"，绝不阻断主流程。
 *   2) **白名单**：只持久化明确列出的键。避免把对局中间态（pos/moves）之类写进去
 *      —— 那些应该每次重开都重置。
 *   3) **重启后必须重新校验**：读回来的值可能与当前规则/模式不兼容
 *      （例如 Renju 专用开关在 freestyle 下无意义）。prefs 只负责"取原值"，
 *      校验交给各自的业务代码（见 main.js 的 applyPrefs）。
 */
(function () {
  'use strict';

  const KEY = 'gomoku.prefs.v1';
  let mem = null;                       // 内存兜底（localStorage 不可用时）
  let lsOk = null;                      // 探测结果缓存

  function storage() {
    if (lsOk === false) return null;
    try {
      const s = window.localStorage;
      if (!s) { lsOk = false; return null; }
      // 主动探测一次（Safari 隐私模式下 getItem 可用但 setItem 抛）
      const probe = '__gomoku_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      lsOk = true;
      return s;
    } catch (e) { lsOk = false; return null; }
  }

  function read() {
    if (mem) return mem;
    const s = storage();
    if (!s) { mem = {}; return mem; }
    try {
      const raw = s.getItem(KEY);
      const o = raw ? JSON.parse(raw) : null;
      mem = (o && typeof o === 'object') ? o : {};
    } catch (e) { mem = {}; }
    return mem;
  }

  function write() {
    const s = storage();
    if (!s) return false;
    try { s.setItem(KEY, JSON.stringify(mem || {})); return true; }
    catch (e) { return false; }          // 配额满 / 被禁用 → 静默降级
  }

  /* ---------- 对外 ---------- */
  function get(key, dflt) {
    const o = read();
    return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : dflt;
  }
  function set(key, val) {
    read();
    if (mem[key] === val) return val;
    mem[key] = val;
    write();
    return val;
  }
  function del(key) {
    read();
    if (!Object.prototype.hasOwnProperty.call(mem, key)) return;
    delete mem[key];
    write();
  }
  function all() { return Object.assign({}, read()); }
  function clear() { mem = {}; write(); }
  // 批量写入（减少 localStorage 抖动；一次 setItem）
  function patch(obj) {
    read();
    let changed = false;
    for (const k of Object.keys(obj || {})) {
      if (mem[k] !== obj[k]) { mem[k] = obj[k]; changed = true; }
    }
    if (changed) write();
    return mem;
  }

  window.G = window.G || {};
  window.G.prefs = {
    get: get, set: set, del: del, all: all, clear: clear, patch: patch,
    get available() { return !!storage(); },
    KEY: KEY,
  };
})();
