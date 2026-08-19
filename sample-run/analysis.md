# Cohort selection and interpretation

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
