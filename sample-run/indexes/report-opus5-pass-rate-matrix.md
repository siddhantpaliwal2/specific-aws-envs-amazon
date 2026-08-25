# Opus 5 report trajectories for Tasks 1–4

All 32 report-referenced Opus 5 trials are valid and have complete
trajectory and verifier artifacts.

These rows retain the report cohort's frozen task identities. They are
not pooled with the earlier Opus 4.8 cohort stored at the same stable raw root.

| Task | Model | Solves | Observed pass rate | pass@1 | pass@3 | pass@8 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Task 1 — tenant attribution | Opus 5 | 7/8 | 87.5% | 0.8750 | 1.0000 | 1.0000 |
| Task 2 — entitlement overage lines | Opus 5 | 5/8 | 62.5% | 0.6250 | 0.9821 | 1.0000 |
| Task 3 — usage-window aggregation | Opus 5 | 8/8 | 100.0% | 1.0000 | 1.0000 | 1.0000 |
| Task 4 — usage attribution chain | Opus 5 | 8/8 | 100.0% | 1.0000 | 1.0000 | 1.0000 |

## Model total

| Model | Solves | Observed pass rate |
| --- | ---: | ---: |
| Opus 5 | 28/32 | 87.50% |

The observed pass rate is the raw solve fraction. `pass@k` uses
`1 - C(n-c, k) / C(n, k)`.
