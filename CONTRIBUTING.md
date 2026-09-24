# 贡献指南 (Contributing)

欢迎通过 Issue 与 Pull Request 参与改进。

## 开发约定

- **引擎层零 DOM 依赖**：`engine/` 下的代码必须能在浏览器与 Node 双跑（UMD 封装，挂载到全局 `G`，Node 走 `require`）。不要在引擎层引入 `document` / `window`。
- **新增引擎模块须同步三处**：
  1. `index.html` 的 `<script src="...">` 列表（顺序与依赖一致）；
  2. `tools/build-worker-src.js` 的 `FILES` 数组（决定 Worker 打包内容）；
  3. 依赖它的模块。
- **改 `engine/*` 后** 跑 `npm run build:worker` 重新生成 `engine/worker-src.js`；
  **改 `ui/*` 后** 跑 `npm run build` 重新生成 `gomoku.html`。
- **每轮改动建议在真实浏览器实跑一次**（开发壳 `index.html` 与单文件 `gomoku.html` 都要过），Node 单测发现不了"脚本漏挂"类问题。

## 测试

- 新功能请补 `test/*.test.js`（基于 Node 内置 `node:test`，零依赖）。
- 棋力相关改动须附自对弈 Elo 与 95% 置信区间；若 CI 含 0，不宣称棋力提升（见 `docs/optimization-plan.md` §17.2）。
- 运行全部测试：`npm test`。

## 提交

- 保持原子提交，提交信息说明**动机**而非仅写 "fix"。
- 避免提交临时探针脚本（`_` 前缀）、日志（`*.log`）与本地覆盖文件。

## 数据与许可证

- 开局库 / 杀题库基于构造数据 + 机器证明，可随仓库分发。
- 部分基准工具可加载 **RenjuNet** 数据集（非商业、仅离线使用），该数据**不随仓库分发**（见 `.gitignore`）。
