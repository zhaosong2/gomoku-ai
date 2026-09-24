/* build.mjs — 合并为单文件 gomoku.html（M10，design §15 / §30）
 *
 *   node build.mjs                 → 生成 gomoku.html
 *   node build.mjs --out=x.html    → 指定输出
 *
 * 做法：读 index.html，把每个 <script src="..."> 替换为其**内联内容**，<style> 保持原样。
 *  · 引擎脚本按 index.html 的既有顺序内联（顺序与依赖一致，见 §30 注释）。
 *  · `engine/worker-src.js` 内联后，Worker 仍走 Blob（内容已在页面里，不额外取网）。
 *  · 结果：单个 .html，**file:// 可直开**（无 CORS/模块加载问题——全部经典 <script>）。
 *
 * ★ 纪律：本脚本**只做文本合并**，不改任何源码语义；产物必须再跑一次浏览器实跑（§34）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (k, d) => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const OUT = path.resolve(ROOT, getArg('out', 'gomoku.html'));
const SRC = path.join(ROOT, 'index.html');

let html = fs.readFileSync(SRC, 'utf8');
const inlined = [];
let missed = [];

// 逐个替换 <script src="..."> 为内联
html = html.replace(/<script\s+src="([^"]+)"><\/script>/g, (_m, rel) => {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { missed.push(rel); return _m; }
  const code = fs.readFileSync(file, 'utf8');
  inlined.push({ rel, bytes: Buffer.byteLength(code) });
  // 用 IIFE 包裹防止变量泄漏到全局（各模块本就自带 UMD 包裹，这里仅加一层保险）
  return '<script>\n/* ===== ' + rel + ' ===== */\n' + code + '\n</script>';
});

if (missed.length) {
  console.error('✗ 以下脚本未找到，无法内联：\n  ' + missed.join('\n  '));
  process.exit(1);
}

// 产物标注（便于识别与验收）
html = html.replace('</title>',
  '</title>\n<!-- 由 build.mjs 生成的单文件产物：' + new Date().toISOString() +
  ' 内联 ' + inlined.length + ' 个脚本 -->');

fs.writeFileSync(OUT, html, 'utf8');

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('✓ 已生成 ' + path.relative(ROOT, OUT));
console.log('  内联脚本 : ' + inlined.length + ' 个');
console.log('  产物体积 : ' + kb + ' KB');
console.log('  （源 index.html '
  + (fs.statSync(SRC).size / 1024).toFixed(1) + ' KB + 内联代码 '
  + (inlined.reduce((s, x) => s + x.bytes, 0) / 1024).toFixed(1) + ' KB）');
