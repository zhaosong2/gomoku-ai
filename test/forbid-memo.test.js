/* test/forbid-memo.test.js — A11 禁手评估缓存单测（§4.12）
 *
 * 出口判据（施工图 §4.12 / §5 第 4 批）：
 *   ① **命中率 ≥ 20%**（P-F 已实测 57.0%；本测试在真实 renju 搜索里复核）
 *   ② 与"无缓存路径"**对拍 diff == 0**（硬红线；缓存键设计不当会静默返回错误禁手结论）
 *   ③ `cfg.forbidMemo` 默认 **false** ⇒ `forbiddenAt` 逐位与旧行为一致
 *   ④ 不同 `mode` / 不同盘面**不串味**
 *   ⑤ 缓存语义**唯一入口**：`forbiddenAt` 与 `forbiddenAtCached` 在任意局面下同结果
 *
 * ★ 关键纪律：`forbiddenAt` 只对**空点**生效（`board[idx] !== EMPTY` ⇒ NONE）。
 *   构造用例时中心点必须为空，否则永远返回 NONE，测不到东西。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const P40 = require('./data/positions40.json');

/* ---------- 参考实现：无缓存版（直接调 forbiddenCore，不经任何 memo） ---------- */
function forbidNoCache(board, idx, mode) {
  const m = mode | 0;
  if (!m || board[idx] !== EMPTY) return PAT.FD_NONE;
  board[idx] = BLACK;
  let r;
  try { r = PAT.forbiddenCore(board, idx, m); } finally { board[idx] = EMPTY; }
  return r;
}

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}

/* 权威构造局面（取自 test/forbidden.test.js 的 CASES：三三/四四/长连/五三三/四三）
 * ★ 用它们而不是自造，是为了保证覆盖真实分歧的禁手等级（DOUBLE_THREE / DOUBLE_FOUR / OVERLINE / NONE） */
const FIX = [
  { name: '三三', stones: [[6, 7, 1], [9, 7, 1], [7, 5, 1], [7, 8, 1]], p: [7, 7] },
  { name: '四四', stones: [[4, 7, 1], [5, 7, 1], [6, 7, 1], [7, 8, 1], [7, 9, 1], [7, 10, 1],
                          [3, 7, 2], [7, 11, 2]], p: [7, 7] },
  { name: '长连', stones: [[3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1], [8, 7, 1]], p: [7, 7] },
  { name: '五三三', stones: [[4, 7, 1], [5, 7, 1], [6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 9, 1],
                            [6, 6, 1], [9, 9, 1]], p: [7, 7] },
  { name: '四三', stones: [[4, 7, 1], [5, 7, 1], [6, 7, 1], [3, 7, 2], [7, 6, 1], [7, 9, 1]], p: [7, 7] },
];

/* 每个固定局面 + 全空点扫一遍，覆盖 NONE/三三/四四/长连等多档结论 */
function sweepPositions() {
  const out = [];
  for (const f of FIX) {
    const b = boardOf(f.stones);
    out.push({ name: f.name, b: b, idxs: allEmpty(b) });
  }
  return out;
}
function allEmpty(b) { const a = []; for (let i = 0; i < NN; i++) if (b[i] === EMPTY) a.push(i); return a; }

/* ---------- ⑤ 语义唯一入口：forbiddenAt 与 forbiddenCore 同结果 ---------- */
test('⑤ ★ forbiddenAtCached 与无缓存路径逐点同结果（权威构造 × 全空点 × mode 1/2）', () => {
  let checked = 0, nontrivial = 0;
  PAT.forbidMemoSet(false);
  for (const { b, idxs } of sweepPositions()) {
    for (const idx of idxs) {
      for (const mode of [1, 2]) {
        const ref = forbidNoCache(b, idx, mode);
        PAT.forbidMemoSet(true);
        const got = PAT.forbiddenAt(b, idx, mode);
        PAT.forbidMemoSet(false);
        assert.equal(got, ref, 'idx=' + idx + ' mode=' + mode + ' 缓存与无缓存不一致');
        checked++;
        if (ref !== PAT.FD_NONE) nontrivial++;
      }
    }
  }
  assert.ok(checked > 1000, '对拍样本不足：' + checked);
  assert.ok(nontrivial > 0, '★ 测试无效：从未覆盖到"真禁手"结论（全为 NONE）');
});

/* ---------- ④ 不串味：同一 idx 不同盘面 / 不同 mode ---------- */
test('④ ★ 缓存键含盘面 + mode ⇒ 不串味', () => {
  PAT.forbidMemoClear();
  PAT.forbidMemoSet(true);
  const A = boardOf([[6, 7, 1], [9, 7, 1], [7, 5, 1], [7, 8, 1]]);       // (7,7)=三三
  const B = Int8Array.from(A); B[idxOf(6, 7)] = 0;                      // 拆掉一子 ⇒ 同 idx 不同结论
  const idx = idxOf(7, 7);
  const ra = PAT.forbiddenAt(A, idx, 1);
  const rb = PAT.forbiddenAt(B, idx, 1);
  const rc = PAT.forbiddenAt(A, idx, 2);                                // 同盘面不同 mode
  assert.equal(ra, forbidNoCache(A, idx, 1), 'A 盘面结果错');
  assert.equal(rb, forbidNoCache(B, idx, 1), 'B 盘面结果错（疑似串味）');
  assert.equal(rc, forbidNoCache(A, idx, 2), 'A 盘面 mode=2 结果错（疑似串味）');
  assert.ok(PAT.forbidMemoStats().size >= 3, '三个不同 (盘面,mode) 键应产生 ≥3 项');
  PAT.forbidMemoSet(false);
});

/* ---------- ③ 默认关：cfg.forbidMemo 缺省 ⇒ 无缓存生效 ---------- */
test('③ ★ 默认关逐位不变：不传 forbidMemo 时 forbiddenAt 行为 == 无缓存', () => {
  // 直接复位为关态，模拟"从未打开"
  PAT.forbidMemoSet(false);
  const before = PAT.forbidMemoStats();
  const b = boardOf([[6, 7, 1], [9, 7, 1], [7, 5, 1], [7, 8, 1]]);   // (7,7)=三三禁手
  for (let k = 0; k < 50; k++) PAT.forbiddenAt(b, idxOf(7, 7), 1);
  const after = PAT.forbidMemoStats();
  assert.equal(after.hit, before.hit, '关态下不应产生命中');
  assert.equal(after.miss, before.miss, '关态下不应产生未命中');
});

/* ---------- ①② 真实搜索：命中率 ≥20% + 无缓存对拍 diff==0 ---------- */
test('①② ★ renju 真实搜索：命中率 ≥20% 且与无缓存路径逐位一致', () => {
  const CFG = { difficulty: 'hard', useBook: false, rule: 'renju', maxDepth: 3, hardLimit: 20000,
                vcfDepth: 0, vctDepth: 0, avoidOpp: false, incr: true };
  let diff = 0, ok = 0, totHit = 0, totMiss = 0, anyMove = false;
  for (let k = 0; k < 12; k++) {
    const p = P40[k];
    SEARCH.ttClear();
    const r1 = SEARCH.think(SEARCH.posFromBoard(Int8Array.from(p.board), p.stm, p.hist),
                            Object.assign({}, CFG, { forbidMemo: false }));
    const s0 = PAT.forbidMemoStats();                    // 关态后计数应不变
    const hitB = s0.hit, missB = s0.miss;
    const b1 = Int8Array.from(p.board);
    // 关态搜索后：随机抽 20 个空点重算，与缓存版对拍
    PAT.forbidMemoClear();
    SEARCH.ttClear();
    const r2 = SEARCH.think(SEARCH.posFromBoard(Int8Array.from(p.board), p.stm, p.hist),
                            Object.assign({}, CFG, { forbidMemo: true }));
    const s1 = PAT.forbidMemoStats();
    totHit += s1.hit; totMiss += s1.miss;
    if (!r1 || !r2) continue;
    ok++;
    if (r1.move.x !== r2.move.x || r1.move.y !== r2.move.y || r1.score !== r2.score) {
      diff++;
      console.log('  DIFF #' + k + ' off=' + JSON.stringify(r1.move) + '/' + r1.score +
                  ' on=' + JSON.stringify(r2.move) + '/' + r2.score);
    }
    // 缓存本身的对拍（同一盘面、全空点）
    PAT.forbidMemoSet(true);
    for (let i = 0; i < NN; i++) {
      if (b1[i] !== EMPTY) continue;
      const ref = forbidNoCache(b1, i, 1);
      const got = PAT.forbiddenAt(b1, i, 1);
      if (got !== ref) { diff++; console.log('  缓存不一致 idx=' + i + ' ref=' + ref + ' got=' + got); break; }
    }
    PAT.forbidMemoSet(false);
    if (r2 && r2.move) anyMove = true;
  }
  PAT.forbidMemoSet(false);
  const rate = (totHit + totMiss) > 0 ? totHit / (totHit + totMiss) : 0;
  console.log('  renju 搜索：hit=' + totHit + ' miss=' + totMiss + ' 命中率=' + (rate * 100).toFixed(1) + '%');
  assert.equal(diff, 0, '硬红线：缓存开启后必须逐位一致，diff=' + diff);
  assert.ok(ok >= 10, '有效样本不足：' + ok);
  assert.ok(anyMove, '搜索应产生着法');
  assert.ok(rate >= 0.20, 'A11 生死判据：命中率须 ≥20%，实测 ' + (rate * 100).toFixed(1) + '%');
});

/* ---------- freestyle 下 forbiddenAt 调用为 0（mS>0 短路） ---------- */
test('★ freestyle 下不产生禁手缓存流量（收益集中在 renju）', () => {
  PAT.forbidMemoClear();
  const CFG = { difficulty: 'hard', useBook: false, rule: 'freestyle', maxDepth: 3, hardLimit: 8000,
                vcfDepth: 0, vctDepth: 0, avoidOpp: false, incr: true, forbidMemo: true };
  SEARCH.ttClear();
  SEARCH.think(SEARCH.posFromBoard(Int8Array.from(P40[0].board), P40[0].stm, P40[0].hist), CFG);
  const s = PAT.forbidMemoStats();
  assert.equal(s.hit + s.miss, 0, 'freestyle 下 forbiddenAt 不应被调用（mS>0 短路）');
  PAT.forbidMemoSet(false);
});

/* ---------- ★ 局部性护栏：结论只依赖 idx 周围 R=5 ---------- */
test('★ 局部性护栏：把 R=5 窗外的格子任意改动，结论必须不变', () => {
  // 依据 tools/_a11-locality.js 的实证（58674 次真实调用 0 冲突）。
  // 这里在固定局面上做"扰动窗外"的硬性验证：随机改动距离 > R 的格子，结果必须逐位一致。
  PAT.forbidMemoSet(false);
  const R = 5;
  const base = boardOf([[6, 7, 1], [9, 7, 1], [7, 5, 1], [7, 8, 1], [4, 3, 2], [10, 11, 2], [2, 2, 2]]);
  const idx = idxOf(7, 7);
  const ref = forbidNoCache(base, idx, 1);
  let rng = 12345;
  const nx = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let changed = 0;
  for (let trial = 0; trial < 50; trial++) {
    const b = Int8Array.from(base);
    for (let i = 0; i < NN; i++) {
      const x = i % N, y = (i / N) | 0;
      if (Math.max(Math.abs(x - 7), Math.abs(y - 7)) <= R) continue;   // 窗内不动
      if (b[i] !== EMPTY) continue;
      if (nx() < 0.1) { b[i] = nx() < 0.5 ? 1 : 2; changed++; }
    }
    const got = forbidNoCache(b, idx, 1);
    assert.equal(got, ref, '窗外扰动改变了结论（R=' + R + ' 局部性不成立）trial=' + trial);
  }
  assert.ok(changed > 50, '扰动样本不足：' + changed);
});

/* ---------- I-neg：篡改缓存键（去掉盘面）必爆 ---------- */
test('★ I-neg：缓存键若漏掉盘面内容，则跨局面串味 ⇒ 对拍必挂', () => {
  // 独立实现一个"坏缓存"（键 = idx|mode，不含盘面）在本地核对，不污染真实导出
  const bad = new Map();
  function badAt(board, idx, mode) {
    const key = idx + '|' + mode;
    let r = bad.get(key);
    if (r === undefined) { r = forbidNoCache(board, idx, mode); bad.set(key, r); }
    return r;
  }
  const idx = idxOf(10, 7);
  // A：idx 处落黑成 7 连长连 ⇒ OVERLINE（禁手）；B：同一 idx 附近无子 ⇒ 合法（0）
  const A = boardOf([[4, 7, 1], [5, 7, 1], [6, 7, 1], [7, 7, 1], [8, 7, 1], [9, 7, 1]]);
  const B = boardOf([[0, 0, 1], [1, 0, 1]]);            // 与 idx 无关的零散子
  const refA = forbidNoCache(A, idx, 1);
  const refB = forbidNoCache(B, idx, 1);
  assert.notEqual(refA, refB, '构造失败：两盘面对同一 idx 结论应不同（A=' + refA + ' B=' + refB + '）');
  const ra = badAt(A, idx, 1);
  const rb = badAt(B, idx, 1);
  assert.equal(ra, refA, '坏缓存首算应正确');
  assert.notEqual(rb, refB, '构造失败：坏缓存未串味');       // 坏缓存把 A 的结论串给了 B
  assert.equal(rb, refA, '坏缓存应返回被串味的（错误）结论');
});

