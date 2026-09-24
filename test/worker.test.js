/* test/worker.test.js — M4 Worker 协议 / 难度预设 / 取消 / 打包新鲜度
 * 说明：Node 无 Worker，故直接对 `worker-entry.handle` 与打包产物做等价验证；
 *      另用 vm 在干净上下文里执行**打包产物**，确保 Worker 真能独立跑起来。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const WE = require('../engine/worker-entry.js');

const { NN, EMPTY, BLACK, WHITE, idxOf } = core;
const ROOT = path.join(__dirname, '..');

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
const OPEN = [[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK], [6, 6, WHITE]];

test('协议：move 返回完整字段 + 合法空点', () => {
  const res = WE.handle({ id: 1, cmd: 'move', board: Array.from(boardOf(OPEN)), stm: BLACK,
                          rule: 'freestyle', difficulty: 'normal' });
  assert.equal(res.cmd, 'move');
  assert.ok(res.move && res.move.x >= 0 && res.move.x < 15 && res.move.y >= 0 && res.move.y < 15);
  assert.equal(boardOf(OPEN)[idxOf(res.move.x, res.move.y)], EMPTY, 'AI 必须落在空点');
  for (const k of ['score', 'nodes', 'depth', 'timeMs', 'fallbackLevel']) {
    assert.ok(res[k] !== undefined, '缺少字段 ' + k);
  }
  assert.ok(res.nodes > 0 && res.depth >= 1);
});

/* ══════════════════════════════════════════════════════════════
 * ★ 开局库的**真实调用链**护栏（v3.21）
 *   曾经的真实缺陷：Worker 的 `move` 请求只带 `board` + `stm` ⇒ `search.posFromBoard`
 *   重建出的局面 hist 为空 ⇒ 开局库前提②(`hist.length === stones`) 恒不成立 ⇒
 *   **产品在浏览器里一次都不走書招**，而 Node 基准（用 core.makeMove 攒历史）全都走。
 *   ——典型的"Node 单测全绿却漏掉真实调用链"，所以这条必须钉在 **Worker 协议层**，
 *   而不是去测 `BOOK.defaultMove()` 这种被直接调用就能过的地方。
 * ══════════════════════════════════════════════════════════════ */
const OPEN3 = [[7, 7, BLACK], [7, 6, WHITE], [8, 8, BLACK]];   // 丘月局前三手 H8 / H9 / I8
const HIST3 = [idxOf(7, 7), idxOf(7, 6), idxOf(8, 8)];

test('开局库｜Worker 请求带 hist 时必须走書招（真实链路，非测 BOOK 内部）', () => {
  const res = WE.handle({ id: 1, cmd: 'move', board: Array.from(boardOf(OPEN3)), stm: WHITE,
                          rule: 'freestyle', difficulty: 'easy', hist: HIST3 });
  assert.equal(res.cmd, 'move');
  assert.equal(res.via, 'book', '带真实历史时应命中开局库');
  assert.ok(res.book && typeof res.book.opening === 'string' && res.book.weight > 0,
            'book 字段应带上开局名与实战权重，实际 ' + JSON.stringify(res.book));
  assert.equal(boardOf(OPEN3)[idxOf(res.move.x, res.move.y)], EMPTY, '書招必须落在空点');
});

test('开局库｜反向对照：不传 hist 时不得命中書招（否则上一条是空断言）', () => {
  const res = WE.handle({ id: 1, cmd: 'move', board: Array.from(boardOf(OPEN3)), stm: WHITE,
                          rule: 'freestyle', difficulty: 'easy' });
  assert.equal(res.cmd, 'move');
  assert.notEqual(res.via, 'book', '没有历史就 reconstruction 不出書招前提，必须退回搜索');
});

test('开局库｜hist 与棋盘不一致时静默退回搜索（不得拿错序列去查库）', () => {
  const bad = WE.handle({ id: 1, cmd: 'move', board: Array.from(boardOf(OPEN3)), stm: WHITE,
                          rule: 'freestyle', difficulty: 'easy',
                          hist: [idxOf(0, 0), idxOf(1, 1), idxOf(2, 2)] });  // 与棋子完全不符
  assert.equal(bad.cmd, 'move');
  assert.notEqual(bad.via, 'book', '历史与棋盘不符应被校验挡下');
  const short = WE.handle({ id: 1, cmd: 'move', board: Array.from(boardOf(OPEN3)), stm: WHITE,
                            rule: 'freestyle', difficulty: 'easy', hist: [idxOf(7, 7)] });  // 长度不符
  assert.equal(short.cmd, 'move');
  assert.notEqual(short.via, 'book', '历史长度不等于棋子数应被挡下');
});

test('协议：abort 置位取消标志', () => {
  assert.equal(WE.handle({ cmd: 'abort' }).ok, true);
  assert.equal(WE.cancelFlag()[0], 1, '取消位应为 1');
});

test('协议：错误码（坏棋盘 / 坏走子方 / 未知指令）', () => {
  assert.equal(WE.handle({ cmd: 'move', board: [1, 2, 3], stm: 1 }).code, 'E_BAD_BOARD', '长度不对');
  assert.equal(WE.handle({ cmd: 'move', stm: 1 }).code, 'E_NO_BOARD', '缺字段');
  assert.equal(WE.handle({ cmd: 'move', board: Array.from(boardOf(OPEN)), stm: 9 }).code, 'E_BAD_STM');
  assert.equal(WE.handle({ cmd: 'nope' }).code, 'E_CMD');
  assert.equal(WE.handle(null).code, 'E_CMD');
});

/* ★ R8（2026-09-23 评审）：棋盘**取值/类型**校验。
 *   老写法 `Array.isArray(src) || typeof src.length === 'number'` 会吞下字符串与
 *   `{length:225}` ⇒ `Int8Array.from` 得**全 0 空盘** ⇒ search 把它当合法空盘，
 *   直接返回天元/书招（**静默错误答案**，比报错更糟）；`board[i]=5` 则崩成 E_INTERNAL。 */
test('★ 协议：非法棋盘必须显式拒绝，不得静默当空盘', () => {
  const good = Array.from(boardOf(OPEN));
  assert.equal(WE.handle({ cmd: 'move', board: 'x'.repeat(225), stm: BLACK }).code, 'E_BAD_BOARD', '字符串');
  assert.equal(WE.handle({ cmd: 'move', board: { length: 225 }, stm: BLACK }).code, 'E_BAD_BOARD', 'array-like');
  const bad = good.slice(); bad[100] = 5;
  assert.equal(WE.handle({ cmd: 'move', board: bad, stm: BLACK }).code, 'E_BAD_BOARD', '取值越界');
  const neg = good.slice(); neg[3] = -1;
  assert.equal(WE.handle({ cmd: 'move', board: neg, stm: BLACK }).code, 'E_BAD_BOARD', '负值');
  // 同一入口的 hint / judge / heat / analyze 也必须走同一道校验
  for (const cmd of ['hint', 'judge', 'heat']) {
    assert.equal(WE.handle({ cmd: cmd, board: 'x'.repeat(225), stm: BLACK }).code, 'E_BAD_BOARD', cmd);
  }
  // 合法输入照常工作（校验不得误伤）
  const ok = WE.handle({ cmd: 'move', board: good, stm: BLACK, difficulty: 'easy' });
  assert.equal(ok.cmd, 'move', JSON.stringify(ok));
  // 普通数组与 Int8Array 都要接受（页面走 Int8Array，测试/工具常走普通数组）
  assert.equal(WE.handle({ cmd: 'move', board: Int8Array.from(good), stm: BLACK, difficulty: 'easy' }).cmd, 'move');
});

test('协议：init 接收 SharedArrayBuffer 后取消位可被外部置位', () => {
  const sab = new SharedArrayBuffer(4);
  const res = WE.handle({ cmd: 'init', cancelBuf: sab });
  assert.equal(res.cmd, 'init');
  assert.equal(res.ok, true);
  assert.equal(res.sab, true, 'Node 有 SAB，应接受');
  const view = new Int32Array(sab);
  view[0] = 1;                                  // 模拟主线程写取消位
  assert.equal(WE.cancelFlag()[0], 1, '共享视图应可见');
});

test('取消：think 收到置位的 cancel 立即降级返回（不搜满时限）', () => {
  const cancel = new Int32Array(1);
  cancel[0] = 1;
  const pos = SEARCH.posFromBoard(boardOf(OPEN), BLACK);
  const t0 = Date.now();
  const r = SEARCH.think(pos, { rule: 'freestyle', maxDepth: 12, width: 22, hardLimit: 5000, cancel: cancel });
  const dt = Date.now() - t0;
  assert.ok(r && r.move, '必须仍返回着法');
  assert.equal(pos.board[idxOf(r.move.x, r.move.y)], EMPTY, '必须落在空点');
  assert.ok(dt < 500, '应迅速返回，实际 ' + dt + 'ms');
});

test('难度预设：四档齐备、强度单调、Renju 深度下调', () => {
  const names = ['easy', 'normal', 'hard', 'master'];
  for (const n of names) {
    const c = SEARCH.difficultyCfg(n, 'freestyle');
    assert.ok(c.maxDepth >= 2 && c.hardLimit > 0 && c.width > 0, n + ' 预设非法');
  }
  const [e, n2, h, m] = names.map(x => SEARCH.difficultyCfg(x, 'freestyle'));
  assert.ok(e.maxDepth < n2.maxDepth && n2.maxDepth < h.maxDepth && h.maxDepth < m.maxDepth, '深度应单调递增');
  assert.ok(e.hardLimit <= n2.hardLimit && n2.hardLimit <= h.hardLimit && h.hardLimit <= m.hardLimit, '时限应单调不减');
  const hRenju = SEARCH.difficultyCfg('hard', 'renju');
  assert.ok(hRenju.maxDepth < h.maxDepth, 'Renju 深度应下调');
});

test('难度预设：think 直接吃 difficulty（显式参数优先）', () => {
  const pos = SEARCH.posFromBoard(boardOf(OPEN), BLACK);
  const r = SEARCH.think(pos, { difficulty: 'easy', rule: 'freestyle' });
  assert.ok(r.depth <= SEARCH.difficultyCfg('easy', 'freestyle').maxDepth, 'easy 不应超过预设深度');
  const pos2 = SEARCH.posFromBoard(boardOf(OPEN), BLACK);
  const r2 = SEARCH.think(pos2, { difficulty: 'easy', maxDepth: 4, rule: 'freestyle' });
  assert.ok(r2.depth >= r.depth, '显式 maxDepth 应覆盖预设');
});

test('打包：worker-src.js 与当前引擎源码一致（防忘记重新生成）', () => {
  const tool = require('../tools/build-worker-src.js');
  const src = fs.readFileSync(path.join(ROOT, 'engine/worker-src.js'), 'utf8');
  const cur = crypto.createHash('sha1').update(tool.bundle).digest('hex').slice(0, 16);
  const m = src.match(/G\.WORKER_SRC_HASH = "([0-9a-f]+)"/);
  assert.ok(m, 'worker-src.js 缺少 HASH');
  assert.equal(m[1], cur, 'worker-src.js 已过期，请运行 node tools/build-worker-src.js');
});

test('打包：产物在干净上下文中可独立运行并响应请求', () => {
  const src = fs.readFileSync(path.join(ROOT, 'engine/worker-src.js'), 'utf8');
  const outer = { console: console };
  outer.globalThis = outer;
  vm.createContext(outer);
  vm.runInContext(src, outer);
  const bundle = outer.G.WORKER_SRC;
  assert.ok(typeof bundle === 'string' && bundle.length > 1000, 'WORKER_SRC 应为非空字符串');

  const w = { console: console };
  w.self = w; w.globalThis = w;
  vm.createContext(w);
  vm.runInContext(bundle, w);
  assert.ok(w.G.core && w.G.search && w.G.workerEntry, '打包后应挂载 core/search/workerEntry');

  const res = w.G.workerEntry.handle({ id: 7, cmd: 'move', board: Array.from(boardOf(OPEN)),
                                       stm: WHITE, rule: 'freestyle', difficulty: 'easy' });
  assert.equal(res.cmd, 'move');
  assert.ok(res.move, '应返回着法');
  assert.equal(w.G.core.idxOf(res.move.x, res.move.y) >= 0, true);

  // ★ 打包产物内的开局库链路。为什么必须在**这里**再验一次：
  //   Node 单测走 require，而 Worker 走 G.* 全局 —— 曾出现
  //   `openings.js` 没进 bundle ⇒ Worker 侧 G.openings undefined（记谱解析直接崩）。
  assert.ok(w.G.openings, '打包后必须能拿到 openings（book.js 依赖它）');
  // §12.4.3：现役开局库是**前缀树**，线库 book-lines.js 已退出产物 ⇒ 这里必须验 hasTree
  assert.ok(w.G.bookTree, '打包后必须能拿到 bookTree（前缀树数据）');
  assert.ok(w.G.book && w.G.book.hasTree(), '打包后前缀树必须可用');
  assert.equal(w.G.book.hasData(), false, '旧线库不应再进产物（Node 侧仍留档供工具使用）');
  const bk = w.G.workerEntry.handle({ id: 8, cmd: 'move', board: Array.from(boardOf(OPEN3)),
                                      stm: WHITE, rule: 'freestyle', difficulty: 'easy',
                                      hist: HIST3 });
  assert.equal(bk.via, 'book', '打包产物里带 hist 也应命中开局库');
  assert.ok(bk.book && bk.book.opening, '打包产物应回传出开局名');
  assert.equal(bk.book.source, 'renjunet-tree', '★ 必须走前缀树，不是旧线库');
  assert.ok(bk.book.depth >= 0 && bk.book.cands > 0, '应回传树的深度/候选数');
});

test('打包：依赖顺序正确，且不夹带 UI / 数据模块', () => {
  const src = fs.readFileSync(path.join(ROOT, 'engine/worker-src.js'), 'utf8');
  const m = src.match(/G\.WORKER_SRC = ("(?:[^"\\]|\\.)*");/);
  assert.ok(m, '无法提取 WORKER_SRC');
  const bundle = JSON.parse(m[1]);

  // 顺序：core 必须在 patterns/rules/eval/search 之前；worker-entry 最后
  const marks = require('../tools/build-worker-src.js').FILES.map(f => '/* ===== ' + f + ' ===== */');
  let last = -1;
  for (let k = 0; k < marks.length; k++) {
    const at = bundle.indexOf(marks[k]);
    assert.ok(at > last, '缺失或顺序错误：' + k);
    last = at;
  }
  // Worker 里不需要的模块不得进入（控制体积 / 避免 DOM 依赖）
  // ★ 判定口径说明：裸子串（'ui/'）会被**注释**误伤——'ui/main.js'、'ui/main.computeForbidden'
  //   这类跨模块注释会命中。引擎源码里不得出现对 UI 层的裸引用（含注释），
  //   若误报请改注释写法（写"主线程交互层"而非 "ui/..."），而非放宽断言。
  //   代价：单跑本文件时 bundle 可能领先于源码，需先重新打包（tools/build-worker-src.js）。
  // ★ 注意：engine/book.js 自 M8 起**应当**进入产物（record.js 需要它解析棋谱），
  //   故它不再属于禁用列表。
  // v3.20 起 `engine/data/` **允许**数据文件进产物：`openings.js`（book.js 依赖，且修了上面那个潜伏 bug）
  // 与开局库数据。v3.22 起开局库换成 `book-tree.js`（前缀匹配树，§12.4.3），线库 `book-lines.js`
  // 退出产物（Node 侧仍留档供测试/工具使用）。其余数据文件一律禁止（尤其巨大的题库/原始数据库）。
  // 判定要在**去掉 owning 标记行**之后做，否则 marker 自身就会命中（同上面的裸子串陷阱）。
  const body = marks.reduce((s, m) => s.split(m).join(''), bundle);
  const allowedData = /engine\/data\/(openings|book-tree)\.js/;
  let rest = body;
  for (;;) {
    const m = rest.match(/engine\/data\/[A-Za-z0-9_.-]*\.js/);
    if (!m) break;
    const isAllowed = allowedData.test(m[0]);
    assert.ok(isAllowed, '产物不应包含数据文件 ' + m[0] +
      '（只允许 openings.js / book-tree.js；若源码确认无此依赖，请先重新打包：tools/build-worker-src.js）');
    if (!isAllowed) break;
    rest = rest.slice(m.index + m[0].length);
  }
  for (const bad of ['ui/', 'render.js']) {
    assert.ok(body.indexOf(bad) === -1,
      '产物不应包含 ' + bad + '（若源码确认无此依赖，请先重新打包：tools/build-worker-src.js）');
  }
  // ★ A13（§4.13 / C-11）：`engine/selfcheck.js` 是**开发/测试期**产物，绝不进 worker 打包
  //   （同 Carbon 的 NDEBUG 裁剪）。断言两条独立证据，防白名单被误加回：
  //   (1) 模块标记不在 bundle 内；(2) 其唯一导出名不得出现在产物源码里。
  //   ★ 注意：core.js 里的 `pos.assertIncr` 钩子字段**允许**进产物（生产用一次 null 比较，
  //     零开销；且这是 dev 挂钩子的唯一入口）⇒ 只禁模块本身与 selfcheck 的导出名，
  //     不禁 `assertIncr` 属性名（否则会误伤 core.js 的合法钩子）。
  assert.ok(bundle.indexOf('/* ===== engine/selfcheck.js ===== */') === -1,
    '★ 产物不得夹带 engine/selfcheck.js（A13 自检仅限 dev/test；若已加入白名单请移除并重打包）');
  const full = fs.readFileSync(path.join(ROOT, 'engine/worker-src.js'), 'utf8');
  for (const sym of ['assertIncrementalStructures', 'checkIncrementalStructures', 'checkLineCache',
                     'setAssertIncr', 'selfcheck.js']) {
    assert.ok(full.indexOf(sym) === -1,
      '★ 产物出现了 A13 自检符号 ' + sym + '（selfcheck 模块被夹带进 bundle）');
  }
  // M8 起 worker 需要 record / coach / book（提示、形势判断、棋谱解析都在 worker 侧执行）
  for (const need of ['/* ===== engine/book.js ===== */', '/* ===== engine/record.js ===== */',
                      '/* ===== engine/coach.js ===== */']) {
    assert.ok(bundle.indexOf(need) >= 0, '产物应包含模块 ' + need);
  }
  // ★ 体积上限重标记录（施工图 §4.12 选项②）：
  //   原上限 200 KB 于 A11 禁手缓存（2026-09-20）被顶破——A11 实现（局部窗哈希键 +
  //   偏移表 + 缓存 API）净增 ~3.4 KB 真实代码。经裁决选"重标上限"而非拆包/删注释：
  //   实测 203.1 KB + 明确余量 ⇒ 208 KB。理由与实测见 gomoku-optimization-plan.md §4.12。
  //   ⚠ 这是**硬断言**：新增引擎代码若再顶破，须重新裁决（勿静默继续上调）。
  assert.ok(bundle.length < 208 * 1024, '产物过大：' + (bundle.length / 1024).toFixed(1) + ' KB');
});

test('浏览器加载顺序：index.html 的引擎脚本必须齐备且与依赖顺序一致', () => {
  // ★ 曾经的 bug：新增 engine/threat.js 后忘了加进 index.html —— Node 单测（require 会自动解依赖）
  //   全绿，但浏览器里 search.js 加载即抛错（THREAT undefined）→ 主线程兜底直接不可用。
  const tool = require('../tools/build-worker-src.js');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const pageOrder = [];
  const re = /<script\s+src="(engine\/[^"]+\.js)"/g;
  let m;
  while ((m = re.exec(html)) !== null) pageOrder.push(m[1]);

  const need = tool.FILES.filter(f => f !== 'engine/worker-entry.js');   // 页面不直接加载 worker-entry
  for (const f of need) {
    assert.ok(pageOrder.indexOf(f) >= 0, 'index.html 缺少脚本 ' + f + '（浏览器会直接报错）');
  }
  const idx = need.map(f => pageOrder.indexOf(f));
  for (let k = 1; k < idx.length; k++) {
    assert.ok(idx[k] > idx[k - 1], '加载顺序错误：' + need[k] + ' 必须在 ' + need[k - 1] + ' 之后');
  }
  assert.ok(pageOrder.indexOf('engine/worker-src.js') >= 0, 'index.html 缺少 engine/worker-src.js');
});

/* ══════════════════════════════════════════════════════════════
 * ★ 逐手分析必须"逐手推进棋盘"（缺陷 #36，2026-09-22 探索性测试发现）
 *   真实缺陷：`doAnalyze` 每一手都拿客户端发来的**初始盘面**去算
 *   ⇒ 整局分析的每一手都返回空盘的首选（天元 H8），连"该点已被占用"都发现不了。
 *   用户视角：一局 180 手的棋谱，逐手分析全部写"引擎首选 H8"（而 H8 正是第 1 手）。
 *   为什么长期没被发现：`hard + 威胁` 档在原实现下**每手要 3.2 秒**，只有"空盘"这种
 *   平凡局面才快 —— 缺陷恰好把成本也掩盖了。
 * ══════════════════════════════════════════════════════════════ */
test('analyze｜每手都按"当时局面"分析：首选不得落在已占点（缺陷 #36 回归）', () => {
  const seq = [[7, 7], [7, 6], [8, 7], [6, 6], [7, 8], [6, 8]];
  const res = WE.handle({ id: 1, cmd: 'analyze', board: Array.from(new Int8Array(NN)), stm: BLACK,
    rule: 'freestyle', overlineMode: 'rif', moves: seq, topN: 1,
    difficulty: 'normal', depth: 2, useThreat: false });
  assert.equal(res.cmd, 'analyze');
  assert.equal(res.items.length, seq.length, '每一手都应有分析结果');
  const occ = [];
  for (let k = 0; k < seq.length; k++) {
    const it = res.items[k];
    assert.equal(it.x, seq[k][0], '第 ' + (k + 1) + ' 手坐标应对应原棋谱');
    assert.equal(it.y, seq[k][1]);
    if (it.best) {
      assert.ok(occ.indexOf(idxOf(it.best.x, it.best.y)) < 0,
        '第 ' + (k + 1) + ' 手的"引擎首选"落在已占点 ' + it.best.coord + ' ⇒ 说明分析用的不是当时局面');
    }
    occ.push(idxOf(seq[k][0], seq[k][1]));
  }
  // 第一手是空盘 ⇒ 首选必是天元；用它反证"并非所有手都返回同一个点"
  assert.deepEqual([res.items[0].best.x, res.items[0].best.y], [7, 7], '空盘首选应为天元');
  assert.ok(!(res.items[1].best.x === 7 && res.items[1].best.y === 7), '第二手不应仍是天元（已占）');
});

test('analyze｜非法手（已占点）被标出并停止，不再当合法手分析', () => {
  const res = WE.handle({ id: 1, cmd: 'analyze', board: Array.from(new Int8Array(NN)), stm: BLACK,
    rule: 'freestyle', overlineMode: 'rif', moves: [[7, 7], [7, 7]], topN: 1,
    difficulty: 'normal', depth: 2, useThreat: false });
  assert.equal(res.items.length, 2);
  assert.equal(res.items[1].illegal, 'E_OCCUPIED', '重复落子应标 E_OCCUPIED');
  assert.equal(res.items[1].best, null, '非法手不给"引擎首选"');
  assert.deepEqual(res.stopped, { no: 2, error: 'E_OCCUPIED' }, '★ 截断必须如实回报（否则调用方当成整段完成）');
});

/* ★ R8：analyze 的输入边界与"如实回报"
 *   旧实现三个小坑：① 缺 moves 报 E_NO_BOARD（文案指向"棋盘"，误导）；
 *   ② `topN = req.topN|0` 不做下界 ⇒ 传 -3 会变成 `h.slice(0,-3)`（"去掉尾巴"而非"取前 N"）；
 *   ③ 越界手静默 break，响应里没有任何"被截断"的信号。 */
test('★ analyze｜缺 moves / topN 下界 / 越界手截断如实回报', () => {
  const empty = Array.from(new Int8Array(NN));
  assert.equal(WE.handle({ cmd: 'analyze', board: empty, stm: BLACK }).code, 'E_NO_MOVES');
  assert.equal(WE.handle({ cmd: 'analyze', board: empty, stm: BLACK, moves: [] }).code, 'E_NO_MOVES');

  const base = { id: 1, cmd: 'analyze', board: empty, stm: BLACK, rule: 'freestyle',
                 overlineMode: 'rif', difficulty: 'normal', depth: 2, useThreat: false };
  const neg = WE.handle(Object.assign({}, base, { moves: [[7, 7]], topN: -3 }));
  assert.equal(neg.items.length, 1);
  assert.ok(neg.items[0].topN.length >= 1, 'topN=-3 必须夹到 ≥1（不得变成"去掉尾巴"）');

  const oob = WE.handle(Object.assign({}, base, { moves: [[7, 7], [99, 3], [8, 8]] }));
  // 越界手没有合法坐标，塞进 items 只会让调用方渲染出一条 x=99 的假结果 ⇒ 不入列表，
  // 但"被截断了"这件事必须由 stopped 如实回报（否则调用方把 k+1..n 当成"算过了"）。
  assert.equal(oob.items.length, 1, '越界手不进结果列表（无合法坐标可渲染）');
  assert.deepEqual(oob.stopped, { no: 2, error: 'E_RANGE' }, '越界截断要能被调用方看见');
  assert.equal(WE.handle(Object.assign({}, base, { moves: [[7, 7]] })).stopped, null, '正常跑完 stopped=null');
});
