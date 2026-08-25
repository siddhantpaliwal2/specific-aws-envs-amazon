# Reproducing the eight-rollout cohort

## Prerequisites

- Harbor 0.18.0 and mini-SWE-agent 2.4.5
- Python 3 and Git
- Daytona access for isolated sandboxes
- Amazon Bedrock credentials authorized for the configured Claude Opus 4.8
  inference profile, plus Claude Opus 5 when reproducing the Task 5 comparison

Keep credentials outside Git and export them in the shell that launches Harbor:

```sh
export DAYTONA_API_KEY=...
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...       # omit for long-lived credentials
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
```

The model route is `bedrock/us.anthropic.claude-opus-4-8`. It uses stock
mini-SWE-agent 2.4.5 at high reasoning effort plus the repository's Bedrock
credential-separation adapter.

The additive Task 5 configuration uses that route and
`bedrock/us.anthropic.claude-opus-5` under the same policy. The shared model
configuration sets a 32,768-token response cap. The stored Opus 5 Tasks 1–4
trials retain the report cohort's separate frozen identities and are provided
for evidence audit, not silently regenerated against the current task tree.

The adapter stores provider credentials in a named Bedrock profile and removes
their source variables before the agent phase. Commands issued by the model
therefore inherit the task image's emulator credentials. Before the first
model request, the adapter uses the repository's AWS SDK path to list the
emulator's buckets; a wrong endpoint or credential stops the trial before it
can enter the scored cohort.

These commands sample a new stochastic cohort; they cannot reproduce the exact
stored model outputs. All 80 recorded attempts are complete under the existing
`sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/` path: 32 historical
four-task Opus 4.8 trials, 32 report Opus 5 trials for Tasks 1–4, and 16 matched
Task 5 trials.

## Audit the stored evidence without model calls

Rebuild the trial index and pass-rate matrix directly from the included
verifier results:

```sh
python3 harness/summarize_report_opus5.py
python3 harness/summarize_task5.py
python3 harness/summarize_cohort.py
git diff --exit-code README.md sample-run/indexes \
  sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/README.md
```

## Launch a new cohort

The earlier four-task manifest records the exact prompt and policy used for the
stored 2026-08-18 evidence. Because the current Task 3 instruction and shared
token cap are intentionally different, keep that manifest as historical
evidence rather than regenerating it from the current tree.

To sample the current four task packages, run the oracle/no-op anchors and
cohort:

```sh
harbor run --config harness/controls.json --yes
harbor run --config harness/cohort.json --yes
```

The cohort configuration requests 32 concurrent attempts: eight attempts for
each of the four tasks. No provider preflight or infrastructure failure enters
the scored denominator.

To run Task 5's oracle/no-op controls and matched two-model cohort separately:

```sh
harbor run --config harness/task5-controls.json --yes
harbor run --config harness/task5-two-opus.json --yes
```

Before committing new evidence, redact credentials and rebuild the index and
README matrix from raw verifier outputs:

```sh
python3 harness/redact_artifacts.py
python3 harness/summarize_report_opus5.py
python3 harness/summarize_task5.py
python3 harness/summarize_cohort.py
```

A valid trial requires a numeric verifier reward, both trajectory formats, a
complete verifier artifact, and no Harbor exception. Preserve provider or
infrastructure failures as unscored evidence rather than counting them as task
failures.
