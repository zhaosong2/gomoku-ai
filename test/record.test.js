/* test/record.test.js — M8 棋谱：解析 / 校验 / 导出 / 回放（§9 / §27） */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');
const REC = require('../engine/record.js');

const { BLACK, WHITE, EMPTY, idxOf, NN } = core;

/* ---------- 格式嗅探（§27.2） ---------- */
test('嗅探：五种格式各自识别正确', () => {
  assert.equal(REC.sniff('1.H8 2.I9'), REC.FMT.RENJU);
  assert.equal(REC.sniff('7,7 7,6 8,6'), REC.FMT.XY);
  assert.equal(REC.sniff('(;GM[1]FF[4]SZ[15];B[hh])'), REC.FMT.SGF);
  assert.equal(REC.sniff('TURN 7,7\nTURN 7,6'), REC.FMT.GOMOCUP);
  assert.equal(REC.sniff('{"moves":[[7,7]]}'), REC.FMT.JSON);
});

/* ---------- Renju 记谱 ---------- */
test('Renju：带步数前缀 + 用时标注', () => {
  const r = REC.parse('1.H8 2.I9(1.5s) 3.I7');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.format, REC.FMT.RENJU);
  assert.deepEqual(r.moves, [[7, 7], [8, 6], [8, 8]]);
  assert.equal(r.times.length, 3, 'times 应与 moves 等长');
  assert.equal(r.times[1], 1500);
});

test('Renju：非法标记报 E_PARSE（§27.3）', () => {
  const r = REC.parse('H8 X9', { format: 'renju' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'E_PARSE');
});

/* ---------- 坐标对 ---------- */
test('坐标对：0/1 基自动识别', () => {
  assert.deepEqual(REC.parse('0,0 1,0').moves, [[0, 0], [1, 0]]);   // 含 0 → 0 基
  assert.deepEqual(REC.parse('8,8 8,7').moves, [[7, 7], [7, 6]]);   // 无 0 → 1 基
});

test('坐标对：越界报 E_RANGE', () => {
  const r = REC.parse('16,3 1,1', { format: 'xy' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'E_RANGE');
});

/* ---------- SGF（含 BL/WL 剩余时间，§9.1） ---------- */
test('SGF：坐标 + DT/PB/PW/RE 元信息 + BL/WL 用时', () => {
  const sgf = '(;GM[1]FF[4]SZ[15]DT[2026-09-18]PB[Alice]PW[Bob]RE[B+];B[hh]BL[12.5];W[ih]WL[9.0];B[ii])';
  const r = REC.parse(sgf);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.format, REC.FMT.SGF);
  // SGF 字母坐标：第 1 字母 = 列（a=0..o=14），第 2 字母 = 行**自上而下**（a=顶）
  // 故列 h→7，行 h→14-7=7；列 i→8，行 h→7；列 i→8，行 i→14-8=6
  assert.deepEqual(r.moves, [[7, 7], [8, 7], [8, 6]]);
  assert.equal(r.times[0], 12500);
  assert.equal(r.times[1], 9000);
  assert.equal(r.meta.date, '2026-09-18');
  assert.equal(r.meta.result, 'B');
  assert.deepEqual(r.meta.players, { black: 'Alice', white: 'Bob' });
});

test('SGF：RU 属性给出 ruleMode（Renju）', () => {
  const r = REC.parse('(;GM[1]SZ[15]RU[Renju];B[hh];W[ii])');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.moves.length, 2);
});

test('SGF：pass（空 / tt）不当作着法', () => {
  const r = REC.parse('(;GM[1]SZ[15];B[hh];W[];B[ii])');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.moves, [[7, 7], [8, 6]]);
});

test('SGF：非 15 路棋盘报 E_RANGE', () => {
  const r = REC.parse('(;GM[1]SZ[19];B[aa])');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'E_RANGE');
});

/* ---------- Gomocup ---------- */
test('Gomocup：TURN x,y 序列（规范固定 0 基）', () => {
  const r = REC.parse('TURN 7,7\nTURN 7,6\nTURN 8,6');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.format, REC.FMT.GOMOCUP);
  // ★ Gomocup 协议坐标恒为 0 基；整盘无 0 也不得被当作 1 基而 +1
  assert.deepEqual(r.moves, [[7, 7], [7, 6], [8, 6]]);
});

test('Gomocup：越界报 E_RANGE', () => {
  const r = REC.parse('TURN 7,7\nTURN 15,3', { format: 'gomocup' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'E_RANGE');
});

/* ---------- JSON（自有格式，§9.4） ---------- */
test('JSON：完整保留 no / timeMs / comment', () => {
  const src = JSON.stringify({
    ruleMode: 'renju', result: 'B',
    meta: { date: '2026-09-18', players: { black: 'A', white: 'B' } },
    moves: [{ no: 1, x: 7, y: 7, player: 1, timeMs: 1200, comment: '开局' },
            { no: 2, x: 7, y: 6, player: 2, timeMs: 800 }],
  });
  const r = REC.parse(src);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.moves, [[7, 7], [7, 6]]);
  assert.equal(r.times[0], 1200);
  assert.equal(r.meta.date, '2026-09-18');
});

/* ---------- 逐步校验（§27.3 E_OCCUPIED / E_RULE） ---------- */
test('校验：重复落子报 E_OCCUPIED 并跳过该手', () => {
  const mv = REC.buildMoves([[7, 7], [7, 6], [7, 7], [8, 6]]);
  assert.equal(mv.errors.length, 1);
  assert.equal(mv.errors[0].error, 'E_OCCUPIED');
  assert.equal(mv.errors[0].no, 3);
  assert.equal(mv.moves.length, 3);                     // 第 3 手被跳过
  assert.deepEqual(mv.moves.map(m => [m.x, m.y]), [[7, 7], [7, 6], [8, 6]]);
});

test('校验：步数与手番自动编号（§9.2 no / player）', () => {
  const mv = REC.buildMoves([[7, 7], [7, 6], [8, 6]]);
  assert.deepEqual(mv.moves.map(m => m.no), [1, 2, 3]);
  assert.deepEqual(mv.moves.map(m => m.player), [BLACK, WHITE, BLACK]);
});

test('校验：Renju 黑禁手步报 E_RULE（允许仍导入复盘 §27.3）', () => {
  // 黑造"双活三"：.BB. 型 → 黑落 (7,7) 后四方向计数
  // 用最直接的构造：黑在 (7,7) 落子同时形成两个活三
  const flat = [];
  // 黑：(7,7) 起 横 (5,7)(6,7) 竖 (7,5)(7,6) → 落 (7,7) 后各成"活三"
  const seq = [[5, 7], [0, 0], [6, 7], [1, 0], [7, 5], [2, 0], [7, 6], [3, 0], [7, 7]];
  const mv = REC.buildMoves(seq, { rule: 'renju', overlineMode: 'rif' });
  const ruleErr = mv.errors.filter(e => e.error === 'E_RULE');
  assert.ok(ruleErr.length >= 1, '应检出禁手步，实际：' + JSON.stringify(mv.errors));
});

/* ══════════════════════════════════════════════════════════════
 * ★★ R8（2026-09-23 评审）：两条"静默错"的校验缺陷
 * ══════════════════════════════════════════════════════════════ */

/* ① 跳过非法手时**没有翻手番** ⇒ 其后每一手的颜色都与棋谱相反（整盘反色），
 *    而 UI 导入（ui/record.js → REC.parse → REC.build，非 strict）正好走这条路径：
 *    用户粘一份含一处重复点的棋谱，会得到一盘"看起来正常、其实全反色"的复盘。 */
test('★ 校验：跳过非法手后，其后各手的颜色仍与棋谱一致（不得整盘反色）', () => {
  // 源棋谱：黑白交替；第 3 手（黑）是重复点被跳过
  const mv = REC.buildMoves([[7, 7], [7, 6], [7, 7], [8, 6], [9, 6], [9, 7]]);
  assert.equal(mv.errors.length, 1);
  assert.equal(mv.errors[0].error, 'E_OCCUPIED');
  // 源：1 黑 / 2 白 / 3 黑(丢) / 4 白 / 5 黑 / 6 白
  assert.deepEqual(mv.moves.map(m => m.player), [1, 2, 2, 1, 2],
    '第 4 手起必须回到"源棋谱的颜色"，实际=' + JSON.stringify(mv.moves.map(m => m.player)));
  // 更长的序列同样不得漂移（旧实现在这里是 [1,2,1,2,1]）
  const mv2 = REC.buildMoves([[7, 7], [7, 6], [7, 7], [8, 6], [9, 6], [9, 7], [10, 7], [10, 8]]);
  assert.deepEqual(mv2.moves.map(m => m.player), [1, 2, 2, 1, 2, 1, 2]);
});

/* ② `stopOnRule` 曾是**永不生效的选项**：LOSE_SENTINEL 分支先 `if (o.stopOnRule) break`，
 *    紧接着又 `if (verdict === 'win' || verdict === LOSE_SENTINEL) break` 无条件停。
 *    现在默认行为不变（读到终局/禁手即止），显式 false 才继续导入以便复盘。 */
test('★ 校验：stopOnRule=false 才继续导入（默认仍止于终局/禁手）', () => {
  const seq = [[5, 7], [0, 0], [6, 7], [1, 0], [7, 5], [2, 0], [7, 6], [3, 0], [7, 7], [4, 0], [8, 8]];
  const def = REC.buildMoves(seq, { rule: 'renju', overlineMode: 'rif' });
  assert.equal(def.moves.length, 9, '默认应在禁手手停下');
  const lax = REC.buildMoves(seq, { rule: 'renju', overlineMode: 'rif', stopOnRule: false });
  assert.ok(lax.moves.length > def.moves.length, '显式 false 应继续导入后续着法');
});

/* ③ viewAt 是读取端的最后一道：越界坐标过去会静默写到**相邻行**（x=20,y=0 ⇒ idx=20 = 下一行 A 列）。 */
test('★ 复盘视图：越界手不得写坏盘面（读取端防御）', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 7]], [], { ruleMode: 'freestyle' });
  rec.moves[2] = Object.assign({}, rec.moves[2], { x: 20, y: 0 });   // 人为破坏
  const v = REC.viewAt(rec, 3);
  assert.equal(v.board[20], 0, '越界手不得落到相邻行（idx=20）');
  assert.equal(v.board[idxOf(7, 7)], 1);
  assert.equal(v.board[idxOf(7, 6)], 2);
});

/* ---------- build：GameRecord 结构（§9.4） ---------- */
test('build：产生完整 GameRecord + 时间统计', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6]], [1000, 2000, 3000], { ruleMode: 'freestyle' });
  assert.equal(rec.ruleMode, 'freestyle');
  assert.equal(rec.moves.length, 3);
  assert.equal(rec.moves[0].no, 1);
  assert.equal(rec.moves[0].timeMs, 1000);
  assert.equal(rec.meta.totalMs, 6000);
  assert.equal(rec.meta.avgMsPerMove, 2000);
  assert.ok(rec.board instanceof Int8Array && rec.board.length === NN);
});

test('build：终局自动判定 result', () => {
  // 黑在 y=7 行连五
  const flat = [];
  const seq = [[3, 7], [3, 8], [4, 7], [4, 8], [5, 7], [5, 8], [6, 7], [6, 8], [7, 7]];
  const rec = REC.build(seq, [], { ruleMode: 'freestyle' });
  assert.equal(rec.result, 'B');
  assert.equal(rec.moves[rec.moves.length - 1].verdict, 'win');
});

/* ---------- 导出（§27.4） ---------- */
test('导出：Renju / 坐标对 / JSON / SGF / Gomocup 五种', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6]], [1100, 900, 500], { ruleMode: 'renju' });
  // (7,7)→H8；(7,6)→H9（y 减小 = 行号增大）；(8,6)→I9
  assert.equal(REC.toRenju(rec), '1.H8 2.H9 3.I9');
  assert.equal(REC.toRenju(rec, { numbered: false }), 'H8 H9 I9');
  assert.equal(REC.toXY(rec), '8,8 8,7 9,7');
  assert.equal(REC.toXY(rec, { oneBased: false }), '7,7 7,6 8,6');
  const round = JSON.parse(REC.toJSON(rec));
  assert.equal(round.moves.length, 3);
  assert.equal(round.moves[0].no, 1);
  const sgf = REC.toSGF(rec);
  assert.ok(/^\(;GM\[1\]/.test(sgf) && /SZ\[15\]/.test(sgf), 'SGF 头正确');
  assert.ok(/;B\[hh\]/.test(sgf), 'SGF 首手应为 hh（x=7,y=7）');
  assert.ok(/BL\[1\.1\]/.test(sgf), '应带 BL 用时');
  assert.equal(REC.toGomocup(rec), 'TURN 7,7\nTURN 7,6\nTURN 8,6');
});

test('导出：SGF 往返一致（含 SGF 坐标轴反转）', () => {
  const rec = REC.build([[7, 7], [8, 7], [8, 6], [6, 8]], [], { ruleMode: 'freestyle' });
  const back = REC.parse(REC.toSGF(rec));
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.moves, [[7, 7], [8, 7], [8, 6], [6, 8]]);
});

test('导出：往返一致（Renju → 解析 → Renju）', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6], [6, 7], [6, 6]], [], { ruleMode: 'freestyle' });
  const t1 = REC.toRenju(rec);
  const back = REC.parse(t1);
  assert.ok(back.ok);
  const rec2 = REC.build(back.moves, back.times, { ruleMode: 'freestyle' });
  assert.equal(REC.toRenju(rec2), t1);
});

test('导出：JSON 往返一致', () => {
  const rec = REC.build([[7, 7], [7, 6]], [500, 700], { ruleMode: 'renju' });
  const back = REC.parse(REC.toJSON(rec));
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.moves, [[7, 7], [7, 6]]);
  assert.equal(back.times[0], 500);
});

/* ★ 回归：所有导出函数必须能吃下 parse() 的**元组**产物（浏览器实跑暴露）
 *   旧实现直接读 m.x / m.player / m.timeMs，遇到 [x,y] 元组时：
 *     · toSGF   → 写出 `;W[\u0000\u0000]`（player undefined → 非 1 → 'W'；x undefined → fromCharCode(NaN)=NUL）
 *     · toGomocup → 写出 `TURN undefined,undefined`
 *     · toRenju → 写出 `NaN.undefined`
 *   全部**不抛异常**，只是产出静默垃圾——比抛错危险得多。
 */
test('导出：全部格式兼容 parse() 的元组 moves（回归）', () => {
  const flat = [[7, 7], [7, 6], [8, 6]];
  const pr = REC.parse('1.H8 2.H9 3.I9', { rule: 'freestyle' });
  assert.ok(pr.ok);
  assert.ok(Array.isArray(pr.moves[0]), 'parse 产物应为元组');

  // toRenju / toXY：元组无 no 字段，但编号须按序补 1..N
  assert.equal(REC.toRenju(pr), '1.H8 2.H9 3.I9');
  assert.equal(REC.toRenju(pr, { numbered: false }), 'H8 H9 I9');
  assert.equal(REC.toXY(pr), '8,8 8,7 9,7');
  // toGomocup：必须是数字，不能出现 undefined
  const gm = REC.toGomocup(pr);
  assert.equal(gm, 'TURN 7,7\nTURN 7,6\nTURN 8,6');
  assert.ok(gm.indexOf('undefined') < 0, '不得写出 undefined');
  // toSGF：黑先交替 + 无 NUL 字符
  const sgf = REC.toSGF(pr);
  assert.ok(/;B\[hh\]/.test(sgf), '首手应为黑 hh：' + sgf);
  assert.ok(/;W\[hi\]/.test(sgf), '次手应为白 hi：' + sgf);
  assert.ok(sgf.indexOf('\u0000') < 0, '不得写出 NUL 字符');
  assert.ok(sgf.indexOf('undefined') < 0, '不得写出 undefined');
  // toJSON：moves 保持元组（parse 形态），但不得崩
  assert.doesNotThrow(() => JSON.parse(REC.toJSON(pr)));
  // exportRecord 全格式统一入口
  for (const f of [REC.FMT.RENJU, REC.FMT.XY, REC.FMT.SGF, REC.FMT.GOMOCUP, REC.FMT.JSON]) {
    const out = REC.exportRecord(pr, f);
    assert.ok(typeof out === 'string' && out.length > 0, '格式 ' + f + ' 应产出非空字符串');
    assert.ok(out.indexOf('undefined') < 0, '格式 ' + f + ' 不得含 undefined');
    assert.ok(out.indexOf('\u0000') < 0, '格式 ' + f + ' 不得含 NUL');
  }
  // 元组形态的 SGF 能往返回元组
  const back = REC.parse(REC.toSGF(pr));
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.moves, flat);
});

test('时间统计：元组形态 computeTimes 不产出 NaN', () => {
  const pr = REC.parse('1.H8 2.H9 3.I9', { rule: 'freestyle' });
  REC.computeTimes(pr);
  assert.ok(Number.isFinite(pr.meta.totalMs), 'totalMs 应为有限数：' + pr.meta.totalMs);
  assert.ok(Number.isFinite(pr.meta.avgMsPerMove), 'avgMs 应为有限数：' + pr.meta.avgMsPerMove);
  // ★ clockMs 语义：**每方各自的剩余时间**（棋钟模式），不是全局累计。
  //   黑走 1500 → 黑剩 60000-1500=58500；白走 800 → 白剩 60000-800=59200
  //   （黑已消耗的不扣白的钟）。容易误算成"全局累减"。
  const rec = REC.build([[7, 7], [7, 6]], [1500, 800], { ruleMode: 'freestyle', meta: { totalMs: 60000 } });
  assert.equal(rec.meta.totalMs, 60000);
  assert.equal(rec.moves[0].clockMs, 58500, '黑的钟：60000 - 1500');
  assert.equal(rec.moves[1].clockMs, 59200, '白的钟：60000 - 800（不扣黑消耗）');
});
test('时间统计：parse 的旁路 times 能被 moveAt / 导出取到', () => {
  const pr = REC.parse('1.H8(1.1s) 2.H9(0.9s) 3.I9(0.5s)', { rule: 'renju' });
  assert.ok(pr.ok, JSON.stringify(pr));
  assert.deepEqual(pr.times, [1100, 900, 500]);
  assert.equal(REC.moveAt(pr, 0).timeMs, 1100);
  assert.equal(REC.moveAt(pr, 2).timeMs, 500);
  const sgf = REC.toSGF(pr);
  assert.ok(/B\[hh\]BL\[1\.1\]/.test(sgf), 'SGF 应带 BL[1.1]：' + sgf);
  assert.ok(/W\[hi\]WL\[0\.9\]/.test(sgf), 'SGF 应带 WL[0.9]：' + sgf);
});

/* ---------- 回放（§9.4 / §29.5） ---------- */
test('回放：viewAt 任意步重建棋盘 + 步数徽标数据', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6]], [100, 200, 300], { ruleMode: 'freestyle' });
  const v0 = REC.viewAt(rec, 0);
  assert.equal(v0.ply, 0);
  assert.equal(v0.board.filter(x => x !== EMPTY).length, 0);
  assert.equal(v0.lastMove, null);

  const v2 = REC.viewAt(rec, 2);
  assert.equal(v2.ply, 2);
  assert.equal(v2.board[idxOf(7, 7)], BLACK);
  assert.equal(v2.board[idxOf(7, 6)], WHITE);
  assert.equal(v2.board[idxOf(8, 6)], EMPTY);
  assert.equal(v2.order[idxOf(7, 7)], 1);
  assert.equal(v2.order[idxOf(7, 6)], 2);
  assert.deepEqual(v2.lastMove, { x: 7, y: 6 });
  assert.deepEqual(v2.current, rec.moves[2]);          // 下一手（供"继续"）
});

test('回放：末手给出 over/winner/winLine', () => {
  const seq = [[3, 7], [3, 8], [4, 7], [4, 8], [5, 7], [5, 8], [6, 7], [6, 8], [7, 7]];
  const rec = REC.build(seq, [], { ruleMode: 'freestyle' });
  const v = REC.viewAt(rec, rec.moves.length);
  assert.equal(v.over, true);
  assert.equal(v.winner, BLACK);
  assert.equal(v.winLine.length, 5);
});

test('回放：stepPly 边界钳制', () => {
  const rec = REC.build([[7, 7], [7, 6], [8, 6]], [], { ruleMode: 'freestyle' });
  assert.equal(REC.stepPly(rec, 0, -1), 0);
  assert.equal(REC.stepPly(rec, 3, +1), 3);
  assert.equal(REC.stepPly(rec, 1, +1), 2);
});

/* ★ 回归：viewAt 必须同时吃下 parse() 与 build() 两种 moves 形态（浏览器实跑暴露）
 *   · parse() → moves[k] = [x, y]          纯元组
 *   · build() → moves[k] = {no,x,y,player} 对象
 *   旧实现只认对象，对 parse() 产物**静默返回空盘**（不报错、不抛异常）——
 *   这正是"看起来回放坏了"的真凶：拿 parse 结果直接喂 viewAt，棋盘永远空。
 *   工程教训：**静默降级比抛错更危险**，两种合法输入必须都支持或明确拒绝。
 */
test('回放：viewAt 兼容 parse() 的元组 moves（回归）', () => {
  const flat = [[7, 7], [7, 6], [8, 6], [6, 8]];
  // 形态 A：parse() 产物（元组）
  const pr = REC.parse('1.H8 2.H9 3.I9 4.G7', { rule: 'freestyle' });
  assert.ok(pr.ok && pr.moves.length === 4);
  assert.ok(Array.isArray(pr.moves[0]), 'parse 的 moves[k] 应为数组元组');
  const vp = REC.viewAt(pr, 4);
  assert.equal(vp.board.filter(x => x !== EMPTY).length, 4, '元组形态必须被正确铺开');
  assert.equal(vp.board[idxOf(7, 7)], BLACK);
  assert.equal(vp.board[idxOf(7, 6)], WHITE);
  assert.equal(vp.board[idxOf(8, 6)], BLACK);
  assert.equal(vp.board[idxOf(6, 8)], WHITE);
  assert.deepEqual(vp.lastMove, { x: 6, y: 8 });
  assert.equal(vp.order[idxOf(7, 7)], 1);
  assert.equal(vp.order[idxOf(6, 8)], 4);

  // 形态 B：build() 产物（对象）——必须与形态 A 逐位等价
  const br = REC.build(flat, [], { ruleMode: 'freestyle' });
  const vb = REC.viewAt(br, 4);
  assert.deepEqual(Array.from(vp.board), Array.from(vb.board), '两种形态重建的棋盘必须一致');
  assert.deepEqual(Array.from(vp.order), Array.from(vb.order));

  // moveAt 契约：两种形态都给出 {x,y,player,no}
  for (const src of [pr, br]) {
    const m = REC.moveAt(src, 2);
    assert.equal(m.x, 8); assert.equal(m.y, 6);
    assert.equal(m.player, BLACK, '第 3 手（k=2）应为黑');   // k 为偶数 → 黑
    assert.equal(m.no, 3);
    assert.equal(REC.moveAt(src, 99), null, '越界应返回 null');
  }
  // 元组形态且手数为奇数时，末手仍是黑（交替推断正确）
  const odd = REC.parse('1.H8 2.H9 3.I9', { rule: 'freestyle' });
  assert.equal(REC.moveAt(odd, 2).player, BLACK);
  assert.equal(REC.moveAt(odd, 1).player, WHITE);
});

test('回放：viewAt 对元组 moves 也能判定终局', () => {
  // 黑连五，走 parse 路径（元组形态）也必须识别 over/winner/winLine
  // ★ Renju 记号：I8..M8 = (8..12, 7) —— 同一行 y=7，才是真共线的连五。
  //   （易错：H8 H9 I9 J9 K9 是 L 形而非直线，不会判胜。）
  const rec = REC.parse('1.I8 2.A1 3.J8 4.A2 5.K8 6.A3 7.L8 8.A4 9.M8', { rule: 'freestyle' });
  assert.ok(rec.ok, JSON.stringify(rec));
  const v = REC.viewAt(rec, rec.moves.length);
  assert.equal(v.over, true, '元组形态下终局必须识别');
  assert.equal(v.winner, BLACK);
  assert.equal(v.winLine.length, 5);
});

/* ---------- fromHistory（§9.4 history ↔ moves 一一对应） ---------- */
test('fromHistory：与对局 history 一一对应（步数/用时同步）', () => {
  const history = [
    { x: 7, y: 7, player: BLACK, no: 1, timeMs: 1200 },
    { x: 7, y: 6, player: WHITE, no: 2, timeMs: 800 },
    { x: 8, y: 6, player: BLACK, no: 3, timeMs: 300 },
  ];
  const rec = REC.fromHistory(history, { ruleMode: 'freestyle', opening: '花月局' });
  assert.equal(rec.moves.length, 3);
  assert.deepEqual(rec.moves.map(m => m.no), [1, 2, 3]);
  assert.deepEqual(rec.moves.map(m => m.timeMs), [1200, 800, 300]);
  assert.equal(rec.meta.opening, '花月局');
  assert.equal(rec.meta.totalMs, 2300);
});

test('fromHistory：PvE 胜负结果自动推导', () => {
  const seq = [[3, 7], [3, 8], [4, 7], [4, 8], [5, 7], [5, 8], [6, 7], [6, 8], [7, 7]];
  const history = seq.map((s, k) => ({ x: s[0], y: s[1], player: k % 2 === 0 ? BLACK : WHITE, no: k + 1, timeMs: 100 }));
  const rec = REC.fromHistory(history, { ruleMode: 'freestyle' });
  assert.equal(rec.result, 'B');
});

/* ---------- 坐标工具 ---------- */
test('坐标：coordText / coordFromText 互逆', () => {
  for (const [x, y] of [[0, 0], [7, 7], [14, 14], [8, 6], [3, 11]]) {
    const t = REC.coordText(x, y);
    const p = REC.coordFromText(t);
    assert.equal(p.x, x, t);
    assert.equal(p.y, y, t);
  }
  assert.equal(REC.coordText(7, 7), 'H8');
  assert.equal(REC.coordFromText('X9'), null);
  assert.equal(REC.coordFromText('A0'), null);
});

test('coordText 与 openings 的 R() 口径一致（§12 坐标系）', () => {
  const OP = require('../engine/data/openings.js');
  for (const o of OP.OPENINGS) {
    for (const m of o.moves) assert.equal(REC.coordText(m.x, m.y).length >= 2, true);
  }
  const h8 = OP.R('H8');
  assert.equal(REC.coordText(h8.x, h8.y), 'H8');
  assert.deepEqual([REC.coordFromText('I9').x, REC.coordFromText('I9').y], [OP.R('I9').x, OP.R('I9').y]);
});
