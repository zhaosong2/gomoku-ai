/* test/mates.test.js — 杀棋题库验收（设计 §17.2 第 1 条：**100% 达标**）
 *
 * 两道独立门槛，缺一不可：
 *   ① 数据自证：题库里存的解法必须能被**独立复算器**逐手重放验证（防止数据本身是错的）；
 *   ② 引擎能力：求解器必须重新找到一条**可证真**的杀法；
 *   ③ 防守题：`think`（开启对方 VCF 规避）必须选到"走完对方不再有 VCF"的着法。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const SEARCH = require('../engine/search.js');
const V = require('../tools/verify-mate.js');
const M = require('../engine/data/mates.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const toIdx = ([x, y]) => y * N + x;

test('题库：文件格式与统计自洽', () => {
  assert.ok(M.STATS.attack >= 20, '进攻题应 >= 20，实际 ' + M.STATS.attack);
  assert.ok(M.STATS.defense >= 3, '防守题应 >= 3，实际 ' + M.STATS.defense);
  assert.equal(M.ATTACK.length, M.STATS.attack);
  assert.equal(M.DEFENSE.length, M.STATS.defense);
  assert.equal(M.MATES.length, M.ATTACK.length + M.DEFENSE.length);
  for (const p of M.ATTACK) {
    assert.ok(['vcf', 'vct'].indexOf(p.kind) >= 0, 'kind 非法：' + p.kind);
    assert.ok(p.plies >= 2, '进攻题链长应 >= 2');
    assert.ok(p.stones.length >= 6 && p.stones.length <= 40, '子数异常：' + p.stones.length);
    assert.ok(p.path.length === p.plies, 'path 长度应等于 plies');
    assert.ok(p.first[0] === p.path[0][0] && p.first[1] === p.path[0][1], 'first 应与 path[0] 一致');
  }
  for (const p of M.DEFENSE) {
    assert.ok(p.safe.length === p.safeCount && p.safeCount >= 1, '防守题安全着法数异常');
  }
});

test('题库①数据自证：每道题的存储解法都能通过独立复算', () => {
  const bad = [];
  for (let k = 0; k < M.ATTACK.length; k++) {
    const p = M.ATTACK[k];
    const path = p.path.map(toIdx);
    const verdict = V.verifyPath(p.stones, p.atk, path, { allowOpenThree: p.kind === 'vct' });
    if (!(verdict === 'OK' || verdict === 'OK_OPEN_THREE')) bad.push('#' + k + ' ' + p.kind + '/' + verdict);
  }
  assert.equal(bad.length, 0, '题库数据未通过复算：' + bad.join(' | '));
});

test('题库②引擎能力：求解器对每道进攻题给出可证真的杀法（100%）', () => {
  const bad = [];
  let byKind = { vcf: 0, vct: 0 };
  let byPly = {};
  for (let k = 0; k < M.ATTACK.length; k++) {
    const p = M.ATTACK[k];
    const r = V.solveAndVerify(p.stones, p.atk, { vcfDepth: 20, vcfBudget: 300000, vctDepth: 16, vctBudget: 200000 });
    if (r.ok) {
      byKind[r.res.via]++;
      byPly[r.res.plies] = (byPly[r.res.plies] || 0) + 1;
    } else {
      bad.push('#' + k + ' ' + p.kind + '/' + p.plies + ' 失败(' + r.why + ')');
    }
  }
  console.log('     进攻题 ' + M.ATTACK.length + ' 道全部求解并复算通过；按解法 ' + JSON.stringify(byKind) +
    '，按链长 ' + JSON.stringify(byPly));
  assert.equal(bad.length, 0, '未 100% 达标：' + bad.join(' | '));
});

test('题库③防守题：think 必须选到"对方不再有 VCF"的着法（100%）', () => {
  const bad = [];
  for (let k = 0; k < M.DEFENSE.length; k++) {
    const p = M.DEFENSE[k];
    const safeSet = new Set(p.safe.map(toIdx));
    SEARCH.ttClear();
    const r = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), {
      rule: 'freestyle', difficulty: 'hard',
      vcfDepth: 10, vctDepth: 8, vcfBudget: 120000, vctBudget: 80000, threatMs: 600,
      avoidOpp: true, avoidK: 40, avoidDepth: 8, avoidBudget: 25000,
    });
    const i = idxOf(r.move.x, r.move.y);
    if (!safeSet.has(i)) {
      bad.push('#' + k + ' 走了(' + r.move.x + ',' + r.move.y + ') via=' + (r.via || '-') +
        '（安全着法 ' + p.safeCount + ' 个）');
    }
  }
  console.log('     防守题 ' + M.DEFENSE.length + ' 道（安全着法数 ' +
    M.DEFENSE.map(d => d.safeCount).join('/') + '）全部选到安全着法');
  assert.equal(bad.length, 0, '防守题未 100% 达标：' + bad.join(' | '));
});
