/* ui/booklib.js — 棋谱库浏览 + 开局库匹配 / 关联棋谱（§12）
 * 设计依据：用户需求
 *   ① 「棋谱库应是**完整棋谱**，而不是只有前几步」→ 数据换为 `book-games.js`（927 局完整对局）；
 *   ② 「开局库是基于棋谱库建立的前缀树，开局库应能**关联到具体棋谱**」
 *      → `relatedGames()` 用**规范化前缀**在当前局面上筛出"本库中经过这里的对局"，可点开阅读；
 *   ③ 「支持选择阅读」→ 列表点击即进入读谱模式。
 *
 * 数据来源：`G.bookGames`（tools/gen-book-games.js 由 RenjuNet 真实对局生成，
 *   **927 局 / 26 开局 / 平均 47.9 手**，含双方棋手与结果）。
 *   ⚠ 许可：仅限离线 / 非商业用途（源库条款）。
 *
 * ★ 与 engine/book.js 的关系（两个**不同口径**，UI 必须分别标注）：
 *   · **开局库**（前缀树 `book-tree.js`）＝ 由**全量 11522 局**聚合成边，携带 (n, 胜率)；
 *     回答"这个局面在实战库里出现过多少次、走这手的一方胜率多少"。
 *   · **棋谱库**（`book-games.js`）＝ 其中 **927 局的完整对局**，回答问题"具体是哪几局、能读"。
 *   ⇒ 命中标注里 `样本 N 局`（全量口径）与 `本库可读 K 局`（可阅读口径）**是两个数，不可混同**。
 */
(function () {
  'use strict';
  const OP = window.G.openings, BK = window.G.book, REC = window.G.record;

  const $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  // 与 record.coordText 同口径（此处独立实现，避免对模块加载顺序产生隐式依赖）
  function coord(x, y) { return String.fromCharCode(65 + x) + (15 - y); }

  /** 结果码 → 中文；黑先，0 = 黑胜 / 1 = 白胜 / 2 = 和 */
  function resultText(r) { return r === 0 ? '黑胜' : r === 1 ? '白胜' : r === 2 ? '和棋' : '—'; }

  /* ============================================================
   * 一、棋谱库列表（浏览 / 筛选 / 载入）
   * ============================================================ */
  function create(opts) {
    const o = opts || {};
    const el = {
      meta: $('blMeta'), search: $('blSearch'), selOpening: $('blOpening'),
      selSort: $('blSort'), btnRandom: $('btnBlRandom'), stat: $('blStat'), list: $('blList'),
    };

    let entries = [];            // 全部棋谱（规范化）
    let view = [];               // 当前筛选结果
    let loaded = false;
    let curKey = '';             // 当前高亮的条目键（避免重复点击）

    /* ---------- 载入数据 ---------- */
    /* ★ 数据源 = `engine/data/book-games.js`（UMD，挂 `G.bookGames`）。
     *   刻意**不从 engine/book.js 开访问器**：完整棋谱库是纯 UI 关注点（给人读 + 做关联），
     *   引擎用不到（决策走前缀树、回落走片段线库）——放进引擎会让 worker 产物白涨。 */
    function ensure() {
      if (loaded) return entries;
      loaded = true;
      let raw = null;
      try {
        const g = window.G && window.G.bookGames;
        if (g && typeof g.unpack === 'function') raw = g.unpack();
      } catch (e) { raw = null; }
      entries = normalize(raw || []);
      return entries;
    }

    /* 棋谱库条目 → 展示用规范化对象
     *   · text  完整着法文本（"H8 H9 H10 …"）
     *   · key   稳定主键（完整着法序列的 idx 串；用于列表高亮与查找）
     *   · canon 规范化 idx 序列（惰性计算，用于"当前局面是否经过这里"的前缀匹配）
     */
    function normalize(list) {
      const out = [];
      let id = 0;
      for (const e of list) {
        if (!e || !Array.isArray(e.moves) || e.moves.length < 3) continue;
        out.push({
          id: id++,                                              // 稳定短 id（列表 DOM 属性用，避免塞长串）
          opening: e.opening || '',
          moves: e.moves,                                        // [[x,y],...]
          n: e.moves.length,
          result: e.result,
          black: e.black || '?',
          white: e.white || '?',
          text: e.moves.map(function (m) { return coord(m[0], m[1]); }).join(' '),
          canon: null,                                           // 惰性：canonOf() 填充
        });
      }
      return out;
    }

    /** 规范化着法序列（8 对称取字典序最小；**数值比较**，见 openings.canonSeq）。
     *  性质：`canonSeq(前缀)` 必为 `canonSeq(整局)` 的前缀 ⇒ 可直接做长度 k 的前缀比较。 */
    function canonOf(e) {
      if (!e.canon) e.canon = OP.canonSeq(e.moves.map(function (m) { return m[1] * 15 + m[0]; })).arr;
      return e.canon;
    }

    /* ---------- 开局库 → 棋谱库的关联（§12.4.5） ----------
     * 给定"到目前为止的落子序列"（idx 数组），返回**本棋谱库中经过该局面**的对局。
     * 依据：canonSeq 的前缀性质 —— 若当前前缀的规范形等于某局规范形的前 k 位，则该局确实走过这里。
     * ⚠ 这是**精确前缀匹配**（不是"相似"）：只认整段前缀逐手一致的对局。 */
    function relatedGames(idxs) {
      ensure();
      if (!idxs || idxs.length < 3) return [];
      const ck = OP.canonSeq(idxs).arr;
      const out = [];
      for (const e of entries) {
        const c = canonOf(e);
        if (c.length < ck.length) continue;
        let ok = true;
        for (let k = 0; k < ck.length; k++) if (c[k] !== ck[k]) { ok = false; break; }
        if (ok) out.push(e);
      }
      return out;
    }

    /* ---------- 筛选 / 排序 ---------- */
    function apply() {
      ensure();
      const q = ((el.search && el.search.value) || '').trim().toLowerCase();
      const op = (el.selOpening && el.selOpening.value) || '';
      const sort = (el.selSort && el.selSort.value) || 'len';
      view = entries.filter(function (e) {
        if (op && e.opening !== op) return false;
        if (!q) return true;
        return e.opening.toLowerCase().indexOf(q) >= 0 ||
               e.black.toLowerCase().indexOf(q) >= 0 ||
               e.white.toLowerCase().indexOf(q) >= 0 ||
               e.text.toLowerCase().indexOf(q) >= 0;
      });
      view.sort(function (a, b) {
        if (sort === 'player') return a.black.localeCompare(b.black, 'zh') || a.white.localeCompare(b.white, 'zh');
        if (sort === 'opening') return a.opening.localeCompare(b.opening, 'zh') || b.n - a.n;
        return b.n - a.n || a.opening.localeCompare(b.opening, 'zh');
      });
      renderList();
      renderStat();
    }

    function renderStat() {
      ensure();
      const total = entries.length;
      const openCount = new Set(entries.map(function (e) { return e.opening; })).size;
      const moves = entries.reduce(function (s, e) { return s + e.n; }, 0);
      if (el.stat) {
        el.stat.textContent = '共 ' + total + ' 局完整棋谱 · ' + openCount + ' 种开局 · ' +
          '合计 ' + moves + ' 手 · 当前显示 ' + view.length + ' 局';
      }
      /* ★ 分组头摘要（折叠时也看得见规模）。
       *   历史缺陷：`el.meta` 被缓存但**从未写入** ⇒ 标题常年显示占位符「—」。 */
      if (el.meta) {
        el.meta.textContent = total ? (total + ' 局 / ' + openCount + ' 开局') : '无数据';
      }
    }

    // 只渲染前 MAX 条，避免 DOM 过大（与 record 列表同样的取舍）
    const MAX_ROWS = 200;
    function renderList() {
      if (!el.list) return;
      if (!view.length) { el.list.innerHTML = '<div class="bl-empty">没有匹配的棋谱</div>'; return; }
      const rows = [];
      const n = Math.min(view.length, MAX_ROWS);
      for (let k = 0; k < n; k++) {
        const e = view[k];
        rows.push('<div class="bl-item' + (e.id === curKey ? ' cur' : '') + '" data-id="' + e.id + '" title="点击进入读谱模式">' +
          '<span class="op2">' + esc(e.opening) + '</span>' +
          '<span class="vs2">' + esc(e.black) + ' vs ' + esc(e.white) + '</span>' +
          '<span class="rs2">' + resultText(e.result) + '</span>' +
          '<span class="ln2">' + e.n + ' 手</span>' +
          '</div>');
      }
      if (view.length > MAX_ROWS) {
        rows.push('<div class="bl-empty">… 其余 ' + (view.length - MAX_ROWS) + ' 局请用筛选缩小范围</div>');
      }
      el.list.innerHTML = rows.join('');
    }

    function fillOpenings() {
      if (!el.selOpening) return;
      ensure();
      const names = [];
      const seen = {};
      for (const e of entries) { if (e.opening && !seen[e.opening]) { seen[e.opening] = 1; names.push(e.opening); } }
      names.sort(function (a, b) { return a.localeCompare(b, 'zh'); });
      el.selOpening.innerHTML = '<option value="">全部开局</option>' +
        names.map(function (nm) { return '<option value="' + esc(nm) + '">' + esc(nm) + '</option>'; }).join('');
    }

    /* ---------- 载入某条棋谱到读谱模式 ---------- */
    function pick(e) {
      if (!e) return;
      curKey = e.id;
      renderList();
      // 交给 recordPanel（由 main 注入）。load 会自动进入读谱模式。
      if (o.onOpen) o.onOpen(e);
    }

    /* ---------- 事件 ---------- */
    if (el.search) el.search.addEventListener('input', apply);
    if (el.selOpening) el.selOpening.addEventListener('change', apply);
    if (el.selSort) el.selSort.addEventListener('change', apply);
    if (el.list) el.list.addEventListener('click', function (ev) {
      const it = ev.target.closest ? ev.target.closest('.bl-item') : null;
      if (!it) return;
      const id = parseInt(it.getAttribute('data-id'), 10);
      const e = entries.find(function (x) { return x.id === id; });
      if (e) pick(e);
    });
    if (el.btnRandom) el.btnRandom.addEventListener('click', function () {
      apply();
      if (!view.length) return;
      pick(view[Math.floor(Math.random() * view.length)]);
    });

    /* ---------- 初始化 ---------- */
    ensure();
    fillOpenings();
    apply();

    return {
      refresh: apply,
      get entries() { return entries; },
      get view() { return view; },
      pick: pick,
      relatedGames: relatedGames,            // ★ 开局库 → 棋谱库关联（§12.4.5）
      // 供测试 / 自动化：按开局名取第一条
      findOpening: function (name) {
        ensure();
        return entries.find(function (e) { return e.opening === name; }) || null;
      },
      // 供测试 / 自动化：按索引取条目
      at: function (i) { ensure(); return entries[i] || null; },
      count: function () { return entries.length; },
    };
  }

  /* ============================================================
   * 二、开局库命中标注（回放局面 → 命中信息）
   * ============================================================ */
  /* ★ 平移归一（R10：模式识别）——把着法序列整体平移，使**第一手落在天元**。
   *   为什么以第一手为锚：开局形态由"前三手的相对位置"定义，而 RIF 库里黑1 恒在天元；
   *   无禁手对局黑1 可以落在任何位置 ⇒ 平移对齐后才能与库匹配。
   *   旋转/镜像由 canonSeq 的 8 对称覆盖（实测 927/927 局旋转 90° 后 canonical 不变），无需另做。
   *   返回 { seq, dx, dy }（seq = 平移后的 idx 序列，dx/dy = 平移量）；形状放不进棋盘 ⇒ null；
   *   已对齐（第一手就是天元，如 Renju 局面）⇒ null（无需平移，直接匹配即可）。 */
  function transNorm(idxs) {
    if (!idxs || !idxs.length) return null;
    const dx = 7 - (idxs[0] % 15), dy = 7 - ((idxs[0] / 15) | 0);
    if (!dx && !dy) return null;
    const seq = [];
    for (const i of idxs) {
      const x = (i % 15) + dx, y = ((i / 15) | 0) + dy;
      if (x < 0 || x > 14 || y < 0 || y > 14) return null;
      seq.push(y * 15 + x);
    }
    return { seq: seq, dx: dx, dy: dy };
  }

  /* 返回结构：
   *   { hit:boolean, depth:number, cands:[{x,y,coord,n,rate}], games:number,
   *     opening:string|null, best:{x,y,coord,n,rate}|null, trans:{dx,dy}|null }
   * 语义：
   *   · 把当前局面的**落子序列**喂给前缀树（treeMove 的同一条下探路径），
   *     看"这个前缀在真实对局库里有没有后继"。
   *   · depth = 能一路匹配到第几手（= hist.length 表示整条都在树上）。
   *   · cands = 库中该前缀的实际后继着法及其样本量/胜率（按样本量降序）。
   *   · shift = {dx,dy} 时先做平移归一（模式识别），候选坐标**映射回真实盘面**后再返回。
   */
  function probeTree(hist, shift) {
    const out = { hit: false, depth: 0, cands: [], games: 0, opening: null, best: null, trans: shift ? { dx: shift.dx, dy: shift.dy } : null };
    let tree = null;
    try { tree = BK && BK.defaultTree ? BK.defaultTree() : null; } catch (e) { tree = null; }
    if (!tree || !hist || !hist.length) return out;

    // 平移（可选）：seq 是"实际拿去匹配的序列"；候选最终要映射回**原坐标**。
    let seq = hist, dx = 0, dy = 0;
    if (shift) {
      for (const i of hist) {
        const x = (i % 15) + shift.dx, y = ((i / 15) | 0) + shift.dy;
        if (x < 0 || x > 14 || y < 0 || y > 14) return out;      // 平移后越界 ⇒ 放弃
      }
      seq = hist.map(i => ((i / 15 | 0) + shift.dy) * 15 + ((i % 15) + shift.dx));
      dx = shift.dx; dy = shift.dy;
    }

    // 下探：与 book.treeMove 完全相同的规范坐标规则（canonSeq 取末元素作边）
    let node = tree, depth = 0;
    while (depth < seq.length) {
      if (!node || node.size === 0) break;
      let c = null;
      try { c = OP.canonSeq(seq.slice(0, depth + 1)); } catch (e) { c = null; }
      if (!c) break;
      const child = node.get(c.arr[c.arr.length - 1]);
      if (!child) break;
      node = child.c; depth++;
    }
    if (depth === 0) return out;
    out.depth = depth;
    const o3 = seq.length >= 3 ? (function () { try { return OP.identify(seq.slice(0, 3)); } catch (e) { return null; } })() : null;
    out.opening = o3 ? o3.name : null;
    if (!node || node.size === 0) return out;         // 匹配到了尽头（库里没有后继）

    // 候选着法：node 的键是**规范坐标**（0 基 idx），要映回真实盘面
    out.hit = true;
    let ti = 0;
    try {
      const c = OP.canonSeq(seq);
      ti = c.ti;
    } catch (e) { ti = 0; }
    const f = (OP.SYM && OP.SYM[OP.SYM_INV[ti]]) || function (a, b) { return [a, b]; };
    /* 已占点集合：前缀树的键是**规范坐标**，同一节点可能混入不同对称分支的边。
     * 极少数边映回原盘面后会落在已占点上（Node 实测 2193 个候选里 5 个）。
     * 引擎侧本来就会挡掉（search.openingMove 的 `pos.board[i] !== EMPTY → null`），
     * 这里同样过滤，避免标注里出现"落在已有棋子上的候选"这种明显错误。 */
    const occupied = new Set(hist);
    const arr = [];
    for (const [m, e] of node) {
      const p = f(m % 15, (m / 15) | 0);
      let px = p[0], py = p[1];
      if (shift) { px -= dx; py -= dy; }              // 平移匹配 ⇒ 映回"平移前"的真实坐标
      const i = py * 15 + px;
      if (px < 0 || px > 14 || py < 0 || py > 14) continue;   // 平移回映可能出界 ⇒ 过滤
      if (i < 0 || i > 224 || occupied.has(i)) continue;
      arr.push({ x: px, y: py, coord: coord(px, py), n: e.n, rate: e.r });
      out.games += e.n;
    }
    arr.sort(function (a, b) { return b.n - a.n || b.rate - a.rate; });
    if (!arr.length) { out.hit = false; out.games = 0; return out; }   // 全被过滤 ⇒ 视作未命中
    out.cands = arr;
    out.best = arr[0] || null;
    return out;
  }

  // 渲染命中标注到 #recBookHit
  /* 三种情形措辞不同（用户要的"标注命中的数量"就在前两种里给足）：
   *   A. hit=true            → 命中：开局面 + 匹配深度 + 后继候选数 + 样本局数 + 候选明细；
   *   B. hit=false 但 depth>0 → 部分命中：前缀匹配到第 depth 手，但该分支在库里没有后继
   *                            （真实对局到此为止）。这是"命中过"而非"没命中"，如实说明。
   *   C. depth=0            → 完全未命中：当前局面不是任何库中棋谱的前缀。
   */
  /* ============================================================
   * 三、把「开局库命中」与「本棋谱库的具体对局」连起来（§12.4.5）
   * ============================================================ */
  /* ★ 两个口径必须分开显示，别混成一个数：
   *   · `样本 N 局`   = **开局库（前缀树）**的样本量，来自全量 11522 局聚合；
   *   · `本库 K 局`   = **棋谱库**里真正能点开阅读的完整对局数（927 局的子集）。
   *   两者同源（RenjuNet），但 K ≤ N 且可能差很多（越深越明显）。
   */
  function relatedHtml(rel, maxRows, isTrans) {
    if (!rel || !rel.length) return '';
    const n = Math.min(rel.length, maxRows || 8);
    const rows = [];
    for (let k = 0; k < n; k++) {
      const e = rel[k];
      rows.push('<div class="bl-rel-item" data-id="' + e.id + '" title="点击进入读谱模式：' +
        esc(e.black) + ' vs ' + esc(e.white) + '（' + e.n + ' 手）">' +
        '<span class="vs">' + esc(e.black) + ' vs ' + esc(e.white) + '</span>' +
        '<span class="rs">' + resultText(e.result) + '</span>' +
        '<span class="ln">' + e.n + ' 手</span>' +
        '</div>');
    }
    if (rel.length > n) rows.push('<div class="bl-empty">… 另有 ' + (rel.length - n) + ' 局，见下方列表</div>');
    return '<div class="bl-rel"><b>本棋谱库中经过此局面的对局 ' + rel.length + ' 局</b>' +
      (isTrans ? '（按<b>平移识别</b>匹配）' : '') + '（点开即进入读谱模式）<div class="bl-rel-list">' + rows.join('') + '</div></div>';
  }

  /**
   * 渲染"当前局面 ↔ 开局库 / 棋谱库"的匹配面板。
   * ★ R10 模式识别：直接匹配不上时，尝试**平移归一**（黑1 对齐天元）再匹配一次；
   *   旋转/镜像由 canonSeq 的 8 对称天然覆盖（927 局实测旋转 90° 后 canonical 全部不变），
   *   平移是无禁手开局（黑1 不在天元）真正缺的那块。平移命中时**如实标注**，
   *   候选坐标已映射回真实盘面（越界/已占的回映候选会被过滤）。
   * @param {number[]} hist            当前落子序列（idx）
   * @param {function} [onOpenOpening] 点开局名 → 打开该开局的第一条棋谱
   * @param {function} [onOpenGame]    点某条具体棋谱（条目对象）→ 进入读谱模式
   * @param {object}   [lib]           棋谱库实例（提供 relatedGames）；缺省则退回全局单例
   */
  function renderHit(hist, onOpenOpening, onOpenGame, lib) {
    const box = $('recBookHit');
    if (!box) return null;
    /* 空盘：给一句可读的占位（看不出这里本该显示什么的空白就是坏设计） */
    if (!hist || !hist.length) {
      box.innerHTML = '<div class="bl-hit none">开局库匹配：<b>尚未落子</b>' +
        '（下满 3 手后显示本局面的开局库命中、后继候选与可阅读的具体棋谱）</div>';
      return null;
    }
    let r = probeTree(hist);
    let seq = hist, isTrans = false;
    if (!r.hit) {
      const t = transNorm(hist);
      if (t) {
        const r2 = probeTree(hist, t);
        if (r2.hit || r2.depth > r.depth) { r = r2; seq = t.seq; isTrans = true; }
      }
    }
    const transTag = isTrans ? '<span class="dim">（<b>平移识别</b> · 黑1 对齐天元后匹配）</span>' : '';

    // 本库关联（精确前缀匹配；平移识别时用平移后的序列 ⇒ 形态相同的库局也能关联上）
    let rel = [];
    const L = lib || sharedLib;
    if (L && L.relatedGames) {
      try { rel = L.relatedGames(seq); } catch (e) { rel = []; }
    }
    r.related = rel;
    r.trans = isTrans;
    const relBox = relatedHtml(rel, 8, isTrans);

    const bind = function () {
      if (onOpenOpening) {
        const a = box.querySelector('.bl-open');
        if (a) a.addEventListener('click', function () { onOpenOpening(r.opening); });
      }
      if (onOpenGame) {
        const items = box.querySelectorAll('.bl-rel-item');
        for (let k = 0; k < items.length; k++) {
          items[k].addEventListener('click', function () {
            const id = parseInt(items[k].getAttribute('data-id'), 10);
            const e = (L && L.at) ? L.at(id) : null;
            if (e) onOpenGame(e);
          });
        }
      }
    };

    if (!r.hit) {
      if (r.depth > 0) {
        const op = r.opening
          ? '<span class="bl-open" data-opening="' + esc(r.opening) + '">' + esc(r.opening) + '</span>'
          : '—';
        box.innerHTML = '<div class="bl-hit none">开局库：<b>部分命中</b>' + transTag + ' · 开局 ' + op +
          ' · 前缀匹配到第 <b>' + r.depth + '</b> 手，该分支在库中<b>没有后继</b>' +
          '（真实对局最多下到这里）' + relBox + '</div>';
        bind();
      } else {
        box.innerHTML = '<div class="bl-hit none">开局库：<b>未命中</b>（当前局面不是任何库中棋谱的前缀，平移对齐后也不是）</div>';
      }
      return r;
    }

    const top = r.cands.slice(0, 8);
    const openLink = r.opening
      ? '<span class="bl-open" data-opening="' + esc(r.opening) + '">' + esc(r.opening) + '</span>'
      : '—';
    box.innerHTML =
      '<div class="bl-hit">开局库：<b>命中</b>' + transTag + ' · 开局 ' + openLink +
      ' · 匹配深度 <b>' + r.depth + '</b> 手' +
      ' · 后继候选 <b>' + r.cands.length + '</b> 个 · 样本 <b>' + r.games + '</b> 局' +
      '<div class="bl-cands">' +
      top.map(function (c, i) {
        const pct = Math.round((c.rate || 0) * 100);
        return '<span class="bl-cand' + (i === 0 ? ' top' : '') + '" title="' +
          c.n + ' 局 · 胜率 ' + pct + '%">' + esc(c.coord) + ' ' + c.n + '/' + pct + '%</span>';
      }).join('') +
      (r.cands.length > top.length ? '<span class="bl-cand">…</span>' : '') +
      '</div>' + relBox + '</div>';
    bind();
    return r;
  }

  /* 共享的棋谱库实例（由 main 通过 setLib 注入，供 renderHit 做关联查询） */
  let sharedLib = null;
  function setLib(lib) { sharedLib = lib; }

  window.G = window.G || {};
  window.G.booklib = {
    create: create, probeTree: probeTree, renderHit: renderHit, setLib: setLib, transNorm: transNorm,
    coord: coord, resultText: resultText,
  };
})();
