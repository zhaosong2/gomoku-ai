/* tools/bench-deep-mates.js — 在"长链"局面（双方均无成五点、plied>=3）上量化 VCF/VCT 的增益 */
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const S = require('../engine/search.js');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

function build(rnd) {
  const stones = [], used = new Uint8Array(NN);
  const atk = rnd() < 0.5 ? BLACK : WHITE, def = core.opp(atk);
  const cx = 6 + ((rnd() * 3) | 0), cy = 6 + ((rnd() * 3) | 0);
  const nL = 2 + ((rnd() * 3) | 0);
  for (let L = 0; L < nL; L++) {
    const d = DIRS4[(rnd() * 4) | 0], len = 2 + ((rnd() * 3) | 0), off = -3 + ((rnd() * 7) | 0);
    for (let k = 0; k < len; k++) {
      const x = cx + d[0] * (k + off), y = cy + d[1] * (k + off);
      if (x < 0 || x >= N || y < 0 || y >= N) continue;
      const i = idxOf(x, y);
      if (used[i]) continue;
      used[i] = 1; stones.push([x, y, atk]);
    }
  }
  const nd = 4 + ((rnd() * 6) | 0);
  for (let k = 0; k < nd; k++) {
    const x = cx - 5 + ((rnd() * 11) | 0), y = cy - 5 + ((rnd() * 11) | 0);
    if (x < 0 || x >= N || y < 0 || y >= N) continue;
    const i = idxOf(x, y);
    if (used[i]) continue;
    used[i] = 1; stones.push([x, y, def]);
  }
  return { stones, atk };
}

const rnd = core.mulberry32(4242);
const deep = [];
const N_SAMPLE = parseInt(process.argv[2] || '120000', 10);
for (let it = 0; it < N_SAMPLE && deep.length < 40; it++) {
  const { stones, atk } = build(rnd);
  const b = new Int8Array(NN);
  let bad = false;
  for (const s of stones) { const i = idxOf(s[0], s[1]); if (b[i]) { bad = true; break; } b[i] = s[2]; }
  if (bad) continue;
  // 过滤：双方都无成五点（排除"一步杀"）
  if (TH.hasFivePoint(b, atk) >= 0 || TH.hasFivePoint(b, core.opp(atk)) >= 0) continue;
  let r;
  try { r = TH.vcfWin(S.posFromBoard(b, atk), atk, { depth: 10, budget: 25000 }); } catch (e) { continue; }
  if (r && r.plies >= 3) deep.push({ stones, atk, r });
}

console.log('样本 ' + N_SAMPLE + ' 个，捞到长链（plies>=3 且双方无成五点）' + deep.length + ' 个');
const hist = {};
for (const d of deep) hist[d.r.plies] = (hist[d.r.plies] || 0) + 1;
console.log('杀法长度分布: ' + JSON.stringify(hist));

const res = {};
for (const lvl of ['normal', 'hard', 'master']) res[lvl] = { miss: 0, hit: 0, plainMs: 0, threatMs: 0 };
for (const d of deep) {
  const b = new Int8Array(NN);
  for (const s of d.stones) b[idxOf(s[0], s[1])] = s[2];
  for (const lvl of ['normal', 'hard', 'master']) {
    S.ttClear();
    let t0 = Date.now();
    const plain = S.think(S.posFromBoard(b, d.atk), { difficulty: lvl, rule: 'freestyle', vcfDepth: 0, vctDepth: 0, avoidOpp: false });
    const pMs = Date.now() - t0;
    S.ttClear();
    t0 = Date.now();
    const thr = S.think(S.posFromBoard(b, d.atk), { difficulty: lvl, rule: 'freestyle' });
    const tMs = Date.now() - t0;
    res[lvl].plainMs += pMs; res[lvl].threatMs += tMs;
    if (Math.abs(plain.score) < 99999000) {
      res[lvl].miss++;
      if (Math.abs(thr.score) >= 99999000) res[lvl].hit++;
    }
  }
}
for (const lvl of ['normal', 'hard', 'master']) {
  const x = res[lvl];
  console.log('  [' + lvl + '] 纯搜索漏 ' + x.miss + '/' + deep.length + ' → VCF/VCT 补回 ' + x.hit +
    '｜耗时 纯搜索 ' + x.plainMs + 'ms vs 含求解 ' + x.threatMs + 'ms');
}
