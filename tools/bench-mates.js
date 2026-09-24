/* tools/bench-mates.js — 题库通过率 × 时限/深度扫描
 * 目的：找出"威胁搜索真正体现出价值"的工作点。
 *   纯搜索的杀棋能力受**深度**限制；VCF/VCT 是**深度无关**的（只要链长在预算内）。
 *   因此在**极限时限**或**浅深度**下，两者的差距才应显现。
 */
const V = require('./verify-mate.js');
const SEARCH = require('../engine/search.js');
const M = require('../engine/data/mates.js');

function rate(cfg) {
  let pass = 0;
  const fails = [];
  for (let k = 0; k < M.ATTACK.length; k++) {
    const p = M.ATTACK[k];
    let ok = false;
    if (cfg.vcfDepth) {
      ok = V.solveAndVerify(p.stones, p.atk, {
        vcfDepth: cfg.vcfDepth, vcfBudget: 60000, vctDepth: cfg.vctDepth || 6, vctBudget: 40000,
      }).ok;
    }
    if (!ok) {
      SEARCH.ttClear();
      const q = SEARCH.think(SEARCH.posFromBoard(V.boardOf(p.stones), p.atk), cfg);
      ok = !!q && Math.abs(q.score) >= 99999000;
    }
    if (ok) pass++; else fails.push(k + '(' + p.kind + p.plies + ')');
  }
  return { pass: pass, total: M.ATTACK.length, fails: fails };
}

const rows = [];
const cases = [
  { name: '困难·每手 30ms·无威胁搜索', cfg: { difficulty: 'hard', hardLimit: 30, vcfDepth: 0, vctDepth: 0, avoidOpp: false } },
  { name: '困难·每手 30ms·有威胁搜索', cfg: { difficulty: 'hard', hardLimit: 30, vcfDepth: 12, vctDepth: 8, avoidOpp: true, threatMs: 30 } },
  { name: '困难·每手 60ms·无威胁搜索', cfg: { difficulty: 'hard', hardLimit: 60, vcfDepth: 0, vctDepth: 0, avoidOpp: false } },
  { name: '困难·每手 60ms·有威胁搜索', cfg: { difficulty: 'hard', hardLimit: 60, vcfDepth: 12, vctDepth: 8, avoidOpp: true, threatMs: 60 } },
  { name: '简单(深度3)·有威胁搜索', cfg: { difficulty: 'easy', vcfDepth: 12, vctDepth: 8, avoidOpp: true } },
  { name: '简单(深度3)·无威胁搜索', cfg: { difficulty: 'easy', vcfDepth: 0, vctDepth: 0, avoidOpp: false } },
  { name: '中等(深度5)·无威胁搜索', cfg: { difficulty: 'normal', vcfDepth: 0, vctDepth: 0, avoidOpp: false } },
  { name: '中等(深度5)·有威胁搜索', cfg: { difficulty: 'normal', vcfDepth: 12, vctDepth: 8, avoidOpp: true } },
  { name: '困难(默认 2s)·无威胁搜索', cfg: { difficulty: 'hard', vcfDepth: 0, vctDepth: 0, avoidOpp: false } },
  { name: '困难(默认 2s)·有威胁搜索', cfg: { difficulty: 'hard' } },
];
for (const c of cases) {
  const t0 = Date.now();
  const r = rate(c.cfg);
  rows.push({ name: c.name, pass: r.pass, total: r.total, ms: Date.now() - t0, fails: r.fails });
}
console.log('题库通过率扫描（进攻题 ' + M.ATTACK.length + ' 道；链长分布 ' + JSON.stringify(M.STATS.hist) + '）\n');
for (const r of rows) {
  const pct = (100 * r.pass / r.total).toFixed(0);
  console.log('  ' + r.name.padEnd(26) + ' ' + String(r.pass).padStart(2) + '/' + r.total + '  ' +
    String(pct).padStart(3) + '%  ' + String(r.ms).padStart(6) + 'ms' +
    (r.fails.length ? '   漏: ' + r.fails.slice(0, 8).join(' ') : ''));
}
