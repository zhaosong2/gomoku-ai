/* ui/main.js — 交互与状态机（M4：人机对战 + M8：提示/形势/棋谱）
 * 设计依据：§29.2（状态机 idle→waitingAI→idle）、§29.5（步数徽标）、§34.5（并发护栏）、
 *           §10 提示 / §11 形势判断 / §9 棋谱回放
 *  · PvP = 本地双人；PvE = 人机（玩家可选执黑/执白）
 *  · 悔棋/重开/切模式/切难度/认输 之前一律先 ai.abort()，并按 id 丢弃过期结果
 *  · M8 叠加层（候选点 / 热力图 / 回放）与对局共用一个 renderer.draw 通道
 */
(function () {
  'use strict';
  const C = window.G.core, RULES = window.G.rules, R = window.G.render, AI = window.G.ai;
  const COACH = window.G.coach, RP = window.G.recordPanel, PANELS = window.G.panels;
  const MENU = window.G.menu, TOUCH = window.G.touch;

  const $ = function (id) { return document.getElementById(id); };
  const canvas = $('board');
  const statusEl = $('status');
  const metaEl = $('meta');
  const chkNo = $('chkNo');
  const chkForbid = $('chkForbid');
  const ruleHint = $('ruleHint');
  const btnUndo = $('btnUndo');
  const btnRestart = $('btnRestart');
  const btnHint = $('btnHint');
  const btnJudge = $('btnJudge');
  const btnHeat = $('btnHeat');
  const btnRecord = $('btnRecord');
  const selRule = $('selRule');
  const selMode = $('selMode');
  const selSide = $('selSide');
  const selLevel = $('selLevel');
  const selTime = $('selTime');
  const selHintLevel = $('selHintLevel');
  const lockNote = $('lockNote');
  // ★ 触屏落子（小屏模式）用到的元素
  const touchBar = $('touchBar');
  const touchText = $('touchText');
  const btnTouchOk = $('btnTouchOk');
  const btnTouchCancel = $('btnTouchCancel');
  const selTouch = $('selTouch');
  const touchDim = $('touchDim');

  let pos, winner, over, winLine, lastMove, hover;
  let orderArr, moves;
  let forbidSet = null;                // Renju 下当前走子方（黑）的禁手点集合（仅用于标红/拦截）
  let thinking = false;            // waitingAI（§29.2）
  let gen = 0;                     // ★ 世代令牌：只有"当前这一手"的响应可以改状态（§34.5）
  let humanSide = 0;               // PvE 下**玩家**执哪一方（0 = PvP 本地双人）
  let lastAI = null;               // 最后一手 AI 信息（分值/深度/用时）
  let plyTime = 0;                 // ★ M8：本手用时（ms），供棋谱 §9.2 timeMs
  let lastHumanTs = 0;
  /* ★ 触屏落子状态（小屏模式）：
   *   touchPref = 偏好（'auto' 按设备 / 'on' 手动开 / 'off' 手动关）
   *   touchOn   = 当前是否生效（由 touchPref + 设备环境解析而来）
   *   ptr       = 本次按下的手势（{ id, p0, from, dist, dragging, blocked }）
   *   ghost     = 手指按住时的"幽灵子"预览点
   *   pending   = **待确认的落点**（松手后仍存在，直到确认/取消/局面变化） */
  let touchPref = 'auto', touchOn = false, ptr = null, ghost = null, pending = null;
  const mqCoarse = (window.matchMedia && window.matchMedia('(pointer: coarse)')) || null;

  const renderer = new R.Renderer(canvas, { onResize: draw });

  /* ---------- M10 动画（§14）：落子淡入 / 五连闪烁 / 候选脉冲 ----------
   * 设计要点：
   *  · 只驱动"重绘"，不改变任何状态；draw() 仍是纯函数（state.anim 缺省 = 静态 ⇒ 与旧行为逐像素一致）。
   *  · prefers-reduced-motion: reduce 时整体关闭（可访问性，§29.4）——`animOn()` 返回 false。
   *  · 用 rAF 惰性循环：仅在"需要动画"时排帧，空闲自动停（不空转烧电）。
   */
  const mqReduce = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')) || null;
  function animOn() { return !(mqReduce && mqReduce.matches); }
  const DROP_MS = 180;
  let anim = { t: 0, dropUser: 0, dropIdx: 0, dropMs: DROP_MS };
  let animRaf = 0, animUntil = 0;
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function startAnim(untilTs) {
    animUntil = Math.max(animUntil, untilTs);
    if (animRaf || !animOn()) return;
    const loop = function () {
      anim.t = nowMs();
      animRaf = 0;
      draw();
      // 仍有"待播"动画（落子/闪烁/脉冲）则续帧；否则停
      const need = anim.t < animUntil || (winLine && winLine.length) || (overlay.candidates && overlay.candidates.length);
      if (need) animRaf = requestAnimationFrame(loop);
    };
    animRaf = requestAnimationFrame(loop);
  }
  // 落子触发淡入；AI/玩家/回放统一走这里
  function bumpDrop(idx) {
    anim.dropIdx = idx || 0;
    anim.dropUser = nowMs();
    startAnim(anim.dropUser + DROP_MS + 20);
  }
  if (mqReduce && mqReduce.addEventListener) {
    mqReduce.addEventListener('change', function () { draw(); });
  }

  /* ---------- M8：叠加层与面板 ---------- */
  let overlay = { candidates: null, heat: null, forbidden: null, preview: null };
  let replay = null;                // 回放视图（由 recordPanel 提供）
  let panel = null, recPanel = null;

  /* ============================================================
   * §29.2 偏好持久化 + 行棋中锁定（用户需求）
   *   ① 所有"开关/选项"刷新后恢复；
   *   ② 高亮只由各自状态决定（见 panels.setHeatUI 的注释）；
   *   ③ 行棋中（已有落子且未终局）不允许切换会改变胜负语义的项。
   *
   * ★ 为什么用"行棋中禁用"而不是"切换即重开"：
   *   规则(selRule)/对战模式(selMode)/执子(selSide) 的语义是"这一局的约定"，
   *   中途改会让已下的棋失去意义（例如 Renju 判过的禁手在 freestyle 下不成立）。
   *   原来一律 `reset()` 把棋盘清空——用户损失棋局，且与"只是想改个偏好"的意图不符。
   *   现在：行棋中置 disabled，**重开后自动解锁**。
   *   难度(selLevel)/时限(selTime) 不影响已落子的合法性，允许随时改（换难度会重算当前手）。
   */
  const PREFS = {
    rule: 'freestyle', mode: 'pve', side: 'black',
    level: 'hard', time: '0',
    hintLevel: 'hard',                 // ★ 需求1：提示难度**独立**于对局难度
    showNo: true, forbid: true, hintScore: false,
    /* ★ 需求3：「提示 / 形势 / 热力」是**长期开关** —— 打开后每手自动刷新，刷新页面也保持。 */
    autoHint: false, autoJudge: false, heat: false,
    rec: { fmt: 'auto', exp: 'renju', speed: '1', autoTime: false, arrow: false },
    legal: 0,          // 供将来扩展
  };
  const P = window.G.prefs;

  /* ============================================================
   * §14 侧栏分组（分类归置 + 分层展开）
   *   · menu 只管"分组的开合"，业务数据一概不碰（见 ui/menu.js 头注释）。
   *   · 开合状态是**纯 UI 偏好** ⇒ 走 prefs 持久化（groups 键），刷新后恢复。
   *   · 动作用 openFor(id)：**幂等展开**（已开时不再写盘），供动作按钮每次点击调用。
   * ============================================================ */
  const menu = MENU ? MENU.create({
    prefs: P,
    // 分组开合 → 同步"对应按钮"的 aria-pressed（按钮 = 面板的开关，语义一致）
    onToggle: function (id, on) {
      if (id === 'record' && btnRecord) btnRecord.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
  }) : null;
  if (menu) menu.init();

  /** 把"行棋中锁定"这件事显式化：分组头徽标 + 组内说明。
   *  原实现只在 select 的 title 里写一句，鼠标不悬停就完全看不出为什么点不动。 */
  function syncLockNote(locked) {
    let text = '';
    let badge = '';
    if (locked && replay) {
      badge = '读谱中已锁定';
      text = '正在读谱：规则 / 对战 / 我执，以及「悔棋 / 重开」都已锁定（它们作用在背后的对局上，' +
             '避免看不到的改动）。点「恢复下棋」退出读谱继续对局，或点「以推演续弈」把当前变化变成对局。';
    } else if (locked) {
      badge = '行棋中已锁定';
      text = '已有落子：规则 / 对战 / 我执 已锁定，点「重开」后可改。' +
             '难度与时限仍可随时调整。';
    } else if (selMode.value !== 'pve') {
      text = '本地双人模式：难度 / 时限 / 我执 不生效（切回「人机对战」可用）。';
    }
    if (lockNote) {
      lockNote.textContent = text;
      lockNote.className = 'grp-dim' + (text ? ' warn' : '');
      lockNote.hidden = !text;
    }
    if (menu) menu.setNote('game', badge, badge ? 'warn' : '');
    const g = $('grpGame');
    if (g) g.classList.toggle('locked', !!locked);
  }

  // 行棋中不可切换的控件（改语义类）
  const LOCK_WHILE_PLAYING = [selRule, selMode, selSide];

  /** 行棋中？= 已有落子且未终局。仅"空盘/已终局"允许改语义类选项。 */
  function inPlay() { return !!(moves && moves.length > 0 && !over && !winner); }

  /** 把锁定状态刷到 UI。必须在每次落子/悔棋/重开/终局之后调用。 */
  function syncLocks() {
    // ★ 读谱模式同样锁定语义类选项：棋谱的规则是固定的，读到一半换规则会让判决失去意义
    const locked = inPlay() || readMode();
    for (const el of LOCK_WHILE_PLAYING) {
      if (!el) continue;
      // 模式非 PvE 时 selSide/selLevel/selTime 本就应禁用（见 applyModeEnable）
      el.dataset.lockPlay = locked ? '1' : '';
      el.disabled = locked || el.dataset.forceOff === '1';
      el.title = locked ? '行棋中不可切换（点「重开」后可改）' : '';
    }
    /* ★ 读谱中还要锁住「悔棋 / 重开」：这两个按钮作用在**背后的对局**上，而屏幕上显示的是棋谱
     *   ⇒ 点了会"静默改动看不见的东西"（实测：读谱中点悔棋 ⇒ 退出读谱 + 对局白丢两手）。
     *   读谱有自己的控制（恢复下棋 / 推演撤回 / 以推演续弈），想动对局先退出读谱即可。 */
    const ro = readMode();
    for (const el of [btnUndo, btnRestart]) {
      if (!el) continue;
      el.dataset.lockPlay = ro ? '1' : '';
      el.disabled = ro;
      el.title = ro ? '读谱中：先点「恢复下棋」退出读谱，再操作对局' : '';
    }
    // 棋盘上的"显示落子顺序 / 标出禁手点"是纯显示开关，行棋中允许改
    if (chkNo) chkNo.disabled = false;
    if (chkForbid) chkForbid.disabled = false;
    // ★ 把"为什么点不动"显式化（否则只有一个不显眼的 title，用户看不出原因）
    syncLockNote(locked);
  }
  /** PvE 专属控件的启用状态（与"行棋中锁定"叠加，取或） */
  function applyModeEnable() {
    const pve = selMode.value === 'pve';
    for (const el of [selSide, selLevel, selTime]) {
      if (!el) continue;
      el.dataset.forceOff = pve ? '' : '1';
    }
    syncLockNote(inPlay());
  }

  /** 「显示与叠加」分组头摘要：折叠时也能看到开了几项叠加。 */
  function syncDisplayNote() {
    if (!menu) return;
    const items = [];
    if (chkNo && chkNo.checked) items.push('步数');
    if (chkForbid && chkForbid.checked && rule() === 'renju') items.push('禁手');
    if ($('chkHintScore') && $('chkHintScore').checked) items.push('分值');
    if ($('chkArrow') && $('chkArrow').checked) items.push('首选箭头');
    if (touchOn) items.push('触屏落子' + (touchPref === 'auto' ? '(自动)' : ''));
    menu.setNote('display', items.length ? items.join(' · ') : '全部关闭');
  }

  /** 「棋谱」分组头摘要：读谱中显示进度，否则显示对局态的提示。
   *  ⚠ 不动 btnRecord 的 aria-pressed —— 那个反映的是**面板开合**（由 menu.onToggle 维护），
   *     两件事不要共用同一个属性，否则又会出现"状态与显示脱钩"。 */
  function syncRecNote() {
    const noteEl = $('recNote');
    const inRead = !!(recPanel && recPanel.active);
    if (noteEl) {
      if (inRead && recPanel.record) {
        const ex = recPanel.hasExtra && recPanel.hasExtra() ? (' · 推演+' + recPanel.extras().length) : '';
        // ★ R10：来源是「推演」（快照当前对局）时如实说"推演中"，不冒充"读谱中"
        const mode = recPanel.startedFromGame ? '推演中 ' : '读谱中 ';
        noteEl.textContent = mode + recPanel.ply + ' / ' + recPanel.record.moves.length + ex;
      } else {
        noteEl.textContent = '对局中';
      }
    }
  }

  /* ============================================================
   * ★ 需求3：提示 / 形势 / 热力 = **长期开关**
   *   · 语义：打开后**每手自动刷新**（落子/AI 走子/悔棋/重开/读谱翻手都会重算），
   *     而不是"点一次算一次"；再点一次关闭。状态写入偏好，刷新后保持。
   *   · 实现：在 `updateStatus()` 里调 `syncObservers()`，用 (局面, 手数) 做幂等键，
   *     同一局面只触发一次，避免重复请求把在飞的那次顶掉（ai.js 是单通道 latest-wins）。
   *   · ⚠ 必须避开"AI 正在思考"：此时发 hint/judge 会把 AI 的 `move` 请求顶掉
   *     （latest-wins）⇒ AI 永远不出招。所以 thinking 期间一律不触发，
   *     等这一手落地后 updateStatus 自然会补上。
   * ============================================================ */
  const obs = { autoHint: false, autoJudge: false };
  let pendingHeat = false;             // 启动时待恢复的热力图开关（等棋盘就绪再真正发起）
  let obsKey = '';                     // 幂等键：'live|12' / 'read|8+2'
  function setToggleUI(btn, on) {
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  /* 幂等键：局面身份（对局 / 读谱 + 手数 + 推演手数） */
  function obsKeyOf() {
    if (replay) return 'read|' + replay.ply + '+' + (replay.extra | 0);
    return 'live|' + (moves ? moves.length : 0) + '|' + (over ? 'o' : '') + (winner ? 'w' : '');
  }
  /** AI 是否"马上会落一子"（此时发辅助请求会跟它抢通道）。 */
  function aiWillAct() {
    return !replay && !over && isAITurn();
  }
  /* 三个长期开关的局面刷新。
   *   ★ 两条硬约束：
   *   ① **必须串行**：AI 通道是单通道 latest-wins，同一 tick 连发三个请求会让前两个被顶掉 ⇒
   *      实测"提示 + 形势同开"时永远只有形势有结果、提示空着（点开关也像没生效）。
   *   ② **AI 回合必须让路且不占键**：等它落子后的 updateStatus 再补算。
   *      （旧实现先写 obsKey 再 return ⇒ 思考期间没算、之后也不会补 ⇒ "单开提示也不刷新"。） */
  let obsChain = 0;
  let obsRetry = 0;
  function syncObservers() {
    if (thinking || aiWillAct()) return;             // 让开通道；**不写 obsKey** ⇒ 这手落地后自动补
    /* ★ R10：面板自己的提示请求**还在飞**时也必须"不占键"。
     *   `panel.askHint()` 在 busy 时静默返回 null ⇒ 旧写法（先写 `obsKey` 再调）会把这次局面变化的
     *   自动刷新**吞掉且永不补**。实测：提示开长期开关 → 快速连落 5 手，摘要一直是**空**（静置 12s 也不动）；而 `askJudge()` 无 busy 守卫 ⇒ 表现为"形势有值、提示空着"。
     *   这正是 §29.2「让路且不占键」铁律的漏网分支 ⇒ 这里改为不占键 + 稍后重试。 */
    if (panel && panel.busy) { scheduleObsRetry(); return; }
    const k = obsKeyOf();
    if (k === obsKey) return;                        // 局面没变 ⇒ 不重复请求
    obsKey = k;
    const jobs = [];
    if (obs.autoHint && panel) jobs.push(function () { return obs.autoHint ? panel.askHint() : null; });
    if (obs.autoJudge && panel) jobs.push(function () { return obs.autoJudge ? panel.askJudge() : null; });
    if (panel && panel.heatOn) jobs.push(function () { return panel.heatOn ? panel.refreshHeat() : null; });
    if (!jobs.length) return;
    const my = ++obsChain;                           // 局面再变 ⇒ 作废剩余任务（新键会另起一条链）
    (function next(i) {
      if (my !== obsChain || i >= jobs.length) return;
      Promise.resolve(jobs[i]()).then(function () { next(i + 1); }, function () { next(i + 1); });
    })(0);
  }
  /** 面板忙 ⇒ 150ms 后再试（只保留一次待重试，避免堆积；面板空闲后自然收敛） */
  function scheduleObsRetry() {
    if (obsRetry) return;
    obsRetry = setTimeout(function () { obsRetry = 0; syncObservers(); }, 150);
  }
  /** 切换长期开关（按钮点击入口）。 */
  function toggleObserver(which) {
    if (which === 'hint') {
      obs.autoHint = !obs.autoHint;
      setToggleUI(btnHint, obs.autoHint);
      savePrefs();
      if (menu) menu.openFor('hint');
      if (!obs.autoHint && panel) panel.clearHints();
      obsKey = ''; syncObservers();      // 统一走同一条路径（避免"手动算一次 + 下次状态更新再算一次"）
      return obs.autoHint;
    }
    if (which === 'judge') {
      obs.autoJudge = !obs.autoJudge;
      setToggleUI(btnJudge, obs.autoJudge);
      savePrefs();
      if (menu) menu.openFor('judge');
      obsKey = ''; syncObservers();
      return obs.autoJudge;
    }
    return false;
  }

  /* ============================================================
   * ★ 需求4：开局库匹配 + 本库对应棋谱（对局中与读谱中共用同一块面板）
   *   · 单点渲染：只有这里写 `#recBookHit`，避免"两处各写一份"再次脱钩。
   *   · 对局中 → 用真实对局历史；读谱中 → 用"棋谱前 ply 手 + 推演手"（record 通过
   *     onView 把 hist 带过来）。
   * ============================================================ */
  function syncBookHit() {
    if (!window.G.booklib || !window.G.booklib.renderHit) return;
    let hist = null;
    if (replay) {
      if (!replay.hist) return;
      hist = replay.hist;
    } else {
      if (!moves) return;
      hist = moves.map(function (m) { return C.idxOf(m.x, m.y); });
    }
    try {
      window.G.booklib.renderHit(hist, openOpening, openGame, bookLib);
    } catch (e) { /* 标注失败不影响对局 */ }
  }

  /** 点某条具体棋谱 → 进入**读谱模式**（需求4：只有这一步才切模式）。
   *  ★ 库里的元信息（棋手 / 结果 / 开局）要一起交给棋谱面板：只传着法文本会让信息栏
   *    显示"结果 未终局"、棋手整块缺失（探索性测试实测）。两条入口（列表 / 开局库关联）
   *    共用本函数，避免"两处各写一份"再次跑偏。 */
  function openGame(e) {
    if (!recPanel || !e) return null;
    if (menu) menu.openFor('record');
    const r = recPanel.load(e.text, 'renju', {
      result: e.result, black: e.black, white: e.white, opening: e.opening,
      // ★ 棋谱库是 RenjuNet 的 **RIF 对局** ⇒ 读它时按 Renju 判（标签与判决才对得上）。
      //   已实测：927 局在 freestyle / renju 两种规则下 errors 与逐手 verdict **0 差异**，
      //   所以这只修正"格式标注"，不改变任何显示结论。
      ruleMode: 'renju',
    });
    if (r) recPanel.seek(r.moves.length);
    syncRecNote();
    return r;
  }
  /** 退出读谱模式，回到原来的对局（推演丢弃，真实对局不动）。 */
  function exitReadMode() {
    if (!recPanel || !recPanel.active) return;
    recPanel.leave();
    leaveReplayCleanup();
    draw(); updateStatus();
    syncRecNote();
    // ★ R10：对局中「推演」进入前会 cancelAI ⇒ 退出时若轮到 AI，必须把这一手补上
    //   （否则用户从推演回来后 AI 永远不走，就是"AI 不出招"的又一入口）。
    if (!over && !winner && isAITurn()) maybeAI();
  }

  /** 启动时把持久化的值写回控件。返回 {ruleChanged} 供调用方决定是否重开。 */
  function applyPrefs() {
    if (!P) return;
    const st = P.all();
    function put(el, key, dflt) {
      const v = st[key];
      if (!el || v === undefined) {
        if (el && dflt !== undefined) el.value = dflt;
        return;
      }
      // 只在"该选项确实存在"时写回，避免把过期枚举值写进 select（会变成空选）
      const ok = Array.prototype.some.call(el.options || [], function (op) { return op.value == v; });
      el.value = ok ? v : (dflt !== undefined ? dflt : el.value);
    }
    put(selRule, 'rule', 'freestyle');
    put(selMode, 'mode', 'pve');
    put(selSide, 'side', 'black');
    put(selLevel, 'level', 'hard');
    put(selTime, 'time', '0');
    put(selHintLevel, 'hintLevel', 'hard');           // ★ 需求1：提示难度
    // ★ 触屏落子：偏好值（auto/on/off）；实际启用与否由 applyTouchMode 按设备解析
    if (selTouch) {
      const tv = st.touch;
      touchPref = (tv === 'on' || tv === 'off') ? tv : 'auto';
      selTouch.value = touchPref;
    }
    if (chkNo) chkNo.checked = st.showNo === undefined ? true : !!st.showNo;
    if (chkForbid) chkForbid.checked = st.forbid === undefined ? true : !!st.forbid;
    if ($('chkHintScore')) $('chkHintScore').checked = !!st.hintScore;
    /* ★ 需求3：三个长期开关的持久化状态（先只读回状态与高亮，请求在启动后由
     *   syncObservers 统一发出 —— 那时面板与棋盘都已就绪）。 */
    obs.autoHint = !!st.autoHint;
    obs.autoJudge = !!st.autoJudge;
    setToggleUI(btnHint, obs.autoHint);
    setToggleUI(btnJudge, obs.autoJudge);
    pendingHeat = !!st.heat;
    applyModeEnable();
    // 棋谱面板的选项（存在才写回）
    const rc = st.rec || {};
    if ($('recFmt') && rc.fmt) $('recFmt').value = rc.fmt;
    if ($('recExpFmt') && rc.exp) $('recExpFmt').value = rc.exp;
    if ($('recSpeed') && rc.speed) $('recSpeed').value = rc.speed;
    if ($('recAutoTime')) $('recAutoTime').checked = !!rc.autoTime;
    if ($('chkArrow')) $('chkArrow').checked = !!rc.arrow;
  }

  /** 收集当前控件值 → 写盘。任何一次改动都调它，保证"改了就有" */
  function savePrefs() {
    if (!P) return;
    P.patch({
      rule: selRule.value, mode: selMode.value, side: selSide.value,
      level: selLevel.value, time: selTime.value,
      hintLevel: selHintLevel ? selHintLevel.value : 'hard',
      showNo: !!(chkNo && chkNo.checked), forbid: !!(chkForbid && chkForbid.checked),
      hintScore: !!($('chkHintScore') && $('chkHintScore').checked),
      touch: touchPref,                                        // ★ 触屏落子（auto/on/off）
      // ★ 需求3：长期开关状态
      autoHint: !!obs.autoHint, autoJudge: !!obs.autoJudge,
      heat: !!(panel && panel.heatOn),
      rec: {
        fmt: $('recFmt') ? $('recFmt').value : 'auto',
        exp: $('recExpFmt') ? $('recExpFmt').value : 'renju',
        speed: $('recSpeed') ? $('recSpeed').value : '1',
        autoTime: !!($('recAutoTime') && $('recAutoTime').checked),
        arrow: !!($('chkArrow') && $('chkArrow').checked),
      },
    });
  }


  const PAT = window.G.patterns;
  function rule() { return selRule.value === 'renju' ? 'renju' : 'freestyle'; }
  function overlineMode() { return 'rif'; }                   // 官方 RIF：五长连判胜（§26.2）
  function forbidModeOf(p) { return PAT.forbidMode(p, rule(), overlineMode()); }
  function difficulty() { return selLevel.value; }

  /* 禁手点集合（§29.3 叠加层红叉）：只在 Renju + 轮到黑时标出。
   * 只扫描已有棋子邻域（radius 2），避免全盘 225 点判定。 */
  function computeForbidden() {
    forbidSet = null;
    if (rule() !== 'renju' || !chkForbid.checked) return;
    if (pos.stm !== C.BLACK || over || winner) return;
    const mode = forbidModeOf(C.BLACK);
    if (!mode) return;
    const b = pos.board, set = new Set();
    let any = false;
    for (let i = 0; i < C.NN; i++) {
      if (b[i] !== C.EMPTY) continue;
      any = true;                                    // 邻域筛选：附近有子才判
      const x = i % C.N, y = (i / C.N) | 0;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= C.N || ny >= C.N) continue;
        if (b[C.idxOf(nx, ny)] !== C.EMPTY) { near = true; break; }
      }
      if (!near) continue;
      if (PAT.forbiddenAt(b, i, mode)) set.add(i);
    }
    if (any) forbidSet = set;
  }

  function updateRuleHint() {
    ruleHint.innerHTML = rule() === 'renju'
      ? 'Renju：黑棋<b>长连 / 四四 / 三三</b>为禁手（判负）；<b>恰好五连</b>优先判胜。' +
        '白棋无禁手。禁手点标红叉且不可落子。'
      : '无禁手：任一方 ≥5 连即胜（长连算胜）。';
  }
  function timeCfg() {
    const t = parseInt(selTime.value, 10) || 0;
    return t > 0 ? { hard: t } : null;
  }
  function readHumanSide() {
    return selMode.value === 'pve' ? (selSide.value === 'black' ? C.BLACK : C.WHITE) : 0;
  }
  const aiSide = function () { return humanSide ? C.opp(humanSide) : 0; };
  const isAITurn = function () { return humanSide !== 0 && pos.stm === C.opp(humanSide); };
  const isHumanTurn = function () { return humanSide === 0 || pos.stm === humanSide; };

  /* ---------- 局面与绘制 ---------- */
  function reset(keepPanel) {
    AI.abort();
    gen++;                                        // 作废所有在飞的请求回调
    thinking = false; lastAI = null;
    pos = C.createPosition();
    winner = 0; over = false; winLine = null; lastMove = null; hover = null;
    forbiddenLose = null; forbidSet = null;
    orderArr = new Int16Array(C.NN);
    moves = [];
    humanSide = readHumanSide();
    plyTime = 0; lastHumanTs = 0;
    replay = null;
    if (!keepPanel) { clearOverlay(); if (recPanel) recPanel.leave(); }
    if (panel) { panel.clearHints(); }
    forbidCache = null;
    clearTouch();                                     // 新局 ⇒ 作废触屏待确认点
    updateRuleHint();
    draw(); updateStatus();
    maybeAI();                                    // 若玩家执白，AI（黑）先手
  }

  function clearOverlay() {
    overlay = { candidates: null, heat: null, forbidden: null, preview: null };
  }

  function draw() {
    /* ★ 启动早期守卫：renderer 在模块顶层创建（第 60 行），它内部注册的 ResizeObserver
     *   会**立刻投递一次初次回调**，那时 `pos` 还没建（pos 在 init 里才 createPosition）。
     *   没有这一行 ⇒ 每次加载都抛一次未捕获 `TypeError: Cannot read property 'board' of undefined`
     *   （异常发生在 observer 回调里 ⇒ **不阻断启动**、界面照样能画，所以 300 项单测 + 339 项
     *   浏览器断言全绿都没发现；是发布后对线上做"零未捕获异常"黑盒断言才暴露的）。
     *   而且 `_resize()` 已先执行过（可能重建位图清空画布）⇒ 此处抛错还会留下"白板"窗口。
     *   与 `redraw()` 的守卫保持同一写法。 */
    if (!pos) return;                             // 启动早期（pos 未建）不画
    if (replay) return;                           // ★ 回放模式：渲染权交给 recordPanel.onView
    computeForbidden();
    renderer.draw({
      board: pos.board, lastMove, winLine, hover,
      showNo: chkNo.checked, order: orderArr,
      forbidden: forbidSet,                          // §29.3：黑方禁手点标红叉
      hoverForbid: !!(hover && forbidSet && forbidSet.has(C.idxOf(hover.x, hover.y))),
      candidates: overlay.candidates,                // M8 §10 候选点圈
      heat: overlay.heat,                            // M8 §11 热力图
      preview: overlay.preview,
      ghost: touchGhost(),                           // ★ 触屏落子：幽灵子预览（待确认/按住中）
      anim: animOn() ? { t: anim.t, dropUser: anim.dropUser, dropIdx: anim.dropIdx,
                         dropMs: DROP_MS, pulse: true, blink: true } : null,   // M10 §14
    });
  }

  // 回放视图回调（§9.4：复用同一渲染通道）
  let lastReplayPly = '';        // 读谱局面身份键（"ply+推演手数"）
  /* ★ 读谱/推演的**绘制**单独成函数：触屏下"按住拖动"要高频重绘（幽灵子跟着手指走），
   *   若每次都走 onReplayView，就会连带重算局面身份、状态栏、开局库面板（后者要重建列表，
   *   在 pointermove 里跑会明显卡顿）。⇒ 绘制与"局面变化后的簿记"分开。 */
  function replayRender() {
    const v = replay;
    if (!v) return;
    computeForbiddenReplay(v);
    const canPoint = readMode() && !v.over;          // 读谱模式：允许在棋盘上落子推演
    renderer.draw({
      board: v.board, lastMove: v.lastMove, winLine: v.winLine,
      hover: canPoint ? hover : null,
      showNo: true, order: v.order,                  // §29.5 回放默认开启步数徽标
      forbidden: forbidSet, hoverForbid: false,
      // 候选点：优先用「提示」为**当前回放局面**算出的结果，其次用「引擎首选」箭头
      candidates: v.over ? null
        : ((overlay.candidates && overlay.candidates.length) ? overlay.candidates : (v.arrows || null)),
      heat: overlay.heat || null,
      preview: null,
      ghost: canPoint ? touchGhost() : null,
      anim: null,                                    // 回放静态（避免逐帧重绘干扰读谱）
    });
  }
  function onReplayView(v) {
    replay = v;
    // ★ 回放步数一变 ⇒ 上一局面算出的提示/热力结果**立刻作废**。
    //   否则会把"第 3 手的候选点"画到"第 8 手"的棋盘上（图与数不符）。
    //   推演也会改变局面 ⇒ 用 (ply + 推演手数) 作为身份键。
    const idKey = v.ply + '+' + (v.extra | 0);
    if (idKey !== lastReplayPly) {
      lastReplayPly = idKey;
      overlay.candidates = null;
      overlay.heat = null;
      clearTouch();                                  // 局面变了 ⇒ 触屏待确认点作废
      if (panel) panel.clearHints();
      obsKey = '';                                   // 长期开关按新局面重算
    }
    replayRender();
    updateReplayStatus(v);
    syncRecNote();                                   // ★ 分组头摘要跟着回放进度走
    syncBookHit();                                   // ★ 开局库匹配 + 本库对应棋谱（读谱中同步更新）
  }
  /** 是否处于「读谱模式」（= 正在读某条具体棋谱）。对局中为 false。 */
  function readMode() { return !!(recPanel && recPanel.active); }
  let forbidCache = null;                            // 回放/对局共用的禁手点缓存（键：规则+步数）
  function computeForbiddenReplay(v) {
    forbidSet = null;
    if (rule() !== 'renju' || !chkForbid.checked || v.over) return;
    // 轮到谁：要把**推演手数**算进去（推演会改变手番）
    const who = (((v.ply + (v.extra | 0)) % 2 === 0)) ? C.BLACK : C.WHITE;
    if (who !== C.BLACK) return;
    const key = v.ply + '+' + (v.extra | 0);
    if (forbidCache && forbidCache.key === key && forbidCache.rule === rule()) { forbidSet = forbidCache.set; return; }
    const mode = forbidModeOf(C.BLACK);
    if (!mode) return;
    const b = v.board, set = new Set();
    let any = false;
    for (let i = 0; i < C.NN; i++) {
      if (b[i] !== C.EMPTY) continue;
      any = true;
      const x = i % C.N, y = (i / C.N) | 0;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= C.N || ny >= C.N) continue;
        if (b[C.idxOf(nx, ny)] !== C.EMPTY) { near = true; break; }
      }
      if (!near) continue;
      if (PAT.forbiddenAt(b, i, mode)) set.add(i);
    }
    forbidSet = any ? set : null;
    forbidCache = { key: key, rule: rule(), set: forbidSet };
  }

  function updateReplayStatus(v) {
    const cur = v.current;
    const who = cur ? (cur.player === C.BLACK ? '黑' : '白') : '';
    let s = '读谱 · 第 ' + v.ply + ' / ' + v.total + ' 手';
    if (cur) s += '（' + who + ' ' + window.G.record.coordText(cur.x, cur.y) + '）';
    if (v.over && v.winner) s += ' · ' + (v.winner === C.BLACK ? '黑胜' : '白胜');
    statusEl.innerHTML = s;
    metaEl.textContent = cur && cur.timeMs ? ('本手用时 ' + RP.fmtMs(cur.timeMs)) : '';
    syncLocks();                 // ★ 回放中也要刷新锁定说明（回放期语义类选项同样不可改）
    syncObservers();             // ★ 读谱中翻手 / 推演 ⇒ 长期开关按新局面自动刷新
  }

  function sideName(p) { return p === C.BLACK ? '黑棋' : '白棋'; }
  function dot(p) { return '<span class="dot" style="background:' + (p === C.BLACK ? '#111' : '#fff') + '"></span>'; }

  function updateStatus() {
    syncLocks();                 // ★ 每次状态更新后同步"行棋中锁定"（终局/重开会自动解锁）
    syncObservers();             // ★ 长期开关（提示/形势/热力）：局面变了就自动刷新
    syncBookHit();               // ★ 开局库匹配 + 本库对应棋谱（对局中也显示）
    if (winner) {
      const tag = (humanSide && winner === humanSide) ? '你胜'
        : (humanSide ? 'AI胜' : '');
      if (forbiddenLose) {
        statusEl.innerHTML = dot(winner) + sideName(winner) + ' 胜利 · ' +
          sideName(forbiddenLose.player) + ' 落于禁手 (' + forbiddenLose.x + ',' + forbiddenLose.y + ')' +
          (tag ? ' · ' + tag : '');
      } else {
        statusEl.innerHTML = dot(winner) + sideName(winner) + ' 胜利' + (tag ? ' · ' + tag : '');
      }
      metaEl.textContent = '';
      announce(sideName(winner) + '胜利' + (forbiddenLose ? '，对方落于禁手' : '') + (tag ? '，' + tag : ''));
      return;
    }
    if (pos.stones >= C.NN) { statusEl.textContent = '平局'; metaEl.textContent = ''; announce('平局'); return; }
    const mine = isHumanTurn();
    const who = (humanSide && !mine) ? ('AI（' + sideName(pos.stm) + '）')
      : (humanSide && mine ? ('你（' + sideName(pos.stm) + '）') : sideName(pos.stm));
    let tail = '';
    if (thinking) tail = ' <span class="think">思考中…</span>';
    else if (humanSide && mine) tail = ' · 请你落子';
    else if (humanSide) tail = '';
    statusEl.innerHTML = dot(pos.stm) + '轮到 ' + who + '（第 ' + (moves.length + 1) + ' 手）' + tail;
    const inf = AI.info();
    metaEl.textContent = lastAI
      ? ('上一手 AI：' + lastAI.ms + 'ms · 深度 ' + lastAI.depth + ' · ' + lastAI.nodes + ' 节点' +
         (lastAI.fallback ? ' · 降级' : '') + ' · 后端 ' + inf.backend)
      : ('后端：' + inf.backend + (inf.backend === 'main' ? '（' + inf.reason + '）' : ''));
    // ★ M10 §29.4：aria-live 播报轮次（胜负分支在上面已 return，另行播报）
    announce('轮到 ' + sideName(pos.stm) + '，第 ' + (moves.length + 1) + ' 手' + (thinking ? '，AI 思考中' : ''));
  }

  /* ---------- 落子 ---------- */
  function place(x, y, byAI, timeMs) {
    if (over || winner) return false;
    const i = C.idxOf(x, y);
    if (pos.board[i] !== C.EMPTY) return false;
    const player = pos.stm;
    // ★ Renju：玩家（黑）落禁手点直接判负——界面**拦截**以避免误触即负（AI 侧仍是"惩罚而非禁止"）
    if (!byAI && player === C.BLACK && forbidSet && forbidSet.has(i)) {
      flashForbid();
      return false;
    }
    C.makeMove(pos, x, y, player);
    const no = moves.length + 1;
    orderArr[i] = no;
    // ★ M8 §9.2：记录每手用时（AI 手用引擎返回值；人类手用思考间隔）
    let t = 0;
    if (Number.isFinite(timeMs) && timeMs >= 0) t = timeMs;
    else if (byAI) t = 0;
    else { const now = Date.now(); t = lastHumanTs ? Math.max(0, now - lastHumanTs) : 0; lastHumanTs = now; }
    if (!byAI) lastHumanTs = Date.now();
    moves.push({ x: x, y: y, player: player, no: no, timeMs: t });
    lastMove = { x: x, y: y };
    // ★ 规则感知裁决（§7.1 / §26）：'win' 成五 | 'lose' 禁手负 | 'none'
    const v = RULES.judge(pos.board, x, y, player, rule(), overlineMode());
    if (v === 'win') {
      winner = player; over = true;
      winLine = RULES.winningLine(pos.board, x, y, player, rule());
    } else if (v === 'lose') {
      winner = C.opp(player); over = true;            // 禁手 → 判对方胜
      winLine = null;
      forbiddenLose = { x: x, y: y, player: player };
    }
    if (panel) {
      panel.clearHints();                              // 局面已变 → 旧提示作废
      panel.applyFromMove(byAI ? lastScore : null, player);   // §11.2 AI 思考后顺带更新形势
    }
    overlay.candidates = null; overlay.heat = null;   // 走子后叠加层失效
    clearTouch(true);                                 // 走子 ⇒ 触屏待确认点作废（下面的 draw 会重绘）
    bumpDrop(i);                                       // ★ M10 §14：新子落子淡入
    draw(); updateStatus();
    if (!over && !byAI) maybeAI();
    return true;
  }

  let forbiddenLose = null;
  let flashTimer = 0;
  function flashForbid() {
    statusEl.innerHTML = '<span class="err">该点是黑棋禁手，不可落子</span>';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { updateStatus(); }, 1800);
  }

  /* ---------- AI 行棋 ---------- */
  let lastScore = null;                                // 最近一次 AI 搜索分值（供形势条复用 §11.2）
  function maybeAI() {
    if (over || winner) return;
    if (!isAITurn()) return;                      // 只在该 AI 走时触发
    if (thinking) return;
    const my = ++gen;                             // 本手令牌
    thinking = true; updateStatus();
    const board = pos.board.slice(), stm = pos.stm;
    const t0 = Date.now();
    AI.askMove(board, stm, { rule: rule(), difficulty: difficulty(), time: timeCfg(),
                             hist: pos.hist.slice() })   // §12.4 开局库需真实历史（否则永不命中）
      .then(function (res) {
        if (my !== gen) return;                   // ★ 已被悔棋/重开/新一手取代 → 丢弃
        thinking = false;
        if (!res || !res.move) { updateStatus(); return; }
        lastAI = {
          ms: res.timeMs, depth: res.depth, nodes: res.nodes,
          fallback: (res.fallbackLevel | 0) !== 0, score: res.score,
        };
        lastScore = res.score;
        const ok = place(res.move.x, res.move.y, true, res.timeMs);
        if (!ok) { updateStatus(); }              // 理论上不会发生（AI 不会下已占点）
      })
      .catch(function (e) {
        if (my !== gen) return;                   // ★ 过期请求的错误不得改状态
        thinking = false;
        if (String(e && e.message) === 'E_ABORTED') { updateStatus(); return; }
        statusEl.innerHTML = '<span class="err">AI 出错：' + String(e && e.message || e) + '</span>';
      });
  }

  /* ---------- 悔棋 ----------
   * PvE：通常退 2 步（AI + 我）；若最后一手是我下的（AI 尚未应），退 1 步。
   * PvP：退 1 步。
   */
  function undo() {
    // 读谱中「悔棋」按钮已被锁定（见 syncLocks）；这里兜住调试钩子/将来新增的调用点：
    // 必须先完整退出读谱（含叠加层与幂等键复位），只置 replay=null 会留下"半读谱"状态。
    if (replay) { if (recPanel) recPanel.leave(); leaveReplayCleanup(); }
    if (!moves.length) return;
    AI.abort();                                   // 先中断，再改状态（§34.5）
    gen++;                                        // 作废所有在飞的请求回调
    thinking = false;
    const ai = aiSide();
    const backToHuman = ai && moves[moves.length - 1].player === ai;
    const steps = ai ? (backToHuman ? 2 : 1) : 1;
    for (let k = 0; k < steps && moves.length; k++) {
      const m = moves.pop();
      C.unmakeMove(pos);
      orderArr[C.idxOf(m.x, m.y)] = 0;
    }
    winner = 0; over = false; winLine = null; lastAI = null; lastScore = null;
    const prev = moves[moves.length - 1];
    lastMove = prev ? { x: prev.x, y: prev.y } : null;
    if (panel) panel.clearHints();
    clearOverlay();
    clearTouch();                                     // 悔棋 ⇒ 作废触屏待确认点
    draw(); updateStatus();
    maybeAI();                                    // 若退到 AI 该走，补一手
  }

  /* ---------- 事件 ---------- */
  function eventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = renderer.size / (rect.width || 1);
    const sy = renderer.size / (rect.height || 1);
    return { px: (e.clientX - rect.left) * sx, py: (e.clientY - rect.top) * sy };
  }
  // 对局中不允许"指向/落子"：悬停高亮与"第 k 手"提示读的是**后台对局**的数据，
  // 画面上却是棋谱局面 ⇒ 直接让路。读谱模式另走一条路径（见 mousemove / click）。
  function canHumanPoint() { return !replay && !thinking && !over && !winner && isHumanTurn(); }

  canvas.addEventListener('mousemove', function (e) {
    if (touchOn) return;              // ★ 触屏模式：预览由 pointer* 接管（见"触屏落子"一节）
    // 读谱模式：只做"悬停高亮"（为推演指位），不做"第 k 手"提示（那要读对局数据）
    if (replay) {
      if (!readMode() || replay.over) return;
      const q = eventPos(e);
      const h = renderer.pxToPos(q.px, q.py);
      const ch = (!!h !== !!hover) || (h && hover && (h.x !== hover.x || h.y !== hover.y));
      hover = h;
      if (ch) onReplayView(replay);
      return;
    }
    if (!canHumanPoint()) { if (hover) { hover = null; draw(); } return; }
    const p = eventPos(e);
    const hit = renderer.pxToPos(p.px, p.py);
    const changed = (!!hit !== !!hover) || (hit && hover && (hit.x !== hover.x || hit.y !== hover.y));
    hover = hit;
    if (changed) draw();
    // §29.5 hover 某子显示"第 k 手 · 用时 t"
    if (panel && hit && pos.board[C.idxOf(hit.x, hit.y)] !== C.EMPTY) {
      const k = orderArr[C.idxOf(hit.x, hit.y)];
      const m = moves[k - 1];
      panel.setLastMove(m ? ('第 <b>' + m.no + '</b> 手 ' + (m.player === C.BLACK ? '黑' : '白') +
        ' · ' + (m.timeMs ? RP.fmtMs(m.timeMs) : '未记录用时')) : '');
    } else if (panel) panel.setLastMove('');
  });
  canvas.addEventListener('mouseleave', function () {
    if (touchOn) return;              // 触屏模式不用鼠标悬停（否则触摸后的合成鼠标事件会留下脏 hover）
    if (hover) { hover = null; draw(); } if (panel) panel.setLastMove('');
  });
  canvas.addEventListener('click', function (e) {
    /* ★ 触屏模式（小屏）：落子**完全**交给 pointerdown/move/up
     *   —— 轻点 = 待确认、按住拖动 = 松手即落。
     *   这里必须让路：触摸在 pointerup 之后浏览器还会补一个 click，
     *   不让路就会"一次点选落两颗子"（确认机制被架空）。 */
    if (touchOn) return;
    /* ★ 需求4：读谱模式下允许在棋盘上**人工续下（推演）** —— 推演只存在于读谱视图上，
     *   不污染棋谱、也不影响真实对局；「恢复下棋」退出即丢弃，「以推演续弈」才落到对局。
     *   ★ 落子判定一律走 commitAt()：鼠标点击与触屏确认/拖动是**同一条路径**
     *     ⇒ 禁手拦截、读谱推演、AI 触发三处语义天然一致（不会出现"触屏少了某道校验"）。 */
    const p = eventPos(e);
    const hit = renderer.pxToPos(p.px, p.py);
    if (hit) commitAt(hit.x, hit.y);
  });

  /* ============================================================
   * ★ 触屏落子（移动端小屏模式）——"确认后落子 **或** 拖动释放落子"。
   *   为什么需要：手指的落点精度远低于鼠标（15 格棋盘在手机上 1 格只有 ~24px），
   *   五子棋又是**不可悔**的（悔棋要重排整局），一次点偏就是一次真实损失。
   *   所以小屏上把"一次点击"拆成两步：先选点（可改、可取消），再确认；而"拖动"本身
   *   已经是一次明确表达，就不再追问第二遍。
   *
   *   判定逻辑（阈值、同点、划出盘外…）全部在 `ui/touch.js` 的纯函数里（有单测穷举边界），
   *   本段只做"DOM 事件 → 状态 → 重绘"的编排。
   *
   *   ⚠ 三条必须守住的约束（以后改这块别再踩）：
   *   ① `click` 与 `mousemove` 必须让路（触摸会补发合成 click / 鼠标事件）；
   *   ② 待确认点必须在**局面变化时作废**（落子 / 悔棋 / 重开 / 读谱翻手 / 关掉触屏）
   *      —— 否则确认条会指向一个已经不存在的局面；
   *   ③ 真正落子只走 `commitAt()`（与鼠标点击同一条路径）。
   * ============================================================ */
  const TOUCH_SLOP = (TOUCH && TOUCH.SLOP) || 0.75;
  function touchEnv() {
    return { coarse: !!(mqCoarse && mqCoarse.matches), width: window.innerWidth || 0,
             maxWidth: (TOUCH && TOUCH.MAX_W) || 600 };
  }
  function touchDimText(on) {
    const auto = touchPref === 'auto';
    const maxw = (TOUCH && TOUCH.MAX_W) || 600;
    if (on) return (auto ? '当前：已按设备自动启用（' : '当前：已手动开启（') +
      '轻点选点后确认，按住拖动到目标松手直接落子）。';
    return auto ? ('当前：未启用（非触屏且视口 >' + maxw + 'px）—— 鼠标点击即落子。')
                : '当前：已关闭 —— 点击即落子。';
  }
  /** 把"是否启用触屏落子"解析出来并生效（偏好变化 / 视口变化 / 指针类型变化都要调）。
   *  ⚠ resize 会高频触发：只在"结论或说明文案真的变了"时才写 DOM（否则拖窗口时会持续重排）。 */
  function applyTouchMode() {
    const on = !!(TOUCH && TOUCH.resolve(touchPref, touchEnv()));
    const txt = touchDimText(on);
    const changed = (on !== touchOn) || !!touchDim && touchDim.textContent !== txt;
    if (!changed) return;
    touchOn = on;
    document.body.classList.toggle('touch', on);
    if (!on) clearTouch();              // 关掉时不要留下"待确认"浮层（否则它会永久挂在屏幕上）
    if (touchDim) touchDim.textContent = txt;
    syncDisplayNote();                  // 「显示与叠加」分组头摘要要跟着显示"触屏"
  }
  /** 该点能否作为**预选**落点（真正的合法性仍由 place()/推演校验把关）。 */
  function validTarget(x, y) {
    const b = (replay && replay.board) ? replay.board : (pos && pos.board);
    if (!b || b[C.idxOf(x, y)] !== C.EMPTY) return false;
    if (replay) return true;                                  // 推演：棋谱面板自己校验（含终局）
    if (pos.stm === C.BLACK && forbidSet && forbidSet.has(C.idxOf(x, y))) return false;
    return true;
  }
  /** 现在这一手若落子，是什么颜色（触屏幽灵子要画对颜色）。 */
  function ghostColor() {
    if (replay) return ((((replay.ply | 0) + (replay.extra | 0)) % 2) === 0) ? C.BLACK : C.WHITE;
    return pos ? pos.stm : C.BLACK;
  }
  function canTouchPlace() {
    if (replay) return readMode() && !replay.over;
    return canHumanPoint();
  }
  /** ★ 落子的**唯一入口**：鼠标点击、触屏确认、触屏拖动释放都走这里。 */
  function commitAt(x, y) {
    if (replay) {
      if (!readMode() || replay.over) return false;
      return !!(recPanel && recPanel.pushExtra && recPanel.pushExtra(x, y));
    }
    if (!canHumanPoint()) return false;                       // waitingAI / 非你回合：禁止落子
    return place(x, y, false) === true;
  }
  function redraw() {
    if (!pos) return;                                         // 启动早期（pos 未建）不画
    syncTouchBar();                                           // 确认条与画面同一真相源（见 syncTouchBar）
    if (replay) replayRender(); else draw();
  }
  /* 幽灵子预览的**优先级**（★ 这一处曾写反，靠截图才发现）：
   *   手指按住时 **只** 画手指下这一颗 —— 否则待确认点会一直占着画面，
   *   拖动预览被完全遮住 ⇒ 用户看到的是"拖动毫无反应"（而 state 里 ghost 一直是对的，
   *   所有状态断言都全绿）。教训：状态对 ≠ 画对，绘制优先级必须有**像素级**断言或截图。 */
  function touchGhost() {
    if (!touchOn) return null;
    if (ptr) return ghost ? { x: ghost.x, y: ghost.y, v: ghostColor(), strong: false } : null;
    if (pending) return { x: pending.x, y: pending.y, v: ghostColor(), strong: true };
    return null;
  }
  /** 确认条：只在"有**已松手**的待确认点"时出现；手势进行中先收起（避免条指向别处造成错位感）。 */
  function syncTouchBar() {
    const show = !!(touchOn && pending && !ptr);
    if (touchBar && touchBar.hidden === show) touchBar.hidden = !show;   // 只在真的变化时写 DOM
    if (show && touchText) {
      const t = '落于 ' + renderer.coordAt(pending.x, pending.y) +
        '（' + (ghostColor() === C.BLACK ? '黑' : '白') + '）';
      if (touchText.textContent !== t) touchText.textContent = t;
    }
  }
  /** 进入待确认态（轻点之后）。 */
  function setPending(v) {
    if (!v) { clearTouch(); return; }
    const same = !!(pending && pending.x === v.x && pending.y === v.y);
    pending = { x: v.x, y: v.y };
    if (!same) {
      syncTouchBar();
      announceNow('已选 ' + renderer.coordAt(v.x, v.y) + '，点「确认落子」或再点该点落子');
    }
    redraw();
  }
  /** 静默作废待确认态（局面变化时用；用户主动取消走 cancelPending）。 */
  function clearTouch(noRedraw) {
    const had = !!pending || !!ghost || !!ptr;
    ptr = null; ghost = null; pending = null;
    if (had) { syncTouchBar(); if (!noRedraw) redraw(); }
  }
  function confirmPending() {
    if (!pending) return false;
    const p = pending;
    clearTouch();                                             // 先清掉（落子后 updateStatus 会重绘）
    const ok = commitAt(p.x, p.y);
    if (ok) announceNow('落子 ' + renderer.coordAt(p.x, p.y));
    else redraw();                                            // 已占点/禁手/非你回合 ⇒ 保持界面一致
    return ok;
  }
  function cancelPending() {
    if (!pending) return false;
    clearTouch();
    announceNow('已取消待落点');
    return true;
  }
  /** 手指按住时的预览（只重绘，不产生任何状态变更）。 */
  function showGhost(hit) {
    const g = (hit && validTarget(hit.x, hit.y)) ? hit : null;
    const same = (!g && !ghost) || !!(g && ghost && g.x === ghost.x && g.y === ghost.y);
    if (same) return;
    ghost = g;
    redraw();
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (!touchOn) return;
    if (e.button !== undefined && e.button !== 0) return;      // 只认主键 / 触摸（右键、中键忽略）
    if (ptr && e.pointerId !== ptr.id) return;                 // 多指：只跟第一根手指
    if (!canTouchPlace()) return;
    const p = eventPos(e);
    const hit = renderer.pxToPos(p.px, p.py);
    ptr = { id: e.pointerId, p0: p, from: hit, dist: 0, dragging: false, blocked: '' };
    syncTouchBar();             // 手势开始 ⇒ 先收起上次的确认条（此时 ptr 已非空）
    /* 抓住指针：手指滑出棋盘外再松手，pointerup 仍会送到 canvas
     * （否则"拖到盘外"会变成"什么都没发生"且 ptr 残留）。合成事件下 pointerId 可能
     * 不在活动指针表里 ⇒ 抛 NotFoundError，吞掉即可（与真实触摸无关）。 */
    try { if (canvas.setPointerCapture && e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId); } catch (err) {}
    if (hit && !validTarget(hit.x, hit.y)) {
      const i = C.idxOf(hit.x, hit.y);
      /* ★ 区分"已占点"与"禁手点"：判据取**当前视图**的棋盘
       *   （读谱时是棋谱局面，不是背后的对局；用错棋盘会把已有棋子误报成"禁手"）。 */
      const vb = (replay && replay.board) ? replay.board : (pos && pos.board);
      const occupied = !!vb && vb[i] !== C.EMPTY;
      ptr.blocked = occupied ? 'occupied' : 'forbidden';
      if (occupied) {
        // 手机上没有"悬停"，顺手用这里替代：点已有棋子 → 显示"第 k 手 · 用时"
        // （读谱局面的手数不属于对局，故只在非读谱时显示）
        if (!replay) {
          const k = orderArr[i], m = moves[k - 1];
          if (panel) panel.setLastMove(m ? ('第 <b>' + m.no + '</b> 手 ' + (m.player === C.BLACK ? '黑' : '白') +
            ' · ' + (m.timeMs ? RP.fmtMs(m.timeMs) : '未记录用时')) : '');
        }
      } else {
        hover = hit;                    // 让 draw() 画出禁手警示圈（红圈）
      }
      redraw();
      return;
    }
    showGhost(hit);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!touchOn || !ptr || e.pointerId !== ptr.id) return;
    const p = eventPos(e);
    ptr.dist = Math.hypot(p.px - ptr.p0.px, p.py - ptr.p0.py);
    const hit = renderer.pxToPos(p.px, p.py);
    // ★ 拖动标记是**粘性**的：一旦拖出去过，即使拖回原点松手也按"拖动释放"处理
    if (!ptr.dragging && TOUCH &&
        TOUCH.isDrag({ from: ptr.from, to: hit, dist: ptr.dist, cell: renderer.cell, slop: TOUCH_SLOP })) {
      ptr.dragging = true;
    }
    if (ptr.blocked) return;
    showGhost(hit);
  });
  function endPointer(e, cancelled) {
    if (!touchOn || !ptr) return;
    const st = ptr;
    if (e.pointerId !== undefined && e.pointerId !== st.id) return;
    ptr = null;
    try { if (canvas.releasePointerCapture && e.pointerId !== undefined) canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    ghost = null;
    const p = eventPos(e);
    const to = cancelled ? null : renderer.pxToPos(p.px, p.py);
    const dist = Math.hypot(p.px - st.p0.px, p.py - st.p0.py);
    const act = TOUCH ? TOUCH.decide({ from: st.from, to: to, dist: dist, cell: renderer.cell,
                                       slop: TOUCH_SLOP, dragging: st.dragging }) : 'cancel';
    if (st.blocked === 'forbidden') {
      if (hover) { hover = null; redraw(); }
      flashForbid();                                             // 与鼠标点禁手点同一条提示
      if (pending) clearTouch();
      return;
    }
    if (st.blocked === 'occupied') {
      announceNow('该点已有棋子');
      if (pending) clearTouch(); else redraw();
      return;
    }
    if (act === 'place' && to && validTarget(to.x, to.y)) {       // ★ 拖动释放：直接落子
      if (pending) clearTouch(true);
      commitAt(to.x, to.y);
      redraw();
      return;
    }
    if (act === 'confirm' && to && validTarget(to.x, to.y)) {
      // 再点同一个待确认点 = 直接确认（像"双击"一样顺手，不用去够底部按钮）
      if (pending && pending.x === to.x && pending.y === to.y) { confirmPending(); return; }
      setPending(to);
      return;
    }
    // 松手处不在交点上（格子间隙 / 盘外）⇒ 视为取消（保留原待确认点则更绕，直接清掉）
    if (pending) clearTouch(); else redraw();
  }
  canvas.addEventListener('pointerup', function (e) { endPointer(e, false); });
  canvas.addEventListener('pointercancel', function (e) { endPointer(e, true); });
  canvas.addEventListener('contextmenu', function (e) { if (touchOn) e.preventDefault(); });   // 长按不弹菜单
  // 偏好 / 视口 / 指针类型任一变化 ⇒ 重新解析（旋转屏幕、插拔鼠标、桌面调试窄窗都覆盖）
  if (mqCoarse && mqCoarse.addEventListener) mqCoarse.addEventListener('change', applyTouchMode);
  window.addEventListener('resize', applyTouchMode);
  window.addEventListener('orientationchange', applyTouchMode);
  if (btnTouchOk) btnTouchOk.addEventListener('click', function () { confirmPending(); });
  if (btnTouchCancel) btnTouchCancel.addEventListener('click', function () { cancelPending(); });

  /* ---------- M10 §29.4 可访问性：键盘导航（方向键 + Enter + Esc） ----------
   *  · 键盘光标独立于鼠标 hover（kbActive 为真时以键盘光标为准，鼠标移动会交还控制权）。
   *  · 与鼠标共用 `hover` 这一"高亮点"（视觉一致）；落子复用 place()（含禁手拦截）。
   *  · aria-live 播报坐标/轮次/胜负（`announce()`）。
   */
  const a11yLive = $('a11y-live');
  let kbActive = false;                          // 键盘导航模式（显示光标）
  let kb = { x: 7, y: 7 };                       // 键盘光标（初始天元）
  function colName(x) { return String.fromCharCode(65 + x); }             // A..O
  function rowName(y) { return String(C.N - y); }                        // 15..1（自上而下）
  let announceTimer = 0, announcePri = 0, announcePend = '';
  // pri 越大优先级越高：0=轮次（可被覆盖），1=操作反馈（落子/光标/取消，覆盖轮次）
  function announce(msg, pri) {
    if (!a11yLive) return;
    pri = pri || 0;
    // 已在防抖窗口内：高优先级覆盖低优先级；同级取最新
    if (announceTimer) {
      if (pri < announcePri) return;
      announcePend = msg;
      return;
    }
    announcePri = pri; announcePend = msg;
    announceTimer = setTimeout(function () {
      announceTimer = 0;
      a11yLive.textContent = announcePend;
      announcePri = 0;
    }, 60);
  }
  function announceNow(msg) {                      // 立即播报（校验/关键事件用）
    if (!a11yLive) return;
    clearTimeout(announceTimer); announceTimer = 0; announcePri = 0;
    a11yLive.textContent = msg;
  }
  function kbSync() {
    if (!kbActive) return;
    hover = { x: kb.x, y: kb.y };
    if (panel) {
      const i = C.idxOf(kb.x, kb.y);
      if (pos.board[i] !== C.EMPTY) {
        const k = orderArr[i], m = moves[k - 1];
        panel.setLastMove(m ? ('第 <b>' + m.no + '</b> 手 ' + (m.player === C.BLACK ? '黑' : '白')) : '');
      } else panel.setLastMove('');
    }
    draw();
  }
  function kbMove(dx, dy) {
    if (replay) { announceNow('读谱模式下不可落子'); return; }
    kbActive = true;
    kb.x = Math.max(0, Math.min(C.N - 1, kb.x + dx));
    kb.y = Math.max(0, Math.min(C.N - 1, kb.y + dy));
    kbSync();
    const i = C.idxOf(kb.x, kb.y), v = pos.board[i];
    announceNow(colName(kb.x) + rowName(kb.y) + '，' +
      (v === C.BLACK ? '黑子' : v === C.WHITE ? '白子' : '空点'));
  }
  function kbPlace() {
    // 读谱模式：键盘也能推演（与鼠标同一条路径）
    if (replay) {
      if (!readMode() || replay.over) return;
      if (!kbActive) { kbActive = true; kbSync(); announceNow('已启用键盘光标：' + colName(kb.x) + rowName(kb.y)); return; }
      if (recPanel.pushExtra && recPanel.pushExtra(kb.x, kb.y)) announceNow('推演落子 ' + colName(kb.x) + rowName(kb.y));
      return;
    }
    if (!canHumanPoint()) { announceNow(thinking ? 'AI 思考中，请稍候' : '现在不是你的回合'); return; }
    if (!kbActive) { kbActive = true; kbSync(); announceNow('已启用键盘光标：' + colName(kb.x) + rowName(kb.y)); return; }
    if (place(kb.x, kb.y, false)) announceNow('落子 ' + colName(kb.x) + rowName(kb.y));
  }
  function kbCancel() {
    if (!kbActive) return;
    kbActive = false; hover = null; draw(); announceNow('已取消键盘光标');
  }
  // Esc 之外的取消：鼠标动一下也交还控制权（符合直觉）
  canvas.addEventListener('mouseenter', function () { if (kbActive) { kbActive = false; } });

  btnUndo.addEventListener('click', undo);
  btnRestart.addEventListener('click', function () { reset(); });
  chkNo.addEventListener('change', function () { savePrefs(); syncDisplayNote(); draw(); });
  chkForbid.addEventListener('change', function () { savePrefs(); syncDisplayNote(); forbidCache = null; draw(); });
  // 规则/模式/执子：语义类，只在空盘或终局后可改（行棋中控件已 disabled，这里再兜一道）
  selRule.addEventListener('change', function () {
    savePrefs();
    syncDisplayNote();                     // 禁手标记只在 Renju 下有意义 → 摘要要跟着变
    if (inPlay()) { syncLocks(); return; }
    forbidCache = null; reset();
  });
  selMode.addEventListener('change', function () {
    savePrefs();
    applyModeEnable();
    if (inPlay()) { syncLocks(); return; }
    reset();
  });
  selSide.addEventListener('change', function () {
    savePrefs();
    if (inPlay()) { syncLocks(); return; }
    reset();
  });
  selLevel.addEventListener('change', function () {   // 换难度：作废当前思考并重算
    savePrefs();
    cancelAI();
    updateStatus();
    maybeAI();
  });
  if (selTime) selTime.addEventListener('change', function () { savePrefs(); updateStatus(); });
  // ★ 触屏落子开关（auto/on/off）：切换后立即生效并落盘
  if (selTouch) selTouch.addEventListener('change', function () {
    touchPref = selTouch.value;
    savePrefs();
    applyTouchMode();
  });
  // ★ 需求1：提示难度独立设置 —— 改了立刻用新档位重算（若提示是长期开着的）
  if (selHintLevel) selHintLevel.addEventListener('change', function () {
    savePrefs();
    obsKey = '';
    if (obs.autoHint && panel) { panel.clearHints(); panel.askHint(); }
  });
  // 棋谱面板选项 + 提示面板选项的持久化
  for (const id of ['recFmt', 'recExpFmt', 'recSpeed', 'recAutoTime', 'chkArrow', 'chkHintScore']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', function () {
      savePrefs();
      if (id === 'chkArrow' || id === 'chkHintScore') syncDisplayNote();
    });
  }

  /* ---------- M8：面板装配 ---------- */
  panel = PANELS.create({
    /* ★ 分析目标 = "用户当前看到的那张棋盘"。
     *   回放模式下必须返回**回放局面**，否则「提示 / 形势」算的是后台那份对局，
     *   而屏幕上显示的是棋谱的某一手 ⇒ 结论与画面不符（菜单功能准确性问题）。 */
    game: function () {
      const hl = (selHintLevel && selHintLevel.value) || 'hard';
      if (replay) {
        const p = replay.ply;
        return {
          board: replay.board,
          stm: replay.stm || ((p % 2 === 0) ? C.BLACK : C.WHITE),   // 读谱局面轮到谁（含推演）
          ply: p + (replay.extra | 0), over: !!replay.over, winner: replay.winner || 0,
          rule: rule(), overlineMode: overlineMode(), difficulty: difficulty(), time: timeCfg(),
          hintDifficulty: hl, replay: true,
        };
      }
      if (!pos) return null;
      return {
        board: pos.board, stm: pos.stm, ply: moves.length, over: over || !!winner,
        winner: winner || 0,
        rule: rule(), overlineMode: overlineMode(), difficulty: difficulty(), time: timeCfg(),
        hintDifficulty: hl, replay: false,
      };
    },
    onOverlay: function (o) {
      if (o.candidates !== undefined) overlay.candidates = o.candidates;
      if (o.heat !== undefined) overlay.heat = o.heat;
      if (o.forbidden !== undefined && o.forbidden) {
        // 形势判断给出的禁手点（含全盘邻域）→ 与本地禁手标红合并（本地优先，避免覆盖用户开关）
        if (rule() === 'renju' && chkForbid.checked) {
          const set = new Set(o.forbidden.map(function (p) { return C.idxOf(p.x, p.y); }));
          if (forbidSet) for (const i of forbidSet) set.add(i);
          forbidSet = set;
        }
      }
      // 回放中：把新叠加重绘到回放视图（否则候选点/禁手只写进 overlay，画面上看不到）
      if (replay) onReplayView(replay);
      else draw();
    },
    onPreview: function (p) {
      overlay.preview = p;
      if (p) { hover = p; }
      draw();
    },
    // 热力图等异步操作失败 → 在状态栏提示（panels 不再自己碰 DOM）
    onError: function (e) {
      statusEl.innerHTML = '<span class="err">' + String((e && e.message) || e) + '</span>';
    },
    // ★ 热力开/关（含失败回滚）→ 反射到「显示与叠加」分组头，折叠时也看得见
    onHeat: function (on) {
      if (menu) menu.setNote('display', on ? '热力图开' : null);
      const g = $('displayPanel');
      if (g) g.classList.toggle('heat', !!on);
      if (!on) syncDisplayNote();            // 关掉后恢复"哪些叠加开着"的摘要
      savePrefs();                           // ★ 需求3：热力是长期开关 ⇒ 状态要落盘
    },
  });

  recPanel = RP.create({
    rule: rule, overlineMode: overlineMode,
    onView: onReplayView,
    // ★ §12：点击命中标注里的开局名 → 在棋谱库里定位并打开该开局的第一条棋谱
    onOpenOpening: function (name) { openOpening(name); },
    /* ★ 需求4：进入 / 退出读谱模式的通知（由 record 模块在 enter/leave 里回调）。
     *   读谱模式 = 只读棋谱 + 可在其上**推演**（人工续下）；退出后回到原来的对局。 */
    onMode: function (on) {
      obsKey = '';                       // 模式切换 ⇒ 长期开关重新算一次
      if (on && menu) menu.openFor('record');
      syncRecNote();
      syncObservers();
    },
    onExit: function () { exitReadMode(); },
    /* ★ R10：「推演」（对局中入口）——把当前对局快照成可推演的棋谱并进入读谱推演。
     *   行为与读谱模式的推演**完全一致**（撤回/清空/以推演续弈/恢复下棋）；
     *   差别只有来源：这里的棋谱前缀就是**当前对局**。
     *   ★ 进入前先 cancelAI：AI 正在思考时快照会漏掉它即将落的这一手，
     *     之后「以推演续弈」就会把这一手悄悄回退掉（不可见的丢子）。 */
    onForkStart: function () {
      if (readMode()) return;
      cancelAI();
      updateStatus();
      const info = {
        ruleMode: rule(), overlineMode: overlineMode(),
        result: winner ? (winner === C.BLACK ? 'B' : 'W') : '?',
        opening: openingName(),
      };
      recPanel.fromGame(moves, info);
      syncRecNote();
    },
    onResume: function (recordMoves, info) {
      // 从第 ply 手续弈（§9.3）：用棋谱前 ply 手重建对局
      AI.abort(); gen++; thinking = false;
      pos = C.createPosition();
      winner = 0; over = false; winLine = null; lastMove = null;
      forbiddenLose = null; forbidSet = null; forbidCache = null;
      orderArr = new Int16Array(C.NN);
      moves = [];
      clearOverlay();
      for (let k = 0; k < recordMoves.length; k++) {
        const m = recordMoves[k];
        C.makeMove(pos, m.x, m.y, m.player);
        orderArr[C.idxOf(m.x, m.y)] = m.no || (k + 1);
        moves.push({ x: m.x, y: m.y, player: m.player, no: m.no || (k + 1), timeMs: m.timeMs || 0 });
        lastMove = { x: m.x, y: m.y };
        const v = RULES.judge(pos.board, m.x, m.y, m.player, rule(), overlineMode());
        if (v === 'win') { winner = m.player; over = true; winLine = RULES.winningLine(pos.board, m.x, m.y, m.player, rule()); }
        else if (v === 'lose') { winner = C.opp(m.player); over = true; forbiddenLose = { x: m.x, y: m.y, player: m.player }; }
      }
      replay = null;
      lastReplayPly = '';
      overlay.candidates = null;
      overlay.heat = null;
      draw(); updateStatus();
      syncRecNote();                            // 「从此续弈」后 active 归 false → 摘要复位
      if (!over) maybeAI();                     // 若续弈后轮到 AI
    },
  });

  /* ---------- §12 棋谱库面板（浏览内置开局库真实棋谱） ---------- */
  let bookLib = null;
  if (window.G.booklib) {
    bookLib = window.G.booklib.create({
      // 点条目 → 载入并进入读谱（与「开局库关联」里的条目走**同一条路径** openGame）
      onOpen: openGame,
    });
  }
  // 命中标注里的开局名 → 定位并打开该开局的第一条棋谱
  function openOpening(name) {
    if (!bookLib || !name || !recPanel) return;
    const e = bookLib.findOpening(name);
    if (!e) { statusEl.innerHTML = '<span class="err">棋谱库中没有「' + name + '」</span>'; return; }
    if (bookLib.refresh) bookLib.refresh();
    bookLib.pick(e);
  }

  btnHint.addEventListener('click', function () { toggleObserver('hint'); });
  btnJudge.addEventListener('click', function () { toggleObserver('judge'); });
  // ★ 热力图开关：**唯一入口**交给 panels 模块（它持有 heatOn 与高亮类，避免两处各写一份 DOM）。
  btnHeat.addEventListener('click', function () {
    if (panel) panel.toggleHeat();
    savePrefs();                       // ★ 需求3：热力也是长期开关，状态持久化
    if (menu) menu.openFor('display');
  });
  /* ★ 需求4：「棋谱」按钮 = **打开棋谱面板**（不进入读谱模式、不打断下棋）。
   *   进入读谱模式只有一个入口：点一条**具体棋谱**（列表 / 开局库关联里的条目）。
   *   再次点击 = 收起面板（与分组头一致）。 */
  btnRecord.addEventListener('click', function () {
    if (menu) menu.toggle('record');
    else if (recPanel) { /* 无 menu 时退化为展开（不应发生） */ }
  });
  /** 退出回放时的清理：回放期算出的提示/热力只对那一手有效，回到对局必须作废。 */
  function leaveReplayCleanup() {
    replay = null;
    lastReplayPly = '';
    overlay.candidates = null;
    overlay.heat = null;
    overlay.preview = null;
    clearTouch();                       // 退出读谱 ⇒ 作废触屏待确认点（它属于读谱局面）
    if (panel) panel.clearHints();
  }

  // 开局名识别（§12；仅前 3 手齐全时）
  function openingName() {
    try {
      if (moves.length < 3 || !window.G.openings) return '';
      const o = window.G.openings.identify(moves.slice(0, 3).map(function (m) { return C.idxOf(m.x, m.y); }));
      return o ? o.name : '';
    } catch (e) { return ''; }
  }

  function cancelAI() { AI.abort(); gen++; thinking = false; }

  window.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    /* ★ 触屏待确认态：Enter 确认 / Esc 取消（键盘用户与外接键盘的平板都走这条）。
     *   ⚠ 只认 Enter，**不认空格** —— 读谱模式里空格是"播放/暂停"（record.js 自建监听），
     *     在这里抢空格会让两个动作同时发生。 */
    if (pending) {
      if (e.key === 'Enter') { e.preventDefault(); confirmPending(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelPending(); return; }
    }
    /* ★ 读谱模式：方向键 / 空格 / Home / End 归**棋谱面板**（它自建了监听）。
     *   历史缺陷：两套键盘逻辑会同时响应 ←/→ —— 既"翻手"又"移动隐藏的键盘光标"，
     *   于是读屏会把**后台对局**的格子念出来，与屏幕上显示的读谱局面不符。
     *   现在这里直接让路，只放行"对当前读谱局面的分析"（H/J，已改为按读谱局面计算）。
     *   ★ Esc 一律退出读谱：帮助里承诺了"Esc 退出"，若因为键盘光标还亮着（kbActive）
     *   就把 Esc 吞掉，用户会觉得"Esc 失灵"（探索性测试实测）。 */
    if (replay) {
      if (e.key === 'h' || e.key === 'H') { toggleObserver('hint'); }
      else if (e.key === 'j' || e.key === 'J') { toggleObserver('judge'); }
      else if (e.key === 'Escape') { kbActive = false; hover = null; exitReadMode(); }
      return;
    }
    // ★ M10 §29.4：方向键导航 + Enter 落子 + Esc 取消（优先于字母快捷键）
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); kbMove(-1, 0); return;
      case 'ArrowRight': e.preventDefault(); kbMove(1, 0); return;
      case 'ArrowUp': e.preventDefault(); kbMove(0, -1); return;
      case 'ArrowDown': e.preventDefault(); kbMove(0, 1); return;
      case 'Enter': case ' ': if (kbActive) { e.preventDefault(); kbPlace(); return; } break;
      case 'Escape': if (kbActive) { e.preventDefault(); kbCancel(); return; } break;
    }
    if (e.key === 'u' || e.key === 'U') undo();
    else if (e.key === 'r' || e.key === 'R') reset();
    /* ★ H / J：与「提示 / 形势」**按钮同一条路径**（长期开关）。
     *   历史缺陷：按键只发一次性请求，而帮助文本承诺"H 提示 · J 形势 —— 开启后每手自动刷新"
     *   ⇒ 文案与行为不符（用户按 H 后落子不再刷新，以为坏了）。 */
    else if (e.key === 'h' || e.key === 'H') toggleObserver('hint');
    else if (e.key === 'j' || e.key === 'J') toggleObserver('judge');
  });
  // 页面隐藏时暂停：中断当前思考，避免后台节流导致误判超时（§34.5）；
  // 回到前台若仍轮到 AI，则重发（否则会出现"AI 不走了"的假死）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (thinking) { cancelAI(); updateStatus(); }
    } else if (!replay && !over && !winner && isAITurn()) {
      maybeAI();
    }
  });

  /* ---------- 调试钩子（只读 + 落子，供自动化验收 / 浏览器实跑使用） ---------- */
  window.G.main = {
    place: place, reset: reset, undo: undo,
    hint: function () { return panel ? panel.askHint() : null; },
    judge: function () { return panel ? panel.askJudge() : null; },
    heat: function () { return btnHeat ? btnHeat.click() : null; },
    loadRecord: function (text, fmt) { return recPanel ? recPanel.load(text, fmt) : null; },
    exportRecord: function (fmt) { return recPanel ? recPanel.exportAs(fmt) : null; },
    overlay: function () { return overlay; },
    panel: function () { return panel; },
    // ★ M10 §29.4：键盘导航调试接口（供浏览器实跑验证）
    a11y: {
      cursor: function () { return kbActive ? { x: kb.x, y: kb.y } : null; },
      live: function () { return a11yLive ? a11yLive.textContent : ''; },
      press: function (key) { window.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true })); },
    },
    // ★ M10 §14：动画状态（供浏览器实跑验证）
    anim: function () { return { on: animOn(), dropIdx: anim.dropIdx, raf: animRaf, reduce: !!(mqReduce && mqReduce.matches) }; },
    // ★ §12：棋谱库（供浏览器实跑验证）
    bookLib: function () { return bookLib; },
    /* ★ 网格点 → **客户端坐标**（供浏览器实跑模拟"悬停/点击某一点"）。
     *   与 ui/render.js 的布局共用同一份计算（含 rect 偏移与显示缩放换算），
     *   避免测试里重复推导留白公式（那是"改布局就悄悄失效"的典型来源）。 */
    clientOf: function (x, y) {
      const r = canvas.getBoundingClientRect();
      const p = renderer.posToPx(x, y);
      const sx = (r.width || renderer.size) / renderer.size;
      const sy = (r.height || renderer.size) / renderer.size;
      return { x: r.left + p.px * sx, y: r.top + p.py * sy };
    },
    openOpening: openOpening,
    openGame: openGame,
    record: function () { return recPanel; },
    // ★ 需求3/4：长期开关与读谱模式（供浏览器实跑验证 / 自动化）
    obs: function () {
      return {
        autoHint: obs.autoHint, autoJudge: obs.autoJudge,
        heat: !!(panel && panel.heatOn),
        btnHint: btnHint ? btnHint.getAttribute('aria-pressed') : null,
        btnJudge: btnJudge ? btnJudge.getAttribute('aria-pressed') : null,
        btnHeat: btnHeat ? btnHeat.getAttribute('aria-pressed') : null,
      };
    },
    toggle: function (which) { return toggleObserver(which); },
    // ★ 触屏落子（小屏模式）状态（供浏览器实跑验证 / 自动化）
    touchState: function () {
      const r = touchBar ? touchBar.getBoundingClientRect() : null;
      return {
        on: touchOn, pref: touchPref, coarse: !!(mqCoarse && mqCoarse.matches),
        width: window.innerWidth, maxWidth: (TOUCH && TOUCH.MAX_W) || null,
        pending: pending ? { x: pending.x, y: pending.y } : null,
        ghost: ghost ? { x: ghost.x, y: ghost.y } : null,
        barHidden: touchBar ? touchBar.hidden : null,
        barVisible: !!(r && r.width > 0 && r.height > 0),
        text: touchText ? touchText.textContent : '',
        dim: touchDim ? touchDim.textContent : '',
        bodyClass: document.body.className,
      };
    },
    readMode: readMode,
    exitReadMode: exitReadMode,
    hintLevel: function () { return selHintLevel ? selHintLevel.value : null; },
    bookHit: function () { return $('recBookHit') ? $('recBookHit').textContent : ''; },
    // ★ §14 侧栏分组（供浏览器实跑验证 / 自动化）
    menu: function () { return menu; },
    notes: function () {
      return {
        game: menu ? menu.getNote('game') : '',
        display: menu ? menu.getNote('display') : '',
        hint: $('hintNote') ? $('hintNote').textContent : '',
        judge: $('judgeLabel') ? $('judgeLabel').textContent : '',
        record: $('recNote') ? $('recNote').textContent : '',
        book: $('blMeta') ? $('blMeta').textContent : '',
      };
    },
    lockNote: function () { return lockNote ? lockNote.textContent : ''; },
    info: function () {
      return {
        rule: rule(), stm: pos.stm, ply: moves.length, over: over, winner: winner,
        forbidCount: forbidSet ? forbidSet.size : 0,
        replay: replay ? replay.ply : null,
        hints: panel ? panel.hints.length : 0,
        judge: panel && panel.judgeRes ? panel.judgeRes.label : null,
        heat: !!(overlay.heat && overlay.heat.length),
        moves: moves.map(function (m) { return [m.x, m.y, m.timeMs | 0]; }),
        forbidHas: function (x, y) { return !!forbidSet && forbidSet.has(C.idxOf(x, y)); },
      };
    },
  };

  /* ---------- 启动 ---------- */
  // ★ 先把持久化的偏好写回控件，再 reset()（reset 会读 selRule/selMode/selSide 建局）
  applyPrefs();
  applyTouchMode();               // ★ 触屏落子：按"偏好 + 设备环境"决定是否启用（要在画第一帧前定下来）
  syncDisplayNote();
  syncRecNote();
  // ?ai=main 可强制主线程后端（便于调试 / file:// 下 Worker 受限时对照）
  const forceMain = /(^|[?&])ai=main(&|$)/.test(location.search);
  AI.init(forceMain).then(function () {
    reset();
    updateStatus();
    // ★ 需求3：恢复持久化的"热力图长期开关"（等棋盘与面板都就绪后再真正发起请求）
    if (pendingHeat && panel) { pendingHeat = false; panel.toggleHeat(); }
  });
})();
