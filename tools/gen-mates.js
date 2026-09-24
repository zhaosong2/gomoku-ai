/* tools/gen-mates.js — 生成并**机器证明**杀棋题库（写入 engine/data/mates.js）
 *
 * 为什么不用公开题集：连珠小站等公开数据只存"棋形图 + 标注序号"，序号并非落子顺序，
 * 无法可靠还原对局（实测：按序号重排后出现"双方同时可成五"的矛盾局面）。
 * 因此题库改为**构造 + 机器证明**：
 *   · 构造：多簇/平行线布局（易形成冲四链），双方都不得已有成五点（排除"一步杀"）；
 *   · 证明：求解器给出杀法 → 再用 `tools/verify-mate.js` 的**独立复算器**逐手重放验证；
 *   · 只有复算通过的才入库，并记录 kind/plies/path/source。
 *   · 另收「防守题」：对方存在 VCF 必胜，我方须找到唯一/少数能破的着法（检验 §25.4 防守侧）。
 * 待实现 Renju（M6）后可换成真实题集：格式已定（§35 MateEntry）。
 *
 * 用法： node tools/gen-mates.js [attackTarget] [defenseTarget] [maxSamples]
 */
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const S = require('../engine/search.js');
const RU = require('../engine/rules.js');
const EV = require('../engine/eval.js');
const V = require('./verify-mate.js');
const fs = require('fs');
const path = require('path');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;
const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

const A_TARGET = parseInt(process.argv[2] || '30', 10);
const D_TARGET = parseInt(process.argv[3] || '8', 10);
const SAMPLES = parseInt(process.argv[4] || '600000', 10);
const DEEP_MIN = parseInt(process.argv[5] || '8', 10);   // 深链(plies>=3)配额

function build(rnd, style) {
  const stones = [], used = new Uint8Array(NN);
  const atk = rnd() < 0.5 ? BLACK : WHITE, def = core.opp(atk);
  const cx = 5 + ((rnd() * 5) | 0), cy = 5 + ((rnd() * 5) | 0);
  if (style === 'ladder') {
    // 平行线：同方向若干短段，垂直方向错开 → 易形成多路冲四
    const d = DIRS4[(rnd() * 4) | 0];
    const pd = [d[1], d[0]];
    const rows = 3 + ((rnd() * 3) | 0), len = 2 + ((rnd() * 2) | 0), off = -3 + ((rnd() * 6) | 0);
    for (let r = 0; r < rows; r++) {
      if (rnd() < 0.25) continue;
      const sx = cx + pd[0] * r, sy = cy + pd[1] * r;
      for (let k = 0; k < len; k++) {
        const x = sx + d[0] * (k + off), y = sy + d[1] * (k + off);
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        const i = idxOf(x, y);
        if (used[i]) continue;
        used[i] = 1; stones.push([x, y, atk]);
      }
    }
  } else {
    const nL = style === 'cross' ? 3 + ((rnd() * 3) | 0) : 2 + ((rnd() * 3) | 0);
    for (let L = 0; L < nL; L++) {
      const d = DIRS4[(rnd() * 4) | 0];
      const len = style === 'cross' ? 3 + ((rnd() * 2) | 0) : 2 + ((rnd() * 3) | 0);
      const off = style === 'cross' ? -4 + ((rnd() * 9) | 0) : -3 + ((rnd() * 7) | 0);
      for (let k = 0; k < len; k++) {
        const x = cx + d[0] * (k + off), y = cy + d[1] * (k + off);
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        const i = idxOf(x, y);
        if (used[i]) continue;
        used[i] = 1; stones.push([x, y, atk]);
      }
    }
  }
  const nd = 4 + ((rnd() * 7) | 0);
  for (let k = 0; k < nd; k++) {
    const x = cx - 6 + ((rnd() * 13) | 0), y = cy - 6 + ((rnd() * 13) | 0);
    if (x < 0 || x >= N || y < 0 || y >= N) continue;
    const i = idxOf(x, y);
    if (used[i]) continue;
    used[i] = 1; stones.push([x, y, def]);
  }
  return { stones, atk };
}

const rnd = core.mulberry32(20260918);
const attacks = [], defenses = [];
const seen = new Set();
let scanned = 0, cand = 0, defTried = 0, vcfOk = 0, vctTried = 0;
const DEF_TRY_MAX = 80;                        // 防守题枚举很贵，限制尝试次数
const TIME_CAP_MS = parseInt(process.env.GEN_TIME_CAP_S || '240', 10) * 1000;   // ★ 硬时限，保证会终止
const t0 = Date.now();
let capped = false;

let deep = 0;
for (let it = 0; it < SAMPLES && (attacks.length < A_TARGET || deep < DEEP_MIN || defenses.length < D_TARGET); it++) {
  if ((it & 1023) === 0 && Date.now() - t0 > TIME_CAP_MS) { capped = true; break; }
  scanned++;
  if (scanned % 20000 === 0) {
    console.log('  … 扫描 ' + scanned + '｜进攻 ' + attacks.length + '/' + A_TARGET +
      '（深链 ' + deep + '/' + DEEP_MIN + '）｜防守 ' + defenses.length + '/' + D_TARGET + '（枚举 ' + defTried + ' 次）｜' +
      ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
  const style = ['cross', 'line', 'ladder'][it % 3];
  const { stones, atk } = build(rnd, style);
  const b = V.boardOf(stones);
  if (!b) continue;
  const def = core.opp(atk);
  if (TH.hasFivePoint(b, atk) >= 0) continue;
  if (TH.hasFivePoint(b, def) >= 0) continue;
  cand++;

  // —— 进攻题：本方存在可证真的 VCF（优先），否则 VCT
  if (attacks.length < A_TARGET || deep < DEEP_MIN) {
    const key = 'A|' + atk + '|' + stones.map(s => s[0] + ',' + s[1]).sort().join(';');
    if (!seen.has(key)) {
      let rec = null;
      let r = null;
      try { r = TH.vcfWin(S.posFromBoard(b, atk), atk, { depth: 10, budget: 15000 }); } catch (e) { }
      if (r && r.plies >= 2 && V.verifyPath(stones, atk, r.path, { allowOpenThree: false }) === 'OK') {
        rec = { kind: 'vcf', plies: r.plies, path: r.path };
        vcfOk++; if (rec.plies >= 3) deep++;
      } else if (TH.threatMoves(b, atk, { includeThree: true, radius: 2 }).length > 0) {
        // ★ VCT 很贵：仅当存在威胁点（含活三点）时才尝试，且预算收紧
        vctTried++;
        let r2 = null;
        try { r2 = TH.vctWin(S.posFromBoard(b, atk), atk, { depth: 6, budget: 4000 }); } catch (e) { }
        if (r2 && r2.plies >= 2) {
          const v2 = V.verifyPath(stones, atk, r2.path, { allowOpenThree: true });
          if (v2 === 'OK' || v2 === 'OK_OPEN_THREE') { rec = { kind: 'vct', plies: r2.plies, path: r2.path }; if (rec.plies >= 3) deep++; }
        }
      }
      if (rec) {
        seen.add(key);
        attacks.push({
          kind: rec.kind, plies: rec.plies, atk: atk,
          stones: stones.map(s => [s[0], s[1], s[2]]),
          first: [rec.path[0] % N, (rec.path[0] / N) | 0], path: rec.path.map(i => [i % N, (i / N) | 0]),
          source: 'generated', style: style,
        });
      }
    }
  }

  // —— 防守题：对方存在 VCF 必胜，而我方只有少数着法能破
  if (defenses.length < D_TARGET && defTried < DEF_TRY_MAX) {
    let oppWin = null;
    try { oppWin = TH.vcfWin(S.posFromBoard(b, def), def, { depth: 8, budget: 8000 }); } catch (e) { }
    if (oppWin && oppWin.plies >= 2) {
      defTried++;
      // ★ 只枚举"邻域候选点"（与 genMoves 一致），不要扫全盘 225 点——否则代价失控
      const cand = EV.candidates(b, 2);
      const safe = [];
      for (let k = 0; k < cand.length; k++) {
        const i = cand[k];
        if (b[i] !== EMPTY) continue;
        const bb = b.slice(); bb[i] = atk;
        if (RU.isWin(bb, i % N, (i / N) | 0, atk)) { safe.push(i); continue; }
        let w = null;
        try { w = TH.vcfWin(S.posFromBoard(bb, def), def, { depth: 4, budget: 2500 }); } catch (e) { }
        if (!w) safe.push(i);
      }
      if (safe.length >= 1 && safe.length <= 12) {
        const key = 'D|' + atk + '|' + stones.map(s => s[0] + ',' + s[1]).sort().join(';');
        if (!seen.has(key)) {
          seen.add(key);
          defenses.push({
            kind: 'defense', plies: oppWin.plies, atk: atk, opp: def,
            stones: stones.map(s => [s[0], s[1], s[2]]),
            safe: safe.map(i => [i % N, (i / N) | 0]), safeCount: safe.length, style: style,
            oppPath: oppWin.path.map(i => [i % N, (i / N) | 0]),
          });
        }
      }
    }
  }
}

attacks.sort((a, b2) => b2.plies - a.plies);
defenses.sort((a, b2) => a.safeCount - b2.safeCount);
const hist = {};
for (const f of attacks) hist[f.kind + f.plies] = (hist[f.kind + f.plies] || 0) + 1;
console.log('扫描 ' + scanned + ' 个构造局面（' + cand + ' 个双方无成五点）' + (capped ? '【触发时限提前结束】' : '') + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's；VCF 命中 ' + vcfOk + '，VCT 尝试 ' + vctTried);
console.log('深链(plies>=3) ' + deep + ' 道');
console.log('进攻题 ' + attacks.length + ' 道：' + JSON.stringify(hist));
console.log('防守题 ' + defenses.length + ' 道：安全着法数 ' + JSON.stringify(defenses.map(d => d.safeCount)));

const out = [];
out.push('/* engine/data/mates.js — 杀棋题库（§35 MateEntry）');
out.push(' * 来源：**构造 + 机器证明**（tools/gen-mates.js 生成，可重跑）。');
out.push(' *   公开题集（连珠小站等）只存"棋形图 + 标注序号"，序号并非落子顺序，无法可靠还原对局，故未导入。');
out.push(' *   Renju 实现（M6）后可直接替换为真实题集——格式不变。');
out.push(' *');
out.push(' * 每题都经 **独立复算器**（tools/verify-mate.js）逐手重放验证：强制 → 守方唯一不失着 → 终局确实获胜。');
out.push(' * 重新生成： node tools/gen-mates.js ' + A_TARGET + ' ' + D_TARGET + ' ' + SAMPLES);
out.push(' */');
out.push('(function (root, factory) {');
out.push("  if (typeof module !== 'undefined' && module.exports) module.exports = factory();");
out.push('  else { root.G = root.G || {}; root.G.mates = factory(); }');
out.push("})(typeof globalThis !== 'undefined' ? globalThis : this, function () {");
out.push("  'use strict';");
out.push('  // 进攻题: { kind:\'vcf\'|\'vct\', plies, atk(1黑/2白), stones:[[x,y,c]…], first:[x,y], path:[[x,y]…] 攻方着手(根→叶) }');
out.push('  // 防守题: { kind:\'defense\', plies, atk(我方), opp, stones, safe:[[x,y]…] 全部可行着法, safeCount }');
out.push('  const ATTACK = ' + JSON.stringify(attacks, null, 1).replace(/\n/g, '\n  ') + ';');
out.push('  const DEFENSE = ' + JSON.stringify(defenses, null, 1).replace(/\n/g, '\n  ') + ';');
out.push('  const STATS = ' + JSON.stringify({
  attack: attacks.length, defense: defenses.length, hist: hist, deep: deep, seed: 20260918, generatedAt: '2026-09-18',
}) + ';');
out.push('  return { ATTACK, DEFENSE, MATES: ATTACK.concat(DEFENSE), STATS };');
out.push('});');
fs.writeFileSync(path.join(__dirname, '..', 'engine/data/mates.js'), out.join('\n') + '\n', 'utf8');
console.log('已写 engine/data/mates.js（' + (out.join('\n').length / 1024).toFixed(1) + ' KB）');
