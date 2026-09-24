/* test/openings.test.js — M2 附加：26 开局数据自检 */
const test = require('node:test');
const assert = require('node:assert');
const OP = require('../engine/data/openings.js');

const idx = (x, y) => y * 15 + x;

test('26 种开局齐全（直指13 + 斜指13）', () => {
  assert.equal(OP.OPENINGS.length, 26);
  assert.equal(OP.DIRECT.length, 13);
  assert.equal(OP.INDIRECT.length, 13);
});

test('每种开局黑1 均为天元，且 3 手互不重合', () => {
  for (const o of OP.OPENINGS) {
    assert.deepEqual(o.moves[0], { x: 7, y: 7 }, o.name + ' 黑1 应为天元');
    assert.equal(new Set(o.idx).size, 3, o.name + ' 三手应互异');
  }
});

test('记谱↔坐标换算正确（H8→(7,7)，H10→(7,5)，F6→(5,9)）', () => {
  assert.deepEqual(OP.R('H8'), { x: 7, y: 7 });
  assert.deepEqual(OP.R('H10'), { x: 7, y: 5 });
  assert.deepEqual(OP.R('F6'), { x: 5, y: 9 });
});

test('开局识别：花月 / 浦月 / 彗星', () => {
  assert.equal(OP.identify([idx(7, 7), idx(7, 6), idx(8, 6)]).name, '花月局');
  assert.equal(OP.identify([idx(7, 7), idx(8, 6), idx(8, 8)]).name, '浦月局');
  assert.equal(OP.identify([idx(7, 7), idx(8, 6), idx(5, 9)]).name, '彗星局');
});

test('镜像等价：花月的镜像仍识别为花月', () => {
  const mirror = [idx(7, 7), idx(7, 8), idx(6, 8)];   // 上下镜像
  assert.equal(OP.identify(mirror).name, '花月局');
});

test('8 种对称变换产出 8 个等价开局', () => {
  const v = OP.variants([{ x: 7, y: 7 }, { x: 7, y: 6 }, { x: 8, y: 6 }]);
  assert.equal(v.length, 8);
  const keys = new Set(v.map(m => m.map(p => idx(p.x, p.y)).join(',')));
  assert.ok(keys.size >= 4, '至少应有 4 个不同朝向（含对称重复）');
});
