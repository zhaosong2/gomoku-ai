/* test/touch.test.js — 触屏（小屏）落子判定（ui/touch.js，纯函数）
 *
 * 为什么这块必须逐条钉住：
 *   判错的后果不是崩溃，而是**"用户没想落的那一子落下去了"** —— 五子棋不可悔，
 *   一次误落就是一次真实损失，而且没有任何报错或异常可供事后定位。
 *
 * 三条口径（对应 ui/touch.js 的三个函数）：
 *   ① autoOn/resolve —— "什么时候该进入触屏模式"：**宁可不进，不可误进**
 *      （误进的代价是桌面鼠标每次落子都要确认一次，很烦；不进只损失便利）；
 *   ② isDrag         —— "什么算拖动"：阈值必须**与棋盘缩放无关**（用格距作单位），
 *      且必须同时满足"位移够远" **与** "目标点变了"；
 *   ③ decide         —— 松手后的唯一出口：place / confirm / cancel。
 *
 * ★ 本文件同时是本模块的**单一真相源守卫**：把 decide 与 isDrag 在整片参数网格上对拍，
 *   防止以后有人只改了一处（"移动时算拖动、松手时算轻点"这类两处口径不一致的经典坑）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'ui', 'touch.js'));

/* ============ 一、自动判定：何时进入触屏模式 ============ */
test('触屏判定｜自动：粗指针（触屏设备）一律启用，与视口无关', () => {
  assert.equal(T.autoOn({ coarse: true, width: 1280 }), true, '平板/横屏手机：靠 coarse 命中');
  assert.equal(T.autoOn({ coarse: true, width: 320 }), true);
  assert.equal(T.autoOn({ coarse: true, width: 0 }), true, '拿不到宽度也要认触屏');
});

test('触屏判定｜自动：窄视口启用（桌面响应式调试 / 指针类型误报的兜底）', () => {
  assert.equal(T.autoOn({ coarse: false, width: 390 }), true, '手机量级视口');
  assert.equal(T.autoOn({ coarse: false, width: T.MAX_W }), true, '恰好等于阈值 ⇒ 启用（含边界）');
  assert.equal(T.autoOn({ coarse: false, width: T.MAX_W + 1 }), false, '阈值之上 ⇒ 不启用');
  assert.equal(T.autoOn({ coarse: false, width: 1280 }), false, '桌面宽窗 ⇒ 不启用（鼠标点击即落子）');
});

test('触屏判定｜自动：环境信息缺失时**不得**误开（宁可不用，不可乱用）', () => {
  assert.equal(T.autoOn(), false, '无参数 ⇒ 关');
  assert.equal(T.autoOn({}), false, '空环境 ⇒ 关');
  assert.equal(T.autoOn({ width: 0 }), false, '拿不到宽度（0）⇒ 关（不能当成"窄"）');
  assert.equal(T.autoOn({ width: NaN }), false);
});

test('触屏判定｜偏好优先于自动：on/off 是用户的显式选择', () => {
  assert.equal(T.resolve('on', { coarse: false, width: 1920 }), true, '桌面手动开启要生效（用于试用/验收）');
  assert.equal(T.resolve('off', { coarse: true, width: 320 }), false, '手机上手动关闭要生效（有人就是习惯直接点）');
  assert.equal(T.resolve('auto', { coarse: true, width: 1920 }), true);
  assert.equal(T.resolve('auto', { coarse: false, width: 1280 }), false);
  assert.equal(T.resolve(undefined, { coarse: true, width: 1280 }), true, '偏好缺失视为 auto');
  assert.equal(T.resolve('乱七八糟', { coarse: false, width: 1280 }), false, '非法值不得当成 on');
});

test('触屏判定｜常量取值的合理性（阈值是"手感"，写歪了会直接破坏可用性）', () => {
  assert.ok(T.MAX_W > 320 && T.MAX_W <= 720, '小屏阈值应在手机量级：' + T.MAX_W);
  assert.ok(T.SLOP > 0.4 && T.SLOP < 1,
    '"拖动"阈值必须 <1 格（否则拖到隔壁点都不算拖动 ⇒ 拖动功能形同不存在），且不能太小（否则轻点抖动就落子）：' + T.SLOP);
});

/* ============ 二、拖动判定 ============ */
test('拖动判定：位移够远 **且** 目标点变了 ⇒ 才算拖动（两个条件缺一不可）', () => {
  const cell = 24;
  // 同一点：即使抖动超过阈值，也不算拖动（否则"确认"机制被架空：手指一抖就落了）
  assert.equal(T.isDrag({ from: { x: 7, y: 7 }, to: { x: 7, y: 7 }, dist: cell * 2, cell: cell }), false,
    '原地抖动不是拖动');
  // 换点了但位移不够（阈值以下）：不算拖动（防"轻点落在两格之间、舍入抖动"导致误落）
  assert.equal(T.isDrag({ from: { x: 7, y: 7 }, to: { x: 8, y: 7 }, dist: cell * 0.5, cell: cell }), false);
  // 两个条件都满足 ⇒ 拖动
  assert.equal(T.isDrag({ from: { x: 7, y: 7 }, to: { x: 8, y: 7 }, dist: cell * 0.8, cell: cell }), true);
});

test('拖动判定：阈值边界（恰好等于阈值 = 拖动，符合"≥"的书面口径）', () => {
  const cell = 20;
  const g = (k) => ({ from: { x: 3, y: 3 }, to: { x: 4, y: 3 }, dist: cell * k, cell: cell });
  assert.equal(T.isDrag(g(T.SLOP - 0.01)), false);
  assert.equal(T.isDrag(g(T.SLOP)), true, '恰好等于阈值 ⇒ 拖动（与注释一致）');
  assert.equal(T.isDrag(g(T.SLOP + 0.01)), true);
});

test('拖动判定：阈值**与棋盘缩放无关**（同一比例在大小棋盘上结论一致）', () => {
  // 若用固定像素而不是格距，小屏（cell≈24）会"拖不动"、大屏（cell≈40）会"过灵敏"
  for (const cell of [12, 20, 24, 40, 60]) {
    assert.equal(T.isDrag({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, dist: cell * 0.9, cell: cell }), true,
      'cell=' + cell);
    assert.equal(T.isDrag({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, dist: cell * 0.3, cell: cell }), false,
      'cell=' + cell);
  }
});

test('拖动判定：缺 from/to 一律不算拖动（不得靠"隐式真值"过）', () => {
  assert.equal(T.isDrag(), false);
  assert.equal(T.isDrag({}), false);
  assert.equal(T.isDrag({ to: { x: 1, y: 1 }, dist: 99, cell: 20 }), false, '没有按下点 ⇒ 无从谈起拖动');
  assert.equal(T.isDrag({ from: { x: 1, y: 1 }, to: null, dist: 99, cell: 20 }), false, '没有当前点 ⇒ 不算');
});

/* ============ 三、松手决策 ============ */
test('松手决策：不在交点上（格子间隙 / 划出盘外）⇒ 什么都不做', () => {
  assert.equal(T.decide({ from: { x: 7, y: 7 }, to: null, dist: 60, cell: 24, dragging: true }), 'cancel');
  assert.equal(T.decide({ to: { x: 7, y: 7 }, dist: 0, cell: 24 }), 'cancel', '没有按下点（非本次手势）⇒ 取消');
  assert.equal(T.decide(), 'cancel');
});

test('松手决策：轻点（位移不够）⇒ 进待确认态；拖动 ⇒ 直接落子', () => {
  const cell = 24;
  assert.equal(T.decide({ from: { x: 7, y: 7 }, to: { x: 7, y: 7 }, dist: 3, cell: cell, dragging: false }),
    'confirm', '轻点必须先确认 —— 这是"防误落"的全部意义');
  assert.equal(T.decide({ from: { x: 7, y: 7 }, to: { x: 9, y: 5 }, dist: cell * 2.2, cell: cell, dragging: true }),
    'place', '拖动释放 ⇒ 直接落子');
});

test('松手决策：dragging 是**粘性**的（拖出去再拖回原点松手，仍按拖动处理）', () => {
  const cell = 24;
  // 用户拖到别处又拖回来：位移=0、目标点=原点，但这是完整的一次拖动表达
  assert.equal(T.decide({ from: { x: 7, y: 7 }, to: { x: 7, y: 7 }, dist: 0, cell: cell, dragging: true }),
    'place', '拖回原点松手 = 落子（否则用户会以为"拖了个寂寞"）');
});

test('★ 单一真相源：decide 与 isDrag 在整片参数网格上必须一致', () => {
  /* 口径：from/to 都存在时，decide 只在"dragging 粘性或 isDrag 为真"时给 place。
   * 这条对拍是防止"移动时按 A 口径判拖动、松手时按 B 口径判轻点"的经典不一致
   * —— 症状是"拖了半天松手却弹出确认条"（或反过来："轻轻一点就落子"），极难复现定位。 */
  const cells = [12, 24, 40];
  const dists = [0, 0.2, 0.5, 0.74, 0.75, 0.76, 1, 2];
  const pairs = [[[7, 7], [7, 7]], [[7, 7], [8, 7]], [[0, 0], [14, 14]]];
  let n = 0;
  for (const cell of cells) for (const k of dists) for (const [a, b] of pairs) {
    for (const dragging of [false, true]) {
      const g = { from: { x: a[0], y: a[1] }, to: { x: b[0], y: b[1] }, dist: cell * k, cell: cell, dragging: dragging };
      const want = (dragging || T.isDrag(g)) ? 'place' : 'confirm';
      assert.equal(T.decide(g), want,
        'cell=' + cell + ' k=' + k + ' ' + a + '→' + b + ' dragging=' + dragging);
      n++;
    }
  }
  assert.ok(n >= 100, '至少覆盖 100 组组合，实得 ' + n);
});

test('★ 误落防线：整片网格里"轻点"绝不允许出现 place（只有真拖动或粘性 dragging 才落子）', () => {
  const cell = 24;
  let places = 0, confirms = 0;
  for (const k of [0, 0.1, 0.3, 0.5, 0.6, 0.74]) {
    for (const [a, b] of [[[7, 7], [7, 7]], [[7, 7], [8, 7]], [[7, 7], [8, 8]]]) {
      const r = T.decide({ from: { x: a[0], y: a[1] }, to: { x: b[0], y: b[1] },
                           dist: cell * k, cell: cell, dragging: false });
      if (r === 'place') places++; else confirms++;
    }
  }
  assert.equal(places, 0, '阈值以下的位移不得直接落子（会误落，代价不可逆）');
  assert.ok(confirms > 0);
});

test('★ 单向性：拖动一定是"位移比例 ≥ 阈值"，不存在"位移极小却判拖动"的通道', () => {
  const cell = 30;
  for (let k = 0; k < T.SLOP; k += 0.05) {
    for (const [a, b] of [[[5, 5], [6, 5]], [[5, 5], [5, 6]], [[5, 5], [5, 5]]]) {
      assert.equal(T.isDrag({ from: { x: a[0], y: a[1] }, to: { x: b[0], y: b[1] }, dist: cell * k, cell: cell }), false,
        'k=' + k.toFixed(2));
    }
  }
});
