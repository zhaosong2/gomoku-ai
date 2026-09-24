/* test/ui-features.test.js — 本次四项 UI 需求的**可 Node 测部分**
 *
 * 背景：四项需求大多在浏览器侧（Canvas 绘制 / DOM / localStorage），完整验收由
 *   `tools/browser-feat-check.js` 负责（须沙箱外）。但其中三块逻辑是**纯函数**，
 *   可以在 Node 里逐条守住：
 *     1. 坐标标注口径：render.colLabel/rowLabel 必须与 record.coordText 逐点一致，
 *        且与 openings.R（"H8" → {7,7}）同一映射。
 *     2. 棋谱库数据：book-lines 能 unpack，条数/开局名集合稳定。
 *     3. 开局库命中探测（booklib.probeTree 的核心逻辑）：下探深度、候选合法性。
 *        —— 这里用与 ui/booklib.js 相同的算法在 Node 重跑，防止"改了一处忘了另一处"。
 *
 * ★ 为什么 ui/render.js 能在 Node 里 require：
 *   它是 UMD（module.exports = factory()），不碰 DOM 的部分（常量与坐标函数）可直接取用。
 *   Renderer 构造需要 canvas，故本文件只测模块级导出的 colLabel/rowLabel。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const core = require('../engine/core.js');
const OP = require('../engine/data/openings.js');
const REC = require('../engine/record.js');
const BOOK = require('../engine/book.js');
const DATA = require('../engine/data/book-lines.js');
const RENDER = require(path.join(__dirname, '..', 'ui', 'render.js'));

const { idxOf } = core;

/* ============ 一、坐标标注口径 ============ */
test('坐标标注：render.colLabel/rowLabel 与 record.coordText 逐点一致（225 点）', () => {
  let mismatch = [];
  for (let x = 0; x < 15; x++) for (let y = 0; y < 15; y++) {
    const a = RENDER.colLabel(x) + RENDER.rowLabel(y);
    const b = REC.coordText(x, y);
    if (a !== b) mismatch.push(a + '!=' + b);
  }
  assert.deepEqual(mismatch, [], '坐标口径不一致：' + mismatch.slice(0, 5).join(' '));
});

test('坐标标注：与开局库 openings.R 同一映射（天元 H8 = {7,7}）', () => {
  assert.equal(RENDER.colLabel(7) + RENDER.rowLabel(7), 'H8');
  const p = OP.R('H8');
  assert.deepEqual({ x: p.x, y: p.y }, { x: 7, y: 7 });
  // 逐点互反：任意 (x,y) 的标注经 openings.R 还原应回到原点
  for (const [x, y] of [[0, 0], [14, 0], [0, 14], [14, 14], [3, 11]]) {
    const q = OP.R(RENDER.colLabel(x) + RENDER.rowLabel(y));
    assert.deepEqual({ x: q.x, y: q.y }, { x, y }, `互反失败 (${x},${y})`);
  }
});

test('坐标标注：列 A–O、行 15–1，且首行首列为边界值', () => {
  assert.equal(RENDER.colLabel(0), 'A');
  assert.equal(RENDER.colLabel(14), 'O');
  assert.equal(RENDER.rowLabel(0), '15');            // 棋盘最上一行 = 15
  assert.equal(RENDER.rowLabel(14), '1');            // 最下一行 = 1
});

/* ============ 二、棋谱库数据 ============ */
test('棋谱库：book-lines 可 unpack，588 条 / 26 开局（引擎回落的开局片段库）', () => {
  const e = DATA.unpack();
  assert.equal(e.length, 588);
  const names = new Set(e.map(x => x.opening));
  assert.equal(names.size, 26);
  // 每条至少 3 手（开局定义要求），坐标在盘内
  for (const x of e) {
    assert.ok(Array.isArray(x.moves) && x.moves.length >= 3, '手数不足：' + x.opening);
    for (const m of x.moves) {
      assert.ok(m[0] >= 0 && m[0] <= 14 && m[1] >= 0 && m[1] <= 14, '坐标越界');
    }
  }
});

test('棋谱库访问器：book.bookLines() 能取到原始条目（引擎回落用）', () => {
  const e = BOOK.bookLines();
  assert.ok(Array.isArray(e) && e.length === 588, 'bookLines() 应返回 588 条');
  assert.ok(e[0].moves && e[0].opening, '条目需含 moves / opening');
  assert.equal(typeof BOOK.bookLinesModule, 'function');
});

/* ★ v3.35（需求2）：UI 上的「棋谱库」换成了 **完整棋谱**（book-games）。
 *   与上面的开局片段库（book-lines）是**两个不同用途**的数据文件，两条都要守。 */
const GAMES = require('../engine/data/book-games.js');

test('R6-1 完整棋谱库：927 局 / 26 开局，且**每局都是完整对局**（不是前几步）', () => {
  const e = GAMES.unpack();
  assert.equal(e.length, 927, '应为 927 局');
  assert.equal(new Set(e.map(x => x.opening)).size, 26, '应覆盖 26 种开局');
  // ★ 与旧线库最本质的区别：手数。旧库固定 10 手（片段），本库是完整对局。
  const lens = e.map(x => x.moves.length);
  const min = Math.min.apply(null, lens);
  assert.ok(min >= 25, '最短也要 25 手（生成器 MINPLIES），实测 = ' + min);
  assert.ok(Math.max.apply(null, lens) > 100, '应有长对局（最长实测 180 手）');
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  assert.ok(avg > 40, '平均手数应 > 40（实测 47.9），实际 = ' + avg.toFixed(1));
  // 元信息齐备：棋手名 + 结果
  for (const x of e.slice(0, 50)) {
    assert.ok(x.black && x.white, '应有双方棋手');
    assert.ok(x.result === 0 || x.result === 1 || x.result === 2, '结果码应为 0/1/2');
  }
});

test('R6-2 完整棋谱库：逐局合法性（无越界 / 无重复落点 / 开局名与前三手一致）', () => {
  const e = GAMES.unpack();
  let oob = 0, dup = 0, badOpen = 0;
  for (const g of e) {
    const seen = new Set();
    for (const m of g.moves) {
      if (m[0] < 0 || m[0] > 14 || m[1] < 0 || m[1] > 14) oob++;
      const k = m[1] * 15 + m[0];
      if (seen.has(k)) dup++;
      seen.add(k);
    }
    const o = OP.identify(g.moves.slice(0, 3).map(m => m[1] * 15 + m[0]));
    if (!o || o.name !== g.opening) badOpen++;
  }
  assert.equal(oob, 0, '不得有越界坐标');
  assert.equal(dup, 0, '同一局内不得重复落点');
  assert.equal(badOpen, 0, '每局前三手必须能 identify 出条目里的开局名');
});

test('R6-3 完整棋谱库：由**主线程 UI 直接读** G.bookGames（引擎不开访问器 ⇒ 不占 worker 体积）', () => {
  /* ★ 设计取舍（v3.35）：完整棋谱库是纯 UI 关注点，`engine/book.js` **故意不提供** bookGames 访问器
   *   —— 它只装引擎用得到的东西（决策走前缀树、回落走片段线库）。放进去会让 worker 产物白涨约 0.6 KB，
   *   而产物上限只剩不到 1 KB 余量。所以这里断言的是"**引擎不应有**该访问器"，
   *   而 UI 直接读数据模块本身（下一条测试守数据正确性）。 */
  assert.equal(BOOK.bookGames, undefined, 'bookGames 不应出现在引擎导出里（它是 UI 关注点）');
  assert.equal(typeof GAMES.unpack, 'function', '数据模块自身必须提供 unpack');
  assert.equal(GAMES.unpack().length, 927, '数据模块应能解出 927 局');
  // ★ 两个库互不干扰：线库仍是 588 条 10 手片段
  assert.equal(BOOK.bookLines().length, 588, 'bookLines 不应被替换');
});

test('R6-4 开局库 → 棋谱库关联：canonSeq 前缀性质（关联算法的正确性基础）', () => {
  /* ui/booklib.relatedGames 依赖："若当前前缀的规范形 == 某局规范形的前 k 位，
   * 则该局确实走过这个局面"。这条性质来自 §12.4.3 的 m(S++x) = m(S) ++ min_{t∈T(S)} t(x)。
   * 这里直接用数据验：任取一局的第 k 手规范前缀，必须等于 canonSeq(整局) 的前 k 位。 */
  const e = GAMES.unpack();
  let bad = 0, checked = 0;
  for (let g = 0; g < Math.min(40, e.length); g++) {
    const idx = e[g].moves.map(m => m[1] * 15 + m[0]);
    const full = OP.canonSeq(idx).arr;
    for (const k of [3, 5, 8, 12]) {
      if (k > idx.length) continue;
      const pre = OP.canonSeq(idx.slice(0, k)).arr;
      checked++;
      for (let j = 0; j < k; j++) if (pre[j] !== full[j]) { bad++; break; }
    }
  }
  assert.ok(checked > 100, '应至少校验 100 组，实际 ' + checked);
  assert.equal(bad, 0, '规范前缀必须是整局规范形的前缀（否则关联会错配）');
});

test('R6-5 关联语义：整局自身的每一段前缀都应能关联到自己', () => {
  /* 用真实数据模拟 relatedGames 的判据：对某局，取它的前 k 手作为"当前局面"，
   * 则该局自己必须在结果集里（自反性）；且**不能**把完全不同开局的局卷进来。 */
  const e = GAMES.unpack();
  const canon = e.map(g => OP.canonSeq(g.moves.map(m => m[1] * 15 + m[0])).arr);
  let selfMiss = 0;
  for (let g = 0; g < 60; g++) {
    const ck = OP.canonSeq(e[g].moves.slice(0, 6).map(m => m[1] * 15 + m[0])).arr;
    const hitIdx = [];
    for (let j = 0; j < e.length; j++) {
      const c = canon[j];
      if (c.length < ck.length) continue;
      let ok = true;
      for (let k = 0; k < ck.length; k++) if (c[k] !== ck[k]) { ok = false; break; }
      if (ok) hitIdx.push(j);
    }
    if (hitIdx.indexOf(g) < 0) selfMiss++;
    // 命中的必须与查询局**同开局**（前 3 手决定开局，所以前缀一致必然同开局）
    for (const j of hitIdx) if (e[j].opening !== e[g].opening) { selfMiss++; break; }
  }
  assert.equal(selfMiss, 0, '关联应满足自反性且不跨开局（实测不一致 ' + selfMiss + ' 处）');
});

test('棋谱库：每条棋谱的前 3 手都能被 openings.identify 认出开局名', () => {
  // 抽查 30 条，避免全量跑太慢
  const e = DATA.unpack().filter((_, k) => k % 19 === 0).slice(0, 30);
  let bad = 0;
  for (const x of e) {
    const idxs = x.moves.slice(0, 3).map(m => idxOf(m[0], m[1]));
    const o = OP.identify(idxs);
    if (!o || o.name !== x.opening) { bad++; if (bad <= 3) console.log('  ✗', x.opening, '→', o && o.name); }
  }
  assert.equal(bad, 0, bad + ' 条棋谱的开局名与 identify 结果不一致');
});

/* ============ 三、开局库命中探测（与 ui/booklib.js 同算法） ============ */
function coord(x, y) { return String.fromCharCode(65 + x) + (15 - y); }
function probeTree(hist) {
  const out = { hit: false, depth: 0, cands: [], games: 0, opening: null, best: null };
  let tree = null;
  try { tree = BOOK.defaultTree(); } catch (e) { tree = null; }
  if (!tree || !hist || !hist.length) return out;
  let node = tree, depth = 0;
  while (depth < hist.length) {
    if (!node || node.size === 0) break;
    let c = null;
    try { c = OP.canonSeq(hist.slice(0, depth + 1)); } catch (e) { c = null; }
    if (!c) break;
    const child = node.get(c.arr[c.arr.length - 1]);
    if (!child) break;
    node = child.c; depth++;
  }
  if (depth === 0) return out;
  out.depth = depth;
  const o3 = hist.length >= 3 ? OP.identify(hist.slice(0, 3)) : null;
  out.opening = o3 ? o3.name : null;
  if (!node || node.size === 0) return out;
  out.hit = true;
  let ti = 0;
  try { ti = OP.canonSeq(hist).ti; } catch (e) { ti = 0; }
  const f = (OP.SYM && OP.SYM[OP.SYM_INV[ti]]) || function (a, b) { return [a, b]; };
  const occupied = new Set(hist);
  const arr = [];
  for (const [m, e] of node) {
    const p = f(m % 15, (m / 15) | 0);
    const i = p[1] * 15 + p[0];
    if (i < 0 || i > 224 || occupied.has(i)) continue;
    arr.push({ x: p[0], y: p[1], coord: coord(p[0], p[1]), n: e.n, rate: e.r });
    out.games += e.n;
  }
  arr.sort((a, b) => b.n - a.n || b.rate - a.rate);
  if (!arr.length) { out.hit = false; out.games = 0; return out; }
  out.cands = arr; out.best = arr[0] || null;
  return out;
}

test('命中探测：空历史 / 只有黑1 的边界情形', () => {
  assert.equal(probeTree([]).hit, false);
  const r1 = probeTree([idxOf(7, 7)]);               // 黑1 天元
  assert.equal(r1.hit, true);
  assert.equal(r1.depth, 1);
  assert.ok(r1.cands.length > 0, '天元后应有后继候选');
  // 黑1 之后的白2 只可能是 H9 / I9 / G9 等 8 邻域 —— 不超过 8 个候选
  assert.ok(r1.cands.length <= 8, '白2 候选不应超过 8（实际 ' + r1.cands.length + '）');
});

test('命中探测：深度随前缀增长，且开局名在第 3 手后可识别', () => {
  const e = DATA.unpack().find(x => x.opening === '丘月局');
  assert.ok(e, '需要一条丘月局棋谱');
  const hist = e.moves.map(m => idxOf(m[0], m[1]));
  const r1 = probeTree(hist.slice(0, 1));
  const r3 = probeTree(hist.slice(0, 3));
  assert.equal(r1.depth, 1);
  assert.equal(r3.depth, 3, '前 3 手应全部匹配');
  assert.equal(r3.opening, '丘月局');
  const rAll = probeTree(hist);
  assert.equal(rAll.depth, hist.length, '整条真实棋谱应都在树上');
  assert.equal(rAll.opening, '丘月局');
});

test('命中探测：候选恒为盘内空点（前 60 条棋谱全前缀扫描）', () => {
  const entries = DATA.unpack().slice(0, 60);
  let checked = 0, bad = 0;
  for (const e of entries) {
    const h = e.moves.map(m => idxOf(m[0], m[1]));
    for (let k = 1; k <= h.length; k++) {
      const r = probeTree(h.slice(0, k));
      if (!r.hit) continue;
      const occupied = new Set(h.slice(0, k));
      for (const c of r.cands) {
        checked++;
        const i = c.y * 15 + c.x;
        if (i < 0 || i > 224 || occupied.has(i)) { bad++; if (bad <= 3) console.log('  ✗', c.coord, '前缀长', k); }
      }
    }
  }
  assert.ok(checked > 1000, '应检查到足量候选（实际 ' + checked + '）');
  assert.equal(bad, 0, bad + ' 个候选落在越界/已占点');
});

test('命中探测：候选数与样本数非负，且样本数 == 候选 n 之和', () => {
  // 用丘月局（样本充足，第 5 手仍有候选）
  const e = DATA.unpack().find(x => x.opening === '丘月局');
  const hist = e.moves.map(m => idxOf(m[0], m[1]));
  const r = probeTree(hist.slice(0, 5));
  assert.ok(r.hit, '丘月局第 5 手应命中');
  let sum = 0;
  for (const c of r.cands) { assert.ok(c.n >= 1, 'n 应 >= 1'); assert.ok(c.rate >= 0 && c.rate <= 1, 'rate 应 ∈ [0,1]'); sum += c.n; }
  assert.equal(sum, r.games, '样本数应等于各候选 n 之和');
});

test('命中探测：树枝穷尽时 depth 仍记录匹深度，但 hit=false / cands 为空', () => {
  /* ★ 语义要点（容易写错）：`depth` 与 `hit` 是**两个独立事实** ——
   *   · depth   = 前缀在树上能走到第几层（"匹配了多深"）；
   *   · hit     = 该层还有**可用的后继候选**（"还能不能给建议"）。
   *   花月局在库里只有 16 局，某条分支到第 5 手就没了后继：depth=5 但 cands=0。
   *   UI 据此显示"匹配到第 5 手后脱库"，比笼统的"未命中"更有信息量。 */
  const e = DATA.unpack().find(x => x.opening === '花月局');
  const hist = e.moves.map(m => idxOf(m[0], m[1]));
  const r3 = probeTree(hist.slice(0, 3));
  assert.ok(r3.hit && r3.cands.length > 0, '前 3 手应有候选');
  const r5 = probeTree(hist.slice(0, 5));
  assert.equal(r5.depth, 5, '深度应记录到第 5 手');
  assert.equal(r5.hit, false, '候选被穷尽 ⇒ hit=false');
  assert.equal(r5.cands.length, 0, 'cands 应为空');
});

test('命中探测：前缀中途脱库（depth < hist.length）不算命中', () => {
  /* 天元 + 角落：第 1 手（天元）在树上，第 2 手（A15=角落）不是任何真实对局的第 2 手
   * ⇒ 下探在第 2 层失败，depth 停在 1。注意此时返回的候选是"第 2 手该下哪"
   * （H9/G9），**不是**"第 3 手该下哪" —— 所以调用方必须看 depth 是否等于 hist.length
   * 才能判断"这个局面本身在库中"。ui/booklib.js 的 renderHit 正是据此区分措辞。 */
  const weird = [idxOf(7, 7), idxOf(0, 0)];
  const r = probeTree(weird);
  assert.equal(r.depth, 1, '只有第 1 手能匹配');
  assert.ok(r.depth < weird.length, '深度应小于前缀长度 ⇒ 中途脱库');
  // 返回的候选应是"白2"合法着（紧贴天元），而不是把角落当已下子的续着
  const occupied = new Set(weird);
  for (const c of r.cands) assert.ok(!occupied.has(c.y * 15 + c.x), '候选不应落在已占点');
});


/* ============================================================
 * 侧栏「分类归置 + 分层展开」（§14）—— 可 Node 测部分
 *   完整交互（开合点击 / 持久化 / 自动展开 / 摘要）由
 *   `tools/browser-menu-check.js` 实跑（34 项，须沙箱外）。
 *   但**静态结构**是可以在 Node 里守住的：分组齐备、id 白名单、
 *   aria 契约、动作按钮的 aria-pressed、以及"折叠不该靠 CSS class 而要靠 hidden"。
 *   这些是最容易被后续改 HTML 时悄悄改坏的契约。
 * ============================================================ */
const fs = require('fs');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const MENU_SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'menu.js'), 'utf8');

test('R5-1 分组齐备且顺序稳定（分类归置的硬契约；v3.35 起棋谱库并入棋谱 ⇒ 6 组）', () => {
  const ids = [];
  const re = /data-grp="([a-z]+)"/g;
  let m;
  while ((m = re.exec(HTML))) ids.push(m[1]);
  assert.deepEqual(ids, ['game', 'display', 'hint', 'judge', 'record', 'help'],
    '分组 id 与顺序必须与 ui/menu.js 的白名单一致（顺序即 DOM 顺序）');
  // 白名单同步：menu.js 的 KNOWN 必须与 HTML 完全一致，否则持久化会漏组
  const known = MENU_SRC.match(/const KNOWN = \[([^\]]+)\]/);
  assert.ok(known, 'menu.js 应有 KNOWN 白名单');
  const klist = known[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(klist, ids, 'menu.js 的 KNOWN 必须与 HTML 的 data-grp 一一对应');
});

test('R5-2 默认只展开「对局设置」（首屏精简）', () => {
  const opened = [];
  const re = /data-grp="([a-z]+)"[^>]*data-open="(\d)"/g;
  let m;
  while ((m = re.exec(HTML))) opened.push([m[1], m[2]]);
  assert.equal(opened.length, 6, '六组都要显式声明 data-open');
  const openOnes = opened.filter(x => x[1] === '1').map(x => x[0]);
  assert.deepEqual(openOnes, ['game'], '只有对局设置默认展开');
  // menu.js 的 DEFAULT_OPEN 必须与之一致（首帧未 init 时不闪）
  assert.ok(/DEFAULT_OPEN = \['game'\]/.test(MENU_SRC), 'menu.js 的 DEFAULT_OPEN 应为 game');
});

test('R5-3 每组都有 button 分组头 + grp-body（可访问性结构）', () => {
  // 用最简单的结构断言：每个 data-grp 段内必须能找到 .grp-btn 与 .grp-body
  const blocks = HTML.split(/data-grp="/).slice(1);
  for (const b of blocks) {
    const id = b.slice(0, b.indexOf('"'));
    const seg = b.slice(0, b.indexOf('</section>') + 10);
    assert.ok(/class="grp-btn"/.test(seg), id + ' 缺少 .grp-btn 分组头');
    assert.ok(/class="grp-body"/.test(seg), id + ' 缺少 .grp-body 折叠体');
    assert.ok(/<button type="button" class="grp-btn"/.test(seg), id + ' 分组头必须是 button（键盘/读屏）');
    assert.ok(/<span class="grp-caret" aria-hidden="true">/.test(seg), id + ' 折叠箭头应 aria-hidden');
  }
  // caret 用 CSS 画，不依赖字体图标
  assert.ok(HTML.includes('.grp.open .grp-caret'), '展开态应有视觉反馈（caret 旋转）');
});

test('R5-4 折叠用 hidden 而不是 CSS class（读屏会正确跳过）', () => {
  // menu.js 必须写 body.hidden；只切 class 会让折叠区仍被读屏念出来
  assert.ok(/g\.body\.hidden = !open;/.test(MENU_SRC), 'menu.js 必须切换 body.hidden');
  assert.ok(/setAttribute\('aria-expanded'/.test(MENU_SRC), 'menu.js 必须维护 aria-expanded');
  assert.ok(/setAttribute\('aria-controls'/.test(MENU_SRC), 'menu.js 必须维护 aria-controls');
});

test('R5-5 动作按钮带 aria-pressed（开关语义可被读屏识别）', () => {
  assert.ok(/id="btnHeat"[^>]*aria-pressed="false"/.test(HTML), 'btnHeat 应有 aria-pressed 初值');
  assert.ok(/id="btnRecord"[^>]*aria-pressed="false"/.test(HTML), 'btnRecord 应有 aria-pressed 初值');
});

test('R5-6 关键控件 id 未被重命名（避免与既有模块脱钩）', () => {
  // 这些 id 被 ui/record.js、ui/panels.js、ui/booklib.js 直接 getElementById 取用
  const NEED = ['recordPanel', 'recText', 'recFile', 'recFmt', 'recExpFmt', 'recErr', 'recInfo',
    'recBar', 'recPly', 'recSpeed', 'recAutoTime', 'chkArrow', 'recCurrent', 'recBookHit',
    'recList', 'recCurve', 'recAnalysis', 'btnRecLoad', 'btnRecPaste', 'btnRecExport',
    'btnRecFirst', 'btnRecPrev', 'btnRecPlay', 'btnRecNext', 'btnRecLast', 'btnRecResume', 'btnRecAnalyze',
    'blMeta', 'blSearch', 'blOpening', 'blSort', 'blStat', 'blList', 'btnBlRandom',
    'judgeBox', 'judgeBarB', 'judgeBarW', 'judgeLabel', 'judgeScore', 'judgeMate', 'judgeErr',
    'hintList', 'hintNote', 'chkHintScore', 'chkNo', 'chkForbid', 'status', 'meta', 'a11y-live',
    'selRule', 'selMode', 'selSide', 'selLevel', 'selTime',
    'btnUndo', 'btnRestart', 'btnHint', 'btnJudge', 'btnHeat', 'btnRecord', 'ruleHint',
    // ★ R9（移动端小屏触屏落子）：确认条 + 开关
    'touchBar', 'touchText', 'btnTouchOk', 'btnTouchCancel', 'selTouch', 'touchDim'];
  for (const id of NEED) {
    assert.ok(new RegExp('id="' + id + '"').test(HTML), 'index.html 缺少 id=' + id);
  }
  // 脚本加载：menu.js 必须在 main.js 之前（main 在模块体内就调用 MENU.create）
  const iMenu = HTML.indexOf('src="ui/menu.js"'), iMain = HTML.indexOf('src="ui/main.js"');
  assert.ok(iMenu > 0 && iMain > 0, 'index.html 应加载 ui/menu.js 与 ui/main.js');
  assert.ok(iMenu < iMain, 'ui/menu.js 必须在 ui/main.js 之前加载');
});

test('R5-7 棋谱库摘要 + 工具条都在「棋谱」分组内（并入后仍完整）', () => {
  // v3.35：棋谱库并入「棋谱」分组 ⇒ blMeta 在**组内的子标题**上（不再是独立分组头）
  const g0 = HTML.indexOf('data-grp="record"');
  const seg = HTML.slice(g0, HTML.indexOf('</section>', g0));
  assert.ok(/id="blMeta"/.test(seg), '#blMeta 应在「棋谱」分组内');
  assert.ok(/id="blList"/.test(seg) && /id="blSearch"/.test(seg), '棋谱库列表与筛选应在同一分组内');
  assert.ok(seg.indexOf('随机一谱') >= 0, '随机按钮文案应为「随机一谱」（它挑的是整条棋谱，不是一手）');
  // ★ 导入 / 导出已按需求隐藏：元素仍在（保持既有取值路径与 id 契约），但收在 hidden 容器里
  const l0 = HTML.indexOf('id="recLegacy"');
  const legacy = HTML.slice(l0, HTML.indexOf('</section>', l0));
  assert.ok(HTML.indexOf('<div hidden id="recLegacy">') >= 0, '#recLegacy 必须是 hidden 容器');
  const HIDDEN = ['recText', 'recFile', 'recFmt', 'recExpFmt', 'btnRecLoad', 'btnRecPaste', 'btnRecExport'];
  for (const id of HIDDEN) {
    assert.ok(legacy.indexOf('id="' + id + '"') >= 0, id + ' 应被收进（隐藏的）#recLegacy 容器');
  }
});

test('R5-8 ★ 全文档 id 唯一（重排 HTML 时最容易踩的坑）', () => {
  /* 为什么单独立一条：把平铺面板改成"分组 + 折叠"时，很容易在新建分组里**照抄**一份
   * 控件却忘了删掉旧的位置 ⇒ 页面里出现两个同名 id。后果很隐蔽：
   *   `getElementById` 只返回**文档中第一个**，于是 main.js 绑到的是旧那一份，
   *   用户点新分组里的控件**毫无反应**——而所有"按 id 取值"的自动化断言却全绿
   *   （因为读的也是第一个）。本仓库实测踩过一次（重复的规则/对战/我执网格）。 */
  const seen = new Map();
  const dup = [];
  const re = /\sid="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML))) {
    const id = m[1];
    seen.set(id, (seen.get(id) || 0) + 1);
    if (seen.get(id) === 2) dup.push(id);
  }
  assert.deepEqual(dup, [], '存在重复 id：' + dup.join(', '));
});

test('R5-9 ★ 关键控件只出现一次且在各分组的 grp-body 内', () => {
  /* 与 R5-8 同样的动机，但多查一步：控件必须真的"被放进分组里"，
   * 而不是留在面板顶层（那会让分组折叠后仍占位置，违反"分层展开"的初衷）。 */
  const inGroup = (id) => {
    // 找到 id 出现处，向前回溯最近的 data-grp 与 grp-body，判断是否被 grp-body 包住
    const seg = HTML.slice(0, HTML.indexOf('id="' + id + '"'));
    const lastGrp = seg.lastIndexOf('data-grp="');
    const lastBody = seg.lastIndexOf('class="grp-body"');
    const lastSection = seg.lastIndexOf('</section>');
    return lastGrp > -1 && lastBody > lastGrp && lastBody > lastSection;
  };
  for (const id of ['selRule', 'selMode', 'selSide', 'selLevel', 'selTime', 'btnUndo', 'btnRestart']) {
    assert.ok(inGroup(id), id + ' 应位于「对局设置」分组的 grp-body 内');
  }
  for (const id of ['chkNo', 'chkForbid', 'chkHintScore', 'chkArrow']) {
    assert.ok(inGroup(id), id + ' 应位于「显示与叠加」分组的 grp-body 内（不再是散落的开关）');
  }
  assert.ok(inGroup('recText') && inGroup('recBar'), '棋谱控件应在「棋谱」分组内');
  assert.ok(inGroup('blList'), '棋谱库列表应在「棋谱库」分组内');
  assert.ok(inGroup('judgeBox') && inGroup('hintList'), '形势/提示的结果区应在各自分组内');
});

test('R6-6 ★ 代码引用的元素 id 必须都存在于页面（防"写了个永不生效的功能"）', () => {
  /* 为什么单独立一条：`panels.setLastMove()` 曾有 5 个调用点，目标 `#lastMoveBox` 却**根本不存在**
   * ⇒ 悬停/键盘指向棋子时显示"第 k 手 · 用时"整块功能静默失效：没有报错、没有断言失败、
   *   也没有任何视觉异常（就是"什么都不显示"）。这类"死引用"只能用静态交叉核对挡住。 */
  const uiDir = path.join(__dirname, '..', 'ui');
  const jsAll = fs.readdirSync(uiDir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(uiDir, f), 'utf8')).join('\n');
  const refs = new Set();
  const re = /(?:\$|getElementById)\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
  let m;
  while ((m = re.exec(jsAll))) refs.add(m[1]);
  const missing = [...refs].filter(id => !new RegExp('id="' + id + '"').test(HTML));
  assert.deepEqual(missing, [], '代码引用了页面中不存在的 id（该功能必然静默失效）：' + missing.join(', '));
  // 顺带守住"悬停显示第 k 手"这个具体功能的落点
  assert.ok(/id="lastMoveBox"/.test(HTML), '#lastMoveBox 必须在页面里（悬停/键盘提示的目标元素）');
});

test('R10-1 ★ 同一元素只能被绑定一次 click（防"两处各绑一份"→ 状态被抵消）', () => {
  /* 为什么必须静态挡：R8 探索性测试发现 `btnHeat` 的 click 被**两个模块各绑一次**
   *   —— ui/panels.js（toggleHeat）与 ui/main.js（toggle → savePrefs）。
   *   两个处理器各 toggle 一次 ⇒ 点一下等于 toggle 两次 ⇒ **热力图永远打不开**，
   *   而且：不报错、不抛异常、按钮的视觉状态看起来"响应了"（被 toggle 回原样）。
   *   唯一的破法就是静态交叉核对"谁绑了什么"，运行期断言很难覆盖"少绑/多绑"。
   *
   * 口径：把 ui/*.js 里 `$('id')` 解析成别名（`const x = $('id')` 与 `{ x: $('id') }`
   *   两种写法都认），再数 `别名.addEventListener('click'` 出现的次数；直接写法
   *   `$('id').addEventListener('click'` 也算。**同一个 id 全仓库合计必须恰好 1**。 */
  const uiDir = path.join(__dirname, '..', 'ui');
  const files = fs.readdirSync(uiDir).filter(f => f.endsWith('.js'));
  const hits = {};                                  // id → ['文件:别名', ...]
  const add = (id, tag) => { (hits[id] = hits[id] || []).push(tag); };

  for (const f of files) {
    const s = fs.readFileSync(path.join(uiDir, f), 'utf8');
    const aliasOf = {};
    let m;
    const reAssign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\('([\w-]+)'\)/g;
    while ((m = reAssign.exec(s))) aliasOf[m[1]] = m[2];
    const reProp = /([A-Za-z_$][\w$]*)\s*:\s*\$\('([\w-]+)'\)/g;
    while ((m = reProp.exec(s))) aliasOf[m[1]] = m[2];
    const reDirect = /\$\('([\w-]+)'\)\.addEventListener\(\s*'click'/g;
    while ((m = reDirect.exec(s))) add(m[1], f + ':(直接)');
    for (const a of Object.keys(aliasOf)) {
      const re = new RegExp('\\b' + a + "\\.addEventListener\\(\\s*'click'", 'g');
      while (re.exec(s)) add(aliasOf[a], f + ':' + a);
    }
  }

  const dup = Object.keys(hits).filter(id => hits[id].length > 1);
  assert.deepEqual(dup.map(id => id + ' ← ' + hits[id].join(' + ')), [],
    '以下元素被绑定了多次 click（会互相抵消/重复触发，且不会报错）');
  // 反向：这几个"长期开关"必须有且只有一处入口（掉了就是按钮彻底失灵）
  for (const id of ['btnHint', 'btnJudge', 'btnHeat', 'btnRecord']) {
    assert.equal((hits[id] || []).length, 1, id + ' 必须恰好有一处 click 入口（0 = 按钮失灵）');
  }
  // ★ R9：触屏确认条的两个按钮同理（重复绑定 = 确认一次落两颗子 / 取消把刚落下的子又撤了）
  for (const id of ['btnTouchOk', 'btnTouchCancel']) {
    assert.equal((hits[id] || []).length, 1, id + ' 必须恰好有一处 click 入口');
  }
});

/* ==========================================================================
 * R9（移动端小屏触屏落子）静态守卫
 *   为什么静态守：这套交互的失败模式几乎都是**静默**的 ——
 *     · click 没让路      ⇒ 触摸补发的 click 又落一子（一次点选落两颗子，看起来像"偶发"）；
 *     · 少了 / 写歪 touch-action ⇒ 按住拖动时手势被页面滚动抢走（表现为"拖不动"，无报错）；
 *     · 确认条不是浮层    ⇒ 小屏上把按钮挤到屏幕外（用户根本够不到）。
 *   这些都无法靠"运行期断言"覆盖，只能交叉核对"页面结构 / 样式 / 事件绑定"是否照约定写了。
 * ========================================================================== */
test('R9-1 触屏落子：页面结构（确认条 + 三态开关）', () => {
  const NEED = ['touchBar', 'touchText', 'btnTouchOk', 'btnTouchCancel', 'selTouch', 'touchDim'];
  for (const id of NEED) assert.ok(new RegExp('id="' + id + '"').test(HTML), 'index.html 缺少 id=' + id);
  // 确认条必须是浮层（fixed）：小屏上拇指可达的前提；且默认隐藏
  const seg = HTML.slice(HTML.indexOf('id="touchBar"') - 200, HTML.indexOf('id="touchBar"') + 400);
  assert.ok(/class="touch-bar"/.test(seg) && /hidden/.test(seg), '确认条应是 .touch-bar 且默认 hidden');
  assert.ok(/\.touch-bar\s*\{[^}]*position:fixed/.test(HTML), '确认条必须是固定浮层（position:fixed）');
  // 三态开关：auto 为默认（自动判定是"不打扰桌面用户"的关键）
  const t0 = HTML.indexOf('id="selTouch"');
  const tseg = HTML.slice(t0, HTML.indexOf('</select>', t0));
  for (const v of ['auto', 'on', 'off']) assert.ok(new RegExp('value="' + v + '"').test(tseg), 'selTouch 缺少选项 ' + v);
  assert.ok(/value="auto"\s+selected/.test(tseg), '默认必须是「自动」（按设备）');
  // 确认条必须给出两个动作（只有一个按钮 = 用户无法反悔）
  assert.ok(/id="btnTouchOk"/.test(HTML) && /确认落子/.test(HTML), '确认按钮与文案');
  assert.ok(/id="btnTouchCancel"/.test(HTML), '取消按钮');
  // 开关必须落在「显示与叠加」分组内（与其余显示类开关一致，别散落在面板顶层）
  const inGroup = (id) => {
    const s = HTML.slice(0, HTML.indexOf('id="' + id + '"'));
    const lastGrp = s.lastIndexOf('data-grp="');
    const lastBody = s.lastIndexOf('class="grp-body"');
    const lastSection = s.lastIndexOf('</section>');
    return lastGrp > -1 && lastBody > lastGrp && lastBody > lastSection;
  };
  assert.ok(inGroup('selTouch'), 'selTouch 应在「显示与叠加」分组的 grp-body 内');
});

test('R9-2 触屏落子：拖动的前提样式（touch-action / 小屏单列布局）', () => {
  /* 没有这条,"按住拖动"会被浏览器当成页面滚动而中断 —— 表现是"拖动偶尔没反应"，
     极像随机 bug（其实是手势被抢走），必须靠静态检查钉住。 */
  assert.ok(/body\.touch canvas\s*\{[^}]*touch-action:none/.test(HTML),
    '触屏模式必须给 canvas 设 touch-action:none（否则拖动被页面滚动抢走）');
  assert.ok(/@media\s*\(max-width:700px\)/.test(HTML), '缺少小屏媒体查询（单列 + 放大触控目标）');
  // 小屏下棋盘要铺满（旧的 80vw 会白白浪费 ~20% 宽度，格子更小更难按准）
  const mq = HTML.slice(HTML.indexOf('@media (max-width:700px)'));
  assert.ok(/canvas\s*\{[^}]*width:min\(9[0-9]vw/.test(mq), '小屏下棋盘宽度应接近满宽');
});

test('R9-3 ★ 触屏落子：事件接线的三条不变量（缺一条就静默出错）', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'ui', 'main.js'), 'utf8');
  // ① click 必须给触屏让路：触摸在 pointerup 之后还会补一个 click
  assert.ok(/addEventListener\('click', function \(e\) \{\s*[\s\S]{0,600}?if \(touchOn\) return;/.test(MAIN),
    'click 处理器必须在触屏模式下让路（否则一次点选落两颗子）');
  // ② 四个 pointer 事件都要接（down/move/up/cancel；少了 cancel 会残留"按住"状态）
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(new RegExp("addEventListener\\('" + ev + "'").test(MAIN), 'main.js 未监听 ' + ev);
  }
  // ③ 落子必须走同一个入口：鼠标 click / 触屏确认 / 触屏拖动都调 commitAt
  const calls = (MAIN.match(/commitAt\(/g) || []).length;
  assert.ok(calls >= 4, 'commitAt 调用点应 ≥4（定义 1 + click 1 + 确认 1 + 拖动 1），实得 ' + calls);
  assert.ok(!/pxToPos[\s\S]{0,120}?place\(hit\.x/.test(MAIN),
    '棋盘点击不得绕过 commitAt 直接 place（否则触屏会少一道禁手/推演校验）');
  // ④ 判定逻辑必须来自纯函数模块（阈值/口径不能有第二份实现）
  assert.ok(/window\.G\.touch/.test(MAIN) && /TOUCH\.decide\(/.test(MAIN) && /TOUCH\.isDrag\(/.test(MAIN),
    '拖动判定必须调用 ui/touch.js 的纯函数（单一真相源）');
  const iTouch = HTML.indexOf('src="ui/touch.js"'), iMainJs = HTML.indexOf('src="ui/main.js"');
  assert.ok(iTouch > 0 && iMainJs > iTouch, 'index.html 必须加载 ui/touch.js，且在 ui/main.js 之前');
  // ⑤ 偏好持久化：刷新后要记得用户的选择
  assert.ok(/touch: touchPref/.test(MAIN), '触屏偏好必须写盘（savePrefs）');
});

/* ============ R10：开局库匹配的模式识别（平移归一 + 旋转覆盖） ============
 * ★ 直接 require **真实的** ui/booklib.js（probeTree/transNorm 不碰 DOM）：
 *   旧测试是"同算法在 Node 重跑"——那有"改了一处忘了另一处"的漂移风险；
 *   模式识别是本轮新增的核心逻辑，必须测真实现。 */
const BL = (function () {
  global.window = { G: { openings: OP, book: BOOK, record: REC } };
  require(path.join(__dirname, '..', 'ui', 'booklib.js'));
  return global.window.G.booklib;
})();

test('R10-1 平移归一 transNorm：黑1 对齐天元 / 已对齐 ⇒ null / 越界 ⇒ null', () => {
  const i = (x, y) => y * 15 + x;
  // 黑1 在 G7(6,6) ⇒ 平移 (+1,+1)：H8(7,7)→I9(8,8)
  assert.deepEqual(BL.transNorm([i(6, 6), i(7, 7), i(8, 6)]),
    { seq: [i(7, 7), i(8, 8), i(9, 7)], dx: 1, dy: 1 });
  // 黑1 已在天元（Renju 局面）⇒ 无需平移
  assert.equal(BL.transNorm([i(7, 7), i(7, 6)]), null);
  // 形状放不进棋盘 ⇒ null（整行跨度，平移后必出界）
  assert.equal(BL.transNorm([i(0, 7), i(14, 7)]), null);
  assert.equal(BL.transNorm([]), null);
});

test('R10-2 旋转识别：canonSeq 的 8 对称已覆盖（927 局旋转 90° 后 canonical 全部不变）', () => {
  /* 用户问"旋转为什么认不出"——实测本来就认得出（旋转不变是 canonSeq 的既有性质）；
   * 此前"认不出"的真实场景是**无禁手黑1 偏移**（旋转后仍偏心，canonical 不同）⇒ R10 补平移。 */
  const games = GAMES.unpack();
  let ok = 0;
  for (const g of games) {
    const a = g.moves.map(m => m[1] * 15 + m[0]);
    const r = a.map(i => { const p = OP.SYM[1](i % 15, (i / 15) | 0); return p[1] * 15 + p[0]; });
    assert.deepEqual(OP.canonSeq(r).arr, OP.canonSeq(a).arr, '旋转 90° 后 canonical 必须不变（' + g.opening + '）');
    ok++;
  }
  assert.equal(ok, 927, '应覆盖全部 927 局');
});

test('R10-3 probeTree 平移识别：黑1 偏移的局面也能命中，候选映射回真实坐标且合法', () => {
  // 取一局库内棋谱整体平移 (−1,−1)（黑1 从 H8 → G7）构造"无禁手偏移开局"
  const g = GAMES.unpack()[0];
  // ⚠ 该局的前缀在树里只通到第 6 手（更深处被 BOOK_SHRINK 剪枝）⇒ 取 6 手
  const seq = g.moves.slice(0, 6).map(m => m[1] * 15 + m[0]);
  const shifted = seq.map(i => { const x = i % 15, y = (i / 15) | 0; return (y - 1) * 15 + (x - 1); });
  const direct = BL.probeTree(seq);
  assert.ok(direct.hit, '原序列应直接命中（前置校验）');
  const off = BL.probeTree(shifted);
  assert.ok(!off.hit, '偏移序列不做平移归一 ⇒ 不应命中（这正是本功能要解决的场景）');
  const t = BL.transNorm(shifted);
  assert.ok(t, '偏移序列应可平移归一');
  const rec = BL.probeTree(shifted, t);
  assert.ok(rec.hit, '平移归一后应命中');
  assert.equal(rec.depth, direct.depth, '匹配深度应与原序列一致');
  assert.equal(rec.opening, direct.opening, '开局名应一致（按对齐后的序列识别）');
  assert.ok(rec.trans, '结果应标注平移识别');
  assert.ok(rec.cands.length > 0 && rec.best, '应有可用候选');
  const occ = new Set(shifted);
  for (const c of rec.cands) {
    assert.ok(c.x >= 0 && c.x <= 14 && c.y >= 0 && c.y <= 14, '候选必须落在真实盘面内');
    assert.ok(!occ.has(c.y * 15 + c.x), '候选不得落在已占点');
  }
  // 与"本库关联"同口径：平移后的序列应能关联到同一开局的具体棋谱
  const relDirect = BL.transNorm(seq);   // 原序列已对齐 ⇒ null
  assert.equal(relDirect, null);
});
