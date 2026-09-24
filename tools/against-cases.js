/* tools/against-cases.js —— U' 等价对拍用例注册表（S3，施工图 §5.5.9）
 *
 * 每条"等价对拍型"优化（A2a/A5/A6/A8/A9/A10/A11/A12）实施时在此追加用例：
 *   cases.<name> = { desc, cfg?, oldFn(pos, ctx, meta), newFn(pos, ctx, meta), cmp?(a, b) }
 *     - oldFn/newFn 返回可 JSON 序列化的结果；同输入下必须**确定性**
 *     - cmp(a,b) 缺省 = JSON 字符串全等；比较不含 timeMs 等非确定字段
 *     - runner 对每次调用**重建 pos**（互不污染），diff 才是干净的旧路径 vs 新路径
 * 约定（铁律）：
 *     - fn 内如调 SEARCH.think：先 SEARCH.ttClear()，cfg 必须带 useBook:false
 *     - fn 不得修改 pos 的盘面语义（make/unmake 必须配对）
 * 自检用例：'selffail'（故意必败）——用于验证 runner 真能抓到不一致（特效性检查 §5.5.5），
 *   不进 --case=all，须显式 --case=selffail 才跑。
 */
'use strict';
const core = require('../engine/core.js');
const SEARCH = require('../engine/search.js');
const { BLACK, WHITE } = core;

/* 与 bench-elo.js 相同的可复现随机流（供需要 rnd 的 cfg 使用） */
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cases = {

  /* S3 管道自证：posFromBoard 快建 vs 空盘逐手 makeMove 重放，两路必须一致。
   * 同时是局面集数据质量的常驻护栏（board/hist/stm 自洽性）。 */
  'board-roundtrip': {
    desc: 'posFromBoard 快建 vs 逐手 makeMove 重放（局面集→pos 全链路自洽）',
    oldFn(pos) {
      return { board: Array.from(pos.board), stm: pos.stm, stones: pos.stones,
               zob: pos.zobHi + ':' + pos.zobLo, hist: pos.hist.slice() };
    },
    newFn(_pos, _ctx, meta) {
      const p = core.createPosition();
      for (let k = 0; k < meta.histIdx.length; k++) {
        const i = meta.histIdx[k];
        const player = (k % 2 === 0) ? BLACK : WHITE;        // renjunet 首手黑、黑白交替
        if (!core.makeMove(p, i % 15, (i / 15) | 0, player)) {
          throw new Error('重放失败：idx=' + i + ' 第 ' + k + ' 手（id=' + meta.id + '）');
        }
      }
      return { board: Array.from(p.board), stm: p.stm, stones: p.stones,
               zob: p.zobHi + ':' + p.zobLo, hist: p.hist.slice() };
    },
  },

  /* 搜索确定性自证 —— A2a 等"开/关开关对拍"的前提：若引擎本身非确定，diff 口径全崩。
   * 同实现跑两遍（各自重建 pos + ttClear），任何差异都说明存在跨调用状态泄漏。
   * ★ hardLimit 必须远大于该深度实际耗时（2s ≫ 深度 4 的 ~10ms）：否则迭代深度
   *   在墙钟超时边界（nodes&511 检查点）上抖动，"非确定"是墙钟假象而非引擎缺陷。
   *   —— 首跑实测 hardLimit=40 时 2/10 出现 nodes 恰差 512 的假差异，即为该现象。 */
  'think-determinism': {
    desc: '同 pos 同 cfg 两次 think 逐字段一致（确定性铁律，useBook:false，完整收敛）',
    cfg: { difficulty: 'hard', hardLimit: 2000, maxDepth: 4, useBook: false, rule: 'freestyle' },
    oldFn(pos) {
      SEARCH.ttClear();
      const r = SEARCH.think(pos, Object.assign({}, this.cfg, { rnd: mulberry32(42) }));
      return r ? { move: r.move, score: r.score, depth: r.depth, nodes: r.nodes,
                   fallbackLevel: r.fallbackLevel, via: r.via || '' } : null;
    },
    newFn(pos, ctx, meta) { return this.oldFn(pos, ctx, meta); },
  },

  /* 特效性自检（必败，须显式点名运行） */
  selffail: {
    desc: 'runner 特效性自检：故意返回不一致结果（必须报 diff>0 且 exit 1）',
    hidden: true,
    oldFn(pos) { return { stones: pos.stones }; },
    newFn(pos) { return { stones: pos.stones + 1 }; },
  },
};

module.exports = { cases, mulberry32 };
