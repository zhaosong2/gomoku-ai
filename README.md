# 五子棋人机对战引擎 · Gomoku / Renju AI

> A zero-dependency, browser-based **Gomoku (Five-in-a-Row)** engine with a strong AI.
> Supports both **Freestyle** (no forbidden points) and **Renju** (forbidden-point) rules,
> plus kifu reading, multi-candidate hints, position judgement, an opening book and a
> machine-proven mate problem set.
>
> **English abstract:** Pure-frontend, dependency-free Gomoku AI. Double-click `gomoku.html`
> to play (works under `file://`). Engine is plain-logic (no DOM), runs in browser and Node.
> See `docs/design.md` for the full technical spec (v3.41) and `docs/optimization-plan.md` for
> milestones & benchmarks.

---

## 特性 (Features)

- **纯前端 · 零依赖 · 单文件**：双击 `gomoku.html` 即玩，`file://` 下可用，无需服务器、无需安装。
- **双规则**：无禁手 **Freestyle** / 有禁手 **Renju**（长连 / 四四 / 三三禁手，五连优先，支持 RIF 与 strict 两种长连判定）。
- **高棋力搜索**：Negamax + αβ + PVS + 迭代加深 + 渴望窗 + 置换表（含代龄与规则盐隔离）+ LMR + killer/history 启发 + 静态搜索 + 时限分级降级（L0→L1→L2→L3，绝不错过必胜/必败）。
- **强制取胜**：**VCF / VCT** 证明式搜索（成五点 ≥2 封不住即判胜；活三节点中和点集校验，宁漏不假）。
- **开局库**：26 种指定开局，前缀匹配树（基于 RenjuNet 真实对局，含胜负信息）。
- **杀棋题库**：机器独立证明的进攻 / 防守题（30 进攻 + 8 防守），引擎能力与防守机制均有门槛测试。
- **棋谱**：读谱（SGF / 坐标记谱）、对局中棋谱面板、回放（含用时曲线、按原用时播放）。
- **提示**：多候选 + 打分 + 形势判断（胜率估计）。
- **4 档难度**：easy / normal / hard / master（搜索深度、VCF/VCT 深度、时限分别标定）。
- **界面**：人机 / 人人、悔棋、禁手点标注、落子顺序徽标、移动端 / 触屏支持。
- **Worker 架构**：Blob Worker（`file://` 下可用），主线程兜底；握手晚到接管、过期结果按世代令牌丢弃。

---

## 快速开始 (Quick Start)

| 目的 | 操作 |
| --- | --- |
| **直接玩** | 用浏览器打开 [`gomoku.html`](gomoku.html)（双击即可，零依赖） |
| 开发模式 | 用任意静态服务器托管本目录，访问 `index.html`（如 `npx serve` / `python -m http.server`） |
| 构建单文件 | `npm run build`  → 重新生成 `gomoku.html` |
| 重打包 Worker | `npm run build:worker` → 重新生成 `engine/worker-src.js` |
| 运行测试 | `npm test` |
| 棋力基准 | `npm run bench:elo` |

> 提示：`index.html` 是分模块加载的**开发壳**，`gomoku.html` 是 `build.mjs` 合并出的**单文件成品**；二者功能一致，发布 / 双击游玩用成品。

---

## 目录结构 (Project Layout)

```
gomoku-ai/
├── index.html            # 开发壳（分模块加载，便于调试）
├── gomoku.html           # 单文件成品（双击即玩，可发布）
├── build.mjs             # 把 index.html 内联合并为单文件
├── engine/               # AI 引擎（搜索 / 评估 / 规则 / 开局库 / 杀法 / Worker 入口）
│   ├── core.js           # 棋盘状态、落子/悔棋、增量缓存钩子
│   ├── patterns.js       # 棋型识别、评分表、禁手判定
│   ├── rules.js          # 胜负 / 禁手裁决
│   ├── eval.js           # 局面静态评估（手番感知、走子方视角）
│   ├── search.js         # 搜索（Negamax+αβ+PVS+TT+LMR+静态搜索+时限降级）
│   ├── threat.js         # VCF / VCT 威胁判据
│   ├── operators.js      # 算子化威胁枚举
│   ├── book.js           # 开局库（解析 / 索引 / 查询）
│   ├── record.js         # 棋谱数据层
│   ├── coach.js          # 提示 / 形势判断
│   ├── worker-entry.js   # Worker 路由
│   ├── worker-src.js     # ★ 自动生成：Worker 打包源码（请勿手工编辑）
│   └── data/             # 开局库 / 杀题库 / 26 开局定义
├── ui/                   # 界面层（渲染 / 交互 / 棋谱面板 / 提示 / 触屏）
├── test/                 # 单元测试（node:test，共 309 项）
├── tools/                # 构建 / 基准 / 生成 / 验证工具
├── docs/                 # 设计文档与优化计划
│   ├── design.md         # 完整技术设计（v3.41）
│   └── optimization-plan.md  # 工程里程碑与基准（v1.4）
└── assets/               # 截图
```

---

## 架构简述 (Architecture)

- **引擎为纯逻辑层**：`engine/` 不依赖 DOM，浏览器（经典 `<script>` 挂全局 `G`）与 Node（`require`）双跑，因此同一份代码既能在页面里搜索，也能在 `node --test` 与 `tools/` 里被验证。
- **搜索**：见 `docs/design.md` §5 / §24（PVS、渴望窗、IID、LMR、置换表三态、根层 PV 复用、规则盐隔离）。
- **评估**：§4（棋型评分表、手番与参考系、禁手=打分惩罚而非禁止）。
- **规则**：§7（无禁手 / 有禁手分离）、§8（禁手判定，五连优先）。
- **开局库**：§12（26 开局 + 前缀匹配树）；**VCF/VCT**：§6；**Worker 协议**：§28。
- **完整规格**：[`docs/design.md`](docs/design.md)（v3.41）；**工程里程碑 / 基准 / 诚实结论**：[`docs/optimization-plan.md`](docs/optimization-plan.md)。

---

## 规则与难度的诚实说明 (Honesty Notes)

本项目对"棋力提升"采取**实测不声称**原则：每一项增强都经过自对弈 **Elo + 95% 置信区间**验证；
当 CI 含 0 时不宣称强度提升。例如 VCF/VCT 把杀棋延迟降低 10 倍以上、发现率无可见提升，
而 30 局自对弈 Elo 为 +11.6（CI [−112.8, +136.0]）——故不声称棋力提升。详见 `docs/optimization-plan.md` §17.2。

---

## 数据与许可证 (Data & License)

- 开局库 / 杀题库基于**构造数据 + 机器证明**，可随仓库分发。
- 部分基准工具（`tools/against*.js`、`tools/bench-book-pos.js` 等）可加载 **RenjuNet** 数据集；
  该数据集**非商业、仅离线使用**，受来源许可限制，**不随本仓库分发**（见 `.gitignore`）。
- 本仓库以 **MIT 许可证**开源（见 [`LICENSE`](LICENSE)）。

---

## 测试 (Tests)

`npm test` 运行 `test/*.test.js`（基于 Node 内置 `node:test`，零依赖）。建议在修改引擎后运行，并在真实浏览器实跑一次。

---

## 路线图 (Roadmap)

- NNUE / WASM 加速（M11，候选）
- 位棋盘（M3c，候选）
- 难度 DIFFICULTY 复标定（M9，候选）
- 真实 Renju 题集接入（替换构造题库，格式不变）

详见 `docs/optimization-plan.md` 的"可选后续"。
