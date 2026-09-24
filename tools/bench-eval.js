/* tools/bench-eval.js — M3b 性能基准（增量评估 vs 全量扫描）
 * 用法： node tools/bench-eval.js
 *  · A/B：同一局面、同一参数，比较 incr=true / false 的节点数与耗时
 *  · 原语：叶子评估、候选生成、定级、落子/回退的单项耗时
 */
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const EV = require('../engine/eval.js');
const SEARCH = require('../engine/search.js');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

function boardOf(stones) {
  const b = new Int8Array(NN);
  for (const s of stones) b[idxOf(s[0], s[1])] = s[2];
  return b;
}
const stones = [[7, 7, BLACK], [7, 6, WHITE], [8, 6, BLACK], [6, 6, WHITE], [8, 8, BLACK],
                [6, 7, WHITE], [6, 5, BLACK], [9, 7, WHITE], [10, 7, BLACK], [5, 8, WHITE]];
const CFG = { maxDepth: 8, width: 14, hardLimit: 4000, ttBits: 18 };

function run(incr) {
  const pos = SEARCH.posFromBoard(boardOf(stones), BLACK);
  SEARCH.ttClear();                     // ttInit 同尺寸会复用旧表，必须清
  const r = SEARCH.think(pos, Object.assign({}, CFG, { incr: incr }));
  return { ms: r.timeMs, nodes: r.nodes, depth: r.depth, nps: Math.round(r.nodes / (r.timeMs / 1000)) };
}

console.log('=== A/B：增量评估（§33.3） ===');
const off = run(false), on = run(true);
console.log('  incr=false : ' + off.ms + 'ms  ' + off.nodes + '节点  depth ' + off.depth + '  NPS ' + off.nps);
console.log('  incr=true  : ' + on.ms + 'ms  ' + on.nodes + '节点  depth ' + on.depth + '  NPS ' + on.nps);
console.log('  节点数一致 : ' + (on.nodes === off.nodes ? '是（评估等价）' : '否 ← 有 bug！'));

console.log('\n=== 原语单项耗时 ===');
const b = boardOf(stones);
const pos = SEARCH.posFromBoard(b, BLACK);
function bench(name, R, fn) {
  fn();
  const t0 = Date.now();
  for (let k = 0; k < R; k++) fn();
  const dt = Date.now() - t0;
  console.log('  ' + name.padEnd(26) + (dt / R * 1000).toFixed(3) + ' µs/次');
}
bench('staticEval（全量扫描）', 100000, () => EV.staticEval(b, BLACK, { rule: 'freestyle' }));
bench('staticEvalPos（增量）', 100000, () => EV.staticEvalPos(pos, { rule: 'freestyle' }));
bench('PAT.levelAt', 500000, () => PAT.levelAt(b, 7 * N + 6, BLACK));
bench('EV.candidates', 100000, () => EV.candidates(b, 2));
bench('winningPoints', 30000, () => SEARCH.winningPoints(b, BLACK));
bench('makeMove/unmake', 300000, () => { core.makeMove(pos, 0, 0, BLACK); core.unmakeMove(pos); });
