# Task: native model suitability smoke

**Status:** Draft — agent-reviewed for the user's end-to-end implementation/test request; not a human-reviewed benchmark.

## Purpose and source evidence

The global configuration and recent native message metadata showed repeated Astra use across build and specialists. Evaluate the routing mechanics separately from limited model-output capability evidence. Each provider/model is a distinct matrix row. Tests must not infer quality from price, size, a quota failure or another provider's result.

## Agent input and hidden truth

The two complete instructions are in `../../cases.mjs`: stable priority ordering (analysis/simple) and dependency scheduling with missing dependencies and cycles (analysis/complex). Each prompt supplies all relevant facts. Expected answers and verifier code stay outside the native session. Models receive only the instruction and a no-tools system prompt.

## Harness and environment

Use actual OpenCode 1.18.31, native configured provider authentication, a temporary empty working directory, a fresh session per trial and an unmanaged router-evaluation agent. Deny all tools. This is the existing native harness rather than a Harbor reconstruction; it measures response-level reasoning, not repository editing, browser/UI work or full agent competence. The user’s running project sessions are neither resumed nor aborted. Only evaluation sessions are deleted after their transcripts are saved privately.

## Verification and fairness

Pass iff the JSON answer satisfies the case's independently fixed scheduling/order result. Stable tie ordering and alphabetical output are explicit requirements. Code fences around correct JSON are accepted. Test the reference, plausible wrong ordering, invalid JSON and missing fields. Do not execute generated code or use a model judge.

Provider quota/auth/access errors and timeouts get `unavailable` or `invalid`, never a quality score. A length-limited response gets `invalid`. A completed, non-truncated wrong answer gets one case failure. A result from one domain or complexity is not extrapolated to another. A single trial cannot establish a general ranking. Do not set a one-step agent limit: OpenCode adds a maximum-step instruction that contaminates JSON-only answers. The initial run using that setting was invalidated in local state, including its passing records.

## Run plan

Catalog scope: every model exposed by the five configured providers. Two cases/model, one trial/case, no LLM judge, 35 seconds/request, native output limit 1024 tokens. Quota-blocked rows are retained as unavailable. Metered attempts require a conservative reference-price reservation under the CLI budget (default zero); this requested bounded run uses a maximum USD 1 reference budget. Completed reservations settle against native reported reference cost; uncertain completions keep the full reservation. Actual native reported cost is retained separately and is not a confirmed invoice. Refresh/model-rate errors and unknown metered rates are skipped. No automatic retries of provider failures. All outputs/traces remain private local artifacts.

## Remaining limits

This is not a validated broad benchmark. Frontend, coding, debugging, security and devops cells remain unmeasured until representative independent-verifier tasks are added. Subscription quota multipliers are unknown. Real invoice cost and hidden provider retries cannot be proven from native cost metadata. Native function/permission routing tests cover task selection, session migration and failure semantics separately.
