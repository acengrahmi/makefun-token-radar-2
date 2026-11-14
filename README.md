# Token Radar (radar-3) — make.fun token-radar-01 entry

A token launch radar: `main.ts` (Node 22, standard library only) reads the sealed
snapshot at `/input/snapshot.json`, prices every pre-token protocol from the snapshot's
own traded comparables, and writes a ranked board (`/output/board.json`), the dashboard
and its data (`/output/dashboard/`, `/output/data.js`), three screenshots, and
`/output/dossier.json` via the kit's vendored `makefun-board.ts`.

The model in one line: implied value = TVL × the shrunk median market-cap/TVL multiple
of the protocol's category (from the 128 snapshot protocols whose tokens already trade
at a measurable cap), adjusted for 7-day TVL momentum, tokenless maturity, chain reach
and category capture — with a low–high range from the comparables' P25–P75 band, a
0–100 audit score from six in-board percentiles, data-derived risk flags, and an
eight-step farm plan per protocol.

Run it: `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`
