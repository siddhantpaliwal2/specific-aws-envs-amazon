# Cohort selection and interpretation

## Report Opus 5 evidence for Tasks 1–4

The 32 Opus 5 trajectories referenced by the report are included at the same
stable raw root as the previously shared evidence.

| Task | Model | Solves | Interpretation |
| --- | --- | ---: | --- |
| [Task 1: tenant attribution](../tasks/01-tenant-attribution/instruction.md) | Opus 5 | 7/8 | Seven solves under the report cohort's frozen Task 1 identity |
| [Task 2: entitlement overage lines](../tasks/02-entitlement-overage-lines/instruction.md) | Opus 5 | 5/8 | Five solves and three failures under the report cohort's frozen Task 2 identity |
| [Task 3: usage-window aggregation](../tasks/03-usage-window-aggregation/instruction.md) | Opus 5 | 8/8 | Consistent solving under the report cohort's frozen Task 3 identity |
| [Task 4: usage attribution chain](../tasks/04-usage-attribution-chain/instruction.md) | Opus 5 | 8/8 | Consistent solving under the report cohort's frozen Task 4 identity |

All 32 have numeric rewards, both trajectory formats, readable transcripts,
lock and result records, complete verifier artifacts, and no Harbor exception.
The exact evidence and report-path mapping is in
[`indexes/report-opus5-trials.json`](indexes/report-opus5-trials.json).

These rows should not be treated as matched pairs with the historical Opus 4.8
matrix below. The preserved historical cohort records different frozen task
digests and a different run policy; keeping the denominators separate preserves
both the old links and the report evidence without relabeling either cohort.

## Task 5 matched supplement

Task 5 adds eight valid trials per model without changing or pooling the
earlier four-task denominator.

| Task | Model | Solves | Interpretation |
| --- | --- | ---: | --- |
| [Task 5: IAM role validation](../tasks/05-iam-role-validation/instruction.md) | Opus 4.8 | 4/8 | Four solves and four failures under one frozen task |
| [Task 5: IAM role validation](../tasks/05-iam-role-validation/instruction.md) | Opus 5 | 8/8 | Consistent solving comparator under the same policy |

All 16 trials have numeric rewards, both trajectory formats, readable
transcripts, lock and result records, complete verifier artifacts, and no Harbor
exception. The recorded control gate is oracle `1.0` and no-op `0.0`. The exact
evidence map is in
[`indexes/task5-trials.json`](indexes/task5-trials.json).

Task 5 should not be added to the historical four-task macro: its trials use
the later 32,768-token response cap, and Task 3's current prompt was separately
clarified for fairness after the earlier cohort was recorded.

## Selection rule

This sample reports eight valid Claude Opus 4.8 trials per task. A task is
included when fewer than four of the eight recorded attempts pass. The four
included tasks have 6 solves across 32 attempts.

| Task | Result | Interpretation |
| --- | ---: | --- |
| [Task 1](../tasks/01-tenant-attribution/instruction.md) | 2/8 | Low-pass task over shared-account onboarding records |
| [Task 2](../tasks/02-entitlement-overage-lines/instruction.md) | 3/8 | In-band task over allowance and invoice-display semantics |
| [Task 3](../tasks/03-usage-window-aggregation/instruction.md) | 1/8 | Low-pass task over complete time-series construction |
| [Task 4](../tasks/04-usage-attribution-chain/instruction.md) | 0/8 | Full-failure difficulty observation over chained ownership records |

The successful runs on Tasks 1 through 3 show model-level reachability under
the recorded setup. Task 4's zero-result row is a difficulty observation, not
by itself evidence that the model can learn or solve the task.

## Fairness and evidence

Each instruction identifies the local AWS-compatible endpoint that the agent
can inspect. Each verifier builds its expected output independently from
root-owned held-out state and checks behavior through the task's public entry
point rather than checking for a particular implementation.

Every included task has an oracle reward of `1.0` and a no-op reward of `0.0`.
All 32 model trials have numeric rewards, complete ATIF and native
mini-SWE-agent trajectories, complete verifier artifacts, and no Harbor
exception.

The matrix reports the recorded outcome only. A passing reference solution
shows that the verifier is reachable; the successful model trials on Tasks 1
through 3 provide the stronger counterexample that those tasks are reachable
by the evaluated model.
