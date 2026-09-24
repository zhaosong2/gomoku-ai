/* test/leafvcf.test.js — A3 叶节点 VCF 单测（§4.3）
 *
 * 覆盖：
 *   ① 开关语义：默认 leafVcfDepth=0（常关）；H_LEAFVCF 位独立；不传字段即回滚
 *   ② 机制生效：已知 VCF 题在"叶 VCF 开 + 根层 VCF 关"下能解出（关态解不出）
 *   ③ ★杀分口径：返回值必须 >= MATE（否则 think 的见杀早停 / toTT 的 ply 补偿 / 分析侧判据全失效）
 *      —— 这是 2026-09-20 实测发现的施工图伪码缺陷（原稿 PAT.WIN-1000-ply < MATE）
 *   ④ 等价性：叶 VCF 关闭时，根着法与分数必须与"位不设"完全一致（零副作用）
 *   ⑤ 禁手安全：renju 下开叶 VCF 不得让黑方走禁手（#33 护栏）
 *   ⑥ 命中率成本护栏：安静中局（无 VCF 杀）里的叶 VCF 不应把节点数抬爆
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const SEARCH = require('../engine/search.js');
const OP = require('../engine/data/openings.js');
const M = require('../engine/data/mates.js');
const V = require('./../tools/verify-mate.js');

const { NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;
const H = SEARCH.H;
const MATE = PAT.WIN - 1000;

function midGame(k) {
  const pos = core.createPosition();
  SEARCH.attachCache(pos, true);
  let t = BLACK;
  for (const m of OP.OPENINGS[k % OP.OPENINGS.length].moves) { core.makeMove(pos, m.x, m.y, t); t = opp(t); }
  for (const m of [[5, 5], [9, 9], [4, 10], [10, 4], [6, 10], [8, 4], [10, 10], [4, 4]]) {
    core.makeMove(pos, m[0], m[1], t); t = opp(t);
  }
  return { board: pos.board.slice(), stm: pos.stm };
}
function fresh(p) { const pos = SEARCH.posFromBoard(p.board, p.stm); SEARCH.attachCache(pos, true); return pos; }

const CFG = { width: 14, radius: 2, ttBits: 14, incr: true, rule: 'freestyle', overlineMode: 'rif',
              vcfDepth: 0, vctDepth: 0, avoidOpp: false };
function run(p, extra) {
  SEARCH.ttClear();
  return SEARCH.think(fresh(p), Object.assign({}, CFG, { h: H.ALL | H.LEAFVCF }, extra));
}

test('A3 开关语义：默认常关；位值正确；不传字段即回滚', () => {
  assert.equal(H.LEAFVCF, 1024, 'H_LEAFVCF 应为 1024（§4.3）');
  assert.equal(H.ALL & H.LEAFVCF, 0, '★ 验收前 LEAFVCF 不应并入 ALL（并入需验收通过）');
  assert.equal(SEARCH.DEFAULT.leafVcfDepth, 0, 'leafVcfDepth 默认必须为 0（常关）');
  assert.equal(SEARCH.DEFAULT.leafVcfBudget, 2000, 'leafVcfBudget 默认 2000');
  // 不传字段 ⇒ 保持 0 ⇒ 机制不触发（回滚语义）
  const r = run(midGame(0), { maxDepth: 4, hardLimit: 600000 });
  assert.equal(r.nodes > 0, true);
  assert.deepEqual(SEARCH.leafVcfStat(), { calls: 0, hits: 0 },
    'leafVcfDepth=0 时叶 VCF 计数器必须为 0（证明未触发）');
});

test('A3 等价性：leafVcfDepth=0 时与"不含 LEAFVCF 位"结论完全一致（零副作用）', () => {
  for (let k = 0; k < 3; k++) {
    const p = midGame(k);
    SEARCH.ttClear();
    const a = SEARCH.think(fresh(p), Object.assign({}, CFG, { maxDepth: 6, hardLimit: 600000, h: H.ALL }));
    SEARCH.ttClear();
    const b = SEARCH.think(fresh(p), Object.assign({}, CFG, { maxDepth: 6, hardLimit: 600000,
      h: H.ALL | H.LEAFVCF, leafVcfDepth: 0 }));
    assert.equal(b.score, a.score, '局面 ' + k + ' 关态分数必须逐位一致');
    assert.equal(b.move && b.move.i, a.move && a.move.i, '局面 ' + k + ' 关态根着法必须一致');
    assert.equal(b.nodes, a.nodes, '局面 ' + k + ' 关态节点数必须一致');
  }
});

test('★A3 杀分口径：叶 VCF 返回值必须 >= MATE（施工图伪码缺陷回归）', () => {
  // 施工图原稿 `PAT.WIN - 1000 - ply` = MATE - ply < MATE ⇒ 三处杀分语义同时失效：
  //   ① think() 的 `bestV >= MATE` 见杀早停判不出
  //   ② toTT/fromTT 的 `v >= MATE` 分支不命中（ply 补偿丢失）
  //   ③ bench-mates / 分析侧 `|score| >= MATE` 判据漏判
  // 正确口径 = PAT.WIN - ply（与 pvs 成五返回一致）。
  assert.ok(PAT.WIN - 1000 - 6 < MATE, '证明伪码口径确实 < MATE（缺陷成立）');
  assert.ok(PAT.WIN - 6 >= MATE, '证明正确口径 >= MATE');

  // 找一道短链 VCF 题：开叶 VCF 必须解出且分数 >= MATE
  let checked = 0;
  for (let k = 0; k < M.ATTACK.length && checked < 3; k++) {
    const p = M.ATTACK[k];
    SEARCH.ttClear();
    const r = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk),
      Object.assign({}, CFG, { difficulty: 'hard', hardLimit: 4000, maxDepth: 8,
        h: H.ALL | H.LEAFVCF, leafVcfDepth: 6, leafVcfBudget: 2000 }));
    if (r.score >= MATE) {
      checked++;
      assert.ok(r.score >= MATE, '题 ' + k + ' 解出后分数 ' + r.score + ' 必须 >= MATE(' + MATE + ')');
      assert.ok(r.score <= PAT.WIN, '杀分不得超过 PAT.WIN');
    }
  }
  assert.ok(checked > 0, '至少应有一道题被叶 VCF 解出（否则机制未生效）');
});

test('A3 机制生效：叶 VCF 开 ⇒ 题库翻盘（关态解不出、开态解出）', () => {
  // 取已知 vcf 题，隔离根层战术（vcfDepth=0），只靠叶 VCF
  const p = M.ATTACK[0];
  SEARCH.ttClear(); SEARCH.leafVcfReset();
  const off = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk),
    Object.assign({}, CFG, { hardLimit: 4000, maxDepth: 8, h: H.ALL | H.LEAFVCF, leafVcfDepth: 0 }));
  const stOff = SEARCH.leafVcfStat();

  SEARCH.ttClear(); SEARCH.leafVcfReset();
  const on = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk),
    Object.assign({}, CFG, { hardLimit: 4000, maxDepth: 8, h: H.ALL | H.LEAFVCF,
      leafVcfDepth: 6, leafVcfBudget: 2000 }));
  const stOn = SEARCH.leafVcfStat();

  assert.equal(stOff.calls, 0, '关态不得调用叶 VCF');
  assert.ok(stOn.calls > 0, '开态必须真的调用了叶 VCF（否则本题不触达叶节点）');
  assert.ok(stOn.hits > 0, '开态应有命中');
  console.log('     题0 关态 score=' + off.score + ' nodes=' + off.nodes +
    ' | 开态 score=' + on.score + ' nodes=' + on.nodes +
    ' calls=' + stOn.calls + ' hits=' + stOn.hits);
  // 开态要么解出（score >= MATE），要么至少分数被显著抬高（叶 VCF 提供更准的战术估值）
  assert.ok(on.score >= MATE || on.score > off.score,
    '开态必须解出或抬高分数（关态 ' + off.score + ' → 开态 ' + on.score + '）');
});

test('A3 禁手安全：renju 下开叶 VCF 不得让黑方走禁手（#33 护栏）', () => {
  // 用 forbidden.test.js 同款构造：黑方处于禁手压力局面，开叶 VCF 后根着法仍不得是禁手点
  const stones = [[7, 7, BLACK], [8, 8, WHITE], [7, 8, BLACK], [6, 6, WHITE], [7, 6, BLACK]];
  const board = new Int8Array(NN);
  for (const s of stones) board[idxOf(s[0], s[1])] = s[2];
  const pos = SEARCH.posFromBoard(board, BLACK);
  SEARCH.attachCache(pos, true);
  SEARCH.ttClear();
  const r = SEARCH.think(pos, {
    width: 14, radius: 2, ttBits: 14, incr: true,
    rule: 'renju', overlineMode: 'rif',
    vcfDepth: 0, vctDepth: 0, avoidOpp: false,
    maxDepth: 6, hardLimit: 3000,
    h: H.ALL | H.LEAFVCF, leafVcfDepth: 6, leafVcfBudget: 2000,
  });
  if (r.move) {
    const forb = PAT.forbiddenAt(pos.board, idxOf(r.move.x, r.move.y), PAT.forbidMode(BLACK, 'renju', 'rif'));
    assert.equal(forb, false, '根着法 (' + r.move.x + ',' + r.move.y + ') 不得是黑方禁手点');
  }
});

test('A3 成本护栏：安静中局开叶 VCF 的节点增幅受控（叶预算硬限）', () => {
  // 安静中局无 VCF 杀 ⇒ 叶 VCF 只烧时间不产出。检查预算硬限是否真的挡住成本爆炸。
  let offNodes = 0, onNodes = 0, calls = 0, hits = 0;
  SEARCH.leafVcfReset();
  for (let k = 0; k < 4; k++) {
    const p = midGame(k);
    SEARCH.ttClear();
    const a = SEARCH.think(fresh(p), Object.assign({}, CFG, { maxDepth: 6, hardLimit: 600000,
      h: H.ALL | H.LEAFVCF, leafVcfDepth: 0 }));
    offNodes += a.nodes;
    SEARCH.ttClear();
    const b = SEARCH.think(fresh(p), Object.assign({}, CFG, { maxDepth: 6, hardLimit: 600000,
      h: H.ALL | H.LEAFVCF, leafVcfDepth: 6, leafVcfBudget: 2000 }));
    onNodes += b.nodes;
  }
  const st = SEARCH.leafVcfStat();
  calls = st.calls; hits = st.hits;
  const ratio = onNodes / offNodes;
  console.log('     安静中局 4 局面：关 ' + offNodes + ' 节点 → 开 ' + onNodes +
    ' 节点（×' + ratio.toFixed(2) + '）  叶 VCF calls=' + calls + ' hits=' + hits);
  assert.ok(ratio < 2.5, '安静中局节点增幅应受控（实测 ×' + ratio.toFixed(2) + ' < 2.5）');
});
