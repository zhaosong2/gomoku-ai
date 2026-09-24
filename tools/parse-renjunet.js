/* tools/parse-renjunet.js — 解析 RenjuNet 对局数据库（XML）→ 结构化棋谱
 *
 * 数据源：https://www.renju.net/game/download/xml/  （gzip 压缩包，解压后约 7 MB XML）
 *   下载：curl -sSL "https://www.renju.net/game/download/" -o renjunet.gz && gunzip renjunet.gz
 *
 * 结构（实测 2026-09-18 版）：
 *   <game id="1" ... opening="21" alt="i8" swap="R" rule="1" bresult="0.5">
 *     <move>h8 h9 h7 h6 i9 g7 f8 ...</move>      ← ★ **落子顺序**坐标串（空格分隔）
 *   </game>
 *   另有 <country> <city> <player> <tournament> <opening> <rule> <month> 等字典表。
 *
 * ★ 与旧题源（iwzq 习题帖）的根本区别：旧源给的是"图面扫描顺序 + 手数编号"，
 *   编号并非落子顺序，无法可靠还原；**本数据库直接给落子顺序**，可以直接重放。
 *
 * 坐标口径（与 openings.js 一致）：小写列 a–o → x = code-97；行 1–15 自下而上 → y = 15-row。
 *   故 h8 → (7,7) = 天元。
 *
 * ⚠ 许可（数据库文件头明示，务必遵守）：
 *   "It is allowed to use this database for non-commercial purposes in the forms of OFFLINE databases only.
 *    It is forbidden to use any contents of this database or its modifications in any website or ONLINE system."
 *   ⇒ **仅限离线 / 非商业**；不得把本库内容或其衍生品用于任何**在线系统/网站**。
 *   本脚本只做离线解析与统计；是否把产物嵌入在线产品须另行判断。
 *
 * 用法：node tools/parse-renjunet.js <xml或gz解压后的xml路径> [输出json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, '..', 'engine', 'data', 'renjunet-games.json');
if (!SRC) { console.error('用法: node tools/parse-renjunet.js <xml路径> [输出json]'); process.exit(1); }

const xml = fs.readFileSync(SRC, 'utf8');

/* ---------- 字典表 ---------- */
function dict(tag, keyAttr) {
  const m = {};
  const re = new RegExp('<' + tag + '\\s+[^>]*' + keyAttr + '="(\\d+)"[^>]*name="([^"]*)"', 'g');
  let x;
  while ((x = re.exec(xml))) m[x[1]] = x[2];
  // 部分表用 abbr 而非 name
  const re2 = new RegExp('<' + tag + '\\s+[^>]*' + keyAttr + '="(\\d+)"[^>]*abbr="([^"]*)"', 'g');
  while ((x = re2.exec(xml))) if (!m[x[1]]) m[x[1]] = x[2];
  return m;
}
const OPENINGS = dict('opening', 'id');
const RULES = dict('rule', 'id');
const PLAYERS = (function () {
  const m = {};
  const re = /<player\s+id="(\d+)"[^>]*?name="([^"]*)"/g;
  let x; while ((x = re.exec(xml))) m[x[1]] = x[2];
  return m;
})();

/* ---------- 对局 ---------- */
const toXY = s => {
  const col = s.charCodeAt(0) - 97;              // a→0
  const row = parseInt(s.slice(1), 10);
  if (!(col >= 0 && col < 15) || !(row >= 1 && row <= 15)) return null;
  return [col, 15 - row];                        // h8 → [7,7]
};

const games = [];
const re = /<game\s+([^>]*)>\s*<move>([\s\S]*?)<\/move>\s*<\/game>/g;
let g, bad = 0, noMove = 0;
while ((g = re.exec(xml))) {
  const attrs = g[1];
  const get = k => { const m = attrs.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : null; };
  const raw = g[2].trim();
  if (!raw) { noMove++; continue; }
  const toks = raw.split(/\s+/);
  const moves = [];
  let ok = true;
  for (const t of toks) { const p = toXY(t); if (!p) { ok = false; break; } moves.push(p); }
  if (!ok || moves.length < 5) { bad++; continue; }
  games.push({
    id: +get('id'),
    rule: +get('rule'),
    opening: +get('opening'),
    openingName: OPENINGS[get('opening')] || null,
    black: +get('black'), white: +get('white'),
    blackName: PLAYERS[get('black')] || null,
    whiteName: PLAYERS[get('white')] || null,
    bresult: get('bresult') === null ? null : +get('bresult'),   // 1 黑胜 / 0 黑负 / 0.5 和
    alt: get('alt'), swap: get('swap'),
    moves,
  });
}

/* ---------- 统计 ---------- */
const byRule = {}, byOpening = {}, lenHist = {};
for (const x of games) {
  byRule[RULES[x.rule] || x.rule] = (byRule[RULES[x.rule] || x.rule] || 0) + 1;
  const nm = x.openingName || ('#' + x.opening);
  byOpening[nm] = (byOpening[nm] || 0) + 1;
  const b = Math.floor(x.moves.length / 10) * 10;
  lenHist[b] = (lenHist[b] || 0) + 1;
}
const topOpenings = Object.entries(byOpening).sort((a, b) => b[1] - a[1]).slice(0, 15);

console.log('=== RenjuNet 数据库解析 ===');
console.log('  对局总数（可解析）: ' + games.length + '   跳过: 无着法 ' + noMove + ' / 非法或过短 ' + bad);
console.log('');
console.log('  按规则:');
for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log('    ' + k.padEnd(22) + v);
console.log('');
console.log('  棋谱长度分布（手数区间 → 局数）:');
for (const k of Object.keys(lenHist).map(Number).sort((a, b) => a - b))
  console.log('    ' + String(k).padStart(3) + '-' + String(k + 9).padStart(3) + ' 手: ' + lenHist[k]);
console.log('');
console.log('  开局分布 Top15:');
for (const [k, v] of topOpenings) console.log('    ' + k.padEnd(14) + v);

fs.writeFileSync(OUT, JSON.stringify({
  source: 'https://www.renju.net/game/download/xml/',
  parsedAt: new Date().toISOString(),
  license: 'OFFLINE / non-commercial only — see source header',
  dicts: { openings: OPENINGS, rules: RULES },
  games,
}));
console.log('');
console.log('  已写出: ' + OUT + '  (' + (fs.statSync(OUT).size / 1048576).toFixed(2) + ' MB)');
