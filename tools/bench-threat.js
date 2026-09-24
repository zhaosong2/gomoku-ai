/* tools/bench-threat.js — M5 威胁搜索收益实测
 * ① 求解器是否正确接管（via=vcf/vct，几乎零耗时）
 * ② 开关 VCF/VCT 对棋力与耗时的影响（自对弈 + 残局命中率）
 */
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const S = require('../engine/search.js');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

const boardOf = st => { const b = new Int8Array(NN); for (const s of st) b[idxOf(s[0], s[1])] = s[2]; return b; };

console.log('=== ① 求解器接管验证 ===');
const vcfCase = [[5, 9, 1], [6, 8, 1], [7, 7, 1], [7, 8, 1], [7, 9, 1], [9, 9, 1], [10, 10, 1],
                 [6, 6, 2], [9, 8, 2], [9, 5, 2], [7, 10, 2], [3, 11, 2], [10, 11, 2], [6, 10, 2]];
S.ttClear();
let r = S.think(S.posFromBoard(boardOf(vcfCase), BLACK), { difficulty: 'hard', rule: 'freestyle' });
console.log('  VCF 局面(hard): via=' + r.via + ' move=(' + r.move.x + ',' + r.move.y + ') ms=' + r.timeMs +
  ' nodes=' + r.nodes + ' path=' + JSON.stringify((r.path || []).map(i => [i % N, (i / N) | 0])));

const vctCase = [[6, 7, WHITE], [8, 7, WHITE], [7, 6, WHITE], [7, 8, WHITE]];
S.ttClear();
r = S.think(S.posFromBoard(boardOf(vctCase), WHITE), { difficulty: 'master', rule: 'freestyle' });
console.log('  双活三局面(master): via=' + r.via + ' move=(' + r.move.x + ',' + r.move.y + ') ms=' + r.timeMs);

const middlegame = [[7, 7, 1], [7, 6, 2], [8, 7, 1], [6, 6, 2], [8, 8, 1], [6, 7, 2], [6, 5, 1], [9, 7, 2], [10, 7, 1], [5, 8, 2]];
for (const inc of [false, true]) {
  S.ttClear();
  const t0 = Date.now();
  const q = S.think(S.posFromBoard(boardOf(middlegame), BLACK), {
    difficulty: 'master', rule: 'freestyle', vcfDepth: inc ? 16 : 0, vctDepth: inc ? 12 : 0, avoidOpp: inc });
  console.log('  中局(master, 威胁搜索=' + inc + '): depth=' + q.depth + ' score=' + q.score +
    ' ms=' + q.timeMs + ' nodes=' + q.nodes + ' via=' + (q.via || '-'));
}

console.log('\n=== ② 强制杀命中率：纯搜索 vs 加了 VCF/VCT（自对弈生成的中局） ===');
const RU = require('../engine/rules.js');
function genMiddlegames(games, maxPly) {
  const out = [];
  for (let g = 0; g < games; g++) {
    const pos = core.createPosition(); S.attachCache(pos);
    for (let ply = 0; ply < maxPly; ply++) {
      if (ply >= 6) out.push({ board: pos.board.slice(), stm: pos.stm, ply: ply });
      S.ttClear();
      const m = S.think(pos, { maxDepth: 4, width: 10, hardLimit: 250, ttBits: 16 });
      if (!m || !m.move) break;
      core.makeMove(pos, m.move.x, m.move.y, pos.stm);
      if (RU.isWin(pos.board, m.move.x, m.move.y, core.opp(pos.stm))) break;
    }
  }
  return out;
}
const positions = genMiddlegames(24, 22);
let forced = 0, plyHist = {};
const stats = {};
for (const lvl of ['normal', 'hard']) stats[lvl] = { miss: 0, hit: 0, hitMs: 0 };
const samples = [];
for (const p of positions) {
  const w = TH.vcfWin(S.posFromBoard(p.board, p.stm), p.stm, { depth: 10, budget: 40000 });
  const v = w ? null : TH.vctWin(S.posFromBoard(p.board, p.stm), p.stm, { depth: 8, budget: 30000 });
  const win = w || v;
  if (!win) continue;
  forced++;
  plyHist[win.plies] = (plyHist[win.plies] || 0) + 1;
  for (const lvl of ['normal', 'hard']) {
    S.ttClear();
    const plain = S.think(S.posFromBoard(p.board, p.stm),
      { difficulty: lvl, rule: 'freestyle', vcfDepth: 0, vctDepth: 0, avoidOpp: false });
    const plainMate = Math.abs(plain.score) >= 99999000;
    S.ttClear();
    const t0 = Date.now();
    const withThreat = S.think(S.posFromBoard(p.board, p.stm), { difficulty: lvl, rule: 'freestyle' });
    const ms = Date.now() - t0;
    const threatMate = Math.abs(withThreat.score) >= 99999000;
    if (!plainMate) {
      stats[lvl].miss++;
      if (threatMate) { stats[lvl].hit++; stats[lvl].hitMs += ms; }
      if (samples.length < 6 && threatMate && lvl === 'normal') {
        samples.push('     [' + lvl + '] 纯搜索漏、VCF/VCT 补回：plies=' + win.plies + ' via=' + withThreat.via +
          ' move=(' + withThreat.move.x + ',' + withThreat.move.y + ') 含求解共 ' + ms + 'ms');
      }
    }
  }
}
console.log('  中局样本 ' + positions.length + ' 个，存在强制杀 ' + forced + ' 个');
console.log('  杀法长度分布（攻方手数）：' + JSON.stringify(plyHist));
for (const lvl of ['normal', 'hard']) {
  const s = stats[lvl];
  console.log('  [' + lvl + '] 纯搜索漏 ' + s.miss + ' 个 → VCF/VCT 补回 ' + s.hit + ' 个' +
    (s.hit ? '（累计 ' + s.hitMs + 'ms，均 ' + Math.round(s.hitMs / s.hit) + 'ms/步）' : ''));
}
if (samples.length) console.log(samples.join('\n'));
