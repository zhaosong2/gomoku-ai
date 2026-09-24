/* test/ai.test.js — M4 `ui/ai.js` 客户端契约（DOM 无关，Node 可直接跑）
 * 覆盖：主线程兜底出招、**过期结果必须被丢弃**、abort 语义、Worker 握手晚到接管。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const core = require('../engine/core.js');
const search = require('../engine/search.js');
const AI_PATH = path.join(__dirname, '..', 'ui', 'ai.js');
const { BLACK, WHITE, EMPTY, NN, idxOf } = core;

function freshAI(extra) {
  const g = { search: search, core: core };
  if (extra) Object.assign(g, extra);
  global.window = { G: g };
  global.location = { search: '' };
  delete require.cache[require.resolve(AI_PATH)];
  require(AI_PATH);
  return global.window.G.ai;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const emptyBoard = () => new Int8Array(NN);

test('主线程兜底：强制 main 后端也能正常出招', async () => {
  const ai = freshAI();
  await ai.init(true);
  assert.equal(ai.info().backend, 'main');
  const r = await ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  assert.equal(r.cmd, 'move');
  assert.deepEqual(r.move, { x: 7, y: 7 }, '空盘应下天元');
});

test('过期结果被丢弃：被新请求顶替的旧请求必须 reject E_ABORTED', async () => {
  const ai = freshAI();
  await ai.init(true);
  const board = emptyBoard();
  const a = ai.askMove(board, BLACK, { rule: 'freestyle', difficulty: 'easy' });
  const b = ai.askMove(board, BLACK, { rule: 'freestyle', difficulty: 'easy' });
  await assert.rejects(a, /E_ABORTED/, '旧请求应被作废');
  const rb = await b;
  assert.equal(rb.cmd, 'move', '新请求应正常返回');
});

test('abort 语义：abort 之后的请求不受影响，且能继续出招', async () => {
  const ai = freshAI();
  await ai.init(true);
  const board = emptyBoard();
  const a = ai.askMove(board, BLACK, { rule: 'freestyle', difficulty: 'easy' });
  ai.abort();
  await assert.rejects(a, /E_ABORTED/);
  const c = await ai.askMove(board, BLACK, { rule: 'freestyle', difficulty: 'easy' });
  assert.deepEqual(c.move, { x: 7, y: 7 }, 'abort 后仍应能正常出招（不得被永久毒化）');
});

/* ---------- Worker 后端：用假 Worker 模拟"握手晚到" ---------- */
function installFakeWorker(replyDelayMs) {
  const state = { created: 0, last: null };
  function FakeWorker() {
    const self = this;
    state.created++; state.last = self;
    self.onmessage = null;
    self.onerror = null;
    self.terminated = false;
    self.terminate = function () { self.terminated = true; };
    self.postMessage = function (m) {
      if (m.cmd === 'init') {
        setTimeout(function () {
          if (!self.terminated && self.onmessage) self.onmessage({ data: { id: m.id, cmd: 'init', ok: true, sab: false } });
        }, replyDelayMs);
      } else if (m.cmd === 'move') {
        setTimeout(function () {
          if (!self.terminated && self.onmessage) {
            self.onmessage({ data: { id: m.id, cmd: 'move', move: { x: 3, y: 4 }, score: 0, nodes: 1, depth: 1, timeMs: 1, fallbackLevel: 0 } });
          }
        }, 1);
      }
    };
  }
  global.Worker = FakeWorker;
  if (!String(global.URL && global.URL.createObjectURL)) global.URL = { createObjectURL: () => 'blob:fake' };
  else { const orig = global.URL.createObjectURL; global.URL.createObjectURL = () => 'blob:fake'; }
  return state;
}

test('Worker 握手晚到 → 接管为正式后端（不得永久降级）', async () => {
  installFakeWorker(60);                       // 握手 60ms，超过下面的 30ms 超时
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 30 });
  const ok = await ai.init(false);
  assert.equal(ok, false, '握手应超时');
  assert.equal(ai.info().backend, 'main', '超时后先落到主线程');

  await sleep(150);                            // 等晚到的 init 回话
  assert.equal(ai.info().backend, 'worker', '晚到的 Worker 应被接管');
  const r = await ai.askMove(emptyBoard(), WHITE, { rule: 'freestyle', difficulty: 'easy' });
  assert.deepEqual(r.move, { x: 3, y: 4 }, '接管后应走 Worker 结果');
});

/* ══════════════════════════════════════════════════════════════
 * ★ 请求调度：move 优先 + 辅助排队（2026-09-22 探索性测试实证）
 *   旧行为（单通道 latest-wins）的两条真实缺陷：
 *     ① AI 思考期间用户点「热力」/按 H ⇒ 在飞的 move 请求被顶掉 ⇒ **AI 永不出招**（无报错）；
 *     ② 被顶掉的 promise 无人收尾 ⇒ 面板 `busy` 永久为真 ⇒ 之后「提示」全部静默失效。
 * ══════════════════════════════════════════════════════════════ */
function installEchoWorker(delayMs) {
  const state = { order: [] };
  function FakeWorker() {
    const self = this;
    self.onmessage = null; self.onerror = null; self.terminated = false;
    self.terminate = function () { self.terminated = true; };
    self.postMessage = function (m) {
      state.order.push(m.cmd);
      const send = function (data) {
        if (self.terminated || !self.onmessage) return;
        self.onmessage({ data: Object.assign({ id: m.id }, data) });
      };
      if (m.cmd === 'init') { setTimeout(function () { send({ cmd: 'init', ok: true, sab: false }); }, 1); return; }
      setTimeout(function () {
        if (m.cmd === 'move') send({ cmd: 'move', move: { x: 3, y: 4 }, score: 0, nodes: 1, depth: 1, timeMs: 1, fallbackLevel: 0 });
        else if (m.cmd === 'hint') send({ cmd: 'hint', hints: [] });
        else send({ cmd: m.cmd, ok: true });
      }, delayMs);
    };
  }
  global.Worker = FakeWorker;
  /* ⚠ 只替换 `createObjectURL`，**不能整个替换 global.URL** ——
   *   Node 内部（以及本仓库运行环境的 fs shim）会用 `URL` 的 instanceof 做路径判定，
   *   把 URL 换成普通对象会直接抛 "Right-hand side of 'instanceof' is not callable"。 */
  if (!String(global.URL && global.URL.createObjectURL)) global.URL = { createObjectURL: () => 'blob:fake' };
  else global.URL.createObjectURL = () => 'blob:fake';
  return state;
}

test('★ 调度：AI 思考期间的辅助请求（提示）不顶掉这一手（move 优先 + 排队）', async () => {
  const st = installEchoWorker(40);
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 500 });
  await ai.init(false);
  assert.equal(ai.info().backend, 'worker');
  const mv = ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  const hint = ai.askHint(emptyBoard(), BLACK, {});          // 与 move 同 tick 发出
  const rm = await mv;
  assert.equal(rm.cmd, 'move', '这一手必须照常完成（旧实现会被辅助请求顶掉 ⇒ AI 不出招）');
  const rh = await hint;
  assert.ok(rh, '辅助请求必须也有结果（排队执行，而不是被丢弃）');
  const iMove = st.order.indexOf('move'), iHint = st.order.indexOf('hint');
  assert.ok(iMove >= 0 && iHint > iMove, 'worker 收到的顺序应为 move 先、hint 后：' + st.order.join(','));
});

test('★ 调度：被顶掉的请求立刻以 E_ABORTED 收尾（不留悬挂 promise）', async () => {
  installEchoWorker(30);
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 500 });
  await ai.init(false);
  const a = ai.askHint(emptyBoard(), BLACK, {});
  const b = ai.askHint(emptyBoard(), BLACK, {});
  await assert.rejects(a, /E_ABORTED/, '被顶替的提示必须 reject（否则面板 busy 永久为真、提示静默失效）');
  await b;
});

/* ══════════════════════════════════════════════════════════════
 * ★ 出口完备性：Worker「崩溃」与「不回应」都必须有出口（2026-09-23 评审）
 *   旧实现 `pending` 只有两个出口（收到响应 / 被顶替），且握手完成后 onerror 被
 *   `done` 挡掉 ⇒ Worker 崩溃或消息丢失时，promise **永不 settle**，
 *   界面永久停在"思考中"且**零报错** —— 与"悬挂 promise"同族，排查成本极高。
 * ══════════════════════════════════════════════════════════════ */
/** 可编程的假 Worker：能握手成功，随后按需"崩溃"或"装死" */
function installBehaviorWorker(opts) {
  const o = opts || {};
  const state = { seen: [] };
  function FakeWorker() {
    const self = this;
    self.onmessage = null; self.onerror = null; self.terminated = false;
    self.terminate = function () { self.terminated = true; };
    self.postMessage = function (m) {
      state.seen.push(m.cmd);
      if (m.cmd === 'init') {
        setTimeout(function () { if (!self.terminated && self.onmessage) self.onmessage({ data: { id: m.id, cmd: 'init', ok: true, sab: false } }); }, 1);
        return;
      }
      if (m.cmd === 'abort') return;
      if (o.crashOn === m.cmd) {                       // 触发运行期错误
        setTimeout(function () { if (!self.terminated && self.onerror) self.onerror({ message: o.crashMsg || 'boom' }); }, 5);
        return;
      }
      if (o.neverReply) return;                        // 装死：不回应（消息丢失 / Worker 卡住）
      setTimeout(function () {
        if (self.terminated || !self.onmessage) return;
        if (m.cmd === 'move') self.onmessage({ data: { id: m.id, cmd: 'move', move: { x: 3, y: 4 }, score: 0, nodes: 1, depth: 1, timeMs: 1, fallbackLevel: 0 } });
        else self.onmessage({ data: { id: m.id, cmd: m.cmd, ok: true } });
      }, 5);
    };
  }
  global.Worker = FakeWorker;
  if (!String(global.URL && global.URL.createObjectURL)) global.URL = { createObjectURL: () => 'blob:fake' };
  else global.URL.createObjectURL = () => 'blob:fake';
  return state;
}

test('★ Worker 运行错误：在飞请求必须立刻 reject（E_WORKER）并降级主线程，之后能自愈出招', async () => {
  installBehaviorWorker({ crashOn: 'move', crashMsg: 'simulated crash' });
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 500 });
  await ai.init(false);
  assert.equal(ai.info().backend, 'worker', '前置：握手成功应在 Worker 后端');

  await assert.rejects(ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' }),
    /E_WORKER/, '运行期错误必须让在飞 promise 失败（不得永久挂起）');
  assert.equal(ai.info().backend, 'main', '运行错误后必须降级（否则后续请求继续撞死 Worker）');
  assert.ok(/运行错误/.test(ai.info().reason), '排障信息要说明原因：' + ai.info().reason);

  const r = await ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  assert.deepEqual(r.move, { x: 7, y: 7 }, '降级后应能自愈出招（主线程兜底）');
});

test('★ 看门狗：Worker 不回应时请求必须超时失败并降级（不得永久停在"思考中"）', async () => {
  installBehaviorWorker({ neverReply: true });
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 500, AI_TIMEOUT_MS: 60 });
  await ai.init(false);
  assert.equal(ai.info().backend, 'worker');

  const mv = ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  await sleep(10);
  assert.equal(ai.sched().watchdog, true, '在飞的 Worker 请求必须有看门狗兜底');

  await assert.rejects(mv, /E_TIMEOUT/, '不回应必须超时失败，而不是永不 settle');
  assert.equal(ai.info().backend, 'main', '超时后必须降级主线程');
  assert.equal(ai.sched().watchdog, false, '超时后看门狗必须解除（不得泄漏计时器）');

  const r = await ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  assert.equal(r.cmd, 'move', '降级后仍应能出招');
});

test('★ 降级路径：排队的多个辅助请求必须依次出结果（不得互相顶替成 E_ABORTED）', async () => {
  /* 场景：AI 思考中用户连开「提示」与「热力」（都被排队）→ Worker 卡死触发看门狗降级。
   *   降级与"这一手结束"是**两个**独立的收尾源，若不串行化放行，两个任务会同时在飞、
   *   后者把前者的 id 作废 ⇒ 前者 E_ABORTED ⇒ 面板静默无反应（R8 自查发现并修掉）。 */
  const coach = require('../engine/coach.js');
  installBehaviorWorker({ neverReply: true });
  const ai = freshAI({ WORKER_SRC: 'self.onmessage=function(){};', AI_HANDSHAKE_MS: 500,
                       AI_TIMEOUT_MS: 60, coach: coach });
  await ai.init(false);

  const mv = ai.askMove(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  const h = ai.askHint(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy', n: 3 });
  const t = ai.askHeat(emptyBoard(), BLACK, { rule: 'freestyle', difficulty: 'easy' });
  await assert.rejects(mv, /E_TIMEOUT/, '前置：这一手应超时失败');
  const [rh, rt] = await Promise.all([h, t]);                 // 两个都不得 rejected
  assert.equal(rh.cmd, 'hint', '降级后提示必须照常出结果');
  assert.equal(rt.cmd, 'heat', '降级后热力必须照常出结果');
});
