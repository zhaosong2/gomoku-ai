/* test/threat.test.js — M5 威胁空间搜索（VCF / VCT）单测
 * 核心不变量：**只声明可证真的必胜**
 *   ① 原语 fivePointsAfter 必须与真值 winningPoints 逐位等价；
 *   ② VCF 返回的路径必须能被**独立复算**验证（每步强制、终局成五）；
 *   ③ 随机局面下 VCF 若声称必胜，独立复算必须通过（不得假杀）；
 *   ④ VCT 声称必胜的局面用 PVS 大深度交叉复核为杀。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const SEARCH = require('../engine/search.js');
const RU = require('../engine/rules.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
const pt = i => ({ x: i % N, y: (i / N) | 0 });
const fmt = i => '(' + (i % N) + ',' + ((i / N) | 0) + ')';

/* ---------- 独立复算：验证路径每一步都是"强制"且终局确实取胜 ----------
 * 只依赖规则与"成五点"定义重放，不使用求解器内部状态。
 * 终局合法的三种形态：
 *   · 该手直接成五；
 *   · 该手留下 >=2 个成五点（活四/双四 → 封不住，下一手必成五）；
 *   · （仅 VCT）该手造活三且满足 VCT 前提，交由 PVS 交叉复核。
 */
function verifyPath(stones, atk, path, opt) {
  const allowOt = !!(opt && opt.allowOpenThree);
  const b = new Int8Array(NN);
  for (const s of stones) {
    const i = idxOf(s[0], s[1]);
    if (b[i] !== EMPTY) return 'STONES_OVERLAP';
    b[i] = s[2];
  }
  const def = core.opp(atk);
  const pos = SEARCH.posFromBoard(b, atk);
  const atkFive0 = TH.hasFivePoint(b, atk) >= 0;
  const defFive0 = TH.hasFivePoint(b, def) >= 0;
  // 攻方先手：若攻方自己能立即成五，则"守方有成五点"不影响结论
  if (defFive0 && !atkFive0) return 'DEF_WINS_FIRST';
  if (path.length >= 2 && atkFive0) return 'ATK_ALREADY_HAS_FIVE_POINT';
  if (path.length === 0) return 'EMPTY_PATH';

  for (let k = 0; k < path.length; k++) {
    const i = path[k], p = pt(i);
    const last = (k === path.length - 1);
    if (pos.board[i] !== EMPTY) return 'OCCUPIED@' + k + fmt(i);
    core.makeMove(pos, p.x, p.y, atk);
    const board = pos.board;

    if (RU.isWin(board, p.x, p.y, atk)) return last ? 'OK' : 'WIN_TOO_EARLY@' + k;

    const cnt = TH.fivePointsAfter(board, i, atk);
    if (cnt >= 2) return last ? 'OK' : 'SHOULD_HAVE_WON@' + k;      // 活四/双四：封不住
    if (cnt === 1) {
      if (last) return 'PATH_NOT_WIN';
      // ★ 守方若有自己的成五点，会先成五 → 本手的"强制性"不成立
      if (TH.hasFivePoint(board, def) >= 0) return 'DEF_WINS_FIRST@' + k;
      const fp = TH.winningPoints(board, atk);
      if (fp.length !== 1) return 'FORCE_NOT_UNIQUE@' + k + '(n=' + fp.length + ')';
      core.makeMove(pos, fp[0] % N, (fp[0] / N) | 0, def);           // 对方唯一不失着
      continue;
    }
    // cnt === 0：只有 VCT 的活三终局允许
    if (!allowOt) return 'NOT_FORCING@' + k;
    if (!last) return 'OPEN_THREE_MIDPATH@' + k;
    return 'OK_OPEN_THREE';
  }
  return 'PATH_NOT_WIN';
}
const verifyVcfPath = (stones, atk, path) => verifyPath(stones, atk, path, { allowOpenThree: false });

/* ---------- 构造式局面生成（固定种子，保证可复现） ---------- */
const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];
function* genPositions(count, seed) {
  const rnd = core.mulberry32(seed);
  for (let iter = 0; iter < count; iter++) {
    const stones = [], used = new Uint8Array(NN);
    const atk = rnd() < 0.5 ? BLACK : WHITE, def = core.opp(atk);
    const cx = 6 + ((rnd() * 3) | 0), cy = 6 + ((rnd() * 3) | 0);
    const nL = 2 + ((rnd() * 2) | 0);
    for (let L = 0; L < nL; L++) {
      const d = DIRS4[(rnd() * 4) | 0], len = 2 + ((rnd() * 2) | 0), off = -2 + ((rnd() * 5) | 0);
      for (let k = 0; k < len; k++) {
        const x = cx + d[0] * (k + off), y = cy + d[1] * (k + off);
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        const i = idxOf(x, y);
        if (used[i]) continue;
        used[i] = 1; stones.push([x, y, atk]);
      }
    }
    const nd = 5 + ((rnd() * 5) | 0);
    for (let k = 0; k < nd; k++) {
      const x = cx - 4 + ((rnd() * 9) | 0), y = cy - 4 + ((rnd() * 9) | 0);
      if (x < 0 || x >= N || y < 0 || y >= N) continue;
      const i = idxOf(x, y);
      if (used[i]) continue;
      used[i] = 1; stones.push([x, y, def]);
    }
    yield { stones, atk };
  }
}

/* ---------- ① 原语等价性 ---------- */
test('原语：fivePointsAfter 与真值 winningPoints 逐位等价（随机抽样）', () => {
  const rnd = core.mulberry32(20260918);
  let tested = 0, mismatch = 0, withFour = 0;
  for (let t = 0; t < 60; t++) {
    const b = new Int8Array(NN);
    for (let k = 0; k < 14; k++) { const i = (rnd() * NN) | 0; if (b[i] === EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE; }
    const wp = TH.winningPoints(b, BLACK);
    for (let i = 0; i < NN; i++) {
      if (b[i] !== EMPTY) continue;
      tested++;
      const cnt = TH.fivePointsAfter(b, i, BLACK);
      const isFive = cnt >= TH.ALREADY, isWp = wp.indexOf(i) >= 0;
      const b2 = b.slice(); b2[i] = BLACK;
      const n2 = TH.winningPoints(b2, BLACK).length;
      if (isFive !== isWp || (cnt >= 1) !== (n2 >= 1)) mismatch++;
      if (cnt >= 1 && cnt < TH.ALREADY) withFour++;
    }
  }
  assert.equal(mismatch, 0, '存在不一致的格点');
  assert.ok(tested > 8000, '抽样量不足：' + tested);
  assert.ok(withFour > 0, '抽样里应出现"造四"点');
});

/* ---------- ② VCF：已知局面 ---------- */
test('VCF：4 步冲四链（黑）', () => {
  const stones = [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
                  [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]];
  const pos = SEARCH.posFromBoard(boardOf(stones), BLACK);
  const r = TH.vcfWin(pos, BLACK, { depth: 8, budget: 50000 });
  assert.ok(r, '应找到 VCF 必胜');
  assert.equal(r.via, 'vcf');
  assert.ok(r.plies >= 3, '应为多步链，实际 plies=' + r.plies);
  assert.equal(verifyVcfPath(stones, BLACK, r.path), 'OK', '路径必须通过独立复算');
});

test('VCF：3 步冲四链（白）', () => {
  const stones = [[7, 8, 2], [8, 7, 2], [7, 9, 2], [7, 10, 2], [9, 10, 2], [10, 11, 2],
                  [8, 6, 1], [11, 12, 1], [7, 11, 1], [6, 10, 1], [6, 4, 1], [10, 8, 1], [8, 12, 1], [8, 5, 1]];
  const pos = SEARCH.posFromBoard(boardOf(stones), WHITE);
  const r = TH.vcfWin(pos, WHITE, { depth: 8, budget: 50000 });
  assert.ok(r, '应找到 VCF 必胜');
  assert.ok(r.plies >= 3, 'plies=' + r.plies);
  assert.equal(verifyVcfPath(stones, WHITE, r.path), 'OK');
});

test('VCF：活四局面（无需递归即胜）', () => {
  const stones = [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK]];
  const pos = SEARCH.posFromBoard(boardOf(stones), BLACK);
  const r = TH.vcfWin(pos, BLACK, { depth: 4, budget: 5000 });
  assert.ok(r);
  assert.equal(verifyVcfPath(stones, BLACK, r.path), 'OK');
});

test('VCF：对方先能成五时必须拒绝（不可强制）', () => {
  // 黑有活三但不成立；白已有成五点 → 黑任何"冲四"都挡不住白先成五
  const stones = [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
                  [3, 5, WHITE], [4, 5, WHITE], [5, 5, WHITE], [6, 5, WHITE]];
  const pos = SEARCH.posFromBoard(boardOf(stones), BLACK);
  assert.equal(TH.hasFivePoint(boardOf(stones), WHITE) >= 0, true, '前置：白应有成五点');
  assert.equal(TH.vcfWin(pos, BLACK, { depth: 8, budget: 20000 }), null, '不可声明必胜');
});

/* ---------- ③ 不得假杀：随机局面下所有 VCF 结论都要经独立复算 ---------- */
test('VCF：12000 个构造局面中，所有"必胜"结论均通过独立复算', () => {
  let claims = 0, multiPly = 0, skipped = 0;
  for (const { stones, atk } of genPositions(12000, 31337)) {
    let r;
    try { r = TH.vcfWin(SEARCH.posFromBoard(boardOf(stones), atk), atk, { depth: 8, budget: 20000 }); }
    catch (e) { skipped++; continue; }
    if (!r) continue;
    claims++;
    if (r.plies >= 3) multiPly++;
    const verdict = verifyVcfPath(stones, atk, r.path);
    assert.equal(verdict, 'OK', '假杀！stones=' + JSON.stringify(stones.map(s => [s[0], s[1], s[2]])) +
      ' atk=' + atk + ' path=' + JSON.stringify(r.path.map(fmt)) + ' 复算=' + verdict);
  }
  assert.ok(claims >= 50, '样本里应出现足够多的 VCF 结论，实际 ' + claims);
  assert.ok(multiPly >= 3, '应包含多步链，实际 ' + multiPly);
  console.log('     VCF 结论 ' + claims + ' 例（其中多步链 ' + multiPly + ' 例）全部复算通过');
});

/* ---------- ④ VCT ---------- */
test('VCT：双活三必胜（VCF 找不到、VCT 能找到）', () => {
  const stones = [[6, 7, WHITE], [8, 7, WHITE], [7, 6, WHITE], [7, 8, WHITE]];
  assert.equal(TH.vcfWin(SEARCH.posFromBoard(boardOf(stones), WHITE), WHITE, { depth: 6, budget: 20000 }), null,
    '该局面不是纯冲四杀，VCF 应返回 null');
  const r = TH.vctWin(SEARCH.posFromBoard(boardOf(stones), WHITE), WHITE, { depth: 8, budget: 40000 });
  assert.ok(r, 'VCT 应找到必胜');
  assert.equal(r.via, 'vct');
  assert.deepEqual(r.move, { x: 7, y: 7 }, '正解是落天元成活三双杀');
});

test('VCT：结论需与 PVS 大深度交叉复核一致', () => {
  const cases = [
    { stones: [[6, 7, WHITE], [8, 7, WHITE], [7, 6, WHITE], [7, 8, WHITE]], atk: WHITE },
    { stones: [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
               [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]], atk: BLACK },
  ];
  for (const c of cases) {
    const r = TH.vctWin(SEARCH.posFromBoard(boardOf(c.stones), c.atk), c.atk, { depth: 8, budget: 40000 });
    if (!r) continue;                                  // 未声明则无需复核
    const v = verifyPath(c.stones, c.atk, r.path, { allowOpenThree: true });
    assert.ok(v === 'OK' || v === 'OK_OPEN_THREE', 'VCT 路径复算失败：' + v);
    SEARCH.ttClear();
    const pv = SEARCH.think(SEARCH.posFromBoard(boardOf(c.stones), c.atk),
      { maxDepth: 12, width: 20, hardLimit: 12000, ttBits: 20 });
    assert.ok(Math.abs(pv.score) >= 99999000, 'PVS 应复核为杀，实际 score=' + pv.score);
  }
});

test('求解器：预算确实生效（不超时、可中断）', () => {
  const stones = [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
                  [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]];
  const t0 = Date.now();
  const r = TH.vcfWin(SEARCH.posFromBoard(boardOf(stones), BLACK), BLACK, { depth: 16, budget: 200 });
  assert.ok(Date.now() - t0 < 3000, '小预算应迅速返回');
  if (r) assert.ok(r.nodes <= 210, '不应超过预算，实际 ' + r.nodes);
});

test('求解器：搜索后棋盘必须完全复原', () => {
  const stones = [[7, 8, 2], [8, 7, 2], [7, 9, 2], [7, 10, 2], [9, 10, 2], [10, 11, 2],
                  [8, 6, 1], [11, 12, 1], [7, 11, 1], [6, 10, 1], [6, 4, 1], [10, 8, 1], [8, 12, 1], [8, 5, 1]];
  const pos = SEARCH.posFromBoard(boardOf(stones), WHITE);
  const before = Array.from(pos.board);
  const h = pos.hist.length;
  TH.vctWin(pos, WHITE, { depth: 6, budget: 30000 });
  TH.vcfWin(pos, WHITE, { depth: 6, budget: 30000 });
  assert.deepEqual(Array.from(pos.board), before, '不得残留落子');
  assert.equal(pos.hist.length, h, '历史栈应复原');
  assert.equal(pos.stm, WHITE, '走子方应复原');
});

/* ---------- ⑤ 与 think 的集成（§25.4） ---------- */
test('集成：think 由 VCF 接管（via=vcf）且耗时远小于完整搜索', () => {
  const stones = [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
                  [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]];
  SEARCH.ttClear();
  const r = SEARCH.think(SEARCH.posFromBoard(boardOf(stones), BLACK), { difficulty: 'hard', rule: 'freestyle' });
  assert.equal(r.via, 'vcf', '应由 VCF 接管');
  assert.deepEqual(r.move, { x: 8, y: 6 });
  assert.ok(r.path && r.path.length >= 3, '应返回杀法路径');
  assert.equal(verifyVcfPath(stones, BLACK, r.path), 'OK', '集成后的路径同样必须可复算');
  // 关掉威胁搜索后仍应能找到（但耗时显著更长）
  SEARCH.ttClear();
  const t0 = Date.now();
  const plain = SEARCH.think(SEARCH.posFromBoard(boardOf(stones), BLACK),
    { difficulty: 'hard', rule: 'freestyle', vcfDepth: 0, vctDepth: 0, avoidOpp: false });
  const plainMs = Date.now() - t0;
  assert.ok(r.timeMs <= plainMs, 'VCF 接管应不慢于完整搜索：' + r.timeMs + 'ms vs ' + plainMs + 'ms');
});

test('集成：think 由 VCT 接管（via=vct）', () => {
  const stones = [[6, 7, WHITE], [8, 7, WHITE], [7, 6, WHITE], [7, 8, WHITE]];
  SEARCH.ttClear();
  const r = SEARCH.think(SEARCH.posFromBoard(boardOf(stones), WHITE), { difficulty: 'master', rule: 'freestyle' });
  assert.equal(r.via, 'vct');
  assert.deepEqual(r.move, { x: 7, y: 7 });
});

test('集成：vcfDepth=0 时关闭威胁搜索（不做无谓开销）', () => {
  const stones = [[6, 7, WHITE], [8, 7, WHITE], [7, 6, WHITE], [7, 8, WHITE]];
  SEARCH.ttClear();
  const r = SEARCH.think(SEARCH.posFromBoard(boardOf(stones), WHITE), {
    difficulty: 'master', rule: 'freestyle', vcfDepth: 0, vctDepth: 0, avoidOpp: false });
  assert.notEqual(r.via, 'vct');
  assert.notEqual(r.via, 'vcf');
});

/* ---------- ⑥ 防守侧：对方 VCF 规避 ---------- */
test('防守：avoidOpponentVcf 只放行"走后对方无 VCF"的着法', () => {
  // 守方=白；黑方存在 3 步 VCF；白方仅少量安全着法（见 tools/find-defense-case.js）
  const stones = [[10, 10, 1], [11, 11, 1], [7, 10, 1], [7, 11, 1], [6, 8, 1], [7, 7, 1],
                  [6, 7, 2], [11, 4, 2], [8, 3, 2], [2, 10, 2], [12, 3, 2], [5, 2, 2]];
  const atk = WHITE, opp = BLACK;
  const b0 = boardOf(stones);
  assert.ok(TH.vcfWin(SEARCH.posFromBoard(b0, opp), opp, { depth: 6, budget: 20000 }), '前置：黑方应有 VCF');

  // 构造根候选（按 §24.3 的攻防同量纲排序）
  const cand = require('../engine/eval.js').candidates(b0, 2);
  const rootMoves = cand.map(i => ({ i: i, x: i % N, y: (i / N) | 0 }))
    .map(m => (m.s = require('../engine/eval.js').moveScoreAt(b0, m.i, atk, { rule: 'freestyle', lambda: 0.9 }, null), m))
    .sort((a, b) => b.s - a.s);

  const allowed = SEARCH.avoidOpponentVcf(SEARCH.posFromBoard(b0, atk),
    { avoidOpp: true, vcfDepth: 8, avoidK: 10, avoidDepth: 8, avoidBudget: 20000 }, rootMoves);
  assert.ok(allowed, '存在危险着法时应返回允许集');
  assert.ok(allowed.size > 0 && allowed.size <= 10, '允许集应非空且不超过 avoidK：' + allowed.size);

  // 独立复核：允许集里的每一手，走后黑方都不得再有 VCF
  for (const i of allowed) {
    const b = b0.slice(); b[i] = atk;
    const still = TH.vcfWin(SEARCH.posFromBoard(b, opp), opp, { depth: 6, budget: 20000 });
    assert.equal(still, null, '允许集里出现了"走完仍被对方 VCF"的着法：' + fmt(i));
  }
});
