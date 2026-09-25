# Phase 7 baseline comparison

The repository now contains a shared evaluation prompt (`eval/baseline.ts`), an injectable `BaselineModel` interface for a live generative model, and an offline deterministic lexical proxy suitable for the hackathon environment.

Run:

```text
npm run eval:baseline
```

The proxy reports misses, safe false positives, p50/p95 latency, and cost basis. It is explicitly not presented as a vendor or model benchmark. On this machine, `tsx` currently fails before execution with Node `uv_os_get_passwd returned ENOMEM`; live numeric results should be generated once that environment issue is resolved.
