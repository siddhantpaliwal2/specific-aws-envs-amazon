# Task 14 raw cohort

This folder contains eight valid Claude Opus 4.8 trials and eight valid Claude
Opus 5 trials for `14-iam-role-validation`. Trial directories keep Harbor's
`task__run-id` naming convention used by the earlier shared raw cohort.

Each trial contains the normalized ATIF trajectory, native mini-SWE-agent
trajectory, readable transcript, result, lock, verifier reward, verifier report,
and verifier stdout. Agent trajectories, transcripts, verifier artifacts,
rewards, tokens, costs, and frozen identities are unchanged. Cohort-local paths
inside result and lock metadata were normalized to this additive destination
layout.
