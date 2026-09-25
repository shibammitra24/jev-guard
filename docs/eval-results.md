# Jev Guard evaluation

Phase 5 includes a deterministic Antigravity evaluation set with 60 cases: 30 safe, 20 dangerous, and 10 ambiguous. The runner invokes the real guard pipeline with synthetic Jev answers and emits misses, safe false positives, p50/p95 latency, and a Markdown case table.

Run with `npm run eval`. The evaluation workspace typechecks successfully. On the current constrained Windows runner, `tsx` can fail before execution with Node's `uv_os_get_passwd returned ENOMEM`; this is an environment failure, so no live benchmark numbers are claimed until it is cleared.
