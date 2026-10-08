/* ui/ai.js — AI 客户端（M4，§28 协议 / §34.1 运行环境约束）
 * 后端优先级：
 *   1) Blob Worker（引擎源码来自 engine/worker-src.js 的 G.WORKER_SRC）——不卡 UI
 *   2) 主线程引擎兜底（Worker 在 file:// 被拦 / 创建失败 / 握手超时）
 *
 * 关键约定（§28）：
 *   · 每个请求带自增 id；**只认当前 id 的响应**，其余一律丢弃（悔棋/重开时尤其重要）。
 *   · abort()：把当前 id 作废（结果必然被丢弃）+ 通过 SAB 置取消位（可用时真正即时中断）。
 *   · ★ 调度：**move 优先**——辅助请求不会顶掉 AI 的一手，
 *     而是排队等它结束；被顶替的请求一律以 E_ABORTED 收尾（不留悬挂 promise）。
 */
(function () {
  'use strict';
  const S = window.G.search;

  let seq = 0, currentId = 0;
  let worker = null, backend = 'main', pending = null;
  let lateWorker = null;                  // 握手超时但仍在运行的 Worker（可能晚到并接管）
  let cancelView = null;                  // SAB 上的取消标志视图
  let lastInfo = { backend: 'main', reason: '' };

  /* ============================================================
   * ★ 请求调度：move 优先 + 辅助请求排队
   *
   * 旧行为（单通道 latest-wins）的两条实测缺陷：
   *   ① **辅助请求会顶掉 AI 的一手**：AI 思考期间用户点一下「热力」/按 H，
   *      就把在飞的 move 请求作废 ⇒ `thinking` 永远为真、**AI 再也不出招**（且无任何报错）。
   *   ② **被顶掉的 promise 无人收尾**：`pending` 被覆盖后旧 promise 既不 resolve 也不 reject
   *      ⇒ 面板的 `busy` 标志永久为真 ⇒ 之后所有「提示」静默失效（点了没反应）。
   *
   * 规则（简单且可解释）：
   *   · **move 不被抢占**：辅助请求（hint/judge/heat/analyze）一律**排队**，等 move 结束按序执行；
   *     同种辅助请求只保留最新一条（避免堆积），被替换的那条立刻以 E_ABORTED 收尾。
   *   · **顶替必收尾**：任何请求被顶掉时立刻 reject(E_ABORTED)，绝不留悬挂的 promise。
   */
  let moveInFlight = false;
  let pendingCmd = null;                  // 在飞请求的 cmd（排障用）
  const auxQueue = [];                    // [{ cmd, run, cancel }]，等待 move 结束

  /** 把在飞请求立刻收尾（不留悬挂 promise） */
  function settlePending() {
    const p = pending; pending = null; pendingCmd = null;
    disarmWatchdog();
    if (p) p.reject(new Error('E_ABORTED'));
  }

  /* ============================================================
   * ★ 看门狗：Worker「不回应」也必须有出口
   *   缺陷链：握手完成后 `onerror` 被 `done` 挡掉（见 tryWorker）＋ `pending` 只有
   *   "收到响应" 与 "被顶替" 两个出口 ⇒ Worker 崩溃/消息丢失时 promise 永不 settle，
   *   UI **永久停在"思考中"且零报错**（与历史"悬挂 promise"同族）。
   *   合法请求的最长耗时是 analyze 一片（~3 s）或单手时限（≤3 s）⇒ 45 s 足够宽松。
   * ============================================================ */
  const WATCHDOG_MS = (window.G.AI_TIMEOUT_MS || 45000);
  let watchdog = 0;
  function armWatchdog() {
    disarmWatchdog();
    if (backend !== 'worker' || !WATCHDOG_MS) return;
    watchdog = setTimeout(function () {
      watchdog = 0;
      const p = pending; pending = null; pendingCmd = null;
      lastInfo = { backend: backend, reason: 'Worker 超时无响应（' + Math.round(WATCHDOG_MS / 1000) + ' s）' };
      if (p) p.reject(new Error('E_TIMEOUT'));
      degradeToMain();                       // 不降级 ⇒ 之后每个请求都会同样卡死
    }, WATCHDOG_MS);
  }
  function disarmWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = 0; } }
  /** Worker 不可用（运行错误 / 超时）⇒ 退回主线程兜底，并放行排队的辅助请求。 */
  function degradeToMain() {
    disarmWatchdog();
    moveInFlight = false;
    const w = worker; worker = null;
    if (w) { try { w.terminate(); } catch (e) {} }
    if (lateWorker) { try { lateWorker.terminate(); } catch (e) {} lateWorker = null; }
    backend = 'main';
    flushAux();
  }
  /** ★ 运行期 Worker 错误（握手后也必须生效，否则错误被静默吞掉） */
  function onWorkerError(e) {
    const msg = (e && e.message) ? e.message : '未知';
    lastInfo = { backend: backend, reason: 'Worker 运行错误：' + msg };
    const p = pending; pending = null; pendingCmd = null;
    if (p) p.reject(new Error('E_WORKER：' + msg));
    degradeToMain();
  }
  /** 入队（同 cmd 去重取最新；被替换者立刻收尾） */
  function queueAux(job) {
    for (let i = 0; i < auxQueue.length; i++) {
      if (auxQueue[i].cmd === job.cmd) {
        const old = auxQueue.splice(i, 1)[0];
        old.cancel();
      }
    }
    auxQueue.push(job);
  }
  /* ★ 串行守卫：`flushAux()` 现在有**两个**调用源 —— move 结束的收尾，以及"降级"
   *   （看门狗超时 / Worker 运行错误）。若不设守卫，两次调用会各放行一个任务 ⇒
   *   两个辅助请求**并发**在飞 ⇒ 后者把前者的 id 作废 ⇒ 前者以 E_ABORTED 静默失败
   *   （表现就是"降级后某个面板点了没反应"，与历史缺陷同族）。 */
  let auxRunning = false;
  /** 串行放行：上一个 settle 后再发下一个（保证同时开启的多个开关都能出结果） */
  function flushAux() {
    if (auxRunning || moveInFlight || !auxQueue.length) return;
    const job = auxQueue.shift();
    auxRunning = true;
    let pr = null;
    try { pr = job.run(); } catch (e) { pr = null; }
    const next = function () { auxRunning = false; flushAux(); };
    Promise.resolve(pr).then(next, next);
  }

  /* ---------- 取消标志（可用则共享给 Worker） ---------- */
  function makeCancelBuf() {
    try {
      if (typeof SharedArrayBuffer !== 'undefined') {
        const sab = new SharedArrayBuffer(4);
        cancelView = new Int32Array(sab);
        return sab;
      }
    } catch (e) { /* 未跨源隔离 → 无 SAB */ }
    return null;
  }

  /* ---------- Worker 后端 ---------- */
  // 握手超时可注入（默认 2s；单测用 G.AI_HANDSHAKE_MS 调小以保证确定性）
  const HANDSHAKE_MS = (window.G.AI_HANDSHAKE_MS || 2000);

  function tryWorker() {
    const src = window.G.WORKER_SRC;
    if (!src) return Promise.reject(new Error('无 worker 源码（engine/worker-src.js 未加载）'));
    let url = null, w = null;
    try {
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new Worker(url);
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      return Promise.reject(e);
    }
    return new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return; done = true;
        // ★ 不终止 Worker：它可能只是慢（首次启动/低端机/虚拟时钟）。
        //   保留它，若稍后回话则**接管**为正式后端，避免永久退回主线程。
        lateWorker = w;
        reject(new Error('Worker 握手超时（保留待接管）'));
      }, HANDSHAKE_MS);
      w.onerror = function (e) {
        if (done) return; done = true;
        clearTimeout(timer);
        try { w.terminate(); } catch (err) {}
        reject(new Error('Worker 运行错误：' + (e && e.message ? e.message : '未知')));
      };
      w.onmessage = function (ev) {
        const m = ev.data;
        if (m && m.cmd === 'init' && !done) {
          done = true; clearTimeout(timer);
          worker = w;
          w.onmessage = onWorkerMessage;
          w.onerror = onWorkerError;        // ★ 换掉握手期的 onerror（它被 done 挡掉 ⇒ 之后静默）
          backend = 'worker';
          lastInfo = { backend: 'worker', reason: 'Blob Worker' };
          resolve(true);
          return;
        }
        onWorkerMessage(ev);
      };
      const buf = makeCancelBuf();
      w.postMessage({ id: ++seq, cmd: 'init', cancelBuf: buf });
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    if (!m) return;
    // 晚到的 init：接管为正式后端（下一次 askMove 起生效）
    if (m.cmd === 'init') {
      if (lateWorker) {
        worker = lateWorker; lateWorker = null;
        worker.onmessage = onWorkerMessage;
        worker.onerror = onWorkerError;
        backend = 'worker';
        lastInfo = { backend: 'worker', reason: 'Blob Worker（握手晚到，已接管）' };
      }
      return;
    }
    if (m.id !== currentId || !pending) return;      // ★ 丢弃过期结果
    const p = pending; pending = null; pendingCmd = null;
    disarmWatchdog();
    if (m.cmd === 'error') p.reject(new Error(m.code + '：' + m.message));
    else p.resolve(m);
  }

  /* ---------- 主线程后端（兜底，会阻塞 UI） ---------- */
  function mainThreadMove(board, stm, opts) {
    const cfg = Object.assign({}, S.difficultyCfg(opts.difficulty, opts.rule), {
      rule: opts.rule || 'freestyle',
    });
    if (opts.time && opts.time.hard) cfg.hardLimit = Math.min(cfg.hardLimit, opts.time.hard);
    // ★ opts.hist：真实落子序列。缺了它，重建的局面 hist 为空 ⇒ §12.4 开局库永不命中
    const pos = S.posFromBoard(board, stm, opts.hist);
    const r = S.think(pos, cfg);
    if (!r || !r.move) throw new Error('搜索未返回着法');
    return {
      cmd: 'move', move: r.move, score: r.score, nodes: r.nodes, depth: r.depth,
      timeMs: r.timeMs, fallbackLevel: r.fallbackLevel, aborted: false,
      via: r.via || null, book: r.book || null,
    };
  }

  /* ---------- 初始化 ---------- */
  let initPromise = null;
  function init(forceMain) {
    if (initPromise) return initPromise;
    if (forceMain) {
      backend = 'main';
      lastInfo = { backend: 'main', reason: '按参数强制主线程' };
      initPromise = Promise.resolve(false);
      return initPromise;
    }
    initPromise = tryWorker().catch(function (e) {
      backend = 'main';
      lastInfo = { backend: 'main', reason: String(e && e.message || e) };
      return false;
    });
    return initPromise;
  }

  /* ---------- 对外：请求一手 ---------- */
  function askMove(board, stm, opts) {
    const o = opts || {};
    moveInFlight = true;
    const id = ++seq;
    currentId = id;
    settlePending();                       // ★ 顶掉在飞的辅助请求（它的 promise 必须立刻收尾）
    const pr = init(o.forceMain).then(function () {
      if (currentId !== id) throw new Error('E_ABORTED');   // 等 init 期间被 abort / 被新请求顶替
      /* ⚠ 这里**不再**清 `cancelView[0]`：`abort()` 刚置的 1 会被这一行立刻抹掉，
       *   于是"取消当前搜索"失效（Worker 侧每个入口自己会清零 CANCEL，不需要客户端代劳）。 */
      if (backend === 'worker' && worker) {
        return new Promise(function (resolve, reject) {
          pending = { resolve: resolve, reject: reject }; pendingCmd = 'move';
          armWatchdog();
          try {
            worker.postMessage({
              id: id, cmd: 'move', board: board.slice(), stm: stm,
              rule: o.rule || 'freestyle', difficulty: o.difficulty || 'hard',
              time: o.time || null,
              hist: o.hist ? o.hist.slice() : null,   // §12.4：开局库要靠它还原真实棋谱前缀
            });
          } catch (e) { pending = null; pendingCmd = null; disarmWatchdog(); reject(e); }
        });
      }
      // 主线程：先让出一帧把"思考中"画出来，再同步计算
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (currentId !== id) return reject(new Error('E_ABORTED'));
          try { resolve(mainThreadMove(board, stm, o)); }
          catch (e) { reject(e); }
        }, 30);
      });
    });
    // move 结束（成功/失败/被顶替）⇒ 放行排队的辅助请求
    return pr.then(function (r) { moveInFlight = false; flushAux(); return r; },
                   function (e) { moveInFlight = false; flushAux(); throw e; });
  }

  /* ---------- M8：hint / judge / heat / analyze（§10 / §11 / §9.3） ----------
   * 复用同一套 id 机制：新请求会作废前一个在飞请求（提示与形势判断天然互斥）；
   * ★ 但**不会**顶掉 AI 的 move —— 有 move 在飞时先排队（见文件头"请求调度"）。
   */
  function send(cmd, payload, o, mainFn) {
    const run = function () {
      const id = ++seq;
      currentId = id;
      return init(o.forceMain).then(function () {
        if (currentId !== id) throw new Error('E_ABORTED');
        if (backend === 'worker' && worker) {
          return new Promise(function (resolve, reject) {
            settlePending();                 // 顶掉同频道在飞请求（并收尾）
            pending = { resolve: resolve, reject: reject }; pendingCmd = cmd;
            armWatchdog();
            const msg = Object.assign({ id: id, cmd: cmd }, payload);
            try { worker.postMessage(msg); }
            catch (e) { pending = null; pendingCmd = null; disarmWatchdog(); reject(e); }
          });
        }
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (currentId !== id) return reject(new Error('E_ABORTED'));
            try { resolve(mainFn()); } catch (e) { reject(e); }
          }, 0);
        });
      });
    };
    if (!moveInFlight) return run();
    return new Promise(function (resolve, reject) {
      const job = {
        cmd: cmd,
        cancel: function () { reject(new Error('E_ABORTED')); },
        run: function () {
          let pr = null;
          try { pr = run(); } catch (e) { reject(e); return null; }
          return Promise.resolve(pr).then(resolve, reject);
        },
      };
      queueAux(job);
    });
  }

  function askHint(board, stm, opts) {
    const o = opts || {};
    return send('hint', {
      board: board.slice(), stm: stm, rule: o.rule || 'freestyle',
      difficulty: o.difficulty || 'hard', n: o.n === undefined ? 5 : o.n,
      depth: o.depth, useThreat: o.useThreat, time: o.time || null,
    }, o, function () {
      const cfg = Object.assign({}, S.difficultyCfg(o.difficulty, o.rule), { rule: o.rule || 'freestyle' });
      if (o.time && o.time.hard) cfg.hardLimit = Math.min(cfg.hardLimit, o.time.hard);
      return { cmd: 'hint', hints: window.G.coach.hint(board, stm, Object.assign({
        topN: o.n === undefined ? 5 : o.n, rule: o.rule || 'freestyle',
        difficulty: o.difficulty || 'hard', depth: o.depth, useThreat: o.useThreat,
      }, o)) };
    });
  }

  function askJudge(board, stm, opts) {
    const o = opts || {};
    return send('judge', {
      board: board.slice(), stm: stm, rule: o.rule || 'freestyle',
      overlineMode: o.overlineMode || 'rif', difficulty: o.difficulty || 'hard',
    }, o, function () {
      const r = window.G.coach.judge(board, stm, {
        rule: o.rule || 'freestyle', overlineMode: o.overlineMode || 'rif',
        difficulty: o.difficulty || 'hard',
      });
      return { cmd: 'judge', blackRate: r.blackRate, label: r.label, score: r.score,
               source: r.source, mate: r.mate, forbiddenPoints: r.forbiddenPoints };
    });
  }

  function askHeat(board, stm, opts) {
    const o = opts || {};
    return send('heat', {
      board: board.slice(), stm: stm, rule: o.rule || 'freestyle',
      overlineMode: o.overlineMode || 'rif', difficulty: o.difficulty || 'normal',
    }, o, function () {
      return { cmd: 'heat', heat: window.G.coach.heat(board, stm, {
        rule: o.rule || 'freestyle', overlineMode: o.overlineMode || 'rif',
        difficulty: o.difficulty || 'normal', depth: o.depth || 2,
      }) };
    });
  }

  function askAnalyze(moves, stm, opts) {
    const o = opts || {};
    return send('analyze', {
      // ★ baseBoard：分片分析时把"这一段之前的盘面"一起送过去（整局分析就是空盘）
      board: o.baseBoard ? Array.prototype.slice.call(o.baseBoard) : blankBoard(),
      stm: stm, rule: o.rule || 'freestyle',
      overlineMode: o.overlineMode || 'rif', difficulty: o.difficulty || 'normal',
      depth: o.depth, useThreat: o.useThreat, time: o.time || null,
      moves: moves, topN: o.topN === undefined ? 1 : o.topN,
    }, o, function () {
      // 主线程兜底由 ui/record.js 自行实现（逐手调 coach），此处只保证接口不抛错
      throw new Error('主线程后端不支持 analyze，请在页面中使用（已内置兜底）');
    });
  }
  function blankBoard() {
    const a = new Int8Array(225);
    return a;
  }

  /* ---------- 对外：中断（结果按 id 必然被丢弃） ---------- */
  function abort() {
    if (cancelView) cancelView[0] = 1;              // Worker 侧即时退出（SAB 可用时）
    currentId = 0;                                  // 作废当前请求
    disarmWatchdog();
    const p = pending; pending = null; pendingCmd = null;
    if (p) p.reject(new Error('E_ABORTED'));        // ★ 立即拒绝在飞 promise，避免其永久挂起
    moveInFlight = false;                           // 已经作废 ⇒ 放行排队的辅助请求
    flushAux();
    const w = worker || lateWorker;
    if (w) { try { w.postMessage({ id: ++seq, cmd: 'abort' }); } catch (e) {} }
  }

  function info() { return { backend: backend, reason: lastInfo.reason }; }

  function dispose() {
    /* ★ dispose 后必须如实降级：原来只 terminate + 置 null，`backend` 仍报 worker ⇒
     *   后续请求静默改走主线程，而排障信息还在说 "worker"（也在飞 promise 永无出口）。 */
    const p = pending; pending = null; pendingCmd = null;
    if (p) p.reject(new Error('E_DISPOSED'));
    disarmWatchdog();
    moveInFlight = false;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (lateWorker) { try { lateWorker.terminate(); } catch (e) {} lateWorker = null; }
    backend = 'main';
    lastInfo = { backend: 'main', reason: '已 dispose（Worker 已终止）' };
    flushAux();
  }

  window.G.ai = {
    /* ★ 调度状态（排障 / 自动化断言用）：move 在飞？辅助队列多长？当前在飞哪个 cmd？
     *   另有 inited / watchdog 两项：前者说明握手是否已定局，后者说明看门狗是否在计时。 */
    sched: function () {
      return { moveInFlight: moveInFlight, auxQueue: auxQueue.length, seq: seq,
               currentId: currentId, pending: pendingCmd, backend: backend,
               inited: !!initPromise, watchdog: !!watchdog };
    },
    init: init, askMove: askMove, abort: abort, info: info, dispose: dispose,
    askHint: askHint, askJudge: askJudge, askHeat: askHeat, askAnalyze: askAnalyze,
    get backend() { return backend; },
  };
})();
