/* tools/duel-analyze.js — D-3：对局过程分析（duel-methodology §3.2 / 施工图 S0 第 3 项）
 *
 * 用法： node tools/duel-analyze.js [trace.jsonl 路径]
 * 输入： _duel-trace.jsonl（bench-elo.js --trace 产出，每局一行，§4.2 格式）
 *
 * 口径（§3.2.2 三边界 + §3.2.3 指标）：
 *   · 见杀封顶  |score| ≥ MATE(1e8−1000) ⇒ 轮走方已见杀；曲线/均值聚合前 clamp ±1e6，
 *               但 plyWin/plyMateSeen 用**原始分**判断（clamp ±1e6 后 5e7 阈值永不触发——
 *               方法论两处口径冲突，此处按用途分流并显式标注）
 *   · 开局库手  book:true 排除出思考质量统计（库的先验不是搜索结论）
 *   · L1 兜底手 fb:1 单列（一层都没搜完，nodes/depth 含义不同）
 *   · scoreA   = aIsBlack ? scoreBlack : −scoreBlack（A 视角；scoreBlack 已在 trace 内归一）
 *   · 胜势阈值  PLYWIN_T = +0.5·WIN（§3.2.3 字面）。分数量级：普通组合分最高 ~1.2e5、
 *               活四 ~1e6、杀分 = WIN−ply ≈ 1e8 ⇒ plyWin 与 plyMateSeen 触发点接近属预期。
 *   · 均势阈值  BAL_T = 1e5（组合级优势以下视为胶着）
 *   · Δ(ply) 主指标需"同开局同执色、A/B 对同一局面各评一次"的 dedicated 采集模式（§3.2.3），
 *     对局 trace 中双方各只走自己的手 ⇒ 不可配对 ⇒ 本版输出分段形势统计，
 *     Δ 配对采集留待 --dual 扩展（打印提示）。
 */
const fs = require('fs');
const path = require('path');

const WIN = 1e8;
const MATE = WIN - 1000;        // |score| ≥ MATE ⇒ 轮走方已见杀（patterns.js WIN=1e8）
const CLAMP = 1e6;              // 曲线聚合封顶（§3.2.2）
const PLYWIN_T = 0.5 * WIN;     // 胜势阈值（§3.2.3 "如 +0.5·WIN"，原始分判断）
const BAL_T = 1e5;              // 均势阈值：组合级优势以下视为胶着
const BUCKET = 10;              // 曲线分桶宽度（ply）

const clamp = v => Math.max(-CLAMP, Math.min(CLAMP, v));

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function se(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length);
}
function f1(v) { return isNaN(v) ? '—' : v.toFixed(1); }
function sg(v) { return isNaN(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(0); }
function kn(v) { return isNaN(v) ? '—' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v.toFixed(0); }

// ---- 单局分析：返回该局全部派生量（不改输入） ----
function perGame(g) {
  const t = g.trace || [];
  const aIsBlack = !!g.aIsBlack;
  const scoreA = tt => (aIsBlack ? tt.scoreBlack : -tt.scoreBlack);
  const A_STM = (t.find(x => x.side === 'A') || {}).stm;
  const B_STM = (t.find(x => x.side === 'B') || {}).stm;
  const winnerSide = g.winner === 0 ? 'draw' : g.winner === A_STM ? 'A' : g.winner === B_STM ? 'B' : '?';

  const out = {
    winnerSide, nSearch: { A: 0, B: 0 }, book: { A: 0, B: 0 }, fb1: { A: 0, B: 0 },
    l0: { A: 0, B: 0 },
    ms: { A: [], B: [] }, nodes: { A: [], B: [] }, depth: { A: [], B: [] },
    plyWin: { A: null, B: null }, mateSeen: { A: null, B: null },
    hold: { A: null, B: null }, upset: { A: null, B: null },
    balRun: 0, buckets: [],
  };
  const NB = 4;
  for (let i = 0; i < NB; i++) out.buckets.push({ a: [], b: [] });

  let run = 0;
  for (const tt of t) {
    const s = scoreA(tt);
    const sC = clamp(s);
    const side = tt.side === 'B' ? 'B' : 'A';
    if (tt.book) { out.book[side]++; continue; }          // 边界②：book 手不进思考质量统计
    if (tt.via === 'l0') { out.l0[side]++; continue; }    // ★ 边界④（D-3 实施发现）：L0 战术手的
                                                          //   score 是哨兵 ±PAT.WIN，不是评估分——
                                                          //   tacticalMove 的封堵/活四强点分支走完
                                                          //   对局继续，却满足 |score|≥MATE ⇒ 若不
                                                          //   排除会把"封堵"误计成"见杀"。
                                                          //   （成五点分支走完即终局，不损失信息）
    if (tt.fb === 1) out.fb1[side]++;                     // 边界③：L1 兜底单列
    out.nSearch[side]++;
    out.ms[side].push(tt.ms);
    out.nodes[side].push(tt.nodes);
    out.depth[side].push(tt.depth);
    const bi = Math.min(NB - 1, Math.floor((tt.ply || 0) / BUCKET));
    out.buckets[bi][side.toLowerCase()].push(sC);   // ★ bucket 内键小写 a/b（stats 键是大写 A/B，勿混）
    // 边界①：离散指标用**原始分**（clamp 后 5e7/MATE 阈值永不触发）
    if (out.plyWin[side] === null && side === 'A' && s >= PLYWIN_T) out.plyWin.A = tt.ply;
    if (out.plyWin[side] === null && side === 'B' && s <= -PLYWIN_T) out.plyWin.B = tt.ply;
    if (out.mateSeen[side] === null && side === 'A' && s >= MATE) out.mateSeen.A = tt.ply;
    if (out.mateSeen[side] === null && side === 'B' && s <= -MATE) out.mateSeen.B = tt.ply;
    // 均势段：局面属性（|scoreA| < BAL_T 的最长连续段）
    if (Math.abs(sC) < BAL_T) { run++; if (run > out.balRun) out.balRun = run; }
    else run = 0;
  }
  // 优势保持 / 反超：以"首次建立胜势"为起点，此后 scoreA 恒 >0（或恒 <0）且终局胜/败
  for (const side of ['A', 'B']) {
    const pw = out.plyWin[side];
    if (pw === null) continue;
    const want = side === 'A' ? 1 : -1;
    const lost = t.some(x => !x.book && x.via !== 'l0' && x.ply > pw && want * scoreA(x) <= 0);
    if (side === 'A') out.hold.A = !lost && winnerSide === 'A';
    else out.hold.B = !lost && winnerSide === 'B';
    if (side === 'A') out.upset.A = winnerSide === 'B';
    else out.upset.B = winnerSide === 'A';
  }
  return out;
}

// ---- 聚合 N 局 → 汇总对象（供 CLI 打印，也可供验收脚本进程内调用） ----
function analyze(games) {
  const per = games.map(perGame);
  const names = games[0] && games[0].names ? games[0].names : { A: '?', B: '?' };
  const g1 = (arr, key, sub) => arr.map(x => x[key][sub]);
  const agg = {};
  for (const side of ['A', 'B']) {
    agg[side] = {
      games: per.filter(x => x.nSearch[side] > 0).length,
      ms: mean([].concat(...per.map(x => x.ms[side]))),
      nodes: mean([].concat(...per.map(x => x.nodes[side]))),
      depth: mean([].concat(...per.map(x => x.depth[side]))),
      book: per.reduce((s, x) => s + x.book[side], 0),
      fb1: per.reduce((s, x) => s + x.fb1[side], 0),
      l0: per.reduce((s, x) => s + x.l0[side], 0),
      plyWin: per.map(x => x.plyWin[side]).filter(v => v !== null),
      mateSeen: per.map(x => x.mateSeen[side]).filter(v => v !== null),
      holdN: per.filter(x => x.hold[side] === true).length,
      holdD: per.filter(x => x.hold[side] !== null).length,
      upsetN: per.filter(x => x.upset[side] === true).length,
      upsetD: per.filter(x => x.upset[side] !== null).length,
    };
  }
  agg.balRun = mean(per.map(x => x.balRun));
  agg.balRunSe = se(per.map(x => x.balRun));
  agg.w = per.filter(x => x.winnerSide === 'A').length;
  agg.l = per.filter(x => x.winnerSide === 'B').length;
  agg.d = per.filter(x => x.winnerSide === 'draw').length;
  agg.buckets = [];
  const NB = per[0] ? per[0].buckets.length : 0;
  for (let i = 0; i < NB; i++) {
    agg.buckets.push({
      a: mean([].concat(...per.map(x => x.buckets[i].a))),
      b: mean([].concat(...per.map(x => x.buckets[i].b))),
    });
  }
  agg.names = names;
  agg.nGames = games.length;
  return agg;
}

function main() {
  const p = process.argv[2] || path.join(__dirname, '..', '_duel-trace.jsonl');
  if (!fs.existsSync(p)) {
    console.error('trace 文件不存在：' + p);
    console.error('先跑：node tools/bench-elo.js <配置A> <配置B> [局数] --trace');
    process.exit(2);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
  if (!lines.length) { console.error('trace 文件为空：' + p); process.exit(2); }
  const games = lines.map(l => JSON.parse(l));
  const a = analyze(games);

  console.log('=== 对局过程分析（D-3 / duel-methodology §3.2） ===');
  console.log('  ' + games.length + ' 局  A=' + a.names.A + '  B=' + a.names.B +
    '  胜负 A ' + a.w + ' / B ' + a.l + ' / 和 ' + a.d);
  console.log('  口径：曲线 clamp ±' + CLAMP.toExponential(0) + '；胜势阈值 +0.5·WIN（原始分）；' +
    '均势 |scoreA|<' + BAL_T.toExponential(0) + '；book 手与 L0 战术手（哨兵分）排除；fb=1 单列');

  console.log('\n① 速度（L1，book 手排除）');
  for (const side of ['A', 'B']) {
    const s = a[side];
    console.log('   ' + side + '  每手 ' + f1(s.ms) + 'ms  节点 ' + kn(s.nodes) +
      '  深度 ' + f1(s.depth) + '  （' + s.games + ' 局）  book ' + s.book +
      ' 手  L0战术 ' + s.l0 + ' 手  L1兜底 ' + s.fb1 + ' 手');
  }

  console.log('\n② 分段形势（L2，A 视角 scoreA，clamp 后均值）');
  console.log('   ply 段      A 思考时眼中   B 思考时眼中   评估分歧(A−B)');
  for (let i = 0; i < a.buckets.length; i++) {
    const bkt = a.buckets[i];
    const lo = i * BUCKET, hi = (i + 1) * BUCKET - 1;
    const div = (isNaN(bkt.a) || isNaN(bkt.b)) ? NaN : bkt.a - bkt.b;
    console.log('   ' + String(lo).padStart(3) + '-' + String(hi).padEnd(3) +
      '    ' + sg(bkt.a).padStart(8) + '      ' + sg(bkt.b).padStart(8) +
      '      ' + sg(div).padStart(8));
  }

  console.log('\n③ 离散事件（L2，均值±SE，括号=触发局数/可判局数）');
  const row = (label, key) => {
    const cell = side => {
      const s = a[side][key];
      if (!s.length) return '—'.padEnd(20);
      return (mean(s).toFixed(1) + '±' + f1(se(s)) + ' 手 (' + s.length + ')').padEnd(20);
    };
    console.log('   ' + label.padEnd(12) + ' A ' + cell('A') + ' B ' + cell('B'));
  };
  row('胜势建立', 'plyWin');
  row('见杀手数', 'mateSeen');
  const pct = (side, n, d) => d ? (100 * n / d).toFixed(0) + '% (' + n + '/' + d + ')' : '— (0)';
  console.log('   优势保持率    A ' + pct('A', a.A.holdN, a.A.holdD).padEnd(20) +
    ' B ' + pct('B', a.B.holdN, a.B.holdD));
  console.log('   反超率        A ' + pct('A', a.A.upsetN, a.A.upsetD).padEnd(20) +
    ' B ' + pct('B', a.B.upsetN, a.B.upsetD));
  console.log('   最长均势段    ' + f1(a.balRun) + '±' + f1(a.balRunSe) + ' 手/局（局面属性，单列）');

  console.log('\n④ Δ(ply) 配对曲线：需 dedicated 采集（同开局同执色 A/B 对同一局面各评一次，§3.2.3 主指标）；' +
    '对局 trace 双方各走各手不可配对 ⇒ 留待 --dual 扩展。');
  console.log('   注：本报告只报数不判优劣——"接受改动"≠"棋力提升"，裁决按 verdict V6/V11 走 L3 CI。');
}

module.exports = { analyze, perGame, WIN, MATE, CLAMP, PLYWIN_T, BAL_T };
if (require.main === module) main();
