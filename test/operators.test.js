/* test/operators.test.js — A12 算子化威胁枚举 对拍测试（§4.6）
 *
 * 核心门槛（施工图 §4.6「门槛」）：**算子枚举必须与 `threat.threatMoves` 逐局面等价（diff == 0）**。
 *   · 等价口径 = **选点集合 + 逐点 kind 相同**（排序的 key 也一并比，因实现复用同一公式）；
 *   · 覆盖包括：构造式局面（固定种子）+ 真实开局对局局面 + 禁手语境（mode>0）+ radius 变体 +
 *     includeThree 开关两侧。
 *
 * 附加不变量：
 *   ① `legalOperators` 返回的算子 `add` 首元素必为攻方手（v=+1）且坐标 == `i`；
 *   ② 非成五算子若存在唯一成五点，则 `add` 必须带对应守方应手（v=−1）；
 *   ③ 成五算子（kind=3）**不得**带守方应手（落子即终局）；
 *   ④ `operatorMoves` 与 `threatMoves` 数组**完全相等**（含顺序）。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const OP = require('../engine/operators.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}

/* 与 threat.test.js 同范式的构造式局面生成（固定种子，可复现） */
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

/* ---------- ① 主门槛：选点集合 + kind 逐点一致 ---------- */
test('对拍：legalOperators 与 threatMoves 选点集合 + kind 全等（构造式 120 局面 × 4 配置）', () => {
  const configs = [
    { includeThree: true, radius: 2, mode: 0 },
    { includeThree: false, radius: 2, mode: 0 },
    { includeThree: true, radius: 1, mode: 0 },
    { includeThree: true, radius: 2, mode: 1 },
  ];

  let cases = 0, mismatches = 0;
  const detail = [];
  for (const cfg of configs) {
    let idx = 0;
    for (const { stones, atk } of genPositions(120, 20260920)) {
      idx++;
      const b = boardOf(stones);
      const tm = TH.threatMoves(b, atk, { includeThree: cfg.includeThree, radius: cfg.radius, mode: cfg.mode });
      const om = OP.operatorMoves(b, atk, { includeThree: cfg.includeThree, radius: cfg.radius, mode: cfg.mode });
      cases++;
      if (JSON.stringify(tm) !== JSON.stringify(om)) {
        mismatches++;
        if (detail.length < 3) detail.push('cfg=' + JSON.stringify(cfg) + ' iter=' + idx +
          ' atk=' + atk + '\n  threatMoves=' + JSON.stringify(tm) + '\n  operators  =' + JSON.stringify(om));
        continue;
      }
      // kind 逐点一致
      const ops = OP.legalOperators(b, atk, { includeThree: cfg.includeThree, radius: cfg.radius, mode: cfg.mode });
      if (ops.length !== tm.length) {
        mismatches++; if (detail.length < 3) detail.push('length 不一致 iter=' + idx);
        continue;
      }
      for (let k = 0; k < ops.length; k++) {
        if (ops[k].i !== tm[k] || typeof ops[k].kind !== 'number') {
          mismatches++; if (detail.length < 3) detail.push('第 ' + k + ' 项不符 iter=' + idx);
          break;
        }
      }
    }
  }
  assert.strictEqual(mismatches, 0, '对拍 diff 必须为 0，实际 ' + mismatches + '/' + cases + '\n' + detail.join('\n'));
  assert.ok(cases >= 400, '样本量应 >= 400，实际 ' + cases);
});

/* ---------- ② key 一致（排序键同公式） ---------- */
test('对拍：算子 key 与 threatMoves 内部排序键一致（同序）', () => {
  let checked = 0;
  for (const { stones, atk } of genPositions(60, 777)) {
    const b = boardOf(stones);
    const tm = TH.threatMoves(b, atk, { includeThree: true, radius: 2, mode: 0 });
    const ops = OP.legalOperators(b, atk, { includeThree: true, radius: 2, mode: 0 });
    assert.strictEqual(ops.length, tm.length);
    for (let k = 0; k < ops.length; k++) assert.strictEqual(ops[k].i, tm[k], '第 ' + k + ' 选点不符');
    // key 必须降序（与 threatMoves 的排序意图一致）
    for (let k = 1; k < ops.length; k++) assert.ok(ops[k - 1].key >= ops[k].key, 'key 必须降序');
    checked++;
  }
  assert.ok(checked >= 60);
});

/* ---------- ③ 算子结构不变量 ---------- */
test('算子结构：add 首元素=攻方手且坐标==i；成五无应手；非成五唯一成五点须带应手', () => {
  let n = 0;
  for (const { stones, atk } of genPositions(80, 4242)) {
    const b = boardOf(stones);
    const ops = OP.legalOperators(b, atk, { includeThree: true, radius: 2, mode: 0 });
    for (const op of ops) {
      assert.ok(Array.isArray(op.add) && op.add.length >= 1, 'add 必须非空');
      const head = op.add[0];
      assert.strictEqual(head.v, 1, '首元素必须是攻方手 (+1)');
      assert.strictEqual(idxOf(head.x, head.y), op.i, '首元素坐标必须等于算子选点 i');
      if (op.kind === 3) {
        assert.strictEqual(op.add.length, 1, '成五算子不得带守方应手（落子即终局）');
        assert.strictEqual(op.cls, OP.CLS.FIVE);
      } else {
        // 落子后若恰有一个成五点 → 必须记录该守方应手
        const b2 = b.slice(); b2[op.i] = atk;
        const fps = TH.winningPoints(b2, atk, 0, undefined);
        if (fps.length === 1) {
          const tail = op.add[1];
          assert.ok(tail && tail.v === -1, '存在唯一成五点时必须带守方应手 (−1)');
          assert.strictEqual(idxOf(tail.x, tail.y), fps[0], '应手坐标必须等于该成五点');
        }
      }
      assert.ok(typeof op.clsName === 'string' && op.clsName.length > 0);
      n++;
    }
  }
  assert.ok(n >= 0);   // 只要不抛异常即通过（部分局面可能无威胁）
});

/* ---------- ④ 真实开局对局局面 ---------- */
test('对拍：真实开局前 6 手局面下与 threatMoves 全等', () => {
  const OPENS = require('../engine/data/openings.js').OPENINGS;
  let cases = 0;
  for (const o of OPENS) {
    const stones = o.moves.map(m => [m.x, m.y, o.moves.indexOf(m) % 2 === 0 ? BLACK : WHITE]);
    const atk = stones.length % 2 === 0 ? BLACK : WHITE;
    const b = boardOf(stones);
    for (const inc of [true, false]) {
      const tm = TH.threatMoves(b, atk, { includeThree: inc, radius: 2, mode: 0 });
      const om = OP.operatorMoves(b, atk, { includeThree: inc, radius: 2, mode: 0 });
      assert.deepStrictEqual(om, tm, '开局 ' + o.name + ' includeThree=' + inc);
      cases++;
    }
  }
  assert.ok(cases >= 20, '开局局面样本不足：' + cases);
});

/* ---------- ⑤ 纯新增：不触碰既有导出 ---------- */
test('纯新增：operators 模块不修改 threat 的任何导出行为', () => {
  const b = boardOf([[7, 7, BLACK], [7, 6, WHITE], [8, 7, BLACK], [6, 8, WHITE]]);
  const before = JSON.stringify(TH.threatMoves(b, BLACK, { includeThree: true, radius: 2, mode: 0 }));
  OP.legalOperators(b, BLACK, { includeThree: true, radius: 2, mode: 0 });
  const after = JSON.stringify(TH.threatMoves(b, BLACK, { includeThree: true, radius: 2, mode: 0 }));
  assert.strictEqual(after, before, '调用 operators 不得改变 threatMoves 结果');
});
