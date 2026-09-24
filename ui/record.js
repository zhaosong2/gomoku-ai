/* ui/record.js — 棋谱面板：导入 / 回放 / 导出 / 用时曲线 / 逐手分析（M8）
 * 设计依据：§9.3 功能、§9.4 回放复用同一渲染通道、§27.4 导出、§29.5 步数徽标
 *
 * 约定：本模块只负责"棋谱视图"，不直接改对局状态。
 *   · 进入回放模式 → 通知 main（onEnter），由 main 让出渲染权；
 *   · 退出回放 / 从某步续弈 → 通知 main（onExit / onResume），由 main 重建对局。
 */
(function () {
  'use strict';
  const C = window.G.core, REC = window.G.record, AI = window.G.ai, COACH = window.G.coach;
  const RULES = window.G.rules;

  const $ = function (id) { return document.getElementById(id); };

  function fmtMs(ms) {
    const t = Math.max(0, Math.round(ms || 0));
    if (t < 1000) return t + 'ms';
    if (t < 60000) return (t / 1000).toFixed(1) + 's';
    const m = Math.floor(t / 60000), s = Math.round((t % 60000) / 1000);
    return m + "'" + (s < 10 ? '0' : '') + s + '"';
  }

  function create(opts) {
    const o = opts || {};
    const el = {
      panel: $('recordPanel'), text: $('recText'), file: $('recFile'),
      btnLoad: $('btnRecLoad'), btnPaste: $('btnRecPaste'), btnExport: $('btnRecExport'),
      selFmt: $('recFmt'), selExpFmt: $('recExpFmt'),
      err: $('recErr'), info: $('recInfo'), list: $('recList'),
      bar: $('recBar'), btnFirst: $('btnRecFirst'), btnPrev: $('btnRecPrev'),
      btnNext: $('btnRecNext'), btnLast: $('btnRecLast'), btnPlay: $('btnRecPlay'),
      btnBack: $('btnRecBack'),
      selSpeed: $('recSpeed'), chkAutoTime: $('recAutoTime'),
      forkBar: $('recForkBar'), forkPly: $('recForkPly'),
      forkStart: $('recForkStart'), btnForkStart: $('btnRecForkStart'),
      btnForkUndo: $('btnRecForkUndo'), btnForkClear: $('btnRecForkClear'), btnForkKeep: $('btnRecForkKeep'),
      curve: $('recCurve'), btnResume: $('btnRecResume'), btnAnalyze: $('btnRecAnalyze'),
      anBox: $('recAnalysis'), chkArrow: $('chkArrow'),
    };

    let rec = null;                 // GameRecord
    let ply = 0;                    // 当前读谱手数（0 = 空盘）
    let playing = 0;                // 自动播放定时器
    let analysing = false;
    let active = false;             // 是否处于读谱模式（由 main 置位）
    let startedFromGame = false;    // 本次进入读谱是否来自"导出当前对局"
    /* ★ 推演（读谱模式下人工续下）：在"棋谱第 ply 手"之后自己摆的变化。
     *   独立于 rec 存在 ⇒ **不污染棋谱本身**，切回真实对局也不受影响。
     *   换手（seek 到别的 ply）即清空 —— 推演依附于它所起始的那个局面。 */
    let extra = [];

    /* ============================================================
     * ★ 逐手分析的预算与分片（2026-09-22 探索性测试实证）
     *   实测（一局 180 手、主线常态档）：
     *     · `hard + 威胁`          ≈ **3220ms/手** ⇒ 整局 10 分钟（原实现就是这档，且因为
     *       "每手都按空盘算"的缺陷而假快：空盘搜索几乎不耗时，所以从没人发现）
     *     · `normal + depth3`      ≈ 141s
     *     · `normal + depth2`      ≈ 40s
     *     · **单手时限（time.hard）实测不收紧总时长**（20ms/手仍是 140s）⇒ 只能靠**总预算**兜
     *   所以：分片请求（每片 12 手）+ 流式出结果 + **总时限 20s**（到点就停在已分析的手数并注明）。
     *   ⚠ Worker 路径与主线程兜底路径共用 REVIEW，避免"有没有 Worker"结论不同。
     * ============================================================ */
    const REVIEW = { difficulty: 'normal', depth: 2, useThreat: false };
    const ANALYZE_CHUNK = 12;
    const ANALYZE_BUDGET_MS = 20000;
    let analyzeRun = 0;                       // 令牌：重新发起 / 退出读谱时作废旧回调

    function toast(msg, isErr) {
      if (!el.err) return;
      el.err.textContent = msg || '';
      el.err.className = isErr ? 'rec-err bad' : 'rec-err';
    }

    /* ---------- 载入 ---------- */
    /* info（可选）：**外部带进来的元信息** —— 棋手 / 结果 / 开局 / 规则。
     *   ⚠ 只传着法文本会让信息栏显示"结果 未终局"+ 无对局者（探索性测试实测），
     *     而数据本来就在棋谱库里；顺带让"读的是哪种规则的棋谱"由棋谱自己决定。 */
    function load(text, fmt, info) {
      stop();
      const inf = info || {};
      const ruleMode = inf.ruleMode === 'renju' ? 'renju' : rec_rule();
      const r = REC.parse(text, { format: fmt || (el.selFmt && el.selFmt.value) || 'auto' });
      if (!r.ok) {
        toast(errText(r), true);
        return null;
      }
      rec = REC.build(r.moves, r.times, {
        ruleMode: ruleMode, result: undefined,
        meta: r.meta, opening: (r.meta && r.meta.opening) || '',
      }, { rule: ruleMode, overlineMode: overline(), format: r.format });
      // 解析器已识别出的元信息优先
      if (r.meta) rec.meta = Object.assign({}, rec.meta, r.meta);
      // ★ 外部元信息（棋谱库）：补棋手 / 结果 / 开局
      if (inf.black || inf.white || inf.opening || inf.result !== undefined) {
        const meta = Object.assign({}, rec.meta);
        if (inf.opening) meta.opening = inf.opening;
        const players = Object.assign({}, meta.players || {});
        if (inf.black) players.black = inf.black;
        if (inf.white) players.white = inf.white;
        if (players.black || players.white) meta.players = players;
        rec.meta = meta;
        if (inf.result === 0 || inf.result === 'B') rec.result = 'B';
        else if (inf.result === 1 || inf.result === 'W') rec.result = 'W';
        else if (inf.result === 2 || inf.result === 'draw') rec.result = 'draw';
      }
      rec.format = r.format;
      startedFromGame = false;                      // ★ 库内/导入的棋谱不是推演快照（R10 修正）
      ply = rec.moves.length;                       // 默认落到末手
      renderInfo(); renderList();
      if (rec.errors.length) {
        toast('已载入棋谱，但有 ' + rec.errors.length + ' 处问题', false);
      } else {
        toast('已载入棋谱（' + rec.moves.length + ' 手 · ' + r.format + '）', false);
      }
      enter();
      return rec;
    }
    /** 当前棋谱使用的规则（读库里的棋谱时以**棋谱自身**的规则为准）。 */
    function recRule() { return (rec && rec.ruleMode) || rec_rule(); }

    function errText(r) {
      if (!r || r.ok) return '';
      const loc = (r.line ? '第 ' + r.line + ' 行' + (r.col ? ' 第 ' + r.col + ' 列' : '') + '：' : '');
      return loc + (r.error || 'E_PARSE') + (r.message ? ' ' + r.message : '') +
             (r.token ? '（' + r.token + '）' : '');
    }

    function rec_rule() { return (o.rule && o.rule()) || 'freestyle'; }
    function overline() { return (o.overlineMode && o.overlineMode()) || 'rif'; }

    /* ---------- 从当前对局生成（§9.4 复用 history） ---------- */
    /* ★ 必须 enter()：本函数的语义是"把当前对局转成棋谱**并进入回放**"。
     *   历史缺陷：fromGame 只生成棋谱、不调 enter() ⇒
     *     ① 回放控制条（recBar）永不出现，用户看不到播放/翻手按钮；
     *     ② `active` 仍为 false ⇒ 「棋谱」按钮的开关语义失效（再点一次又生成一遍，
     *        而不是"退出回放"）；
     *     ③ 「棋谱」分组头也不会有回放中的状态提示。
     *   与 `load()` 的行为对齐（load 也调 enter）。 */
    function fromGame(history, info) {
      const r = REC.fromHistory(history, Object.assign({ ruleMode: rec_rule(), overlineMode: overline() }, info || {}));
      rec = r;
      ply = r.moves.length;
      startedFromGame = true;
      renderInfo(); renderList();
      toast('已生成棋谱（' + r.moves.length + ' 手）', false);
      enter();
      return r;
    }

    /* ---------- 回放控制 ---------- */
    /* ---------- 读谱模式进出 ---------- */
    function enter() {
      active = true;
      if (el.panel) el.panel.classList.add('on');
      if (el.bar) el.bar.hidden = false;
      if (el.forkBar) el.forkBar.hidden = false;
      if (el.forkStart) el.forkStart.hidden = true;   // 读谱/推演中：入口让位给推演条
      seek(ply);
      if (o.onMode) o.onMode(true);
    }
    function leave() {
      stop(); active = false;
      extra = [];
      analyzeRun++; analysing = false;          // ★ 退出读谱 ⇒ 作废还在跑的分片分析
      if (el.panel) el.panel.classList.remove('on');
      if (el.bar) el.bar.hidden = true;
      if (el.forkBar) el.forkBar.hidden = true;
      if (el.forkStart) el.forkStart.hidden = false;  // 回到对局：入口恢复
      if (el.anBox) { el.anBox.innerHTML = ''; el.anBox.hidden = true; }
      if (o.onMode) o.onMode(false);
    }
    function stop() {
      if (playing) { clearTimeout(playing); playing = 0; }
      if (el.btnPlay) el.btnPlay.textContent = '▶';
    }

    function seek(p) {
      if (!rec) return;
      const target = Math.max(0, Math.min(rec.moves.length, p | 0));
      // ★ 换手 ⇒ 推演作废（推演依附于它所起始的那个局面）；同一手内重绘不受影响
      if (target !== ply) extra = [];
      ply = target;
      const v = REC.viewAt(rec, ply, { overlineMode: overline() });

      /* ★ 推演叠加：把 extra 应用到 v 的**副本**上。这样 rec 始终是原始棋谱，
       *   「恢复下棋」/切换棋谱都不会被推演污染；只有「以推演续弈」才会把它变成真实对局。 */
      let board = v.board, order = v.order, lastMove = v.lastMove;
      let over = v.over, winner = v.winner, winLine = v.winLine;
      if (extra.length) {
        board = Int8Array.from(v.board);
        order = Int16Array.from(v.order);
        over = false; winner = 0; winLine = null;
        for (const e of extra) {
          const i = C.idxOf(e.x, e.y);
          board[i] = e.player;
          order[i] = e.no;
          lastMove = { x: e.x, y: e.y };
          const r = RULES.judge(board, e.x, e.y, e.player, recRule(), overline());
          if (r === 'win') { over = true; winner = e.player; winLine = RULES.winningLine(board, e.x, e.y, e.player, recRule()); }
          else if (r === 'lose') { over = true; winner = C.opp(e.player); winLine = null; }
        }
      }

      // 箭头叠加（§10 复用：读谱时把引擎首选画出来）
      let arrows = null;
      if (el.chkArrow && el.chkArrow.checked && !over && COACH) {
        try {
          const stm = ((ply + extra.length) % 2 === 0) ? C.BLACK : C.WHITE;
          arrows = COACH.hint(board, stm, { topN: 3, rule: recRule(), overlineMode: overline(), difficulty: 'normal', depth: 3, useThreat: false })
            .map(function (q) { return { x: q.x, y: q.y, norm: q.norm, rank: q.rank, type: q.type }; });
        } catch (e) { arrows = null; }
      }
      /* ★ 开局库匹配 / 本库关联棋谱（§12.4.5）由 **main** 统一渲染（onView 里带 hist），
       *   不在本模块画 —— 对局中也要显示同一块面板，若两处各写一份必然脱钩。 */
      const hist = [];
      for (let k = 0; k < ply; k++) { const m = REC.moveAt(rec, k); if (m) hist.push(C.idxOf(m.x, m.y)); }
      for (const e of extra) hist.push(C.idxOf(e.x, e.y));

      if (o.onView) o.onView({
        board: board, lastMove: lastMove, winLine: winLine, order: order,
        ply: v.ply, total: rec.moves.length, over: over, winner: winner,
        current: v.current, arrows: arrows, hist: hist,
        extra: extra.length, stm: ((ply + extra.length) % 2 === 0) ? C.BLACK : C.WHITE,
      });
      syncBar(); renderList(); markCurve();
    }

    /* ---------- 推演（读谱模式下的"人工续下"） ---------- */
    /** 在当前位置落一手推演。非法（越界 / 已占 / 已终局 / 非读谱态）返回 false。 */
    function pushExtra(x, y) {
      if (!active || !rec) return false;
      if (!(x >= 0 && x < C.N && y >= 0 && y < C.N)) return false;
      const v = REC.viewAt(rec, ply, { overlineMode: overline() });
      const i = C.idxOf(x, y);
      const base = extra.length ? (function () {
        const b = Int8Array.from(v.board);
        for (const e of extra) b[C.idxOf(e.x, e.y)] = e.player;
        return b;
      })() : v.board;
      if (base[i] !== C.EMPTY) return false;
      if (v.over) return false;
      const n = extra.length;
      const player = ((ply + n) % 2 === 0) ? C.BLACK : C.WHITE;
      extra.push({ x: x, y: y, player: player, no: ply + n + 1 });
      seek(ply);                                     // 同手重绘 ⇒ 不清空推演
      return true;
    }    function popExtra() {
      if (!extra.length) return false;
      extra.pop(); seek(ply); return true;
    }
    function clearExtra() {
      if (!extra.length) return false;
      extra = []; seek(ply); return true;
    }
    /** 推演序列（只读副本）。 */
    function extras() { return extra.map(function (e) { return { x: e.x, y: e.y, player: e.player, no: e.no }; }); }

    /** 「以推演续弈」：把"棋谱前 ply 手 + 推演手"变成**真实对局**（交给 main 的 onResume）。 */
    function keepFork() {
      if (!rec) return false;
      const mv = [];
      for (let k = 0; k < ply; k++) {
        const m = REC.moveAt(rec, k);
        if (m) mv.push({ x: m.x, y: m.y, player: m.player, no: m.no || (k + 1), timeMs: m.timeMs || 0 });
      }
      for (const e of extra) mv.push({ x: e.x, y: e.y, player: e.player, no: e.no, timeMs: 0 });
      if (!mv.length) return false;
      const info = { ruleMode: rec.ruleMode, ply: mv.length };
      clearExtra();
      leave();
      if (o.onResume) o.onResume(mv, info);
      return true;
    }

    function syncBar() {
      if (!rec) return;
      const label = $('recPly');
      if (label) label.textContent = ply + ' / ' + rec.moves.length;
      if (el.btnPrev) el.btnPrev.disabled = ply <= 0;
      if (el.btnFirst) el.btnFirst.disabled = ply <= 0;
      if (el.btnNext) el.btnNext.disabled = ply >= rec.moves.length;
      if (el.btnLast) el.btnLast.disabled = ply >= rec.moves.length;
      // 推演条：读谱模式下常显（哪怕还没推演，也要能看到"这里可以摆变化"）
      if (el.forkBar) el.forkBar.hidden = !active;
      if (el.forkPly) el.forkPly.textContent = '+ ' + extra.length + ' 手';
      if (el.btnForkUndo) el.btnForkUndo.disabled = !extra.length;
      if (el.btnForkClear) el.btnForkClear.disabled = !extra.length;
      if (el.btnForkKeep) el.btnForkKeep.disabled = ply + extra.length < 1;
      const cur = $('recCurrent');
      if (cur) {
        const m = ply > 0 ? rec.moves[ply - 1] : null;
        cur.textContent = m
          ? ('第 ' + m.no + ' 手 ' + (m.player === C.BLACK ? '黑' : '白') + ' ' + REC.coordText(m.x, m.y) +
             (m.timeMs ? ' · 用时 ' + fmtMs(m.timeMs) : '') + (m.verdict === 'win' ? ' · 成五' : (m.verdict === 'lose' ? ' · 禁手' : '')))
          : '开局（空盘）';
        if (extra.length) {
          const e = extra[extra.length - 1];
          cur.textContent += '    ⟶ 推演 ' + extra.length + ' 手，当前 ' + REC.coordText(e.x, e.y);
        }
      }
    }

    function play() {
      if (!rec) return;
      if (playing) { stop(); return; }
      if (ply >= rec.moves.length) seek(0);
      if (el.btnPlay) el.btnPlay.textContent = '❚❚';
      const speed = el.selSpeed ? parseFloat(el.selSpeed.value) || 1 : 1;
      const useTime = el.chkAutoTime && el.chkAutoTime.checked;
      (function tick() {
        if (ply >= rec.moves.length) { stop(); return; }
        const cur = ply > 0 ? rec.moves[ply - 1] : null;
        const nxt = rec.moves[ply];
        let delay = 700 / speed;
        if (useTime && nxt && nxt.timeMs > 0) delay = Math.max(120, nxt.timeMs / speed);
        else if (!useTime) delay = 700 / speed;
        playing = setTimeout(function () {
          seek(ply + 1);
          if (ply >= rec.moves.length) { stop(); return; }
          tick();
        }, delay);
      })();
    }

    /* ---------- 渲染：元信息 / 列表 / 曲线 ---------- */
    function renderInfo() {
      if (!el.info || !rec) return;
      const meta = rec.meta || {};
      const pl = meta.players || {};
      const res = rec.result === 'B' ? '黑胜' : rec.result === 'W' ? '白胜' : rec.result === 'draw' ? '和棋' : '未终局';
      /* 用时列：库里导出的棋谱**没有**每手用时 ⇒ 原来会显示"总用时 0ms（平均 0ms）"，
       * 看着像"这盘棋下了 0 毫秒"，是误导。没有数据就明说"未记录"。 */
      const hasTime = (meta.totalMs > 0) || (rec.moves || []).some(function (m) { return m.timeMs > 0; });
      el.info.innerHTML =
        row('格式', rec.format + '（' + (rec.ruleMode === 'renju' ? 'Renju' : '无禁手') + '）') +
        row('结果', res) +
        (meta.date ? row('日期', esc(meta.date)) : '') +
        ((pl.black || pl.white) ? row('对局者', esc(pl.black || '?') + ' vs ' + esc(pl.white || '?')) : '') +
        (meta.opening ? row('开局', esc(meta.opening)) : '') +
        row('手数', rec.moves.length + ' 手') +
        (hasTime
          ? row('总用时', fmtMs(meta.totalMs) + '（平均 ' + fmtMs(meta.avgMsPerMove) + '）')
          : row('用时', '该棋谱未记录用时')) +
        (rec.errors && rec.errors.length ? '<div class="rec-warn">⚠ ' + rec.errors.length + ' 处问题：' +
          rec.errors.slice(0, 4).map(function (e) { return e.error + '@第' + e.no + '手'; }).join('、') +
          (rec.errors.length > 4 ? ' …' : '') + '</div>' : '');
      function row(k, v) { return '<div class="rec-row"><span>' + k + '</span><b>' + v + '</b></div>'; }
    }
    function renderList() {
      if (!el.list || !rec) return;
      const rows = [];
      // 最近 60 手（长棋谱只渲染尾部，避免 DOM 过大）
      const from = Math.max(0, rec.moves.length - 60);
      if (from > 0) rows.push('<div class="rec-more">… 前 ' + from + ' 手已折叠</div>');
      for (let k = from; k < rec.moves.length; k++) {
        const m = rec.moves[k];
        const cur = (k + 1 === ply) ? ' cur' : '';
        rows.push('<div class="rec-item' + cur + '" data-ply="' + (k + 1) + '">' +
          '<i class="dot ' + (m.player === C.BLACK ? 'b' : 'w') + '"></i>' +
          '<span class="no">' + m.no + '</span>' +
          '<span class="co">' + REC.coordText(m.x, m.y) + '</span>' +
          '<span class="tm">' + (m.timeMs ? fmtMs(m.timeMs) : '') + '</span>' +
          (m.verdict === 'win' ? '<span class="tag win">成五</span>' : '') +
          (m.verdict === 'lose' ? '<span class="tag lose">禁手</span>' : '') +
          '</div>');
      }
      el.list.innerHTML = rows.join('');
    }

    // 用时曲线（§9.3）：SVG 折线 + 长考手标记
    function renderCurve() {
      if (!el.curve || !rec || !COACH) return;
      const ts = COACH.timeSeries(rec);
      if (!ts.length) { el.curve.innerHTML = ''; return; }
      const W = 300, H = 56, pad = 3;
      const max = Math.max.apply(null, ts.map(function (t) { return t.timeMs; })) || 1;
      const n = ts.length;
      const X = function (i) { return pad + (n <= 1 ? 0 : i * (W - 2 * pad) / (n - 1)); };
      const Y = function (t) { return H - pad - (t.timeMs / max) * (H - 2 * pad); };
      let pts = '', dots = '';
      for (let i = 0; i < n; i++) {
        pts += (i ? ' ' : '') + X(i).toFixed(1) + ',' + Y(ts[i]).toFixed(1);
        if (ts[i].isOutlier) dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(ts[i]).toFixed(1) + '" r="2.4" class="out"/>';
        if (i + 1 === ply) dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(ts[i]).toFixed(1) + '" r="3" class="cur"/>';
      }
      el.curve.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<polyline points="' + pts + '" class="ln"/>' + dots + '</svg>' +
        '<div class="rec-curve-legend"><span>用时曲线（峰值 ' + fmtMs(max) + '）</span>' +
        '<span class="out">● 长考手</span></div>';
    }
    function markCurve() { renderCurve(); }

    /* ---------- 导出 ---------- */
    function exportAs(fmt) {
      if (!rec) { toast('请先导入或生成棋谱', true); return; }
      const text = REC.exportRecord(rec, fmt, { numbered: true, oneBased: true, time: true });
      const name = 'gomoku-' + (rec.meta && rec.meta.date ? rec.meta.date : 'record') + '.' + ext(fmt);
      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        toast('已导出 ' + name, false);
      } catch (e) {
        // file:// 下 download 可能受限 → 把文本框展开供复制（它在 #recLegacy 里默认隐藏）
        if (el.text) el.text.value = text;
        const legacy = $('recLegacy');
        if (legacy) legacy.hidden = false;
        toast('下载被浏览器阻止，已展开文本框（可直接复制）', true);
      }
    }
    function ext(fmt) { return fmt === 'json' ? 'json' : fmt === 'sgf' ? 'sgf' : fmt === 'gomocup' ? 'txt' : 'txt'; }

    /* ---------- 逐手分析（§9.3 "逐手 AI 分析"） ----------
     * 分片 + 流式 + 总预算（见上）。每片独立请求 ⇒ 界面有进度、结果逐片出现、可随时打断。 */
    function analyze() {
      if (!rec) { toast('请先载入棋谱', true); return; }
      if (analysing) return;
      analysing = true;
      const run = ++analyzeRun;
      const seq = rec.moves.map(function (m) { return [m.x, m.y]; });
      const items = [];
      const t0 = Date.now();
      if (el.anBox) { el.anBox.hidden = false; el.anBox.innerHTML = '<div class="rec-dim">分析中… 0 / ' + seq.length + '</div>'; }
      (function nextChunk(from) {
        if (run !== analyzeRun) return;                       // 已被重新发起 / 退出读谱取代
        if (from >= seq.length) { analysing = false; renderAnalysis(items, { total: seq.length }); return; }
        if (Date.now() - t0 > ANALYZE_BUDGET_MS) {            // 到总预算：停在已分析的手数
          analysing = false;
          renderAnalysis(items, { total: seq.length, stopped: true });
          return;
        }
        const to = Math.min(seq.length, from + ANALYZE_CHUNK);
        AI.askAnalyze(seq.slice(from, to), (from % 2 === 0) ? C.BLACK : C.WHITE, Object.assign({
          rule: recRule(), overlineMode: overline(), topN: 1, baseBoard: boardAfter(from),
        }, REVIEW)).then(function (res) {
          if (run !== analyzeRun) return;
          const got = (res && res.items) || [];
          for (const it of got) items.push(Object.assign({}, it, { no: from + (it.no | 0) }));
          // ★ 引擎报了非法手 ⇒ 其后无法继续推演棋盘，就地收尾（别把"没算"混成"算过了"）
          if (got.some(function (it) { return it && it.illegal; })) {
            analysing = false;
            renderAnalysis(items, { total: seq.length });
            return;
          }
          if (el.anBox) {
            el.anBox.innerHTML = '<div class="rec-dim">分析中… ' + to + ' / ' + seq.length +
              '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）</div>';
          }
          renderAnalysis(items, { total: seq.length, inProgress: to });   // ★ 流式：每片落地即显示
          nextChunk(to);
        }).catch(function (e) {
          if (run !== analyzeRun) return;
          /* ★ 被新请求顶替（E_ABORTED）时**不要**跑主线程兜底：那是同步计算，
           *   对长棋谱会把页面冻住数秒，而用户此时已经做了别的操作、本来就放弃了这次分析。 */
          if (String(e && e.message) === 'E_ABORTED') {
            analysing = false;
            if (el.anBox) el.anBox.innerHTML = '<div class="rec-warn">分析被新的操作中断 —— 可再点一次「逐手分析」</div>';
            return;
          }
          fallbackAnalyze(seq, from, items, t0);              // 后端不支持 ⇒ 本地兜底接着跑
        });
      })(0);
    }

    /** 前 n 手之后的盘面（分片请求要把"起点盘面"一起送过去）。 */
    function boardAfter(n) {
      const b = new Int8Array(C.NN);
      let stm = C.BLACK;
      for (let k = 0; k < n; k++) {
        const m = REC.moveAt(rec, k);
        if (!m) break;
        b[C.idxOf(m.x, m.y)] = m.player || stm;
        stm = C.opp(stm);
      }
      return b;
    }

    /* 主线程兜底（无 Worker / 后端不支持 analyze 时）。**分片让帧**，避免长棋谱冻住界面。 */
    function fallbackAnalyze(seq, from, items, t0) {
      const board = boardAfter(from);
      let stm = (from % 2 === 0) ? C.BLACK : C.WHITE;
      let k = from;
      const CHUNK = 8;
      (function step() {
        if (k >= seq.length || Date.now() - t0 > ANALYZE_BUDGET_MS) {
          analysing = false;
          renderAnalysis(items, { total: seq.length, stopped: k < seq.length, local: true });
          return;
        }
        try {
          const end = Math.min(seq.length, k + CHUNK);
          for (; k < end; k++) {
            const h = COACH.hint(board, stm, Object.assign({ topN: 1, rule: recRule(), overlineMode: overline() }, REVIEW));
            const top = h[0] || null;
            const hit = !!top && top.x === seq[k][0] && top.y === seq[k][1];
            items.push({ no: k + 1, x: seq[k][0], y: seq[k][1], player: stm,
                         best: top, inTopN: hit, rank: hit ? 1 : 0, topN: h });
            board[C.idxOf(seq[k][0], seq[k][1])] = stm;
            stm = C.opp(stm);
          }
        } catch (e2) {
          analysing = false;
          if (el.anBox) el.anBox.innerHTML = '<div class="rec-warn">分析失败：' + esc(String(e2 && e2.message || e2)) + '</div>';
          return;
        }
        if (el.anBox) el.anBox.innerHTML = '<div class="rec-dim">分析中… ' + k + ' / ' + seq.length + '（主线程兜底）</div>';
        setTimeout(step, 0);
      })();
    }

    function renderAnalysis(items, opts) {
      if (!el.anBox) return;
      const o2 = opts || {};
      // 一致性：本手与引擎首选的重合率（供"复盘契合度"参考）
      let hit = 0;
      for (const it of items) if (it.inTopN) hit++;
      const rate = items.length ? Math.round(hit / items.length * 100) : 0;
      const rows = items.map(function (it) {
        const b = it.best;
        const ok = it.inTopN;
        // ★ 非法手（引擎标 illegal，如 E_OCCUPIED）不能记成"分歧"：那不是"引擎不同意这手"，
        //   而是"这一手根本下不出去"——两者对复盘的含义完全不同。
        const bad = !!(it && it.illegal);
        const cls = bad ? 'differ' : (ok ? 'ok' : 'differ');
        const txt = bad ? '非法' : (ok ? '契合' : '分歧');
        return '<div class="rec-an-item" data-ply="' + it.no + '">' +
          '<span class="no">' + it.no + '</span>' +
          '<span class="co">' + REC.coordText(it.x, it.y) + '</span>' +
          '<span class="res ' + cls + '">' + txt + '</span>' +
          (b ? '<span class="bs">引擎首选 ' + b.coord + ' <em>' + (b.type || '') + '</em></span>' : '<span class="bs">—</span>') +
          '</div>';
      }).join('');
      const illegal = items.filter(function (it) { return it && it.illegal; }).length;
      /* 只在**跑完**或**到时间上限**时说明范围：契合率的分母必须写清楚，
       * 否则"前 120 手的结果"会被当整局结论（两个口径不可混，见 §12.4.5 教训）。 */
      let scope = '';
      if (illegal) {
        scope = '<div class="rec-warn">棋谱第 ' + items[items.length - 1].no +
          ' 手非法（' + items[items.length - 1].illegal + '），其后不再分析 —— 契合率只代表已分析的部分</div>';
      } else if (o2.inProgress) {
        scope = '<div class="rec-dim">分析中… 已出 ' + items.length + ' / ' + (o2.total || '?') + ' 手</div>';
      } else if (o2.stopped) {
        scope = '<div class="rec-warn">已分析前 ' + items.length + ' / ' + (o2.total || '?') +
          ' 手（达到时间上限）—— 契合率只代表这一段</div>';
      } else if (o2.total && items.length < o2.total) {
        scope = '<div class="rec-warn">只分析了前 ' + items.length + ' / ' + o2.total + ' 手</div>';
      }
      el.anBox.innerHTML =
        '<div class="rec-an-head">逐手分析：引擎首选契合 <b>' + rate + '%</b>（' + hit + '/' + items.length + '）' +
        '<span class="dim"> · 复核档位 ' + REVIEW.difficulty + ' / 深度 ' + REVIEW.depth +
        (REVIEW.useThreat ? '' : ' / 不用威胁搜索') + '</span></div>' + scope +
        '<div class="rec-an-list">' + rows + '</div>';
    }

    /* ---------- 事件绑定 ---------- */
    if (el.btnLoad) el.btnLoad.addEventListener('click', function () {
      if (el.text && el.text.value.trim()) load(el.text.value);
      else toast('请先粘贴棋谱文本', true);
    });
    if (el.btnPaste) el.btnPaste.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { toast('浏览器不支持读取剪贴板，请手动粘贴', true); return; }
      navigator.clipboard.readText().then(function (t) {
        if (el.text) el.text.value = t;
        load(t);
      }).catch(function () { toast('读取剪贴板被拒绝，请手动粘贴到文本框', true); });
    });
    if (el.file) el.file.addEventListener('change', function () {
      const f = el.file.files && el.file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = function () { if (el.text) el.text.value = String(rd.result || ''); load(String(rd.result || '')); };
      rd.readAsText(f, 'utf-8');
    });
    if (el.btnExport) el.btnExport.addEventListener('click', function () {
      exportAs((el.selExpFmt && el.selExpFmt.value) || 'renju');
    });
    if (el.btnFirst) el.btnFirst.addEventListener('click', function () { stop(); seek(0); });
    if (el.btnPrev) el.btnPrev.addEventListener('click', function () { stop(); seek(ply - 1); });
    if (el.btnNext) el.btnNext.addEventListener('click', function () { stop(); seek(ply + 1); });
    if (el.btnLast) el.btnLast.addEventListener('click', function () { stop(); seek(rec ? rec.moves.length : 0); });
    if (el.btnPlay) el.btnPlay.addEventListener('click', play);
    if (el.selSpeed) el.selSpeed.addEventListener('change', function () { if (playing) { stop(); play(); } });
    if (el.chkArrow) el.chkArrow.addEventListener('change', function () { seek(ply); });
    if (el.list) el.list.addEventListener('click', function (e) {
      const it = e.target.closest ? e.target.closest('.rec-item') : null;
      if (!it) return;
      stop(); seek(parseInt(it.getAttribute('data-ply'), 10) || 0);
    });
    if (el.anBox) el.anBox.addEventListener('click', function (e) {
      const it = e.target.closest ? e.target.closest('.rec-an-item') : null;
      if (!it) return;
      seek(parseInt(it.getAttribute('data-ply'), 10) || 0);
    });
    if (el.btnResume) el.btnResume.addEventListener('click', function () {
      if (!rec) { toast('请先载入棋谱', true); return; }
      const moves = rec.moves.slice(0, ply);
      /* ★ 顺序：**先 leave() 再 onResume**（与 keepFork 一致）。
       *   反过来的话，main 的 updateStatus → syncLocks 会在 `active` 仍为 true 时执行
       *   ⇒ 悔棋/重开 被按"读谱中"锁住，而 leave() 之后没人再刷新锁定态
       *   ⇒ 本地双人模式下这两个按钮会一直点不动（PvE 只靠 AI 应手时的 updateStatus 自愈）。 */
      leave();
      if (o.onResume) o.onResume(moves, { ruleMode: rec.ruleMode, ply: ply });
    });
    /* 「恢复下棋」：退出读谱模式，回到**原来的对局**（推演一并丢弃，不动真实对局）。
     * 与「以推演续弈」的区别：后者会把"棋谱前 N 手 + 推演手"变成新的对局。 */
    if (el.btnBack) el.btnBack.addEventListener('click', function () {
      if (o.onExit) o.onExit();          // 由 main 负责退出（它还要清叠加层/复位按钮）
      else leave();
    });
    /* 「推演」（对局中入口，R10）：快照当前对局 → 进入读谱推演。真实对局在退出前完全不动。 */
    if (el.btnForkStart) el.btnForkStart.addEventListener('click', function () {
      if (active) return;
      if (o.onForkStart) o.onForkStart();
    });
    if (el.btnForkUndo) el.btnForkUndo.addEventListener('click', function () { popExtra(); });
    if (el.btnForkClear) el.btnForkClear.addEventListener('click', function () { clearExtra(); });
    if (el.btnForkKeep) el.btnForkKeep.addEventListener('click', function () { keepFork(); });
    if (el.btnAnalyze) el.btnAnalyze.addEventListener('click', analyze);

    // 键盘：←/→ 翻手，空格播放（仅在回放模式）
    window.addEventListener('keydown', function (e) {
      if (!active) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') { stop(); seek(ply - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stop(); seek(ply + 1); e.preventDefault(); }
      else if (e.key === ' ') { play(); e.preventDefault(); }
      else if (e.key === 'Home') { stop(); seek(0); }
      else if (e.key === 'End') { stop(); seek(rec ? rec.moves.length : 0); }
    });

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
      });
    }

    /* ---------- 对外 ---------- */
    return {
      load: load, fromGame: fromGame, leave: leave, seek: seek, play: play,
      exportAs: exportAs, analyze: analyze,
      pushExtra: pushExtra, popExtra: popExtra, clearExtra: clearExtra,
      extras: extras, hasExtra: function () { return extra.length > 0; },
      keepFork: keepFork,
      // ★ 供测试 / 自动化：只读当前读谱局面的前缀（不含终局多出的手）
      historyAt: function (p) {
        if (!rec) return [];
        const n = Math.max(0, Math.min(rec.moves.length, p === undefined ? ply : (p | 0)));
        const out = [];
        for (let k = 0; k < n; k++) { const m = REC.moveAt(rec, k); if (m) out.push([m.x, m.y, m.player, m.no]); }
        return out;
      },
      get record() { return rec; },
      get ply() { return ply; },
      get active() { return active; },
      get startedFromGame() { return startedFromGame; },
      fmtMs: fmtMs,
    };
  }

  window.G.recordPanel = { create: create, fmtMs: fmtMs };
})();
