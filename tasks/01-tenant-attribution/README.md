# Task 1 — tenant attribution

A feature-removal task cut from a real NestJS TypeScript backend
(`metering-src/extracted/top-up-billing-lifecycle`, 534 `.ts` files, 87 runtime
dependencies). The agent works in the actual repository, not a purpose-built
skeleton, and there is no specification document anywhere in the box.

## What was taken out

The EC2 uptime collector sweeps every metered account named by the business'
onboarding record and publishes one usage row per customer. What the workspace
ships without is the layer that decides *which* customer a running instance is
billable to: the onboarding records that say who may be billed for which
account, whether an account belongs to one customer outright, and what to do
with a machine that names several customers, names one that was never onboarded
for the account it is sitting in, or names nobody at all.

The remaining collector reads the `meteringCustomerId` tag and bills whoever it
names. That is a coherent implementation of a world where every machine belongs
to exactly one customer and its tag is always right — which is what the code
reads like, not like something with a hole in it.

| file | change vs upstream |
| --- | --- |
| `src/microservices/ec2InstanceDataGatherer/ec2InstanceDataGatherer.service.ts` | rewritten around the multi-account registry (+98 / −46): sweeps every account in the registry through `AssumeRole`, collects instances, then sums running time straight off the `meteringCustomerId` tag |
| `src/microservices/ec2InstanceDataGatherer/Dto/ec2InstanceDataGatherer.dto.ts` | job now carries the registry location instead of a single IAM role (+11 / −3) |
| `src/utils/aws/s3.ts` | gains `getDocument` (+6 / −1) |
| `src/onboarding/entities/meteringAccounts.entity.ts` | new, 46 lines: `MeteredAccount` and `MeteringRegistry`, including the `customerRecordPrefix` field the missing layer used to consume |

Nothing else moved. `StandardMeasurementEntity`, the dimension DTOs and the
cost path are exactly what upstream had, so the row shape a solution has to
produce is not something the task invented.

There are no stubs, no `TODO`s about the absent behaviour, no commented-out
code, no `not supported` throws, and no `.git` directory. The single `TODO` in
the collector (`make this dynamic`, on the running-time increment) is upstream's
own and predates the task. The words attribution, tenant, dedicated and
onboarding record appear nowhere the agent can read except as the
`customerRecordPrefix` field name and the S3 keys themselves.

## Where the rules live

No single file states the rule set. To derive it in full an agent has to read
across the repository *and* query the sandbox:

| source | what it yields |
| --- | --- |
| `src/onboarding/entities/meteringAccounts.entity.ts` | the registry shape, and `customerRecordPrefix` — a pointer to a body of records nothing in the tree currently reads |
| the S3 objects under that prefix in the sandbox | that records are per customer, list the accounts that customer may be billed for, and carry a `dedicated` flag on some of them |
| `src/microservices/ec2InstanceDataGatherer/ec2InstanceDataGatherer.service.ts` | that the `meteringDimensionId` tag is comma-separated and gates the sweep, and that the tag reducer flattens `Tags` to a map |
| the sandbox instances | that `meteringCustomerId` is comma-separated too, that some machines carry no tag, and that some name a customer whose record does not list the account |
| `src/measurement-config/entities/standardMeasurement.entity.ts` and `create-standard-measurement.dto.ts` | one row per customer, `recordValue` numeric, keyed by `customerId` and `dimensionId` |
| `integration/measurement/ec2RunningTimeMeasurement.integration.spec.ts` | corroborates the running-time increment (five minutes of an hour) and the tag names |

An agent that reads only the collector sees a tag and a loop, and will write
tag-only attribution. That is exactly the `w1` mutant below, and it scores 0.0.

## How it is graded

`tests/test.sh` stops the agent-facing endpoint, restarts the emulator on a
held-out account document, drops a root-owned driver into `/app`, and calls the
collector once per dimension. It never trusts an exit code or stdout. The
driver accepts either shape of solution: a collector that returns measurement
entities, or one that only publishes them through the queue entry point.

`tests/compute_reward.py` runs as root, loads no submitted code, and re-derives
the correct answer from the held-out document with its own reference model.
Reward is 1.0 only if, for both dimensions, the set of billed customers matches
and every customer's total running time matches to within floating-point
tolerance.

Two dimensions are exercised (`dim-uptime`, `dim-egress`), which between them
cover every case class:

| case | held-out example | correct outcome |
| --- | --- | --- |
| tag names an onboarded customer | `cus_vantage` in its own account | billed to that customer |
| no tag at all, dedicated account | a box in `200000000011` | billed to the account's customer |
| no tag at all, shared account | a box in `200000000033` | off the bill |
| tag names several customers, all onboarded there | three names in `200000000033` | split evenly three ways |
| tag disagrees with the account, dedicated | `cus_relict` in `200000000022` | billed to the account's customer |
| tag disagrees with the account, shared | `cus_quarry` in `200000000033` | off the bill |
| tag mixes an onboarded and a non-onboarded name | `cus_quarry,cus_orbital` in `200000000033` | whole machine to the onboarded one |
| empty tag value | `200000000044` | off the bill |
| duplicate name in one tag | `cus_orbital,cus_orbital` | counted once |
| whitespace after a comma | `cus_vantage, cus_pinnacle` | both honoured |
| wrong dimension, or not running | egress-only and stopped boxes | absent from the uptime totals |

Measured in the built image, each candidate applied to `/app` as the agent user
and scored by the real verifier:

| candidate | reward |
| --- | --- |
| reference solution | **1.0** |
| starting workspace, unchanged | **0.0** |
| tag-only attribution (no onboarding check) | 0.0 |
| account-only attribution (dedicated owner, tags ignored) | 0.0 |
| unplaceable machines spread over all permitted customers instead of dropped | 0.0 |
| dimension gate dropped | 0.0 |
| per-account accumulation with `Map`, rows assembled at the end | **1.0** |
| publishes from the queue entry point, no `gatherUsage`, direct SDK calls | **1.0** |

Both `0.0` anchors were re-measured with an empty host environment
(`env -i`) so no host AWS config or `HOME` can leak in.

## Sandbox vs held-out account

The box serves `/opt/metering-sandbox/public.json`: one metering account, two
metered accounts, two onboarded customers, nine instances. Every case class is
present in kind — a dedicated account with an untagged box, a shared account
with a box naming two customers, a box naming a customer not onboarded for its
account, boxes on another dimension, a stopped box.

The held-out document is four metered accounts, six customer records, twenty-two
instances, one customer onboarded only for an account the business does not
meter, empty and duplicated and whitespace-padded tag values, and two graded
dimensions. Passing locally is not evidence of passing the grade.

`DescribeInstances` pages three at a time in both documents. This is present so
that a solution which ignores `NextToken` cannot accidentally look correct on a
tiny estate; it is deliberately not the source of difficulty, since defensive
pagination is a habit both target models already have.

## Layout

```
environment/Dockerfile          image: node 22, python 3, the repo at /app
environment/task-init.sh        starts the emulated endpoint on :4566
environment/workspace/          the repository, capability removed
environment/mockaws/            task-owned copy of the emulated control plane
environment/sandbox/            world-readable fixture + sandbox notes
environment/verifier-data/      root-only: held-out account, run spec, driver
environment/gen_scenarios.py    regenerates both account documents
instruction.md                  the prompt (844 characters, one paragraph)
solution/solution.patch         the oracle (3 files, +113 / −7)
tests/test.sh                   verifier entry point
tests/compute_reward.py         trusted scorer with its own reference model
```

`environment/mockaws/` diverges from `shared/mockaws/` on purpose: it adds the
`tag-key` filter to `DescribeInstances` (the collector's own filter, which the
shared copy silently ignored), a few extra instance fields, and an SSM
parameter service. `shared/` itself is unmodified.

## Regenerating

```
python3 environment/gen_scenarios.py --out-dir /tmp/scenarios
install -m 0644 /tmp/scenarios/public.json environment/sandbox/public.json
install -m 0644 /tmp/scenarios/holdout.json environment/verifier-data/holdout.json
```
