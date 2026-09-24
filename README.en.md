# Gomoku / Renju AI Engine

> A zero-dependency, browser-based **Gomoku (Five-in-a-Row)** engine with a strong AI.
> Supports both **Freestyle** (no forbidden points) and **Renju** (forbidden-point) rules,
> plus kifu reading, multi-candidate hints, position judgement, an opening book and a
> machine-proven mate problem set.
>
> **中文说明：** 本文档为英文版，[中文 README](../README.md) 见仓库根目录。双击 `gomoku.html` 即可游玩
> （`file://` 下可用）。引擎为纯逻辑层（无 DOM），浏览器与 Node 双跑。完整技术规格见
> [`docs/design.md`](docs/design.md) (v3.41)，工程里程碑与基准见 [`docs/optimization-plan.md`](docs/optimization-plan.md)。
>
> **English abstract:** Pure-frontend, dependency-free Gomoku AI. Double-click `gomoku.html`
> to play (works under `file://`). The engine is plain logic (no DOM), runs in both the
> browser and Node. See `docs/design.md` for the full technical spec (v3.41) and
> `docs/optimization-plan.md` for milestones & benchmarks.

---

## Features

- **Pure frontend · zero dependency · single file**: Double-click `gomoku.html` to play. Works under `file://` — no server, no install.
- **Dual rulesets**: Forbidden-free **Freestyle** / forbidden-point **Renju** (overline / double-four / double-three; five-in-a-row wins; both RIF and strict overline interpretations supported).
- **Strong search**: Negamax + αβ + PVS + iterative deepening + aspiration windows + transposition table (with age bits and ruleset-salt isolation) + LMR + killer/history heuristics + quiescence search + time-budget tiered degradation (L0→L1→L2→L3; never misses a forced win/loss).
- **Forced win**: **VCF / VCT** proof search (a five-forming point that cannot be blocked with ≥2 defenders is declared a win; living-three neutral-point sets are verified — better to miss than to report a false win).
- **Opening book**: 26 official openings, prefix-match tree (based on real RenjuNet games, with win/loss information).
- **Mate puzzles**: Machine-independently-proven attack / defense problems (30 attack + 8 defense); both engine strength and defense mechanisms have threshold tests.
- **Kifu**: Reading (SGF / coordinate notation), in-game kifu panel, replay (with a time-usage curve, played back at the original pace).
- **Hints**: Multiple candidates + scoring + position judgement (win-rate estimate).
- **4 difficulty levels**: easy / normal / hard / master (search depth, VCF/VCT depth, and time budget individually calibrated).
- **UI**: Human-vs-AI / Human-vs-Human, undo, forbidden-point marking, move-order badges, mobile / touch support.
- **Worker architecture**: Blob Worker (works under `file://`), with a main-thread fallback; late handshake takeover and stale results dropped by generation tokens.

---

## Quick Start

| Goal | Action |
| --- | --- |
| **Play now** | Open [`gomoku.html`](gomoku.html) in a browser (double-click; zero dependency) |
| Dev mode | Serve this directory with any static server and visit `index.html` (e.g. `npx serve` / `python -m http.server`) |
| Build single file | `npm run build` → regenerate `gomoku.html` |
| Repack Worker | `npm run build:worker` → regenerate `engine/worker-src.js` |
| Run tests | `npm test` |
| Elo benchmark | `npm run bench:elo` |

> Note: `index.html` is the **dev shell** that loads modules separately (easier to debug); `gomoku.html` is the **single-file build** produced by `build.mjs`. They are functionally identical — use the built file for release / double-click play.

---

## Project Layout

```
gomoku-ai/
├── index.html            # Dev shell (modular loading, easier to debug)
├── gomoku.html           # Single-file build (double-click to play, releasable)
├── build.mjs             # Inlines index.html modules into a single file
├── engine/               # AI engine (search / eval / rules / opening book / mates / Worker entry)
│   ├── core.js           # Board state, move/undo, incremental cache hooks
│   ├── patterns.js       # Shape recognition, scoring tables, forbidden-point detection
│   ├── rules.js          # Win/loss / forbidden-point adjudication
│   ├── eval.js           # Static position evaluation (side-to-move aware, mover's perspective)
│   ├── search.js         # Search (Negamax+αβ+PVS+TT+LMR+quiescence+time-budget degradation)
│   ├── threat.js         # VCF / VCT threat criteria
│   ├── operators.js      # Operator-based threat enumeration
│   ├── book.js           # Opening book (parse / index / query)
│   ├── record.js         # Kifu data layer
│   ├── coach.js          # Hints / position judgement
│   ├── worker-entry.js   # Worker router
│   ├── worker-src.js     # ★ auto-generated: Worker bundle (do NOT edit by hand)
│   └── data/             # Opening book / mate puzzles / 26-opening definitions
├── ui/                   # UI layer (render / interaction / kifu panel / hints / touch)
├── test/                 # Unit tests (node:test, 309 cases total)
├── tools/                # Build / benchmark / generate / verify tools
├── docs/                 # Design docs and optimization plan
│   ├── design.md         # Full technical design (v3.41)
│   └── optimization-plan.md  # Engineering milestones & benchmarks (v1.4)
└── assets/               # Screenshots
```

---

## Architecture

- **Engine is a pure-logic layer**: `engine/` does not depend on the DOM and runs in both the browser (classic `<script>` exposing global `G`) and Node (`require`). The same code searches on the page and is verified under `node --test` and `tools/`.
- **Search**: See `docs/design.md` §5 / §24 (PVS, aspiration windows, IID, LMR, three-state transposition table, root PV reuse, ruleset-salt isolation).
- **Evaluation**: §4 (shape scoring tables, side-to-move and reference frame, forbidden points as score penalties rather than hard bans).
- **Rules**: §7 (forbidden-free / forbidden-point split), §8 (forbidden-point detection, five-in-a-row priority).
- **Opening book**: §12 (26 openings + prefix-match tree); **VCF/VCT**: §6; **Worker protocol**: §28.
- **Full spec**: [`docs/design.md`](docs/design.md) (v3.41); **engineering milestones / benchmarks / honest conclusions**: [`docs/optimization-plan.md`](docs/optimization-plan.md).

---

## Honesty Notes on Strength & Difficulty

This project follows a **measure-don't-claim** principle for "strength gains": every enhancement is validated by self-play **Elo + 95% confidence interval**; when the CI contains 0, no strength gain is claimed. For example, VCF/VCT reduces mate-delay by more than 10× with no visible improvement in detection rate, while a 30-game self-play Elo was +11.6 (CI [−112.8, +136.0]) — so no strength gain is claimed. See `docs/optimization-plan.md` §17.2.

---

## Data & License

- The opening book / mate puzzles are based on **constructed data + machine proof**, and may be distributed with the repository.
- Some benchmark tools (`tools/against*.js`, `tools/bench-book-pos.js`, etc.) can load the **RenjuNet** dataset; that dataset is **non-commercial and for offline use only**, is restricted by its source license, and is **NOT distributed with this repository** (see `.gitignore`).
- This repository is open-sourced under the **MIT License** (see [`LICENSE`](LICENSE)).

---

## Tests

`npm test` runs `test/*.test.js` (built on Node's built-in `node:test`, zero dependency). It is recommended to run after engine changes, and to play a real game in a browser once.

---

## Roadmap

- NNUE / WASM acceleration (M11, candidate)
- Bitboard (M3c, candidate)
- Difficulty DIFFICULTY recalibration (M9, candidate)
- Real Renju problem set integration (replacing the constructed puzzles, format unchanged)

See the "Optional Follow-ups" section of `docs/optimization-plan.md`.
