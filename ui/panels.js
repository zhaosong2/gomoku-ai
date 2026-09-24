/* ui/panels.js — 侧栏面板：提示列表 / 形势条 / 热力图 / 控制按钮（M8）
 * 设计依据：§10.2 UI、§11.1 输出、§29.3 叠加层、§29.2 状态机按钮
 *
 * 本模块只做"展示 + 触发"，所有计算走 AI 后端（Worker 优先，主线程兜底）。
 * 与 render.js 的接口：main 汇总 state → renderer.draw(state)；本模块通过
 * onOverlay 回传需要叠加的数据（热力图 / 候选点圈）。
 */
(function () {
  'use strict';
  const C = window.G.core, REC = window.G.record, AI = window.G.ai, COACH = window.G.coach;

  const $ = function (id) { return document.getElementById(id); };

  function pct(v) { return Math.round((v || 0) * 1000) / 10 + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function create(opts) {
    const o = opts || {};
    const el = {
      hintBox: $('hintList'), btnHint: $('btnHint'), chkScore: $('chkHintScore'),
      hintNote: $('hintNote'),
      judgeBox: $('judgeBox'), btnJudge: $('btnJudge'),
      barB: $('judgeBarB'), barW: $('judgeBarW'), label: $('judgeLabel'),
      mateTag: $('judgeMate'), scoreTag: $('judgeScore'),
      judgeErr: $('judgeErr'),
      btnHeat: $('btnHeat'),
      lastBox: $('lastMoveBox'),          // ★ 悬停显示"第 k 手 · 用时"（v3.36 补上元素）
    };

    let hints = [];                 // 最近一次提示
    let judgeRes = null;            // 最近一次形势判断
    let heatOn = false;
    let heatData = null;
    let busy = false;
    let lastHintPly = -1;           // 提示对应的手数（局面变了要作废）

    /* ---------- 提示（§10） ---------- */
    /** 分组头摘要：折叠状态下也能看到"提示对应第几手、有几个候选"（用户需求：分层展开要看得见状态）。 */
    function note(text, cls) {
      if (!el.hintNote) return;
      el.hintNote.textContent = text == null ? '' : String(text);
      el.hintNote.className = 'grp-note' + (cls ? ' ' + cls : '');
      el.hintNote.hidden = !text;
    }

    /* 结果失效时的中性复位。
     *   ★ 为什么必须有：`ui/ai.js` 是**单通道 latest-wins**（新请求会把在飞的旧请求
     *   `currentId` 顶掉 → 旧 promise 以 E_ABORTED 拒绝）。若失败分支直接 return，
     *   面板就会**永久停在"计算中…"**——用户看到的是一个永远不会结束的加载态。
     *   凡是要给 UI 写"进行中"的地方，都必须在所有出口（成功/失败/取消/被顶替）收尾。
     *   ⚠ 复位时若有**上一次的有效结果**，要还原成那份结果——不能拿"没有新结果"当"没有结果"。 */
    function idleHints() {
      if (hints.length) { renderHints(); return; }      // 回到上一次的有效结果
      if (el.hintBox) el.hintBox.innerHTML = '<div class="dim">点上方「提示」列出候选点与推荐度</div>';
      note('');
    }

    /** 请求提示。★ 返回 promise（永不 reject）：`main.syncObservers` 靠它**串行**执行多个
     *  长期开关 —— 同 tick 连发会被单通道 latest-wins 互相顶掉（实测：提示+形势同开时提示永远空）。 */
    function askHint() {
      if (busy) return Promise.resolve(null);
      const g = o.game();
      if (!g || g.over) return Promise.resolve(null);
      busy = true;
      if (el.hintBox) el.hintBox.innerHTML = '<div class="dim">计算中…</div>';
      const ply = g.ply;
      note('计算中…');
      return AI.askHint(g.board, g.stm, {
        // ★ 需求1：提示走**独立的**提示难度（`g.hintDifficulty`），与对局难度解耦 ——
        //   用户可以在"对手只是中等"的对局里要"大师级"的提示，反之亦然。
        rule: g.rule, overlineMode: g.overlineMode,
        difficulty: g.hintDifficulty || g.difficulty,
        // 时间预算用**提示难度自身的**默认值（不再被对局的"时限"夹住）——
        // 否则把对局限时设成 0.3 秒时，再高的提示难度也算不出东西。
        n: 5, time: null,
      }).then(function (res) {
        busy = false;
        if (!same(g, ply)) { idleHints(); return; }    // 局面已变 → 丢弃并复位
        hints = (res && res.hints) || [];
        lastHintPly = ply;
        renderHints();
        if (o.onOverlay) o.onOverlay({ candidates: hints });
      }).catch(function (e) {
        busy = false;
        const msg = String((e && e.message) || e);
        if (msg !== 'E_ABORTED' && same(g, ply)) {
          note('失败', 'warn');
          if (el.hintBox) el.hintBox.innerHTML = '<div class="bad">提示失败：' + esc(msg) + '</div>';
          return;
        }
        // 取消 / 被新请求顶替 / 局面已变：结果不再有效 ⇒ 必须把"计算中…"抹掉
        idleHints();
      });
    }

    // 局面是否仍是"发起请求时的那一个"
    function same(g, ply) {
      const cur = o.game();
      return cur && !cur.over && cur.ply === ply;
    }

    function renderHints() {
      if (!el.hintBox) return;
      if (!hints.length) {
        el.hintBox.innerHTML = '<div class="dim">无候选（对局可能已结束）</div>';
        note(lastHintPly >= 0 ? '第 ' + lastHintPly + ' 手 · 无候选' : '', 'warn');
        return;
      }
      const showScore = el.chkScore && el.chkScore.checked;
      const win = hints.filter(function (h) { return h.win; }).length;
      note('第 ' + lastHintPly + ' 手 · ' + hints.length + ' 个候选' + (win ? ' · 必胜 ' + win : ''),
        win ? 'ok' : '');
      el.hintBox.innerHTML = hints.map(function (h) {
        const w = Math.round(h.norm);                    // 0..100
        /* ★ R8：必胜标签写明**杀法来源与步数**——用户问过"为什么提示选步骤多的杀"，
         *   把"这是几步的杀"亮出来，快慢一目了然（search = 搜索证明；vcf/vct = 威胁链）。 */
        const mateName = h.mate === 'win' ? '成五' : h.mate === 'vcf' ? 'VCF 必杀'
          : h.mate === 'vct' ? 'VCT 必杀' : h.mate === 'search' ? '搜索确认必胜' : '必胜';
        const mateTip = mateName + (h.mateLen > 1 ? ' · 约 ' + h.mateLen + ' 手' : '');
        return '<div class="hint-item" data-x="' + h.x + '" data-y="' + h.y + '">' +
          '<span class="rank">' + h.rank + '</span>' +
          '<span class="coord">' + h.coord + '</span>' +
          '<span class="type t' + tag(h.type) + '">' + esc(h.type) + '</span>' +
          '<span class="meter"><i style="width:' + w + '%"></i></span>' +
          '<span class="norm" title="推荐度（同类候选的相对强度，非胜率）">' + w + '%</span>' +
          (h.win ? '<span class="tag win" title="' + mateTip + '">必胜' + (h.mateLen > 1 ? '·' + h.mateLen : '') + '</span>' : '') +
          (showScore ? '<span class="score">' + h.score + '</span>' : '') +
          '</div>';
      }).join('');
    }
    function tag(type) {
      const m = { '成五': 'w', '活四': 'w', '双四': 'w', '四三': 'w', '双三': 'a', '冲四': 'a', '活三': 'a', '防守': 'd', '常规': 'n', '禁手': 'x' };
      return m[type] || 'n';
    }

    function clearHints() {
      hints = []; lastHintPly = -1;
      if (el.hintBox) el.hintBox.innerHTML = '';
      note('');
      if (o.onOverlay) o.onOverlay({ candidates: null });
    }

    /* ---------- 形势判断（§11） ---------- */
    /* ★ 错误/提示一律写进**独立槽位** #judgeErr，绝不覆写 #judgeBox。
     *   历史缺陷：原来 `el.judgeBox.innerHTML = …` 会把形势条/标签/杀着标签的 DOM
     *   整块替换 ⇒ 缓存引用 el.barB/el.barW/el.label 变成**脱离文档的游离节点**，
     *   之后 renderJudge() 的写入全部落空 ⇒ **形势条永久不再更新**（一次失败即静默
     *   报废整块面板，且没有任何报错）。现已改为独立槽位。 */
    function setJudgeErr(msg) {
      if (!el.judgeErr) return;
      el.judgeErr.textContent = msg || '';
      el.judgeErr.hidden = !msg;
    }
    /** 形势判断的中性复位（同 hint：所有出口都要收尾，不能停在"判断中…"）。 */
    function idleJudge() {
      if (judgeRes) { renderJudge(); return; }         // 有旧结论 → 还原成旧结论
      if (el.label) el.label.textContent = '';
      if (el.scoreTag) el.scoreTag.textContent = '尚未判断（点「形势」或下完一手后自动更新）';
    }

    /** 请求形势判断。★ 同样返回 promise（见 askHint 的说明）。 */
    function askJudge() {
      const g = o.game();
      if (!g) return Promise.resolve(null);
      if (g.over) {
        /* ★ 终局后不再请求引擎（R11）：引擎 judge 只看"轮到谁/谁有成五点"，终局盘面会给出
         *   荒谬结论——白已五连而黑还有个四 ⇒ "黑已胜 100%"（用户实测踩中）。直接显示终局结论。 */
        const w = g.winner || 0;
        judgeRes = {
          blackRate: w === C.BLACK ? 1 : w === C.WHITE ? 0 : 0.5,
          label: w === C.BLACK ? '黑已胜' : w === C.WHITE ? '白已胜' : '和棋',
          score: w === C.BLACK ? 1e8 : w === C.WHITE ? -1e8 : 0,
          source: 'over', mate: null, forbiddenPoints: [],
        };
        renderJudge();
        return Promise.resolve(null);
      }
      const ply = g.ply;
      if (el.label) el.label.textContent = '判断中…';
      setJudgeErr('');
      return AI.askJudge(g.board, g.stm, { rule: g.rule, overlineMode: g.overlineMode })
        .then(function (res) {
          if (!same(g, ply)) { idleJudge(); return; }
          judgeRes = res;
          renderJudge();
          if (o.onOverlay) o.onOverlay({ forbidden: res.forbiddenPoints });
        })
        .catch(function (e) {
          const msg = String((e && e.message) || e);
          if (msg !== 'E_ABORTED' && same(g, ply)) {
            if (el.label) el.label.textContent = '失败';
            setJudgeErr('判断失败：' + msg);
            return;
          }
          idleJudge();
        });
    }

    // AI 思考完成后顺带更新（§11.2：复用搜索结果、零额外开销）
    function applyJudge(res, g) {
      if (!res) return;
      const cur = o.game();
      // 顺带更新只在"同一局面之后"生效：这里放宽为直接采用（调用方已保证时序）
      judgeRes = res;
      renderJudge();
      if (o.onOverlay && res.forbiddenPoints) o.onOverlay({ forbidden: res.forbiddenPoints });
    }

    // AI 行棋结果里的 score → 本地换算形势条（真正的"零额外开销"路径）
    function applyFromMove(score, stm) {
      if (score === undefined || score === null || !COACH) return;
      let s = score;
      if (stm === C.WHITE) s = -s;                       // 统一到黑方视角
      const rate = COACH.evalToWinRate(s);
      judgeRes = { blackRate: rate, label: COACH.labelOf(rate, s), score: Math.round(s), source: 'move', mate: null, forbiddenPoints: [] };
      renderJudge();
    }

    function renderJudge() {
      if (!el.judgeBox) return;
      const r = judgeRes;
      if (!r) {
        if (el.label) el.label.textContent = '';
        if (el.scoreTag) el.scoreTag.textContent = '尚未判断（点「形势」或下完一手后自动更新）';
        return;
      }
      setJudgeErr('');
      const b = Math.max(0, Math.min(1, r.blackRate || 0));
      const bp = (b * 100).toFixed(1);
      if (el.barB) el.barB.style.width = bp + '%';
      if (el.barW) el.barW.style.width = (100 - bp) + '%';
      if (el.label) el.label.textContent = r.label || '—';
      if (el.mateTag) {
        if (r.mate && r.mate.side) {
          el.mateTag.hidden = false;
          el.mateTag.textContent = (r.mate.side === 'B' ? '黑' : '白') + '有杀（' +
            (r.mate.via ? r.mate.via.toUpperCase() : 'VCF') + (r.mate.plies ? ' ' + r.mate.plies + ' 手' : '') + '）';
          el.mateTag.className = 'judge-mate ' + (r.mate.side === 'B' ? 'b' : 'w');
        } else { el.mateTag.hidden = true; }
      }
      if (el.scoreTag) {
        const src = r.source === 'win' ? '终局判定' : r.source === 'over' ? '对局结束'
          : r.source === 'urgent' ? '对方有成五点' : r.source === 'mate' ? '威胁搜索'
          : r.source === 'move' ? 'AI 搜索结果' : '静态评估';
        el.scoreTag.textContent = '黑胜率 ' + bp + '% · 分值 ' + (r.score >= 0 ? '+' : '') + r.score + ' · ' + src;
      }
      const extra = [];
      if (r.forbiddenPoints && r.forbiddenPoints.length) extra.push('黑禁手点 ' + r.forbiddenPoints.length + ' 个');
      if (judgeRes.source === 'eval' && Math.abs(r.score) >= 1e7) extra.push('已达胜势分');
      if (extra.length && el.scoreTag) el.scoreTag.textContent += ' · ' + extra.join(' · ');
    }

    /* ---------- 热力图（§11.1 可选） ---------- */
    /* ★ 开关高亮的**单一真相源**（用户反馈：切换别的开关后已开的高亮丢了）。
     *   根因：`btnHeat` 的 'on' 类曾被两处独立写——本模块的 heatOn 与 main.js 的
     *   `overlay.heat` 分支。任一处的 catch / 空结果分支都会把类抹掉，而另一处的
     *   布尔状态没变 ⇒ 状态与高亮脱钩（有时还反向）。
     *   修法：① 高亮类名统一走 `onClass` 属性（与视觉解耦，便于测试与主题化）；
     *         ② 只有本模块写 heatOn 与高亮；main.js 改为调本模块，不再自己碰 DOM。
     */
    const ON_CLASS = 'on';
    function setHeatUI(on) {
      heatOn = !!on;
      if (el.btnHeat) {
        el.btnHeat.classList.toggle(ON_CLASS, heatOn);
        el.btnHeat.setAttribute('aria-pressed', heatOn ? 'true' : 'false');
      }
      // 通知调用方（main）把状态反射到分组头，保持"折叠时也看得见状态"
      if (o.onHeat) o.onHeat(heatOn);
    }
    function toggleHeat() {
      if (heatOn) {                                   // 关：立即生效，不等异步
        setHeatUI(false);
        heatData = null;
        if (o.onOverlay) o.onOverlay({ heat: null });
        return;
      }
      requestHeat();
    }
    /** 长期开关用：**保持开启**，只重新取数据（局面变了就重算）。返回 promise。 */
    function refreshHeat() {
      if (!heatOn) return Promise.resolve(null);
      return requestHeat();
    }
    function requestHeat() {
      const g = o.game();
      if (!g) return Promise.resolve(null);
      setHeatUI(true);                                // 开：先亮（乐观 UI），失败再回滚
      const ply = g.ply;
      return AI.askHeat(g.board, g.stm, {
        rule: g.rule, overlineMode: g.overlineMode,
        // ★ 热力图本应按**当前难度**取值（§13 难度标定工具要量测"该档位玩家实际看到的
        //   强弱提示"）。此前漏传 difficulty → ai.js 落到 normal 默认值，热力图与所选
        //   难度脱钩（2026-09-19 M9 修正）。
        difficulty: g.difficulty, depth: g.depth,
      })
        .then(function (res) {
          if (!same(g, ply) || !heatOn) return;
          heatData = (res && res.heat) || null;
          if (!heatData || !heatData.length) { setHeatUI(false); heatData = null; }
          if (o.onOverlay) o.onOverlay({ heat: heatData });
        })
        .catch(function (e) {
          setHeatUI(false);                           // ★ 失败必须回滚高亮，否则"亮着但没图"
          heatData = null;
          if (o.onOverlay) o.onOverlay({ heat: null });
          if (String(e && e.message) === 'E_ABORTED') return;
          if (o.onError) o.onError(e);
        });
    }

    /* ---------- 最近一手信息（§29.5 hover 联动 / §9.2 时间） ---------- */
    function setLastMove(info) {
      if (!el.lastBox) return;
      if (!info) { el.lastBox.textContent = ''; return; }
      el.lastBox.innerHTML = info;
    }

    /* ---------- 事件 ---------- */
    /* ★ 这里**不**再给 btnHint / btnJudge / btnHeat 绑 click。
     *   历史缺陷（2026-09-23 评审）：本模块与 `ui/main.js` 各绑了一个 click 监听 ⇒
     *   一次点击触发**两次** toggle。对「热力」是致命的：panels 先开 → main 紧接着又关，
     *   最终 heatOn 仍为 false，「热力图」按钮**怎么点都打不开**、还顺手把 prefs 写成 false。
     *   更隐蔽的是断言全绿：`heat === cls && pressed===cls` 这类"三者一致"的断言在
     *   "一致地关着"时也成立（browser-ux-check 就是这么被绕过去的）。
     *   ⇒ 三个开关按钮的**唯一入口**归 main（它还要落盘 / 自动展开分组），本模块只提供 API。 */
    if (el.chkScore) el.chkScore.addEventListener('change', renderHints);
    if (el.hintBox) el.hintBox.addEventListener('click', function (e) {
      const it = e.target.closest ? e.target.closest('.hint-item') : null;
      if (!it) return;
      const x = parseInt(it.getAttribute('data-x'), 10), y = parseInt(it.getAttribute('data-y'), 10);
      if (o.onPreview) o.onPreview({ x: x, y: y });
    });
    if (el.hintBox) el.hintBox.addEventListener('mouseover', function (e) {
      const it = e.target.closest ? e.target.closest('.hint-item') : null;
      if (!it || !o.onPreview) return;
      o.onPreview({ x: parseInt(it.getAttribute('data-x'), 10), y: parseInt(it.getAttribute('data-y'), 10) });
    });

    return {
      askHint: askHint, askJudge: askJudge, applyJudge: applyJudge, applyFromMove: applyFromMove,
      toggleHeat: toggleHeat, refreshHeat: refreshHeat, setHeatUI: setHeatUI,
      clearHints: clearHints, setLastMove: setLastMove,
      renderHints: renderHints, renderJudge: renderJudge,
      get hints() { return hints; },
      get judgeRes() { return judgeRes; },
      get heatOn() { return heatOn; },
      get heat() { return heatData; },
      get busy() { return busy; },
    };
  }

  window.G.panels = { create: create };
})();
