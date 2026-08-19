# Task 3 — usage-window aggregation

A feature-removal task cut from a real NestJS TypeScript backend
(`metering-src/extracted/top-up-billing-lifecycle`, 534 `.ts` files, 87 runtime
dependencies). The agent works in the actual repository, not a purpose-built
skeleton, and there is no specification document anywhere in the box.

## What was taken out

Reading a customer's usage walks the dimensions of the offering they are
enrolled in and answers with a usage document per dimension. What the workspace
ships without is the layer that turns a series of readings into the *buckets*
that document is supposed to carry: cutting the caller's window at interval
boundaries and reporting its own edges, carrying a provisioned level forward
over intervals nobody touched, accounting for a dimension with no readings at
all, splitting a metadata-priced dimension into one line per group, and handing
the buckets back oldest first.

What remains reads every series the dimension published, applies the dimension's
aggregation method to the lot, and answers with a single document spanning the
whole window. That is a coherent implementation of a world where the portal only
ever wants one number per dimension — which is what the code reads like, not
like something with a hole in it. `npm test` is green (55 suites, 287 tests) and
`nest build` typechecks clean before a single edit.

### Upstream, and what became of it

| upstream | change |
| --- | --- |
| `src/influx/influxUsageAggregateEvent.ts` (492 lines) | split. The infrastructure discovery half survives as `src/influx/influxDiscoveryEvent.ts` (218 lines). The usage aggregation half — `aggregateDimensionUsageFunction`, the `usageData` handler of `dimensionFunctionMap`, and `buildAggregationQueries`, upstream lines 59-272 — is gone (214 lines) |
| `src/influx/influx.service.ts` | −223: `aggregateDimensionUsageQuery`, `dimensionUsageNoAggregation`, `getAggregateUsageForDimension` and the Flux helpers they used (`aggregationIntervalToInfluxQueryLine`, `aggregationMethodToQueryLine`, `roundingInfluxMethod`, `customGroupBy`, `queryRange`) |
| `src/utils/aws/cloudwatchUsage.ts` | new, 167 lines: the metric layout usage is published under, `listUsageSeries`, `readUsageSamples`, `metadataOf` |
| `src/usage/usageAggregation.event.ts` | new, 188 lines: `UsageAggregationEvent`, CloudWatch-sourced, with the naive whole-window aggregation described above |
| `src/usage/usage.service.ts` | +3 / −6: `findUsageForCustomer` calls the aggregation entry point directly and no longer injects the metric-store client it has no further use for |
| `src/contract/contract.service.ts`, `src/usage/usage.controller.ts` | +2 / −2 each: `convertCreateUsageDtoToAggregateUsageResponse` moved with the class |
| `test/fixtures/module/mockUsageAggregation.ts` | new, 14 lines: the fixture the specs that used to stub aggregated usage on the metric-store mock now use |
| `src/billing/billing.service.spec.ts`, `test/api/{usage,invoices,portal}.api-spec.ts` | +21 / −13 total: rewired onto that fixture |

InfluxDB cannot run in a sealed container, so the readings were re-sourced
rather than mocked: usage is published to CloudWatch under `Metering/Usage` /
`DimensionUsage`, dimensioned by `BusinessId`, `CustomerId`, `DimensionId`, plus
one `Metadata_<key>` dimension per metadata key a reading carries. A series
holds at most one reading a minute, so `readUsageSamples` asks `GetMetricData`
for a sixty second period and gets the readings themselves back. Nothing in the
usage path mentions Influx any more; `InfluxService` still exists for the
config, contract and discovery queries that are genuinely its own.

There are no stubs, no `TODO`s about the absent behaviour, no commented-out
code, no `not supported` throws, and no `.git` directory. The two `TODO`s in
`usage.controller.ts` are upstream's own and concern producer authorisation and
an event-type parser. The words bucket, window, carry, pad and group appear
nowhere the agent can read as a description of what to build.

## Where the rules live

No single file states the rule set. To derive it in full an agent has to read
across the repository *and* probe the sandbox endpoint:

| source | what it yields |
| --- | --- |
| `src/dimensions/dto/create-dimension.dto.ts` | `aggregationInterval`, `aggregationIntervalInMS`, `aggregationMethod`, and `SampleType` with its `continious` member — the distinction the level behaviour hangs off |
| `src/customer/dto/read-customer.dto.ts` | `UsageResponseDocument` (`value`, `startTime`, `endTime`), `AggregatedUsageResponse`, and `MetadataGroupedAggregatedUsageResponse` with its row-level `metadataGroup` — a shape nothing currently produces |
| `src/dimensions/dto/dimensionTiersGroupByMetadataDto.dto.ts` | that a dimension is priced per metadata group, and that the group is named by the *keys* of `metadataGroups` |
| `src/offering/entities/offeringPackage.entity.ts` | that pricing takes `usage[usage.length - 1]` for some aggregation methods, so the buckets have to be in time order |
| `src/dimensions/dimensions.service.ts` | that an upfront dimension defaults to the `continious` sample type, i.e. that a level is a thing you provision rather than consume |
| `integration/usage/usage.integration.spec.ts` and `usageDate.integration.input.ts` | corroborates that a customer with no readings still gets one interval per step across the window and that every value reads `'0'` |
| `integration/dimension/dimensionAggregation.integration.spec.ts` | reads the last bucket of a grouped dimension's usage, corroborating both the ordering and the split |
| the sandbox endpoint | that readings come back newest first, that pages are shorter than the answer, that a metadata group is a series of its own, that a quiet dimension publishes no series at all, and that a window's own edges do not line up with the clock |

An agent that reads only the surviving code sees a series and a reducer, and
will write one number per dimension. That is the starting state, and it scores
0.0.

## How it is graded

`tests/test.sh` stops the agent-facing endpoint, proves that its process has
exited and its port can be rebound, then starts a held-out emulator whose
identity is verified with a run-specific admin token. It drops a root-owned
driver into `/app` and reads two customers' usage through
`UsageService.findUsageForCustomer` — the real call path, untouched by the
removal. It never trusts an exit code or stdout. The driver accepts either
shape of answer: a row that names its own `metadataGroup`, or buckets that
carry it.

`tests/compute_reward.py` runs as root, loads no submitted code, and re-derives
every bucket from the held-out document with its own reference model. Reward is
1.0 only if, for both windows, the set of rows matches (dimension and metadata
group) and every bucket of every row matches in value, start and end, in order.
Nine rows and thirty-two buckets are compared.

Two windows are exercised, which between them cover every case class:

| case | held-out example | correct outcome |
| --- | --- | --- |
| window edges off the clock | `00:20` to `03:40`, hourly | four buckets: `00:20-01:00`, `01:00-02:00`, `02:00-03:00`, `03:00-03:40` |
| consumption reads the window only | `dim_api_calls` has readings at `00:05` and `03:50` | neither counts, though `00:05` shares a clock hour with the window start |
| a provisioned level carries forward | `dim_seats`, last set forty days earlier | quiet buckets read `4`, not `0` |
| a provisioned level with a nearer history | `dim_reserved_gb`, last set fourteen days earlier | first bucket reads `15` before the in-window change to `25` |
| an interval nobody used | the `02:00-03:00` hour of `dim_api_calls` | reads `0`, not absent and not null |
| a dimension with no readings at all | `dim_idle_gb` over three whole days | three buckets, each `0`, not an empty answer |
| metadata groups split | `dim_storage_gb` over two regions, `dim_seat_hours` over two plans | one row per group, each with its own buckets |
| buckets in time order | every row | oldest first, though `GetMetricData` answers newest first |
| the dimension's own method | `dim_backup_jobs` counts readings of `3`, `7` and `5` | `2`, not `15` |
| readings that belong to somebody else | another customer, another business, another dimension, another namespace | absent from the numbers |

Measured in the built image, each candidate applied to `/app` as the agent user
and scored by the real verifier:

| candidate | reward |
| --- | --- |
| reference solution (`solution/solution.patch`, +182 / −21) | **1.0** |
| starting workspace, unchanged | **0.0** |
| empty list for a dimension with no readings | 0.0 |
| provisioned level read like consumption, no carry forward | 0.0 |
| metadata groups added up into one line | 0.0 |
| buckets on interval boundaries, window edges ignored | 0.0 |
| buckets in the order CloudWatch answered in | 0.0 |
| an untouched interval reported as null rather than zero | 0.0 |
| a provisioned level looked for over the last thirty days only | 0.0 |
| imperative rewrite: one pass into a `Map`, group named on the buckets | **1.0** |
| the whole computation in a separate module, event class delegates | **1.0** |

Every failing candidate fails on the case it was written to miss and no other.
`AWS_REGION` was re-checked with an empty `HOME` under `env -i`: without it the
usage reader raises `Region is missing`, with it the read succeeds, and it is
set in the Dockerfile `ENV`, in `task.toml` and in the verifier's `env -i` list.

## Sandbox vs held-out account

The box serves `/opt/metering-sandbox/public.json`: one business, one customer
that matters, four dimensions. Every hazard is present in kind — readings on
either side of a window, an hour in the middle nobody used, a level set a
fortnight ago, two metadata groups, a dimension with no series at all, pages
shorter than the answer, and readings newest first.

The held-out document is two customers, six graded dimensions across two
windows (one hourly and off the clock, one three whole days), two of them
metadata-grouped, two of them provisioned levels with different histories, one
with no readings at all, plus readings belonging to another customer, another
business, a dimension outside the offering, and another namespace entirely.
Passing locally is not evidence of passing the grade.

Paging is mild and present in both documents: `GetMetricData` pages five at a
time in the sandbox and four in the held-out account, `ListMetrics` one at a
time in both. A metadata-grouped dimension therefore needs a second
`ListMetrics` call and a nine-reading series a third `GetMetricData` call. This
is deliberately not the source of difficulty — `tasks/10-ec2-egress-metrics`
grades fetching CloudWatch metrics, including paging, throttling and scan
order, and this task grades only what is done with the series once it is in
hand. The transport here is a finished, agent-visible helper.

## Layout

```
environment/Dockerfile          image: node 22, python 3, the repo at /app
environment/task-init.sh        starts the emulated endpoint on :4566
environment/workspace/          the repository, capability removed
environment/mockaws/            task-owned copy of the emulated control plane
environment/sandbox/            world-readable fixture + sandbox notes
environment/verifier-data/      root-only: held-out account, run spec, driver
environment/gen_scenarios.py    regenerates both account documents
instruction.md                  the prompt (823 characters, one paragraph)
solution/solution.patch         the oracle (1 file, +182 / −21)
tests/test.sh                   verifier entry point
tests/compute_reward.py         trusted scorer with its own reference model
```

`environment/mockaws/` is the copy from `tasks/10-ec2-egress-metrics`, which
already models `GetMetricData` period alignment, scan order and token paging,
and `ListMetrics` partial dimension matching. It is unmodified. `shared/mockaws/`
is untouched.

## Notes on the graded contract

Two properties of the held-out document are there to keep every case decidable
rather than debatable, and regenerating it should preserve them:

* The window with the dimension that has no readings is a whole number of days
  and starts on a day boundary, so padding it from the window start and padding
  it on the aligned grid give the same answer.
* Provisioned dimensions appear only in the window that starts off the clock,
  and never have a reading between the start of their first bucket's clock hour
  and the window start, so the value of that bucket does not depend on whether
  the level is read over the clock hour or over the reported bucket.

A lookback for a provisioned level passes at any depth that reaches the reading
that set it: the reference solution reads from a fixed historical epoch, one of
the passing alternatives reads from the Unix epoch, and a thirty day lookback is
one of the failing candidates.

## Regenerating

```
cd environment && python3 gen_scenarios.py
```
