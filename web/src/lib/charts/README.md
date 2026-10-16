# SVG chart API

Import components from `#lib/charts/index.ts`, or directly from their `.svelte` file.
Every chart requires `label` and `description` strings supplied by the localized caller.
These become the SVG's accessible name, `<title>` and `<desc>`. There is no animation,
audio acquisition, transport access, application state or automatic write in a chart.

| Component        | Data props                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ResponseChart`  | `curve: { bands, preampDb }`; optional `minDb`, `maxDb`, `tickStepDb`, `locale`, `eqLabel`, `outputLabel`, `theme`        |
| `MiniCurve`      | `curve`; optional `minDb`, `maxDb`, `color`                                                                               |
| `PoleZeroPlot`   | `bands`; optional `locale`                                                                                                |
| `ByteMap`        | `curve`; optional zero-based `selectedSection` for the five-word zoom                                                     |
| `ReportTimeline` | `curve`; optional localized `commitLabel`                                                                                 |
| `PolarDiagram`   | `curve`; include the open-loop / not-a-Nyquist-stability-test caveat in `description` and the surrounding caption         |
| `ErrorHeatMap`   | `rows: number[][]` of signed fit-minus-target dB, `rowLabels`; optional `grid` (default core `GRID`), `limitDb`, `locale` |
| `WiggleTrace`    | `values: number[]` of actual samples or residuals; optional symmetric `range`                                             |

Response EQ/output use core `curveResponseDb` (nominal preamp included in output).
The complex-plane diagrams use core `sectionAnalysis` and its actual Q27 words;
the polar diagram uses core `sectionDb` and `quantizedPreampDb`. Only the phase
projection (not exposed by core) and quadratic-root coordinates are chart-specific.
Payload bytes and report frames come from core `encodePayload` / `reportsFromPayload`.
The timeline shows nominal delays, not measured USB/flash completion: 9 × 16 + 150 = 294 ms.

Pure geometry modules are independently importable without Svelte:

- `scales.ts`: `logScale`, `dbScale`, `dbTicks`, `linePath`, number/frequency labels.
- `response.ts`: `responseGeometry`, `miniCurvePath`, `Curve`, `Band`.
- `protocol.ts`: `payloadRegions`, `reportTimeline`, `hexBytes`, word/timing constants.
- `plane.ts`: `poleZeroGeometry`, `polarResponse`, `polarGeometry`, `PolarSample`.
- `diagnostics.ts`: `curveErrors`, `errorHeatGeometry`, `wiggleGeometry`.

`ChartFrame` counter-scales text to ≥11 CSS px desktop / ≥10 CSS px mobile, even
when SVGs shrink. `theme` is `scope`, `paper` or `cable`. Sparse mobile tick labels
avoid collisions; full numeric data remains in SVG descriptions/tooltips.
