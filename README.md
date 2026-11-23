[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vnz347/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vnz347/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Fast site generator

A faster drop-in for [make.fun](https://make.fun)'s own makefun-site 1.0.0,
written for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. It answers exactly as makefun-site 1.0.0 does on every case — the same
output tree, byte for byte: every page's `index.html`, the index and tag pages,
`build-report.txt`, and every static file — and does it about 4.5x faster than
the reference on the practice set (measured CPU time, warmed, both run beside
each other on the same machine: 109 ms against 496 ms across the three cases).

## How it is faster

The reference splits every body into lines, walks each line, and renders every
template from its tree on every page. This one never does that where a cheaper
shape does it instead:

- The Markdown reader works on spans of the body, never splitting it into
  lines: a paragraph whose lines need no trimming is one slice, and a fence's
  body is one slice, escaped once.
- Inline rendering scans with a lookup table and copies plain text in whole
  slices, with HTML escaping fused into the scan; emphasis and link closers
  are found with the native `indexOf`, and only a candidate with a backslash
  before it needs the escape-parity check.
- Templates compile to JavaScript functions once per case, and a template
  whose output depends only on build-constant values is rendered once and
  reused; one that depends on a single variable is memoised on that variable.
  Cyclic include sets are never memoised.
- Word counts, slugs and link targets are cached per case (each case answered
  alone, nothing carried from one case to the next), and card tag views and
  post link records are built once and shared.
- The driver turns V8's incremental marking off and runs the optimising
  compiler on the main thread, which matters in a one-CPU container where the
  background optimiser thread only steals time from the build.

## Correctness

Byte-identical answers against makefun-site 1.0.0 on the practice set (3
cases), on 18 further generated cases from six other seeds, and on 31
hand-written edge cases covering the front-matter grammar (every refusal
reason), the Markdown subset (fences, lists, quotes, headings, emphasis, links,
raw HTML), CRLF and CR line endings, unicode slugs and collisions, cyclic and
deep includes, shadowed statics, pagination, and template dialect corners.

## Run it

Node 22 or later, nothing to install:

```sh
node main.ts
```

The harness runs `node /bot/main.ts`. It reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`, and
writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Layout

- `solve.js` — the generator: a dependency-free ES module whose `run(input)`
  returns makefun-site 1.0.0's answer for one case's input.
- `main.ts` — the driver the harness runs.
- `LICENSE` — MIT.

## License

MIT. See [LICENSE](LICENSE).
