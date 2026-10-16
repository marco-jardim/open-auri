# Worker API

```ts
import { createGateWorker, createSolverWorker } from '#lib/workers/index.ts';

const gate = createGateWorker();
const drag = await gate.drag({
	bands,
	preampDb,
	bandIndex: 0,
	param: 'gainDb',
	from: 2,
	to: 12,
	experimental: false
});
// drag.value / drag.bands are accepted on the advisory drag grid, after snapping.
// drag.firstRefused and drag.reasons describe the first tested refused candidate.
const confirmation = await gate.commit({ bands: drag.bands, preampDb });
// confirmation.verdict is the complete gateForWrite result (always full grid).
gate.dispose();

const solver = createSolverWorker();
const solution = await solver.solve({
	points: [
		{ freqHz: 20, gainDb: -2 },
		{ freqHz: 20000, gainDb: 0 }
	],
	options: { maxTimeMs: 1200, maxIterations: 400 }
});
// Alternatively solve({ options: { target, grid, ... } }).
const target = await solver.target({ points, grid });
solver.dispose();
```

Both clients expose `request(input, { id?, signal? })`, `cancel(id?)`, `dispose()`.
Convenience methods take the same request options as their second argument.
Each response echoes its `id` and discriminating `type`. Latest request wins:
superseded, cancelled or aborted promises reject with `AbortError`. Cancellation
terminates a busy worker, because synchronous core work cannot process a cancel
message mid-execution. A later request lazily creates another module worker.
Worker-side queued requests are also coalesced/cancelled by ID, and late replies
cannot overwrite a newer result. Use separate clients for independent jobs.

No worker is instantiated until the first request. With no global `Worker` (SSR),
or `{ worker: false }` (tests), the same pure handler runs synchronously and its
result is delivered through a Promise. This fallback does not offer interactive
main-thread performance; browser interaction should use the default worker mode.
`workerFactory` is an optional test injection point.

Wire requests are `GateRequest` / `SolverRequest`; cancellation is
`{ type: 'cancel', id }`. Wire replies are `{ id, ok: true, result }` or
`{ id, ok: false, error }`. There are no progress messages. `maxTimeMs` and all
serializable solver options pass unchanged to core. Function-valued `clock` is
intentionally excluded from the worker input type.

`handleGateRequest` and `handleSolverRequest` are pure, DOM-free exports from their
`*-handler.ts` modules. Drag requires an accepted `from` state and an active band;
it uses core `boundarySearch`, `interpolateBand`, `snapToGridAccepted` and rechecks
the snapped result. Rejected starting states are errors, not fabricated approvals.
Commit is validation only: actual writes still belong exclusively to the core
transport, which must revalidate its own snapshot with `gateForWrite`.
