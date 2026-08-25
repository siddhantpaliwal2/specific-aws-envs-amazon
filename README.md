# Sample RL Tasks for AWS - Amazon

This repository contains five packaged AWS coding tasks. The original shared
four-task cohort remains at its existing paths with 6 solves across 32 valid
Claude Opus 4.8 trials. The same stable raw-evidence folder now also contains
the report's 32 Claude Opus 5 trajectories for Tasks 1-4 and Task 5's 16
matched trajectories. All 40 Opus 5 trajectories discussed in the report are
there, for 80 scored attempts in total.

Compared with the earlier shared sample, the model response cap was raised to
32,768 tokens and Task 3's instruction was tweaked to state its bucket geometry
and pre-window standing-level behavior explicitly, making the graded behavior
fairer to infer. The earlier raw cohort, controls, indexes, and links are kept
intact and remain labeled as historical evidence for the prompt and run policy
they recorded.

## Table of contents

- [Public snapshot](#public-snapshot)
- [Pass@k matrix](#passk-matrix)
- [AWS API surface exposed to the agent](#aws-api-surface-exposed-to-the-agent)
- [Task inventory](#task-inventory)
- [Trace-backed failure modes](#trace-backed-failure-modes)
  - [1. Free-line visibility was confused with billable quantity](#1-free-line-visibility-was-confused-with-billable-quantity)
  - [2. A partial interval extended outside the requested window](#2-a-partial-interval-extended-outside-the-requested-window)
- [Where the trajectories are stored](#where-the-trajectories-are-stored)
- [Reproduction](#reproduction)
- [Evidence and controls](#evidence-and-controls)

## Pass@k matrix

Each row contains eight valid trials. `c/n` is the observed solve count. The
table uses `pass@k = 1 - C(n-c, k) / C(n, k)`, the estimated chance that at
least one of `k` sampled attempts succeeds.

<!-- MINI_SWE_MATRIX_START -->
| Task | Opus 4.8 `c/n` | Opus 4.8 pass@1 | Opus 4.8 pass@3 | Opus 4.8 pass@8 | Opus 5 `c/n` | Opus 5 pass@1 | Opus 5 pass@3 | Opus 5 pass@8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [Task&nbsp;1:&nbsp;Tenant&nbsp;attribution](tasks/01-tenant-attribution/instruction.md) | 2/8 | 0.25 | 0.64 | 1.00 | 7/8 | 0.88 | 1.00 | 1.00 |
| [Task&nbsp;2:&nbsp;Entitlement&nbsp;overage&nbsp;lines](tasks/02-entitlement-overage-lines/instruction.md) | 3/8 | 0.38 | 0.82 | 1.00 | 5/8 | 0.62 | 0.98 | 1.00 |
| [Task&nbsp;3:&nbsp;Usage&nbsp;window&nbsp;aggregation](tasks/03-usage-window-aggregation/instruction.md) | 2/8 | 0.25 | 0.64 | 1.00 | 8/8 | 1.00 | 1.00 | 1.00 |
| [Task&nbsp;4:&nbsp;Usage&nbsp;attribution&nbsp;chain](tasks/04-usage-attribution-chain/instruction.md) | 2/8 | 0.25 | 0.64 | 1.00 | 8/8 | 1.00 | 1.00 | 1.00 |
| [Task&nbsp;5:&nbsp;IAM&nbsp;role&nbsp;validation](tasks/05-iam-role-validation/instruction.md) | 4/8 | 0.50 | 0.93 | 1.00 | 8/8 | 1.00 | 1.00 | 1.00 |
<!-- MINI_SWE_MATRIX_END -->

*Updated run rates after the response-token limit was raised to 32,768.*

<!-- MINI_SWE_MACRO_START -->
Unweighted macro-average across Tasks 1-5:

| Metric | Opus 4.8 | Opus 5 |
| --- | ---: | ---: |
| Valid solves | 13/40 | 36/40 |
| Raw solve rate | 32.5% | 90.0% |
| pass@1 | 0.33 | 0.90 |
| pass@3 | 0.74 | 1.00 |
| pass@8 | 1.00 | 1.00 |
<!-- MINI_SWE_MACRO_END -->

The macro pass@k values average the five task-level estimates; they are not a
pooled trial estimator.

## AWS API surface exposed to the agent

Each Daytona sandbox exposes one task-local AWS-compatible endpoint at
`http://127.0.0.1:4566`. The task image sets `AWS_ENDPOINT_URL`, the `us-east-1`
region, and emulator credentials. Every task instruction tells the agent that
the endpoint is available and may be inspected. No live AWS account is used.

| AWS service | Operations used | Tasks |
| --- | --- | --- |
| Amazon S3 | `GetObject`, `ListObjectsV2` | Tasks 1, 2, and 4 |
| AWS STS | `AssumeRole` | Tasks 1, 2, 4, and 5 |
| Amazon EC2 | `DescribeInstances`, `DescribeRegions` | Tasks 1, 4, and 5 |
| Amazon CloudWatch | `GetMetricData`, `ListMetrics` | Tasks 2 and 3 |
| AWS Systems Manager Parameter Store | `GetParameter`, `GetParameters`, `GetParametersByPath` | Task 4 |

The endpoint speaks the wire protocols expected by the AWS SDK and implements
the pagination, role-trust, throttling, and transient-fault cases used by the
tasks. At task start it serves a deterministic development scenario that the
agent can inspect. During grading, `tests/test.sh` replaces it with a
root-owned held-out scenario containing the same record kinds and fields but
different identifiers and scale. The verifier calls the submitted
implementation's public entry point and derives the expected result
independently.

## Task inventory

<table>
  <thead>
    <tr>
      <th scope="col" width="120">Task</th>
      <th scope="col">What it tests</th>
      <th scope="col">Recorded results</th>
      <th scope="col">Role in this sample</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="tasks/01-tenant-attribution/instruction.md">Task&nbsp;1</a></td>
      <td>Assign shared-account AWS usage to the right customer</td>
      <td>Historical Opus 4.8: 2/8; report Opus 5: 7/8</td>
      <td>Low-pass task</td>
    </tr>
    <tr>
      <td><a href="tasks/02-entitlement-overage-lines/instruction.md">Task&nbsp;2</a></td>
      <td>Separate chargeable usage from whether an invoice line is visible</td>
      <td>Historical Opus 4.8: 3/8; report Opus 5: 5/8</td>
      <td>In-band task</td>
    </tr>
    <tr>
      <td><a href="tasks/03-usage-window-aggregation/instruction.md">Task&nbsp;3</a></td>
      <td>Build a complete time series with carry-forward and distinct groups</td>
      <td>Historical Opus 4.8: 1/8; report Opus 5: 8/8</td>
      <td>Prompt clarified after the earlier cohort</td>
    </tr>
    <tr>
      <td><a href="tasks/04-usage-attribution-chain/instruction.md">Task&nbsp;4</a></td>
      <td>Follow ownership links across AWS records to a final billing code</td>
      <td>Historical Opus 4.8: 0/8; report Opus 5: 8/8</td>
      <td>Full-failure difficulty task</td>
    </tr>
    <tr>
      <td><a href="tasks/05-iam-role-validation/instruction.md">Task&nbsp;5</a></td>
      <td>Validate a customer IAM role before saving its settings</td>
      <td>Opus 4.8: 4 of 8; Opus 5: 8 of 8</td>
      <td>Matched two-model supplement</td>
    </tr>
  </tbody>
</table>

Each task folder contains the instruction, environment, behavioral verifier,
reference solution, and a task-specific README.

## Trace-backed failure modes

The preserved four-task analysis begins with the task contract and verifier result, then compares
the submitted code with a successful run of the same frozen task. A trajectory
is treated as an observable work log, not as access to hidden model reasoning.
This mirrors tool-grounded checking methods such as
[PDoctor](https://arxiv.org/abs/2404.17833), which checks plans against task
constraints, and [CRITIC](https://arxiv.org/abs/2305.11738), which uses
external feedback to check and revise outputs. Here, the executable verifier
provides that external feedback.

| # | Failure mode | Repeated evidence | Successful comparison | Practical training target |
| ---: | --- | --- | --- | --- |
| 1 | A free invoice line used raw usage instead of chargeable usage | The same quantity error appears in 4 of the 5 failed Task 2 verifier reports | Three runs solve the same frozen task | Keep line visibility and billed quantity as separate decisions |
| 2 | A partial aggregation window extended beyond one requested edge | Boundary errors appear in 4 of the 7 failed Task 3 verifier reports | One run solves the same frozen task | State interval-boundary invariants before implementing the loop |

### 1. Free-line visibility was confused with billable quantity

[Task 2](tasks/02-entitlement-overage-lines/instruction.md) asks the
implementation to decide two things independently: how much usage remains
chargeable after an allowance, and whether a zero-priced dimension should
still appear on the invoice.

Failed run
[`LFFL9rM`](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/02-entitlement-overage-lines__LFFL9rM/agent/trajectory.json)
correctly computes the overage, but replaces it with total usage whenever the
dimension is free:

```ts
const owesSomething = chargeableUsage > 0 && unitCost > 0;
if (!owesSomething && !(priceIsZero && !hideFreeDimensions)) return;

const billedQuantity = priceIsZero ? totalUsage : chargeableUsage;
```

The [verifier report](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/02-entitlement-overage-lines__LFFL9rM/verifier/report.txt)
shows the result: quantities of `30`, `12`, and `75` appear where the
chargeable quantity is `0`, while `48` appears where the expected overage is
`18`.

Passing run
[`VcktpKc`](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/02-entitlement-overage-lines__VcktpKc/agent/trajectory.json)
keeps the two decisions separate:

```ts
const chargeableQuantity = this.chargeableQuantity({ dimension, totalUsage });
const owes = chargeableQuantity > 0 && unitCost > 0;
const free = unitCost === 0;

if (!owes && !free) return;
if (!owes && free && hideFreeDimensions) return;
// The emitted line continues to use chargeableQuantity.
```

A useful reasoning method is a two-column constraint table: one column for
whether the line exists and another for its quantity. Tests should cover
zero-priced dimensions below, at, and above their allowance.

### 2. A partial interval extended outside the requested window

[Task 3](tasks/03-usage-window-aggregation/instruction.md) requires the steps
to cover exactly the requested interval. If a request starts partway through
an hour, the first bucket starts at the request time and ends at the next clock
boundary.

Failed run
[`z4pBknz`](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/03-usage-window-aggregation__z4pBknz/agent/trajectory.json)
rounds the first cursor down before building the steps:

```ts
const windowEnd = new Date(endTime);
let cursor = floorToInterval(new Date(startTime), interval);
while (cursor < windowEnd) {
    const end = nextBoundary(cursor, interval);
    steps.push({ start: cursor, end });
    cursor = end;
}
```

The [verifier report](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/03-usage-window-aggregation__z4pBknz/verifier/report.txt)
records a first bucket beginning at `00:00` instead of the requested `00:20`.

Passing run
[`hauurVi`](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/03-usage-window-aggregation__hauurVi/agent/trajectory.json)
starts at the request edge and clips the final step:

```ts
const windowStart = new Date(startTime);
const windowEnd = new Date(endTime);
let cursor = windowStart;
while (cursor.getTime() < windowEnd.getTime()) {
    const boundary = nextBoundary(cursor, interval);
    const stepEnd = boundary.getTime() < windowEnd.getTime() ? boundary : windowEnd;
    steps.push({ startTime: cursor.toISOString(), endTime: stepEnd.toISOString() });
    cursor = stepEnd;
}
```

A useful reasoning method is to write the loop invariants first: oldest first,
no gaps, no overlaps, no overhang, and natural boundaries between the two
clipped edges.

## Where the trajectories are stored

The existing raw-evidence URL is unchanged. It now contains the 32 earlier
Opus 4.8 attempts, the report's 32 Opus 5 attempts for Tasks 1-4, and Task 5's
16 matched trials:

```text
sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/
```

Each task-model cell has eight trial folders. Inside each trial, the normalized ATIF trace
is `agent/trajectory.json`, the native mini-SWE-agent trace is
`agent/mini-swe-agent.trajectory.json`, and the grading artifacts are under
`verifier/`. The historical
[`sample-run/indexes/trials.json`](sample-run/indexes/trials.json) and additive
[`sample-run/indexes/report-opus5-trials.json`](sample-run/indexes/report-opus5-trials.json)
and [`sample-run/indexes/task5-trials.json`](sample-run/indexes/task5-trials.json)
indexes map every matrix row to its exact stored evidence.

## Reproduction

To audit the included evidence without launching sandboxes or calling a model:

```sh
python3 harness/summarize_report_opus5.py
python3 harness/summarize_task5.py
python3 harness/summarize_cohort.py
git diff --exit-code README.md sample-run/indexes
```

To sample a new stochastic cohort, follow
[`HANDOFF.md`](HANDOFF.md). A new cohort will not reproduce the exact model
outputs stored here, but it uses the same frozen task packages, model route,
agent configuration, and verifier controls.

## Evidence and controls

- **Harness:** Harbor 0.18.0 with mini-SWE-agent 2.4.5 in isolated Daytona
  sandboxes, at high reasoning effort.
- **Routes:** The earlier cohort uses Claude Opus 4.8. The report evidence uses
  Claude Opus 5 through Amazon Bedrock. Task 5 uses both models under a matched
  policy. The later policy has a 32,768-token response cap and binary verifiers.
- **Denominator:** All 80 stored trials are valid: 32 historical Opus 4.8
  attempts, 32 report Opus 5 attempts for Tasks 1-4, and 16 matched Task 5
  attempts. The three evidence sets retain separate indexes and are not pooled
  across mismatched frozen identities. Admission requires a numeric reward,
  complete ATIF and native mini-SWE-agent trajectories, a complete verifier
  artifact, and no Harbor exception.
- **Controls:** All four included oracle runs score `1.0`; all four no-op runs
  score `0.0`. Task 5's recorded control gate is oracle `1.0` and no-op `0.0`.
- **Raw model evidence:**
  [`sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/`](sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/)
  contains all 80 scored attempts: the original 32, the report's 32 Opus 5
  attempts for Tasks 1-4, and Task 5's 16 matched attempts. The folder name is
  retained so previously shared links remain stable.
- **Raw controls:**
  [`sample-run/raw/amazon-opus-4-8-four-task-controls-20260818/`](sample-run/raw/amazon-opus-4-8-four-task-controls-20260818/)
  contains all eight control runs.
- **Machine-readable index:**
  [`sample-run/indexes/trials.json`](sample-run/indexes/trials.json) resolves
  every earlier trial to its stored evidence;
  [`sample-run/indexes/report-opus5-trials.json`](sample-run/indexes/report-opus5-trials.json)
  resolves the report's Opus 5 trials for Tasks 1-4 and records their report
  source paths; and
  [`sample-run/indexes/task5-trials.json`](sample-run/indexes/task5-trials.json)
  resolves the Task 5 trials.
- **Frozen inputs:**
  [`sample-run/manifests/frozen-cohort.json`](sample-run/manifests/frozen-cohort.json)
  records the earlier task and harness checksums;
  [`sample-run/manifests/report-opus5-results.json`](sample-run/manifests/report-opus5-results.json)
  records the report Opus 5 cells, source commit, and frozen identities; and
  [`sample-run/manifests/task5-results.json`](sample-run/manifests/task5-results.json)
  records Task 5's frozen identities and control gate.
