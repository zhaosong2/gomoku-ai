/* engine/worker-entry.js — Worker 端消息路由（M4，§28 协议）
 * 环境：浏览器 Worker（engine/*.js 已拼进 `G.*`，本文件自动接管 onmessage）/
 *       Node（require 导出 { handle, CANCEL, setCancelBuffer }，不自动挂 onmessage，供单测）。
 * 协议：各指令与响应的完整形状见 §28。易错点两条：
 *   ★ board 一律 225 格、取值仅 0/1/2（非法 → E_BAD_BOARD）；hint 的 n 与 analyze 的 topN 取整并夹下界。
 *   ★ abort：Worker 单线程，搜索期间收不到 abort ⇒ 即时中断只能靠 `init` 传入的 SharedArrayBuffer
 *     （需跨源隔离，§34.1）；无 SAB 时 abort 只在两次请求之间生效，正确性靠主线程按 id 丢弃过期结果。
 */
(function (root) {
  'use strict';
  const G = root.G || (root.G = {});

  // Node 下允许直接 require 依赖（浏览器 Worker 里走 G.*）
  function pick(name) {
    if (G[name]) return G[name];
    if (typeof require === 'function') {
      try { G[name] = require('./' + name + '.js'); return G[name]; } catch (e) { /* Worker 环境 */ }
    }
    return null;
  }

  const ERR = {
    E_NO_BOARD: '缺少或非法棋盘',
    E_BAD_BOARD: '棋盘取值非法（须 225 格、取值仅 0/1/2）',
    E_BAD_STM: '非法走子方',
    E_CMD: '未知指令',
    E_NO_ENGINE: '引擎未就绪',
    E_NO_MOVES: '缺少 moves',
    E_INTERNAL: '内部错误',
  };

  // 取消标志：默认本地；若 `init` 传入 SAB 则改为共享（主线程可即时置位）
  let CANCEL = new Int32Array(1);
  function setCancelBuffer(buf) {
    if (!buf || typeof SharedArrayBuffer === 'undefined' || !(buf instanceof SharedArrayBuffer)) return false;
    CANCEL = new Int32Array(buf);
    CANCEL[0] = 0;
    return true;
  }

  /* ★ 只接受 Int8Array / 普通数组，且**逐格校验取值 ∈ {0,1,2}**。老写法会吞下字符串与
   *   `{length:225}` ⇒ 得**全 0 空盘**（空盘是 search 的合法前提，返天元/书招）⇒ 静默给错答案。 */
  function toBoardArray(src) {
    if (!(src instanceof Int8Array) && !Array.isArray(src)) return null;
    const core = pick('core');
    const nn = core ? core.NN : 225;
    if (src.length !== nn) return null;
    const a = (src instanceof Int8Array) ? src : Int8Array.from(src);
    for (let i = 0; i < nn; i++) { const v = a[i]; if (v !== 0 && v !== 1 && v !== 2) return null; }
    return a;
  }
  /** 棋盘错误码：缺字段 vs 取值非法要分开（否则排障看不出客户端发错了什么）。 */
  function boardErr(req) {
    return (req.board === undefined || req.board === null)
      ? { cmd: 'error', code: 'E_NO_BOARD', message: ERR.E_NO_BOARD }
      : { cmd: 'error', code: 'E_BAD_BOARD', message: ERR.E_BAD_BOARD };
  }

  function doMove(req) {
    const S = pick('search');
    if (!S) return { cmd: 'error', code: 'E_NO_ENGINE', message: ERR.E_NO_ENGINE };
    const board = toBoardArray(req.board);
    if (!board) return boardErr(req);
    const stm = (req.stm === 1 || req.stm === 2) ? req.stm : null;
    if (stm === null) return { cmd: 'error', code: 'E_BAD_STM', message: ERR.E_BAD_STM };

    const rule = req.rule || 'freestyle';
    const cfg = Object.assign({}, S.difficultyCfg(req.difficulty, rule), {
      rule: rule,
      cancel: CANCEL,
    });
    if (req.time) {
      if (req.time.hard) cfg.hardLimit = Math.min(cfg.hardLimit, req.time.hard);
      if (req.time.perMove) cfg.hardLimit = Math.min(cfg.hardLimit, req.time.perMove);
    }

    CANCEL[0] = 0;
    // ★ req.hist：真实落子序列（缺了 §12.4 开局库在 Worker 里永不命中，详见 search.posFromBoard）。
    const pos = S.posFromBoard(board, stm, req.hist);
    const r = S.think(pos, cfg);
    if (!r || !r.move) return { cmd: 'error', code: 'E_INTERNAL', message: '搜索未返回着法' };
    return {
      cmd: 'move',
      move: { x: r.move.x, y: r.move.y },
      score: r.score, nodes: r.nodes, depth: r.depth,
      timeMs: r.timeMs === undefined ? 0 : r.timeMs,
      fallbackLevel: r.fallbackLevel === undefined ? 0 : r.fallbackLevel,
      aborted: CANCEL[0] === 1,
      via: r.via || null,
      book: r.book || null,          // { opening, weight, source }｜非書招时为 null
    };
  }

  /* ---------- M8：hint / judge / analyze（§10 / §11 / §9.3）---------- */
  // 公共：校验 board + stm，返回 {board, stm, rule, om} 或 {error}
  function commonOf(req) {
    const board = toBoardArray(req.board);
    if (!board) return { error: boardErr(req) };
    const stm = (req.stm === 1 || req.stm === 2) ? req.stm : null;
    if (stm === null) return { error: { cmd: 'error', code: 'E_BAD_STM', message: ERR.E_BAD_STM } };
    return { board: board, stm: stm, rule: req.rule || 'freestyle',
             om: req.overlineMode || 'rif' };
  }

  function doHint(req) {
    const C = pick('coach');
    if (!C) return { cmd: 'error', code: 'E_NO_ENGINE', message: '教练模块未就绪' };
    const c = commonOf(req);
    if (c.error) return c.error;
    // ★ 与 analyze 的 topN 同口径：取整 + 夹下界（旧写法 `req.n | 0` 传 -3 会变成 `slice(0,-3)`）。
    const nRaw = (req.n === undefined || req.n === null) ? 5 : (req.n | 0);
    const n = Math.max(1, nRaw);
    CANCEL[0] = 0;
    const hints = C.hint(c.board, c.stm, {
      topN: n, rule: c.rule, overlineMode: c.om,
      difficulty: req.difficulty || 'hard',
      depth: req.depth,
      time: req.time || null,
      useThreat: req.useThreat !== false,
      threatK: req.threatK,
    });
    return { cmd: 'hint', hints: hints, aborted: CANCEL[0] === 1 };
  }

  function doJudge(req) {
    const C = pick('coach');
    if (!C) return { cmd: 'error', code: 'E_NO_ENGINE', message: '教练模块未就绪' };
    const c = commonOf(req);
    if (c.error) return c.error;
    CANCEL[0] = 0;
    const r = C.judge(c.board, c.stm, {
      rule: c.rule, overlineMode: c.om,
      useThreat: req.useThreat !== false,
      forbidden: req.forbidden !== false,
      difficulty: req.difficulty || 'hard',
      threatMs: req.threatMs,
    });
    return {
      cmd: 'judge',
      blackRate: r.blackRate, label: r.label, score: r.score, source: r.source,
      mate: r.mate, forbiddenPoints: r.forbiddenPoints || [],
    };
  }

  // 出点热力图（§11.1 可选叠加层）
  function doHeat(req) {
    const C = pick('coach');
    if (!C) return { cmd: 'error', code: 'E_NO_ENGINE', message: '教练模块未就绪' };
    const c = commonOf(req);
    if (c.error) return c.error;
    CANCEL[0] = 0;
    const heat = C.heat(c.board, c.stm, {
      rule: c.rule, overlineMode: c.om,
      difficulty: req.difficulty || 'normal', depth: req.depth || 2,
    });
    return { cmd: 'heat', heat: heat };
  }

  // 棋谱逐手分析：对每一手出一份 hint + judge（默认只给 Top1 + 结论，避免响应过大）
  function doAnalyze(req) {
    const C = pick('coach');
    if (!C) return { cmd: 'error', code: 'E_NO_ENGINE', message: '教练模块未就绪' };
    const c = commonOf(req);
    if (c.error) return c.error;
    const seq = req.moves;                                  // [[x,y]...] 或 [{x,y}...]
    if (!Array.isArray(seq) || !seq.length) return { cmd: 'error', code: 'E_NO_MOVES', message: ERR.E_NO_MOVES };
    const core2 = pick('core'), S = pick('search');
    if (!core2 || !S) return { cmd: 'error', code: 'E_NO_ENGINE', message: ERR.E_NO_ENGINE };
    CANCEL[0] = 0;                                          // 与其余四个入口一致（防上次的取消跨请求残留）
    /* ★ 逐手推进的棋盘（缺陷 #36）：原实现每一手都拿客户端发来的**初始盘面**（整局分析即空盘）
     *   ⇒ 每手"引擎首选"都成了空盘首选（天元），连"已占用"都发现不了。
     *   正确做法 = 分析"这一手之前"的局面，再把这一手落上去进入下一手。 */
    const run = c.board.slice();
    let stm = c.stm;
    const out = [];
    let stopped = null;                                     // 截断原因（如实回报，别把"没算"当"算过了"）
    const topN = Math.max(1, req.topN === undefined ? 1 : (req.topN | 0));
    for (let k = 0; k < seq.length; k++) {
      const p = Array.isArray(seq[k]) ? { x: seq[k][0], y: seq[k][1] } : seq[k];
      if (!p || p.x < 0 || p.x > 14 || p.y < 0 || p.y > 14) { stopped = { no: k + 1, error: 'E_RANGE' }; break; }
      const i = core2.idxOf(p.x, p.y);
      if (run[i] !== core2.EMPTY) {                        // 非法着法：记录后停止（不再当合法手分析）
        out.push({ no: k + 1, x: p.x, y: p.y, player: stm, best: null,
                   inTopN: false, rank: 0, topN: [], illegal: 'E_OCCUPIED' });
        stopped = { no: k + 1, error: 'E_OCCUPIED' };
        break;
      }
      // 分析"走这一手之前"的局面
      const h = C.hint(run, stm, { topN: Math.max(1, topN), rule: c.rule, overlineMode: c.om,
        difficulty: req.difficulty || 'hard', depth: req.depth, useThreat: req.useThreat !== false });
      const top = h.length ? h[0] : null;
      // 本手是否等于引擎首选 / 分歧程度
      const rankInHints = h.findIndex(function (q) { return q.x === p.x && q.y === p.y; });
      const j = C.judge(run, stm, { rule: c.rule, overlineMode: c.om, useThreat: false, forbidden: false });
      out.push({
        no: k + 1, x: p.x, y: p.y, player: stm,
        best: top ? { x: top.x, y: top.y, coord: top.coord, score: top.score, norm: top.norm, type: top.type, win: top.win } : null,
        inTopN: rankInHints >= 0, rank: rankInHints >= 0 ? rankInHints + 1 : 0,
        topN: h.slice(0, topN),
        judge: { blackRate: j.blackRate, label: j.label },
      });
      // 推进棋盘（下一手基于此局面分析）
      run[i] = stm;
      stm = core2.opp(stm);
    }
    return { cmd: 'analyze', items: out, stopped: stopped };
  }

  // 同步处理一条请求 → 一条响应（不含 id，由调用方补）
  function handle(req) {
    try {
      if (!req || typeof req.cmd !== 'string') {
        return { cmd: 'error', code: 'E_CMD', message: ERR.E_CMD };
      }
      switch (req.cmd) {
        case 'init':    return { cmd: 'init', ok: true, sab: setCancelBuffer(req.cancelBuf) };
        case 'move':    return doMove(req);
        case 'hint':    return doHint(req);
        case 'judge':   return doJudge(req);
        case 'heat':    return doHeat(req);
        case 'analyze': return doAnalyze(req);
        case 'abort':   CANCEL[0] = 1; return { cmd: 'abort', ok: true };
        default:        return { cmd: 'error', code: 'E_CMD', message: ERR.E_CMD + '：' + req.cmd };
      }
    } catch (e) {
      return { cmd: 'error', code: 'E_INTERNAL', message: String((e && e.message) || e) };
    }
  }

  const API = { handle: handle, setCancelBuffer: setCancelBuffer, cancelFlag: function () { return CANCEL; }, ERR: ERR };

  // 浏览器 Worker：自动接管 onmessage
  const isWorker = (typeof importScripts === 'function') ||
    (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document);
  if (isWorker) {
    self.onmessage = function (ev) {
      const req = ev.data;
      let res;
      try { res = handle(req); } catch (e) { res = { cmd: 'error', code: 'E_INTERNAL', message: String((e && e.message) || e) }; }
      // ★ postMessage 抛 DataCloneError 时若不兜住，Worker 会静默死掉、主线程干等看门狗超时。
      try {
        res.id = req && req.id;
        self.postMessage(res);
      } catch (e2) {
        try { self.postMessage({ id: req && req.id, cmd: 'error', code: 'E_INTERNAL', message: '结果无法序列化：' + String((e2 && e2.message) || e2) }); } catch (e3) { /* 彻底无救，交给看门狗 */ }
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else G.workerEntry = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
