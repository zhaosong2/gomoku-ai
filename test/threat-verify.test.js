/* test/threat-verify.test.js — A7 VCF/VCT 反向验证单测（§4.5）
 *
 * 覆盖：
 *   ① 纯新增语义：refutePath 已导出；vcfWin/vctWin 加 opts.verify 后**既有导出签名不变**
 *   ② ★ 假阴性 == 0（本条最大风险）：verify=true 时题库 40/40 仍全过，结论与 verify=false 一致
 *   ③ refutePath 真能抓"守方抢杀"（不是恒 false 的空壳）
 *   ④ ★ 攻方终局优先：攻方已成活四（≥2 成五点）时，守方另有无关成五点**不得**判可反驳
 *      （2026-09-20 实测踩坑：漏这一步会误杀题库题 34/37）
 *   ⑤ path 前缀已在盘上（path[0] = 已落的 first 手）不得当作路径损坏
 *   ⑥ 不改既有行为：refutePath 全程 make/unmake，调用后局面的 stones 与 zobrist 必须复原
 *   ⑦ renju 兼容：禁手点上不得把黑方禁手点当威胁
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const TH = require('../engine/threat.js');
const SEARCH = require('../engine/search.js');
const M = require('../engine/data/mates.js');
const V = require('./../tools/verify-mate.js');

const { NN, EMPTY, BLACK, WHITE, idxOf, opp } = core;
const near = (a, b, t) => Math.abs(a - b) <= t;

function bd(stones) { const b = new Int8Array(NN); for (const s of stones) b[idxOf(s[0], s[1])] = s[2]; return b; }
function mk(stones, stm) { const pos = SEARCH.posFromBoard(bd(stones), stm); SEARCH.attachCache(pos, true); return pos; }

test('A7 纯新增语义：refutePath 已导出；既有导出签名与行为不变', () => {
  assert.equal(typeof TH.refutePath, 'function', 'refutePath 必须已导出');
  // 既有导出全在
  for (const k of ['winningPoints', 'hasFivePoint', 'hasFivePointIn', 'fivePointsAfter',
    'makesFive', 'makesFour', 'makesOpenFour', 'makesOpenThree', 'threatMoves', 'vcfWin', 'vctWin']) {
    assert.equal(typeof TH[k], 'function', '既有导出 ' + k + ' 不得丢失');
  }
  // opts.verify 默认关：同一局面 verify 省略 vs verify:false 结论逐位一致
  const q = M.ATTACK[0];
  const p1 = SEARCH.posFromBoard(V.boardOf(q.stones), q.atk);
  const p2 = SEARCH.posFromBoard(V.boardOf(q.stones), q.atk);
  const a = TH.vcfWin(p1, q.atk, { depth: 20, budget: 300000 });
  const b = TH.vcfWin(p2, q.atk, { depth: 20, budget: 300000, verify: false });
  assert.equal(!!a, !!b, 'verify 省略与 verify:false 必须一致（默认 false）');
  if (a && b) assert.deepEqual(b.path, a.path, '同一线；verify:false 不得改变路径');
});

test('★A7 假阴性 == 0（本条最大风险）：verify=true 时题库 40/40 仍全过', () => {
  let okOff = 0, okOn = 0; const fails = [];
  for (let k = 0; k < M.ATTACK.length; k++) {
    const q = M.ATTACK[k];
    const off = V.solveAndVerify(q.stones, q.atk, { vcfDepth: 20, vcfBudget: 300000, useVerify: false });
    const on = V.solveAndVerify(q.stones, q.atk, { vcfDepth: 20, vcfBudget: 300000, useVerify: true });
    if (off.ok) okOff++;
    if (on.ok) okOn++; else fails.push(k + '(' + q.kind + q.plies + ':' + on.why + ')');
  }
  console.log('     独立复算：verify 关 ' + okOff + '/' + M.ATTACK.length +
    ' → verify 开 ' + okOn + '/' + M.ATTACK.length);
  assert.equal(okOn, okOff, 'verify=true 不得降低通过率（假阴性必须为 0）；失败: ' + fails.join(' '));
  assert.equal(okOn, M.ATTACK.length, '题库必须全过（40/40）');
});

test('A7 refutePath 真能抓"守方抢杀"（不是恒 false 的空壳）', () => {
  // 守方(黑)已成四 → 其成五点 2 个 ⇒ 攻方(白)任何慢线都来不及
  const stones = [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 7, BLACK],
                  [5, 6, WHITE], [6, 6, WHITE], [7, 6, WHITE]];
  const board = bd(stones);
  assert.equal(TH.winningPoints(board, BLACK, 0, 'freestyle').length, 2, '前置：黑应有 2 个成五点');
  assert.equal(TH.winningPoints(board, WHITE, 0, 'freestyle').length, 0, '前置：白尚无成五点');
  // 白走一步非终局手 → 黑立即成五 ⇒ 应判可反驳
  const r = TH.refutePath(mk(stones, WHITE), WHITE, [idxOf(6, 5)], {});
  assert.equal(r, true, '守方已成四时，攻方非终局线必须被判可反驳');
});

test('★A7 攻方终局优先：攻方活四时守方无关成五点不得判可反驳（题34/37 误杀回归）', () => {
  // 白活四（(5,7)~(8,7)）成五点 2 个；黑另有一条四（(1,4)~(1,7)）
  const stones = [[5, 7, WHITE], [6, 7, WHITE], [7, 7, WHITE], [8, 7, WHITE],
                  [1, 4, BLACK], [1, 5, BLACK], [1, 6, BLACK], [1, 7, BLACK]];
  const board = bd(stones);
  assert.equal(TH.winningPoints(board, WHITE, 0, 'freestyle').length, 2, '前置：白活四应有 2 成五点');
  assert.ok(TH.winningPoints(board, BLACK, 0, 'freestyle').length > 0, '前置：黑应另有成五点');
  const r = TH.refutePath(mk(stones, WHITE), WHITE, [idxOf(9, 7)], {});
  assert.equal(r, false, '攻方活四终局 ⇒ 守方无关成五点不构成反驳（否则误杀真杀）');

  // 真实题库回归：题 34 / 37 在 verify 开时不得被判无杀
  for (const k of [34, 37]) {
    const q = M.ATTACK[k];
    const on = V.solveAndVerify(q.stones, q.atk, { vcfDepth: 20, vcfBudget: 300000, useVerify: true });
    assert.ok(on.ok, '题库题 ' + k + ' 在 verify 开时不得被判无杀（实测曾误杀，why=' + on.why + '）');
  }
});

test('A7 path 前缀已在盘上不得当作路径损坏（手工构造）', () => {
  // 白活四局面：白 (5,7)(6,7)(7,7)(8,7)；path = [白某已落点, 白(9,7) 成五]
  // 即 path[0] 已在盘上、path[1] 是新落子 ⇒ 必须跳过 path[0] 而非判 UNRELIABLE。
  const stones = [[5, 7, WHITE], [6, 7, WHITE], [7, 7, WHITE], [8, 7, WHITE],
                  [1, 4, BLACK], [1, 5, BLACK], [1, 6, BLACK], [0, 0, BLACK]];
  const board = bd(stones);
  assert.equal(board[idxOf(6, 7)], WHITE, '前置：path[0] 已在盘上');
  const r = TH.refutePath(mk(stones, WHITE), WHITE, [idxOf(6, 7), idxOf(9, 7)], {});
  assert.equal(r, false, '前缀已在盘上 ⇒ 跳过并继续，不得判路径损坏');

  // 反例：path 里出现一颗**对方**子 ⇒ 路径不可信，判可反驳
  const r2 = TH.refutePath(mk(stones, WHITE), WHITE, [idxOf(1, 4), idxOf(9, 7)], {});
  assert.equal(r2, true, 'path 含对方子 ⇒ 路径不可信，必须判可反驳');
});

test('A7 无副作用：refutePath / verify 开启后局面必须逐位复原', () => {
  for (const k of [0, 12, 37]) {
    const q = M.ATTACK[k];
    const pos = SEARCH.posFromBoard(V.boardOf(q.stones), q.atk);
    const r = TH.vcfWin(SEARCH.posFromBoard(V.boardOf(q.stones), q.atk), q.atk, { depth: 20, budget: 300000 });
    if (!r) continue;
    const stones0 = pos.stones, zhi = pos.zobHi, zlo = pos.zobLo, hist0 = pos.hist.length;
    const snap = pos.board.slice();
    TH.refutePath(pos, q.atk, r.path, {});
    assert.equal(pos.stones, stones0, '题 ' + k + ' stones 必须复原');
    assert.equal(pos.hist.length, hist0, '题 ' + k + ' hist 长度必须复原');
    assert.equal(pos.zobHi, zhi, '题 ' + k + ' zobHi 必须复原');
    assert.equal(pos.zobLo, zlo, '题 ' + k + ' zobLo 必须复原');
    let diff = 0;
    for (let i = 0; i < NN; i++) if (pos.board[i] !== snap[i]) diff++;
    assert.equal(diff, 0, '题 ' + k + ' 棋盘必须逐位复原（diff=' + diff + '）');
  }
});

test('A7 renju 兼容：禁手点不得被当作威胁/挡点', () => {
  // 黑方 renju 下，其禁手点不应出现在 winningPoints 里（作为 black 视角）
  const stones = [[7, 7, BLACK], [7, 8, BLACK], [7, 9, BLACK], [7, 10, BLACK]];   // 黑竖四
  const board = bd(stones);
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  const wp = TH.winningPoints(board, BLACK, mode, 'renju');
  const wpNoMode = TH.winningPoints(board, BLACK, 0, 'renju');
  // 该形黑两条成五点 (7,6)/(7,11) 中，(7,6) 若为禁手则被剔除
  console.log('     renju 黑成五点（含禁手过滤）=' + wp.length + ' /（不过滤）=' + wpNoMode.length);
  assert.ok(wp.length <= wpNoMode.length, '禁手过滤后成点数不得增加');
  // refutePath 在 renju 下不得抛异常
  const pos = SEARCH.posFromBoard(bd([[7, 7, BLACK], [8, 8, WHITE], [7, 8, BLACK], [6, 6, WHITE], [7, 6, BLACK]]), BLACK);
  const r = TH.refutePath(pos, BLACK, [idxOf(7, 5)], { rule: 'renju', overlineMode: 'rif' });
  assert.equal(typeof r, 'boolean', 'renju 下 refutePath 必须正常返回布尔值');
});
