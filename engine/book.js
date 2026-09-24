/* engine/book.js — 开局库：格式 / 导入解析 / 索引 / 查询 / 校验
 * 设计依据：§12 开局库（BookLine 格式）、§9 棋谱解析、§27 错误码
 *
 * BookLine 格式：
 *   { ruleSet:'freestyle'|'rif', opening:'花月局', moves:[[x,y],...], weight:1, source:'generated' }
 * 索引：以「落子序列（idx）」为键；加载时把每条线做 8 种对称展开 → 查询时键为原始序列，天然覆盖镜像/旋转。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'), require('./data/openings.js'));
  else { root.G = root.G || {}; root.G.book = factory(root.G.core, root.G.openings); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, OP) {
  'use strict';
  const { N, idxOf } = core;
  const VERSION = 1;

  /* ---------- 校验 ---------- */
  function validateLine(e) {
    if (!e || !Array.isArray(e.moves) || e.moves.length < 3) return 'E_LINE';
    const seen = new Set();
    for (const m of e.moves) {
      if (!Array.isArray(m) || m.length < 2) return 'E_FORMAT';
      const x = m[0], y = m[1];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 14 || y < 0 || y > 14) return 'E_RANGE';
      const i = idxOf(x, y);
      if (seen.has(i)) return 'E_OCCUPIED';
      seen.add(i);
    }
    return null;
  }

  /* ---------- 棋谱文本解析（§9.1 / §27）---------- */
  // Renju 记谱（"1.H8 2.I9"、"H8 H9 I9"）或坐标对（"7,7 7,6"、"(7,7)(7,6)"）
  function parseRecord(text) {
    const s = String(text == null ? '' : text);
    if (/[A-Za-z]\s*\d/.test(s)) {
      // 只保留"含字母"的 token（步数前缀如 "1." 会被拆掉），逐个严格校验
      const toks = s.replace(/[().,;、\t\r\n]+/g, ' ').split(/\s+/).filter(t => /[A-Za-z]/.test(t));
      const moves = [];
      for (const t of toks) {
        if (!/^[A-Oa-o]\d{1,2}$/.test(t)) return { ok: false, error: 'E_PARSE', token: t };
        const p = OP.R(t.toUpperCase());
        if (p.x < 0 || p.x > 14 || p.y < 0 || p.y > 14) return { ok: false, error: 'E_RANGE', token: t };
        moves.push([p.x, p.y]);
      }
      if (!moves.length) return { ok: false, error: 'E_PARSE' };
      return { ok: true, mode: 'renju', moves: moves };
    }
    const nums = (s.match(/\d+/g) || []).map(Number);
    if (nums.length < 2 || nums.length % 2 !== 0) return { ok: false, error: 'E_PARSE' };
    const oneBased = nums.indexOf(0) === -1;                 // 出现 0 → 0 基，否则 1 基
    const moves = [];
    for (let i = 0; i < nums.length; i += 2) {
      const x = nums[i] - (oneBased ? 1 : 0), y = nums[i + 1] - (oneBased ? 1 : 0);
      if (x < 0 || x > 14 || y < 0 || y > 14) return { ok: false, error: 'E_RANGE' };
      moves.push([x, y]);
    }
    return { ok: true, mode: 'xy', moves: moves };
  }

  function toRenjuText(moves) {
    return moves.map(m => OP.R ? (String.fromCharCode(65 + m[0]) + (15 - m[1])) : '').join(' ');
  }

  /* ---------- 索引构建（含 8 种对称展开）---------- */
  function push(index, key, item) {
    let list = index.get(key);
    if (!list) { list = []; index.set(key, list); }
    for (const c of list) if (c.x === item.x && c.y === item.y && c.ruleSet === item.ruleSet) { c.w += item.w; return; }
    list.push(item);
  }

  function build(entries) {
    const index = new Map();
    const bad = [];
    for (const e of entries) {
      const err = validateLine(e);
      if (err) { bad.push({ opening: e && e.opening, error: err }); continue; }
      for (const f of OP.SYM) {
        const mv = e.moves.map(m => { const p = f(m[0], m[1]); return [p[0], p[1]]; });
        const prefix = [];
        // ★ v3.20：连 k=0 也建键（空历史 '' → 该线第一手）。原写法 `if (k > 0)` 把**黑 1**漏掉了
        //   ⇒ 空盘查库必然 miss，开局第 1 手只能退回搜索（实测白花 261ms）。
        //   安全性：调用方（search.openingMove）已用 `hist.length === stones` 挡住
        //   "棋盘有子但历史为空"的构造局面，故 '' 只可能对应真正的空盘。
        for (let k = 0; k < mv.length; k++) {
          push(index, prefix.join(','), { x: mv[k][0], y: mv[k][1], w: e.weight == null ? 1 : e.weight, opening: e.opening, ruleSet: e.ruleSet, source: e.source });
          prefix.push(idxOf(mv[k][0], mv[k][1]));
        }
      }
    }
    return { index: index, rejected: bad };
  }

  /* ---------- 查询 ---------- */
  // historyIdxs：从第 1 手起的落子 idx 序列（与对称无关，内部按原序列查）
  function bookMove(index, historyIdxs, opts) {
    const key = historyIdxs.join(',');
    const list = index.get(key);
    if (!list || !list.length) return null;
    const ruleSet = opts && opts.ruleSet;
    let use = list;
    if (ruleSet) { const f = list.filter(c => !c.ruleSet || c.ruleSet === ruleSet); if (f.length) use = f; }
    // ★ 只在前 topK 个高频候选里抽样：避免长尾的低频/冷门变体稀释实战强度
    const topK = (opts && opts.topK) | 0;
    if (topK > 0 && use.length > topK) {
      use = use.slice().sort((a, b) => b.w - a.w).slice(0, topK);
    }
    let tot = 0;
    for (const c of use) tot += c.w;
    const rnd = (opts && opts.rnd) || Math.random;
    let r = rnd() * tot;
    for (const c of use) { r -= c.w; if (r <= 0) return c; }
    return use[use.length - 1];
  }

  // 从布面重建历史 idx（用于查询）
  function historyIdxsOf(moves) { return moves.map(m => idxOf(m[0], m[1])); }

  /* ---------- 默认开局库（懒加载单例，供 search.think 使用）----------
   * 数据来源：Node 下 require 本目录数据文件；浏览器/worker 下取 `G.bookLines`
   * （数据文件是 UMD，被 tools/build-worker-src.js 打进产物并在 index.html 里以 script 加载）。
   * 没有数据 ⇒ 返回 false，**静默禁用开局库**（不影响其余功能）。
   * ⚠ 这是**开局片段线库**（前 10 手 + 频次），只作 `search.openingMove` 的**回落路径**
   *   （树未命中时用）。**不是** UI 上那个"棋谱库"——后者见下方 bookGames()。
   */
  let _def = null;
  function linesModule() {
    try { if (typeof require === 'function') return require('./data/book-lines.js'); } catch (e) { /* 无数据 */ }
    return (typeof globalThis !== 'undefined' && globalThis.G && globalThis.G.bookLines) || null;
  }
  function defaultBook() {
    if (_def !== null) return _def;
    const m = linesModule();
    _def = (m && typeof m.unpack === 'function') ? build(m.unpack()) : false;
    return _def;
  }
  function defaultMove(historyIdxs, opts) {
    const b = defaultBook();
    if (!b) return null;                       // false = 无数据
    return bookMove(b.index, historyIdxs, opts);
  }
  /* 线库模块访问器（Node 侧工具/测试用；UI 已改用 bookGames） */
  function bookLinesModule() { return linesModule(); }
  function bookLines() {
    const m = linesModule();
    return (m && typeof m.unpack === 'function') ? m.unpack() : null;
  }
  /* ★ 完整棋谱库（`data/book-games.js`）**刻意不在这里开访问器**：它是纯 UI 关注点
   *   （给人读 + 做关联），引擎用不到 ⇒ 放进 worker 产物是白涨体积（§12.4.5）。 */

  /* ================= 前缀匹配树（§12.4.3）=================
   * 模型（用户指定）：
   *   从**已下 2 手**开始匹配 → 命中约 26 个"第 3 手"候选，看各自标记的历史胜率，
   *   优先下胜率更高的；再以 3 手下探（约 100+ 候选）看第 4 手……**直到匹配不上任何棋谱**。
   *
   * 与线库（build/bookMove）的区别：
   *   · 线库只存"完整开局线 + 频次"，没有胜负信息 ⇒ 只能按热度随机抽；
   *   · 树存"每个前缀下的候选着 + (频次 n, 胜率 r)" ⇒ 可以**按实战胜率选点**。
   *
   * ★ 两个容易写错的地方（都已在 openings.canonSeq 注释里给出证明/反例）：
   *   ① 每层必须用 canon(整段前缀) 的**最后一个元素**作边，不能沿用父节点挑的那个 ti
   *      ——稳定子群非平凡（例如只有一个天元时 8 个变换全固定它）会让同形的两局分家。
   *   ② 候选着法在**规范坐标系**里，必须用它爹的逆变换映回原盘面：
   *      t(真实)=规范 ⇒ 真实 = t⁻¹(规范)。SYM 里 5/6 是 90° 旋转（4 阶、非对合），
   *      故必须用 SYM_INV，不能直接用同一个 f。
   */
  /* ★ 收缩系数 K（§12.4.3）：留出集标定，非拍脑袋。
   *   11522 局对半切（两次独立切分都指向同一个点）：logloss 最小处 K=120（0.6884 / 0.6863），
   *   K∈[80,200] 曲线平坦 ⇒ 取 120。参考线：常数 0.5 的 logloss = 0.693。
   *   K 太小的代价是追噪声（n=18 的 0.833 会被当成近确定性证据）；K→∞ 则退化成"只看频次"。
   */
  const BOOK_SHRINK = 120;

  /* ★ "统计上分不开"的带宽（胜率差）。见 treeMove 里的赢家诅咒说明。
   *   ⚠ 与 BOOK_SHRINK 不同，这个值**没有**留出集标定支持（反事实不可观测），是保守修正。 */
  const BOOK_TIE = 0.02;

  let _tree = null;
  function treeModule() {
    try { if (typeof require === 'function') return require('./data/book-tree.js'); } catch (e) { /* 无数据 */ }
    return (typeof globalThis !== 'undefined' && globalThis.G && globalThis.G.bookTree) || null;
  }
  function defaultTree() {
    if (_tree !== null) return _tree;
    const m = treeModule();
    _tree = (m && typeof m.unpack === 'function') ? m.unpack() : false;
    return _tree;
  }

  /**
   * 前缀树下探 + 按胜率选点。
   * @param tree  unpack() 出来的 Map（null 表示无数据）
   * @param hist  已下手的 idx 序列（第 1 手起，0 基 x,y → y*15+x）
   * @param opts  { shrink=BOOK_SHRINK }  收缩系数（经验贝叶斯：score=(w+K·prior)/(n+K)）
   * @returns null（匹配不上/无数据）或
   *          { x, y, n, rate, score, prior, depth, cands, games, opening, source }
   */
  function treeMove(tree, hist, opts) {
    if (!tree) return null;
    const K = (opts && opts.shrink) > 0 ? opts.shrink : BOOK_SHRINK;
    if (!Array.isArray(hist)) return null;
    let node = tree, prior = 0.5, depth = 0, ti = 0;

    /* ---- 下探。★ 只有**整条 hist 都在树上**才可用：
     *   若中途某一手匹配不上，那么"当前节点"给出的是**已经下过的那一手**的候选，
     *   拿它当我们要走的那手是错的（等于替对手回溯）⇒ 直接放弃，交回搜索。 */
    while (depth < hist.length) {
      if (!node || node.size === 0) return null;
      const c = OP.canonSeq(hist.slice(0, depth + 1));
      const child = node.get(c.arr[c.arr.length - 1]);
      if (!child) return null;
      /* ★ 先验两件事，缺一不可：
       *   ① **翻面**：边上的 r 是"走那一手的一方"的胜率；轮到我们时对手已下完那手，
       *      我方的先验胜率是 1 − r。
       *   ② **先验本身也要收缩**：必须用父边的**收缩后**胜率，而不是原始胜率。
       *      原始胜率在 n=2 时只能取 {0, .5, 1}，翻面后先验 ∈{1, .5, 0} 极端过信。
       *      ★ 留出集实测（_tune-book-k.js，11522 局对半切，两次切分一致）：
       *        原始先验 logloss 0.757（**比常数 0.5 的 0.693 还差**）；
       *        收缩先验 logloss 0.688 —— 只有后者才真有预测力。 */
      prior = 1 - (child.r * child.n + K * prior) / (child.n + K);
      node = child.c; ti = c.ti; depth++;
    }
    if (!node || node.size === 0) return null;

    /* ---- 选点，两趟：
     *   第 1 趟：算全体候选的收缩胜率，取最大值 M。
     *   第 2 趟：在 [M − TIE, M] 这个"统计上分不开"的带子里，取**样本量最大**的那个。
     *
     * ★ 为什么不能直接取 argmax —— **赢家诅咒**：
     *   噪声最大的候选（n 小）也最容易蹦到最高分。实测就有这么一手：丘月局深度 3，
     *   4 个候选共 396 局，argmax 选中的是 **n=4** 那一手，而它只以 **0.006** 的分差
     *   赢过主流着法 —— 两个估计之差的标准误约 0.05，这点分差纯属噪声。
     *   而且还有一层**混淆**：冷门着法之所以冷门，很可能正因为它是坏棋
     *   （专门研究过的人不这么下）。所以"薄样本 ≈ 先验"这个假设偏乐观。
     *   ⇒ 分不开时就偏向证据多的那一手。TIE=0.02 约等于 n≈100~400 两候选之差的半个标准误。
     * ⚠ 诚实标注：K 是留出集标定出来的，但 **TIE 不是**（反事实观测不到，标不了）。
     *   它是按标准"赢家诅咒"理论做的保守修正，列入 follow-up 待更强证据。
     */
    // ⚠ 用 typeof 判断而不是 `> 0`：tie=0 是**合法值**（退回纯 argmax），测试要拿它做反向对照
    const TIE = (opts && typeof opts.tie === 'number') ? opts.tie : BOOK_TIE;
    let M = -Infinity, cands = 0, games = 0;
    for (const [, e] of node) {
      cands++; games += e.n;
      const sc = (e.r * e.n + K * prior) / (e.n + K);
      if (sc > M) M = sc;
    }
    let best = null, argmax = null;
    for (const [m, e] of node) {
      const sc = (e.r * e.n + K * prior) / (e.n + K);
      if (!argmax || sc > argmax.score + 1e-12) argmax = { m: m, score: sc, n: e.n, rate: e.r };
      if (sc < M - TIE) continue;                       // 明显更差 ⇒ 不看
      if (!best || e.n > best.n) best = { m: m, score: sc, n: e.n, rate: e.r };
    }
    if (!best) return null;

    /* ---- 映回原盘面 */
    const f = OP.SYM[OP.SYM_INV[ti]];
    const p = f(best.m % N, (best.m / N) | 0);
    const o = hist.length >= 3 ? OP.identify(hist.slice(0, 3)) : null;
    return { x: p[0], y: p[1], n: best.n, rate: best.rate, score: best.score, prior: prior,
             depth: depth, cands: cands, games: games, w: best.n,
             topScore: M, tie: TIE, argmaxN: argmax ? argmax.n : 0,
             opening: o ? o.name : null, source: 'renjunet-tree' };
  }

  function defaultTreeMove(historyIdxs, opts) {
    const t = defaultTree();
    if (!t) return null;                       // false = 无数据
    return treeMove(t, historyIdxs, opts);
  }

  return { VERSION, validateLine, parseRecord, toRenjuText, build, bookMove, historyIdxsOf,
           defaultBook, defaultMove, hasData: () => !!defaultBook(),
           bookLinesModule, bookLines,       // 开局片段线库（引擎回落用；Node 侧工具/测试）
           /* §12.4.3 前缀树 */
           BOOK_SHRINK, BOOK_TIE, treeModule, defaultTree, treeMove, defaultTreeMove,
           hasTree: () => !!defaultTree() };
});
