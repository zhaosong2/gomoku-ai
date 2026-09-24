/* test/forbidden.test.js — 禁手判定（M6 / 设计 §7.3 §8 §26 §31 #2~#6c）
 *
 * 判据来源：设计 §26.2 严格定义 + §26.3 必测边界 + §31 用例表。
 * 每个局面都在 tools/_probe-forbid.js 里先手工核对过，不是"写完就让它过"。
 *
 * 三条铁律：
 *  ① 恰好五连 > 一切禁手（五三三 / 五四四 / 五长连 均判胜）；
 *  ② 只有"未同时成恰好五"的长连才判负（rif）；strict 模式下长连一律负；
 *  ③ 冲四 + 活三 = FOUR_THREE，**不算三三**。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'engine/core.js'));
const PAT = require(path.join(ROOT, 'engine/patterns.js'));
const RU = require(path.join(ROOT, 'engine/rules.js'));
const SEARCH = require(path.join(ROOT, 'engine/search.js'));
const EV_REF = require(path.join(ROOT, 'engine/eval.js'));    // #33 护栏：着法排序探针

const { NN, N, EMPTY, BLACK, WHITE, idxOf, opp } = core;
const L = PAT.L;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) {
    const i = idxOf(s[0], s[1]);
    assert.equal(b[i], EMPTY, '测试局面有重叠子 @' + s[0] + ',' + s[1]);
    b[i] = s[2];
  }
  return b;
}
const fmt = i => '(' + (i % N) + ',' + ((i / N) | 0) + ')';

/* ---------- 局面库：全部落点在 (7,7)，(x,y,c) ---------- */
const P = [7, 7];
const CASES = [
  {
    name: '三三禁手（两向跳活三 §31#3）',
    stones: [[6, 7, BLACK], [9, 7, BLACK], [7, 5, BLACK], [7, 8, BLACK]],
    p: P, player: BLACK, forbid: L.DOUBLE_THREE,
    judge: { renju_rif: 'lose', renju_strict: 'lose', freestyle: 'none' },
  },
  {
    name: '四四禁手（两向冲四 §31#4）',
    stones: [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [7, 8, BLACK], [7, 9, BLACK], [7, 10, BLACK],
             [3, 7, WHITE], [7, 11, WHITE]],
    p: P, player: BLACK, forbid: L.DOUBLE_FOUR,
    judge: { renju_rif: 'lose', renju_strict: 'lose', freestyle: 'none' },
  },
  {
    name: '纯长连（无恰好五 §31#6c）',
    stones: [[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [8, 7, BLACK]],
    p: P, player: BLACK, forbid: L.OVERLINE,
    judge: { renju_rif: 'lose', renju_strict: 'lose', freestyle: 'win' },
  },
  {
    name: '五连优先·五三三（§31#6）',
    stones: [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [8, 7, BLACK],
             [7, 6, BLACK], [7, 9, BLACK], [6, 6, BLACK], [9, 9, BLACK]],
    p: P, player: BLACK, forbid: 0,
    judge: { renju_rif: 'win', renju_strict: 'win', freestyle: 'win' },
  },
  {
    name: '五连优先·五长连（§31#6b）',
    stones: [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [8, 7, BLACK],
             [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK]],
    p: P, player: BLACK, forbid: 0,
    judge: { renju_rif: 'win', renju_strict: 'lose', freestyle: 'win' },   // strict：长连一律负
  },
  {
    name: '冲四+活三 = 四三，不算三三（§31#5）',
    stones: [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [3, 7, WHITE],
             [7, 6, BLACK], [7, 9, BLACK]],
    p: P, player: BLACK, forbid: 0,
    judge: { renju_rif: 'none', renju_strict: 'none', freestyle: 'none' },
  },
  {
    name: '白棋无禁手（同形三三 §7.3）',
    stones: [[6, 7, WHITE], [9, 7, WHITE], [7, 5, WHITE], [7, 8, WHITE]],
    p: P, player: WHITE, forbid: 0,
    judge: { renju_rif: 'none', renju_strict: 'none', freestyle: 'none' },
  },
];
// freestyle 下"黑长连算胜"已由上一条"纯长连"的 judge.freestyle='win' 覆盖（同一局面，无需重复）。

test('禁手判定：§26.3 必测边界 + §31 #2~#6c 逐条', () => {
  for (const c of CASES) {
    const b = boardOf(c.stones);
    const i = idxOf(c.p[0], c.p[1]);
    const mode = PAT.forbidMode(c.player, 'renju', 'rif');
    const got = PAT.forbiddenAt(b, i, mode);
    assert.equal(got, c.forbid,
      c.name + '：期望禁手=' + c.forbid + '，实际=' + got);

    // 裁决（三方规则）
    const bb = b.slice(); bb[i] = c.player;
    assert.equal(RU.judge(bb, c.p[0], c.p[1], c.player, 'renju', 'rif'), c.judge.renju_rif,
      c.name + '：renju/rif 裁决不符');
    assert.equal(RU.judge(bb, c.p[0], c.p[1], c.player, 'renju', 'strict'), c.judge.renju_strict,
      c.name + '：renju/strict 裁决不符');
    assert.equal(RU.judge(bb, c.p[0], c.p[1], c.player, 'freestyle', 'rif'), c.judge.freestyle,
      c.name + '：freestyle 裁决不符');
  }
  console.log('     ' + CASES.length + ' 个边界局面 × 3 规则全部符合设计');
});

test('判定一致性：judge 与 forbiddenAt 必须同一口径（随机局面）', () => {
  const rnd = core.mulberry32(20260919);
  let checked = 0, lose = 0, win = 0;
  for (let t = 0; t < 400; t++) {
    const b = new Int8Array(NN);
    const n = 8 + ((rnd() * 14) | 0);
    for (let k = 0; k < n; k++) {
      const i = (rnd() * NN) | 0;
      if (b[i] === EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE;
    }
    for (let i = 0; i < NN; i++) {
      if (b[i] !== EMPTY) continue;
      const x = i % N, y = (i / N) | 0;
      // —— 黑（renju）
      const fb = PAT.forbiddenAt(b, i, PAT.forbidMode(BLACK, 'renju', 'rif'));
      b[i] = BLACK;
      const j = RU.judge(b, x, y, BLACK, 'renju', 'rif');
      b[i] = EMPTY;
      checked++;
      if (j === 'lose') lose++;
      if (j === 'win') win++;
      assert.ok((j === 'lose') === (fb !== 0),
        '黑棋口径不一致 @' + fmt(i) + '：禁手=' + fb + ' 裁决=' + j);
      // 判负 ⇔ 必然不成五（恰好五优先）
      if (j === 'win') assert.equal(fb, 0, '成五不得同时判禁手 @' + fmt(i));
      // —— 白（renju）：恒无禁手
      const fw = PAT.forbiddenAt(b, i, PAT.forbidMode(WHITE, 'renju', 'rif'));
      assert.equal(fw, 0, '白棋不应有禁手 @' + fmt(i));
      // —— freestyle：恒无禁手
      const ff = PAT.forbiddenAt(b, i, PAT.forbidMode(BLACK, 'freestyle', 'rif'));
      assert.equal(ff, 0, 'freestyle 不应有禁手 @' + fmt(i));
    }
  }
  assert.ok(lose > 0, '样本里应出现禁手负，实际 ' + lose);
  assert.ok(win > 0, '样本里应出现黑胜，实际 ' + win);
  console.log('     ' + checked + ' 个空点：judge ⇔ forbiddenAt 口径完全一致（禁手负 ' + lose + '，黑胜 ' + win + '）');
});

test('isWin：renju-黑 用"恰好五连"，不得把五长连判成不胜', () => {
  // 五长连：横向恰好五 + 纵向六连
  const st = [[4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [8, 7, BLACK],
              [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK]];
  const b = boardOf(st); b[idxOf(7, 7)] = BLACK;
  assert.ok(RU.isWin(b, 7, 7, BLACK, 'renju', 'rif'), 'rif：五长连应判胜（五连优先）');
  assert.ok(!RU.isWin(b, 7, 7, BLACK, 'renju', 'strict'), 'strict：长连一律负，不得判胜');
  assert.ok(RU.isWin(b, 7, 7, BLACK, 'freestyle', 'rif'), 'freestyle：≥5 即胜');
  // 纯长连：renju 下**不是**胜（会因禁手判负，但不是"赢"）
  const st2 = [[3, 7, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK], [8, 7, BLACK]];
  const b2 = boardOf(st2); b2[idxOf(7, 7)] = BLACK;
  assert.ok(!RU.isWin(b2, 7, 7, BLACK, 'renju', 'rif'), 'renju：纯长连不是胜');
  assert.ok(RU.isWin(b2, 7, 7, BLACK, 'freestyle', 'rif'), 'freestyle：长连算胜');
});

// ★ 必须真正落子（重试直到找到空点）：否则手序会错乱（误把白棋着法当黑棋判禁手）
function randomMove(pos, rnd) {
  for (let t = 0; t < 200; t++) {
    const i = (rnd() * NN) | 0;
    if (pos.board[i] === EMPTY) { core.makeMove(pos, i % N, (i / N) | 0, pos.stm); return i; }
  }
  return -1;
}

test('AI 执黑（renju）不落禁手点：随机局面统计', () => {
  const rnd = core.mulberry32(4242);
  let games = 0, moves = 0, forbiddenPlayed = 0, withChoice = 0;
  for (let g = 0; g < 24; g++) {
    const pos = core.createPosition();
    SEARCH.attachCache(pos);
    for (let k = 0; k < 6; k++) randomMove(pos, rnd);      // 随机开局，保证局面多样
    games++;
    for (let ply = 0; ply < 8; ply++) {
      // 轮到白 → 随机应；轮到黑 → AI 决策并检查
      if (pos.stm === WHITE) { if (randomMove(pos, rnd) < 0) break; continue; }
      SEARCH.ttClear();
      const r = SEARCH.think(pos, { rule: 'renju', difficulty: 'normal', hardLimit: 400 });
      if (!r || !r.move) break;
      const i = idxOf(r.move.x, r.move.y);
      assert.equal(pos.board[i], EMPTY, 'AI 返回了已占点');
      moves++;
      // 若本局面存在"非禁手"的合法着法，AI 就不该选禁手点
      const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
      let hasLegal = false;
      for (let j = 0; j < NN && !hasLegal; j++) {
        if (pos.board[j] !== EMPTY) continue;
        if (!PAT.forbiddenAt(pos.board, j, mode)) hasLegal = true;
      }
      if (hasLegal) withChoice++;
      const fb = PAT.forbiddenAt(pos.board, i, mode);
      if (fb && hasLegal) {
        forbiddenPlayed++;
        if (forbiddenPlayed <= 3) console.log('     ⚠ 有合法着法却落禁手 @' + fmt(i) + ' 类型=' + fb);
      }
      core.makeMove(pos, r.move.x, r.move.y, BLACK);
      if (RU.judge(pos.board, r.move.x, r.move.y, BLACK, 'renju', 'rif') !== 'none') break;
      if (randomMove(pos, rnd) < 0) break;
    }
  }
  assert.equal(forbiddenPlayed, 0,
    'AI 执黑不得在有合法着法时落禁手点：' + forbiddenPlayed + '/' + moves + ' 手违规');
  console.log('     ' + games + ' 局 / ' + moves + ' 手 AI 执黑着法（其中 ' + withChoice +
    ' 手存在非禁手选择）：0 手违规');
});

/* ============================================================
 * ★★ 回归护栏（#33，2026-09-20）：堵住"廉价预检双向不可靠"的漏洞
 *
 * 背景：`levelAt` 曾用"廉价预检"（窗口模型 nFour>=2||nThree>=2）跳过严格判定，
 *   · 假阴 19.5~23.7% —— 禁手点被判合法并给**正分**（`长连` 甚至 +1e8=WIN），
 *     实测导致引擎**真的走出禁手点自败**；
 *   · 假阳 ≈0.01% —— `decideOf` 的窗口口径把合法点判为禁手 → 引擎弃好着。
 * 根因：窗口模型"每方向只报一个最强型"，会隐藏"同一方向同时是四与活三"里的活三；
 *   且存在"窗口最强型=活二、严格=活三"的形态 ⇒ **任何基于窗口的门槛都无法 sound**。
 * 现行口径：Renju-黑时 `levelAt` **恒调严格算法**（`forbiddenCore`）。
 * 下面三组用例是该决策的护栏——若有人把"廉价预检"加回来，这里会红。
 * ============================================================ */

// ① 最小反例：横向六连的端点，窗口分类="连五"（不是 OVERLINE）→ 旧预检不会触发
test('#33 护栏：长连端点不得被判成"连五"（旧廉价预检的最小反例）', () => {
  const b = new Int8Array(NN);
  // 横 (7,7)..(12,7) 全黑（六连），落点取端点 (7,7)
  for (let x = 7; x <= 12; x++) b[idxOf(x, 7)] = BLACK;
  b[idxOf(7, 7)] = EMPTY;                       // 落点留空
  const i = idxOf(7, 7);
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  const strict = PAT.forbiddenAt(b, i, mode);
  assert.equal(strict, L.OVERLINE, '严格判定应为长连禁手，实际=' + PAT.LNAME[strict]);

  const la = PAT.levelAt(b, i, BLACK, mode);
  assert.equal(la, L.OVERLINE,
    'levelAt 必须返回长连（旧预检会返回"连五"=WIN 正分）实际=' + PAT.LNAME[la]);
  assert.equal(PAT.levelScore(la, 'renju', 'black', 'stm'), PAT.FORBIDDEN,
    '该等级必须是 FORBIDDEN（不得给正分）');
});

// ② 双向一致性：levelAt 与 forbiddenAt 在"是否禁手"上必须完全一致（大样本）
test('#33 护栏：levelAt 与 forbiddenAt 的"是否禁手"口径必须一致（大样本）', () => {
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  const rnd = core.mulberry32(20260920);
  let checked = 0, forbid = 0, fn = 0, fp = 0;
  for (let g = 0; g < 260; g++) {
    // 聚簇落子（纯随机撒子几乎不产生禁手，必须聚簇）
    const b = new Int8Array(NN);
    for (let a = 0, A = 2 + ((rnd() * 3) | 0); a < A; a++) {
      const ax = 2 + ((rnd() * 11) | 0), ay = 2 + ((rnd() * 11) | 0);
      for (let k = 0, n = 4 + ((rnd() * 9) | 0); k < n; k++) {
        const x = ax + ((rnd() * 5) | 0) - 2, y = ay + ((rnd() * 5) | 0) - 2;
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        const j = idxOf(x, y);
        if (b[j] === EMPTY) b[j] = rnd() < 0.55 ? BLACK : WHITE;
      }
    }
    for (let i = 0; i < NN; i++) {
      if (b[i] !== EMPTY) continue;
      checked++;
      const fb = PAT.forbiddenAt(b, i, mode);
      const la = PAT.levelAt(b, i, BLACK, mode);
      const laForbid = (la === L.DOUBLE_THREE || la === L.DOUBLE_FOUR || la === L.OVERLINE);
      if (fb) forbid++;
      if (fb && !laForbid) { fn++; if (fn <= 3) console.log('     ⚠ 假阴 @' + fmt(i) + ' strict=' + PAT.LNAME[fb] + ' levelAt=' + PAT.LNAME[la]); }
      if (!fb && laForbid) { fp++; if (fp <= 3) console.log('     ⚠ 假阳 @' + fmt(i) + ' levelAt=' + PAT.LNAME[la]); }
    }
  }
  assert.ok(forbid > 100, '样本里应出现足够多的禁手点，实际 ' + forbid);
  assert.equal(fn, 0, 'levelAt 不得漏判禁手（假阴）：' + fn + ' 个');
  assert.equal(fp, 0, 'levelAt 不得误判禁手（假阳）：' + fp + ' 个');
  console.log('     ' + checked + ' 个空点 / ' + forbid + ' 个禁手点：levelAt ⇔ forbiddenAt 双向零不一致');
});

// ③ 端到端：构造"禁手点是排序最优"的局面，引擎仍不得落它
//    修复前：这类局面里禁手点会因"漏判"拿到正分、排到第 1，引擎 6/12 次真的落禁手。
//    修复后：禁手点恒得 FORBIDDEN（−1e9）→ 排到最后 → 引擎永不落它。
//    这里**手工构造**，不靠随机搜索（否则策略一改，用例就"找不到局面"而空转）。
test('#33 护栏：禁手点是排序最优时，引擎仍不得落它（手工构造）', () => {
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  const cfg = { rule: 'renju', overlineMode: 'rif', lambda: 0.9 };

  // 构造：黑横向 (7,7)..(12,7) 六连（落端点 (7,7) 即长连禁手）；
  //       (7,7) 在窗口模型里会被判"连五"（+1e8）——正是旧预检漏掉、被排第 1 的形态。
  //       同时盘面确有合法着法（大量空点）。
  const b = new Int8Array(NN);
  for (let x = 7; x <= 12; x++) b[idxOf(x, 7)] = BLACK;
  b[idxOf(7, 7)] = EMPTY;                         // 落点留空
  b[idxOf(0, 0)] = WHITE; b[idxOf(14, 14)] = WHITE;
  const target = idxOf(7, 7);

  // ① 该点严格判定必须是禁手
  const fb = PAT.forbiddenAt(b, target, mode);
  assert.equal(fb, L.OVERLINE, '构造点的严格判定应为长连，实际=' + PAT.LNAME[fb]);

  // ② 排序分必须是强负（不得为正）——修复前这里是 +1e8
  const sc = EV_REF.moveScoreAt(b, target, BLACK, cfg, {});
  assert.ok(sc < 0, '禁手点的排序分必须为负，实际=' + sc);

  // ③ 它不得出现在**排序候选的前列**（前 8 名之内）
  const scored = [];
  for (let i = 0; i < NN; i++) {
    if (b[i] !== EMPTY) continue;
    scored.push({ i: i, s: EV_REF.moveScoreAt(b, i, BLACK, cfg, {}) });
  }
  scored.sort((p, q) => q.s - p.s);
  const rank = scored.findIndex(e => e.i === target) + 1;
  assert.ok(rank > 8, '禁手点不得排进排序前 8 名，实际第 ' + rank + ' 名（score=' + sc + '）');

  // ④ 端到端：引擎不得落该点
  SEARCH.ttClear();
  const r = SEARCH.think(SEARCH.posFromBoard(b, BLACK), { rule: 'renju', difficulty: 'hard', hardLimit: 600 });
  assert.ok(r && r.move, '引擎应返回着法');
  assert.ok(!(r.move.x === 7 && r.move.y === 7),
    '引擎不得落禁手点 (7,7)，实际落 (' + r.move.x + ',' + r.move.y + ')');
  console.log('     构造点排序第 ' + rank + ' 名（score=' + sc + '）；引擎落 (' +
    r.move.x + ',' + r.move.y + ') — 未落禁手');
});

/* ---------- 逼禁（§31 #9 / §7.3）：白造威胁，黑唯一解围点恰为禁手 ----------
 * 白 (4,7)..(7,7) 冲四，左端被黑 (3,7) 堵住 → 白的唯一成五点是 (8,7)；
 * 而 (8,7) 对黑是"双三"禁手 → 黑**无法合法封堵** → 白胜。
 */
const SQUEEZE = [
  [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE], [7, 7, WHITE],
  [3, 7, BLACK], [8, 5, BLACK], [8, 6, BLACK], [7, 6, BLACK], [9, 8, BLACK],
];
// 白尚未成四的版本（供"白主动走出逼禁"用）
const SQUEEZE_PRE = SQUEEZE.filter(s => !(s[0] === 7 && s[1] === 7));

test('逼禁：黑唯一解围点是禁手 → renju 判黑负，freestyle 可堵（§31 #9）', () => {
  const b = boardOf(SQUEEZE);
  const di = idxOf(8, 7);
  // ① 解围点确实是黑的禁手
  assert.equal(PAT.forbiddenAt(b, di, PAT.forbidMode(BLACK, 'renju', 'rif')), L.DOUBLE_THREE,
    '(8,7) 应是黑的双三禁手');
  // ② 白的唯一成五点就是该点
  const wp = SEARCH.winningPoints(b, WHITE);
  assert.deepEqual(wp, [di], '白成五点应恰为 (8,7)，实际 ' + wp.map(fmt).join(' '));

  // ③ 黑若落该点：renju 判负；freestyle 合法
  const bb = b.slice(); bb[di] = BLACK;
  assert.equal(RU.judge(bb, 8, 7, BLACK, 'renju', 'rif'), 'lose', 'renju：黑堵禁手点应判负');
  assert.equal(RU.judge(bb, 8, 7, BLACK, 'freestyle', 'rif'), 'none', 'freestyle：黑堵该点合法');

  // ④ 引擎行为差异：renju 执黑**拒绝**落禁手；freestyle 执黑**会**堵
  SEARCH.ttClear();
  const rF = SEARCH.think(SEARCH.posFromBoard(b, BLACK),
    { rule: 'freestyle', difficulty: 'hard', hardLimit: 1500 });
  assert.ok(rF.move.x === 8 && rF.move.y === 7,
    'freestyle：黑应堵 (8,7)，实际 (' + rF.move.x + ',' + rF.move.y + ')');

  SEARCH.ttClear();
  const rR = SEARCH.think(SEARCH.posFromBoard(b, BLACK),
    { rule: 'renju', difficulty: 'hard', hardLimit: 1500 });
  assert.ok(!(rR.move.x === 8 && rR.move.y === 7),
    'renju：黑不得落禁手点 (8,7)');
  assert.ok(rR.score <= -99999000,
    'renju：黑无解应判负，实际 score=' + rR.score);
  console.log('     逼禁成立：renju 黑 score=' + rR.score + '（无解）；freestyle 黑堵 (' +
    rF.move.x + ',' + rF.move.y + ') 存活');
});

test('逼禁涌现：同一局面 renju 下白有必胜着，freestyle 下没有（§7.3）', () => {
  const b = boardOf(SQUEEZE_PRE);
  SEARCH.ttClear();
  const rR = SEARCH.think(SEARCH.posFromBoard(b, WHITE),
    { rule: 'renju', difficulty: 'hard', hardLimit: 2000 });
  SEARCH.ttClear();
  const rF = SEARCH.think(SEARCH.posFromBoard(b, WHITE),
    { rule: 'freestyle', difficulty: 'hard', hardLimit: 2000 });

  assert.ok(rR.move.x === 7 && rR.move.y === 7,
    'renju：白应走 (7,7) 造逼禁，实际 (' + rR.move.x + ',' + rR.move.y + ')');
  assert.ok(rR.score >= 99999000, 'renju：(7,7) 应被判必胜，实际 score=' + rR.score);
  assert.ok(Math.abs(rF.score) < 99999000,
    'freestyle：不存在该必胜着（黑可合法封堵），实际 score=' + rF.score);
  console.log('     renju 白 (' + rR.move.x + ',' + rR.move.y + ') score=' + rR.score +
    '（' + rR.timeMs + 'ms）vs freestyle score=' + rF.score + ' → 逼禁是规则相关的');
});

test('规则插件：接口齐全且 freestyle 恒不禁手（§7.1）', () => {
  for (const name of ['freestyle', 'renju']) {
    const R = RU.get(name);
    assert.ok(R && R.name === name, '缺少规则插件 ' + name);
    for (const f of ['checkWin', 'isForbidden', 'forbidMode']) {
      assert.equal(typeof R[f], 'function', name + ' 缺少 ' + f);
    }
  }
  // freestyle：任何局面任何点都非禁手
  const rnd = core.mulberry32(7);
  for (let t = 0; t < 30; t++) {
    const b = new Int8Array(NN);
    for (let k = 0; k < 20; k++) { const i = (rnd() * NN) | 0; if (b[i] === EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE; }
    for (let i = 0; i < NN; i++) if (b[i] === EMPTY) assert.equal(RU.isForbidden(b, i, 'freestyle', 'rif'), 0);
  }
  assert.equal(RU.get('nonexistent'), RU.RULES.freestyle, '未知规则应回落 freestyle');
});

test('UI 契约（M6）：规则可选、裁决走 judge、禁手可标红', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'ui/main.js'), 'utf8');
  const render = fs.readFileSync(path.join(ROOT, 'ui/render.js'), 'utf8');
  const ai = fs.readFileSync(path.join(ROOT, 'ui/ai.js'), 'utf8');

  assert.ok(/id="selRule"/.test(html), 'index.html 缺少规则选择器 selRule');
  assert.ok(/value="renju"/.test(html) && /value="freestyle"/.test(html), '规则选项不全');
  assert.ok(/id="chkForbid"/.test(html), '缺少"标出禁手点"开关');
  // ★ 裁决必须用规则感知的 judge（否则 Renju 禁手不会判负）
  assert.ok(/RULES\.judge\(/.test(main), 'main.js 必须用 RULES.judge 裁决');
  assert.ok(/rule: rule\(\)/.test(main), 'main.js 必须把规则传给 AI');
  assert.ok(/forbidden/.test(render), 'render.js 必须支持禁手点渲染');
  assert.ok(/rule: o\.rule/.test(ai), 'ai.js 必须把规则透传给后端');
});

test('性能：禁手判定不得成为搜索瓶颈', () => {
  const rnd = core.mulberry32(99);
  const boards = [];
  for (let t = 0; t < 20; t++) {
    const b = new Int8Array(NN);
    for (let k = 0; k < 18; k++) { const i = (rnd() * NN) | 0; if (b[i] === EMPTY) b[i] = rnd() < 0.5 ? BLACK : WHITE; }
    boards.push(b);
  }
  const mode = PAT.forbidMode(BLACK, 'renju', 'rif');
  const t0 = Date.now();
  let n = 0;
  for (const b of boards) for (let i = 0; i < NN; i++) if (b[i] === EMPTY) { PAT.forbiddenAt(b, i, mode); n++; }
  const ms = Date.now() - t0;
  const per = ms * 1000 / n;                      // µs/次
  assert.ok(per < 20, '单次禁手判定 ' + per.toFixed(2) + 'µs 过慢');
  console.log('     ' + n + ' 次判定：' + ms + 'ms（' + per.toFixed(2) + 'µs/次）');
});
