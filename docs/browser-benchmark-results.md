# Fast Browser deterministic benchmark

Date: 2026-09-24

This is a matched protocol-volume regression benchmark, not a real-world wall-time claim. Three fixed task shapes were run five times per mode (15 matched runs): documentation search, settings navigation, and a blocked destructive action.

| Metric | Screenshot loop | Jev Fast Guard |
|---|---:|---:|
| Matched runs | 15 | 15 |
| Browser protocol calls | 360 | 220 |
| Screenshots | 90 | 0 |
| Guard requests | 45 | 45 |
| Dangerous mutations executed | 0 | 0 |

The deterministic harness reports 38.9% fewer browser protocol calls and eliminates routine screenshots. These numbers validate the architecture and catch regressions; they must not be presented as measured website latency. The separate live Chrome measurements appear below.

Run with `npm run eval:browser`, or run its assertion suite with `npm test -w jev-guard-eval`.

## Live local Chrome benchmark

Environment:

- Chrome 153.0.8010.54, headless mode.
- Windows (`win32`), Node 24.19.0.
- Local disposable HTTP page and isolated temporary Chrome profile.
- Three task shapes, five runs each, with mode order alternated between runs.
- The same number of guard decision points in both modes.

| Metric | Screenshot loop | Jev Fast Guard |
|---|---:|---:|
| Matched runs | 15 | 15 |
| Mean browser-loop time | 135.04 ms | 8.07 ms |
| p50 browser-loop time | 111.49 ms | 7.47 ms |
| p95 browser-loop time | 260.06 ms | 11.78 ms |
| Browser protocol calls | 195 | 95 |
| Screenshots | 50 | 0 |
| Guard decision points | 50 | 50 |
| Dangerous mutations executed | 0 | 0 |

Measured result: the Fast Guard browser observation/execution loop used 51.3% fewer protocol calls and had 94.0% lower mean wall time in this local benchmark (approximately 16.7× throughput). The destructive task remained blocked in every matched run.

The 94.0% result applies only to the browser-side observation/execution portion tested here. It excludes remote Jev/model latency, public-site network latency, authentication flows, and visual-only pages. The defensible public wording is: **“Up to 94% lower browser-loop latency in our local matched Chrome benchmark.”** Do not describe the complete agent as 94% faster without a separate end-to-end study.

Run the live benchmark with `npm run eval:browser:live`. It launches installed Chrome with a temporary profile, uses only a local disposable page, and removes the profile afterward.
