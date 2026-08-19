# Task 4 — usage-attribution chain

A feature-removal task cut from a real NestJS TypeScript backend
(`metering-src/extracted/top-up-billing-lifecycle`, 466 `.ts` files, 87 runtime
dependencies). The agent works in the actual repository, not a purpose-built
skeleton, and there is no specification document anywhere in the box.

The capability under test is **following a reference chain all the way to its
end**. Every usage line names a pocket of the estate. A pocket either carries
the spend itself or hands it on to something else, and what it hands on to may
hand it on again. The next thing to fetch is decided by the content of the
record just read, so the walk cannot be written as one loop over one collection
and it cannot be planned before the first fetch returns.

This is deliberately **not** a task about edge conditions. There is exactly one
rule and it applies identically to every line: an amount belongs to the charge
code the chain finally resolves to. What separates a 0.0 from a 1.0 is how far
the implementation actually walked.

## The one rule

Each usage line carries an attribution reference. Follow the hand-offs until a
record has none left, and book the line's quantity, amount and a line count
against the charge code carried by the record the walk ends on. One row per
charge code that actually carries spend. Nothing else is graded, and there is no
special case anywhere: every graded outcome is decidable straight from the
held-out document with no judgment.

## Four stores, four fetches

A reference is one of four forms, and the four live in different places and are
read by different calls:

| reference | lives in | how it is read | what it can hand on to |
| --- | --- | --- | --- |
| `pool/<name>` | one entry in `attribution/pools.json` in the metering bucket | one `GetObject`, whole set at once | anything, via `rollsUpTo` |
| `unit/<name>` | its own object under `attribution/units/` | one `GetObject` per unit | anything, via `parentRef` |
| `node/<account>/<region>/<instance>` | the tags on an EC2 instance in a member account | `AssumeRole` then a regional `DescribeInstances` | anything, via the `meteringRollsInto` tag |
| `alias/<key>` | the parameter tree, under `/metering/attribution/alias/` | `GetParameter` or a `GetParametersByPath` sweep | anything |

`alias/` is the indirect one: it carries no charge code of its own and exists
only to name the identifier the next store is keyed by, so it must be resolved
before the next fetch can even be addressed. The tag keys, the parameter root
and the two hand-off field names are all visible in the sandbox document, and
`GetParametersByPath` on `/` lists the whole alias tree, so nothing here has to
be guessed.

Chains are built from these shapes, all of which appear in both estates:

```
direct           pool
unit-1           pool -> unit
node-1           pool -> node
alias-unit       pool -> alias -> unit
unit-node        pool -> unit -> node
node-unit        pool -> node -> unit
unit-alias-node  pool -> unit -> alias -> node
four             pool -> unit -> node -> unit
five             pool -> alias -> unit -> node -> pool -> unit
six              pool -> unit -> node -> alias -> unit -> node -> pool
loop-short       pool -> unit -> back to the pool
loop-long        pool -> unit -> alias -> pool -> back into the ring
join-deep        two pools converging on one deep chain
join-mid         two pools converging part way along another chain
```

Cycles terminate objectively rather than by judgment: every member of a ring
carries the same charge code, so a walk that stops the moment it stands on a
reference it has already stood on lands on the same answer wherever it entered.
Joins are the same thing seen from the other side and cost nothing extra beyond
not walking the shared tail twice.

## What was taken out

The shipped tree resolves the first hop and stops. `AttributionPool` has a
`chargeCode` and nothing else, `AttributionDirectory` loads `pools.json` and
answers `chargeCodeFor` out of that one map, and neither the parameter tree nor
instance tags nor the unit objects are read at all:

| file | change |
| --- | --- |
| `src/onboarding/entities/attributionDirectory.entity.ts` | 44 lines: `rollsUpTo` gone from the pool, `AttributionUnit` gone, the walk replaced by a single map lookup (+111 / −8 to restore) |
| `src/microservices/usageAttribution/usageAttribution.service.ts` | resolves each line synchronously against that map, builds no per-account credential set (+16 / −5) |
| `src/utils/aws/awsEc2.ts` | no instance-tag reader (+16 / −0) |
| `src/utils/aws/awsSSM.ts` | only the region long-name lookup the repo already had (+6 / −0) |

**13 lines removed, 149 inserted, four files** between the starting tree and
`solution/solution.patch`. Everything else the path needs is present and
working: the multi-account loop over the onboarding record, role assumption,
paginated prefix listings, the usage-export entity, the attributed-spend entity
and its Influx transformer, the module wiring and the scheduler DTO.

Relative to upstream, the attribution path is new, since upstream has no
attribution collector at all:

| file | upstream → shipped | change |
| --- | --- | --- |
| `src/utils/aws/s3.ts` | 5 → 33 | +29 / −1 |
| `src/scheduler/entities/scheduler.entity.ts` | 102 → 104 | +2 / −0 |
| `src/app.module.ts` | 132 → 134 | +2 / −0 |
| `src/onboarding/entities/meteringAccounts.entity.ts` | new | 57 lines |
| `src/onboarding/entities/usageExport.entity.ts` | new | 58 lines |
| `src/onboarding/entities/attributionDirectory.entity.ts` | new | 44 lines |
| `src/microservices/usageAttribution/usageAttribution.service.ts` | new | 102 lines |
| `src/microservices/usageAttribution/usageAttribution.module.ts` | new | 16 lines |
| `src/microservices/usageAttribution/dto/usageAttribution.dto.ts` | new | 28 lines |
| `src/microservices/usageAttribution/entities/attributedSpend.entity.ts` | new | 56 lines |

`package-lock.json` is byte-identical to upstream. There are no stubs, no
`TODO`s about the absent behaviour, no commented-out code, no `not supported`
throws, and no `.git`, `dist/` or `node_modules/` in the workspace. The starting
tree builds (`nest build`, clean), lints clean, and passes the repository's own
unit suite (55 suites, 287 tests, all green, run in the built image). So does
the oracle tree.

The starting state is coherent rather than obviously broken. Booking a line
against the code on the pocket it came out of is a correct implementation of a
world where pockets carry their own spend, and most of them do.

## The scale

| | sandbox (`/opt/metering-sandbox/public.json`) | held-out |
| --- | --- | --- |
| onboarded accounts | 2 | 4 |
| regions across the estate | 3 | 6 |
| usage lines graded | 33 | 93 |
| chains | 18 | 34 |
| charge codes in the answer | 16 | 24 |
| pools | 21 | 37 |
| unit objects | 15 | 26 |
| alias parameters | 5 | 8 |
| instances carrying attribution tags | 9 | 16 |
| `ListObjectsV2` page cap | 2 | 3 |
| throttle on `DescribeInstances` | every 9th call, burst 2 | every 11th call, burst 2 |
| metering account, bucket, business | different from the held-out ones | — |

Chain depth, counted as records visited before the walk can stop, and weighted
by the usage lines that depend on it:

| depth | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| sandbox lines | 9 | 11 | 7 | 3 | 1 | 2 |
| held-out lines | 28 | 38 | 16 | 6 | 2 | 3 |

Two thirds of the held-out lines are settled within two hops, which is exactly
why an implementation that stops there produces a report that looks finished.

**Minimum API calls for a correct answer against the held-out estate: 84.** One
`GetObject` for the onboarding record, one for the pool document, 4
`AssumeRole`, 8 `ListObjectsV2`, 20 `GetObject` for the usage exports, 26
`GetObject` for the unit objects, 8 `GetParameter`, and 16 `DescribeInstances`
if every node is fetched once and cached. Volume is not the point here and the
numbers are deliberately small: what costs turns is that the 26th unit fetch
cannot be issued until the 25th has come back and been read.

## How it is graded

`tests/test.sh` stops the agent-facing endpoint, confirms the port is actually
released by trying to bind it rather than by asking whether it answers, starts
the emulator on a held-out estate behind a per-run admin token, drops a
root-owned driver into `/app`, and calls the collector's public entry point
(`UsageAttributionService.attributeSpend`) once. It never trusts an exit code or
stdout. `tests/compute_reward.py` runs as root, loads no submitted code, and
re-derives every chain from the held-out document with its own independent
resolver.

Reward is binary: the set of charge codes must match exactly, with no missing
rows and no invented ones, and quantity, amount and line count must match on
every row to within a part in a billion.

Measured in the built image through harbor, each candidate applied to `/app` and
scored by the real verifier:

| candidate | rows returned | reward |
| --- | --- | --- |
| reference solution (`solution/solution.patch`) | 24 | **1.0** |
| starting workspace, unchanged (harbor `nop`) | 23 | **0.0** |
| `p1` follows exactly one record | 23 | 0.0 |
| `p2` follows exactly two records | 28 | 0.0 |
| `p5` follows five records, everything but the deepest chains | 25 | 0.0 |
| `a1` alternative: bulk prefetch of every pool, unit, alias and region's tags up front, then a memoised recursive walk with no I/O in it | 24 | **1.0** |

Every partial walk returns a well-formed report. Each row is fully populated,
every charge code is a plausible-looking service code, every number is a
positive total, and no row is obviously a placeholder. `p1` reports 23 codes
across every account, `p2` reports 28, `p5` reports 25 of which 23 are exactly
right. None errors and none returns an empty answer. `p5` is wrong in one place
only: it books 154.13 to `cc-checkout-apps` where the answer is 244.95, and
invents a `cc-task-runners` row of 90.82 that belongs further up the same chain.

The intermediate charge codes are drawn from the same naming convention as the
terminal ones on purpose. Nothing about the string `cc-token-cache` says it
hands its cost on, so a shallow report gives the reader no signal that it is
short.

Both anchors were measured through the real harness, which launches the
submission with `env -i` and `HOME=/home/agent`, so no host AWS configuration
can leak in. `AWS_REGION` is set in the image, in `task.toml` and in that
`env -i` list; the SDK pinned in this tree reads only `AWS_REGION`.

## Sandbox vs held-out estate

Every structure the held-out estate has, the sandbox has too. Verified
mechanically over both documents: the same six record kinds, the same four
reference forms, the same pool, unit, line and registry field sets, the same tag
keys, aliases pointing at all three of pool, unit and node, instance tags
pointing at all of pool, unit, alias and a bare charge code, both cycle shapes,
both join shapes, and a chain as deep as the deepest held-out chain. The
held-out set of every one of those is a subset of the sandbox set, with nothing
held-out-only anywhere.

The charge code vocabularies are disjoint by construction, so an answer
memorised from the sandbox is worth nothing.

Run against the sandbox, the shipped tree returns 16 rows covering all 33 lines
and the correct answer is also 16 rows covering all 33 lines. Only four of those
rows agree. The gap is visible locally before anything is graded, but only to
someone who checks the values rather than the shape.

## Layout

```
environment/Dockerfile          image: node 22, python 3, the repo at /app
environment/task-init.sh        starts the emulated endpoint on :4566
environment/workspace/          the repository, capability removed
environment/mockaws/            task-owned copy of the emulated control plane
environment/sandbox/            world-readable fixture + sandbox notes
environment/verifier-data/      root-only: held-out estate, run spec, driver
environment/gen_scenarios.py    regenerates both estate documents
instruction.md                  the prompt (830 characters, one paragraph)
solution/solution.patch         the oracle (4 files, +149 / −13)
solution/solve.sh               applies it to /app
tests/test.sh                   verifier entry point
tests/compute_reward.py         trusted scorer with its own reference model
scale.json                      the numbers above, emitted by the generator
```

`environment/mockaws/` starts from the copy task 24 owns. Three things needed
doing to it, and they are the only differences:

- `Instance` gained a `region`, defaulted from its availability zone, and
  `DescribeInstances` now answers only for the region it was sent to. Instances
  are regional in AWS and were not in the fixture format, so without this a
  `node/` reference could not name a region meaningfully.
- `Account` gained a `parameters` tree, and SSM now serves `GetParameter`,
  `GetParameters` and a paginated `GetParametersByPath` over it alongside the
  static global-infrastructure region names it already held.
- Nothing else. `shared/` is untouched.

## Regenerating

```
python3 environment/gen_scenarios.py
```

It writes `environment/sandbox/public.json`,
`environment/verifier-data/holdout.json`,
`environment/verifier-data/run-spec.json` and `scale.json`, and fails loudly if
any structure appears in the held-out document that the sandbox does not also
exercise. Every value is derived from a seeded stream, so the two estates are
independent and regenerating either is reproducible. The generator never enters
the image.
