# Reproducing the eight-rollout cohort

## Prerequisites

- Harbor 0.18.0 and mini-SWE-agent 2.4.5
- Python 3 and Git
- Daytona access for isolated sandboxes
- Amazon Bedrock credentials authorized for the configured Claude Opus 4.8
  inference profile

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

The adapter stores provider credentials in a named Bedrock profile and removes
their source variables before the agent phase. Commands issued by the model
therefore inherit the task image's emulator credentials. Before the first
model request, the adapter uses the repository's AWS SDK path to list the
emulator's buckets; a wrong endpoint or credential stops the trial before it
can enter the scored cohort.

These commands sample a new stochastic cohort; they cannot reproduce the exact
stored model outputs. The recorded attempts are complete under
`sample-run/raw/amazon-opus-4-8-four-task-cohort-20260818/`.

## Audit the stored evidence without model calls

Rebuild the trial index and pass-rate matrix directly from the included
verifier results:

```sh
python3 harness/summarize_cohort.py
git diff --exit-code README.md sample-run/indexes
```

## Launch a new cohort

Verify the frozen inputs, run the oracle/no-op anchors, and execute the cohort:

```sh
python3 harness/freeze_manifest.py
git diff --exit-code sample-run/manifests/frozen-cohort.json
harbor run --config harness/controls.json --yes
harbor run --config harness/cohort.json --yes
```

The cohort configuration requests 32 concurrent attempts: eight attempts for
each of the four tasks. No provider preflight or infrastructure failure enters
the scored denominator.

Before committing new evidence, redact credentials and rebuild the index and
README matrix from raw verifier outputs:

```sh
python3 harness/redact_artifacts.py
python3 harness/summarize_cohort.py
```

A valid trial requires a numeric verifier reward, both trajectory formats, a
complete verifier artifact, and no Harbor exception. Preserve provider or
infrastructure failures as unscored evidence rather than counting them as task
failures.
