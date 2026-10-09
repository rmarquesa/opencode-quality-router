# OpenCode Quality Router

Task-specific model selection with quality or quality/cost objectives and quota-aware fallback for native OpenCode agents.

Your primary agent chooses the model for each delegated task. The plugin checks that choice against the model catalog, your candidate allowlist, and current quota observations. If a provider fails, it continues the existing specialist session with the next eligible alternative.

**Tested with OpenCode 1.18.31 and Node.js 22+.** This is an experimental OpenCode 1.x plugin. Compatibility with OpenCode 2.x is not claimed.

## What it does

- Adds `quota_candidates` to inspect candidates, capability notes, quota, and reset times.
- Extends the native `task` tool with `task_domain`, `task_complexity`, `model`, `model_reason`, and `model_order`.
- Keeps native agent prompts, task permissions, child sessions, and foreground cancellation behavior.
- Supports concurrent tasks with independent model choices, including tasks targeting the same specialist.
- Persists normalized quota observations and model failure cooldowns across restarts.
- Distinguishes provider-wide limits, model groups, account pools, and Copilot premium quota.
- Recovers primary agents without requiring an unavailable model to make a routing decision.
- Reports selected and actual models through logs, notifications, and task metadata.

## Selection policy

Set `objective` to `"value"` for task-specific quality/cost decisions or `"quality"` to maximize quality regardless of cost. Existing configs default to `"quality"`; the example config uses `"value"`.

In value mode, the primary agent analyzes the task's complexity, risks, capabilities, context and acceptance checks. It compares models capable of doing that task using capability notes, evidence, catalog capabilities and account economics. It should choose a less costly adequate model when a more costly option offers no meaningful expected quality gain, and justify extra cost for tasks where it does. This is a coordinator decision, not a fixed formula dividing an invented quality score by a price.

`quota_candidates` supplies model input/output/cache reference rates, context pricing tiers, context limits, reasoning/tool/image capabilities, account billing mode and available quota. In value mode `candidate_index` lists every eligible model and billing mode alphabetically without a recommendation rank. Detail rows default to 12 per page, avoiding native tool-output truncation for large catalogs. Inspect relevant entries with `models: ["provider/model", ...]` (up to 20), or follow `next_offset` using `offset`; `include_blocked: true` includes blocked rows in page inspection. `details: true` returns full notes and quota windows for the inspected page. The primary must consult the tool with a concrete `task` summary, `task_domain` and `task_complexity` in the current parent session (consultation expires after five minutes), then provide the matching `task_domain`/`task_complexity`, `model`, a nonempty `model_reason` comparing quality/cost, and `model_order` with the acceptable alternatives. Delegations missing that decision are rejected for the primary to reassess. Recovery stays inside the selected model and the assessed alternatives, preserving the primary's order. Use `[]` when there are no acceptable alternatives; the plugin stops rather than silently switching to an unassessed expensive model.

Configure `providerEconomics` for your actual account. Candidate `economics` overrides a provider entry. Billing may be `free`, `included`, `metered`, or `unknown`. Use `free` only for a provider offer you have verified. A configured free candidate is blocked if its current catalog rates are missing or no longer zero, preventing a promotion ending from silently enabling a paid route. Zero rates alone never imply a free offer. Included subscription quota is a resource, not an API token charge. Zero catalog prices do not prove free or unlimited use. Missing costs and model-specific quota consumption remain unknown. `quotaUnitsPerRequest` is optional and should be set only from verified provider/account evidence; the plugin never guesses a multiplier from a model name or API price.

For example, configure a verified subscription account as follows:

```json
{
  "objective": "value",
  "providerEconomics": {
    "openai": {
      "billing": "included",
      "source": "Your verified ChatGPT OAuth subscription",
      "notes": "Included plan capacity; model-specific quota consumption is unknown."
    }
  }
}
```

Each successful candidate consultation authorizes one managed delegation in value mode. Multiple concurrent tasks, including tasks of the same domain/complexity on the same agent, each need their own consultation; a consultation cannot be reused for unrelated work. In quality mode, cost and latency do not rank models. Missing task choices still use configured candidate order, and alternatives omitted from `model_order` remain available afterward.

Capability notes and configured ordering are operator preferences or hypotheses, **not measured benchmarks or a guarantee that one model is universally best**. The quality of selection depends on the coordinator's judgment and available evidence. The plugin validates explicit decisions; it does not validate the truth of a rationale, grade generated code, or automatically escalate after a poor answer. The primary is instructed to verify results and reassess task fit if acceptance checks fail. Initial primary-agent selection remains configured by OpenCode. Use a suitable workhorse model for the primary instead of making every role default to a flagship. With `preserveManualSelection: false`, an old session carrying a managed model switches to the first eligible configured candidate at its next user turn after the plugin is reloaded; running generations are not interrupted. Delegated tasks still honor their explicit choices independently.

Quota is an eligibility check. Catalog membership does not prove available capacity or access, and remaining quota percentage is not a quality/efficiency score. Reference prices come from OpenCode's model catalog and may be stale or account-specific placeholders; they are never confirmed actual charges. Verify billing terms before using them as financial estimates.

## Capability matrix

The matrix has one row per configured provider/model and separate cells for frontend, coding, debugging, security, devops and analysis, each at simple/complex task complexity. Cells start unmeasured. Actual evaluation records can populate only the matching cell; a provider failure is unavailable, not a failed quality score. Results do not transfer across providers, domains or complexity. Tested reasoning variants are reported; a result at a low variant does not prove performance at every other setting. The coordinator receives the relevant cell in `quota_candidates` and uses it as limited evidence rather than an automatic universal ranking.

Native smoke evaluation instructions, independent verifiers and an agent-reviewed draft spec are under `evals/model-routing`. The runner uses configured OpenCode authentication, fresh sessions, an empty working directory, denied tools and no model judge. It evaluates response-level reasoning; it does not establish frontend/code/security competence. It keeps every catalog row, including rows skipped for quota, access, unknown rates or the reference-price budget. Actual output-budget/timeouts remain invalid trials. Local transcripts and reports must remain private.

```sh
node evals/model-routing/run.mjs \
  --catalog /private/path/to/opencode-model-catalog.json \
  --config /private/path/to/quality-router.json \
  --report-dir /private/path/to/evidence \
  --max-reference-usd 0
```

The catalog argument is a JSON object mapping `provider/model` to native OpenCode model metadata. Metered attempts default to a zero budget. A positive budget reserves conservative catalog-reference input/output costs before each request and settles completed reservations using native reported cost; unknown completion costs retain their reservation. This is not a confirmed invoice or a provider-enforced spending cap. Native reported usage/cost is retained separately. Classified provider failures also enter the normal model cooldown. The CLI matrix export can be used without generating model responses:

```sh
node src/cli.mjs matrix --catalog /private/path/to/opencode-model-catalog.json --config /private/path/to/quality-router.json
```

## Installation

1. Install OpenCode 1.18.31 or use the exact version you intend to validate.
2. Clone this repository and install its dependencies:

   ```sh
   git clone https://github.com/rmarquesa/opencode-quality-router.git
   cd opencode-quality-router
   npm ci
   ```

3. Copy `examples/quality-router.json` to your global OpenCode configuration directory, normally `~/.config/opencode/quality-router.json`. Adjust the candidate IDs to match `opencode models` and configure the adapters you use.
4. Add the absolute path of `src/index.mjs` to the `plugin` array in your existing `opencode.jsonc`:

   ```jsonc
   {
     "plugin": ["/absolute/path/to/opencode-quality-router/src/index.mjs"],
   }
   ```

5. Define the corresponding agents in OpenCode. See `examples/opencode.jsonc` for a coordinator and a frontend specialist. Keep any existing prompts and permissions you need.
6. Remove other automatic model-routing plugins to avoid conflicting selection or duplicate retries. Keep provider authentication plugins, such as Antigravity Auth.
7. Restart OpenCode.

This repository is not published to the npm registry. The local-file installation above is the supported installation path for this release.

Provider credentials must already be configured in OpenCode. This plugin neither creates subscriptions nor supplies API keys.

## Using the router

Ask your primary agent to perform a task normally. The plugin adds routing instructions to managed primary agents. The coordinator should:

1. Classify this task and call `quota_candidates` with the specialist, task summary, `task_domain` and `task_complexity`.
2. Assess the task, then compare capability evidence, availability and economics.
3. Call native `task` with its selected model, quality/cost rationale and acceptable alternative order.

Example model-generated task arguments:

```json
{
  "description": "Improve dashboard accessibility",
  "subagent_type": "frontend-specialist",
  "task_domain": "frontend",
  "task_complexity": "simple",
  "model": "openai/gpt-6.1-sol",
  "model_reason": "This bounded accessibility change needs implementation and browser verification. This model is an adequate candidate; more expensive reasoning is not justified by the current scope. Compare the configured billing and quota evidence before dispatch.",
  "model_order": [
    "openai/gpt-6.1-sol",
    "google/antigravity-claude-opus-4-6-thinking",
    "google/antigravity-gemini-3.1-pro"
  ],
  "prompt": "Inspect the existing dashboard. Fix keyboard navigation and contrast. Preserve its design language and verify the rendered result."
}
```

The example IDs are illustrative. A model must be in the specialist's allowlist and OpenCode's current catalog. Quota is rechecked before dispatch. If the requested model becomes blocked, value mode chooses an eligible assessed alternative. Quality mode also permits the remaining configured candidates afterward.

An unconfigured agent continues using native OpenCode behavior. In value mode a managed task must include an explicit model, rationale and alternative order. In quality mode a task without an explicit model uses the configured candidate order. Automatic model recovery does not change the specialist role.

## Configuration

The default file is `$XDG_CONFIG_HOME/opencode/quality-router.json`, or `~/.config/opencode/quality-router.json`. Set `OPENCODE_QUALITY_ROUTER_CONFIG` to an absolute path to use another file. Plugin tuple options can also specify `configPath` on hosts supporting that API.

| Setting                        | Default                                          | Meaning                                                                                         |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `objective`                    | `quality`                                        | `quality` or `value`; value requires a task-specific explicit decision                          |
| `providerEconomics`            | Unconfigured                                     | Billing/usage guidance keyed by provider ID                                                     |
| Candidate `economics`          | Provider setting or unknown                      | Account billing, source, notes and optional verified `quotaUnitsPerRequest`                     |
| `agents`                       | Required                                         | Candidate profiles keyed by existing OpenCode agent name                                        |
| `agents.<name>.candidates`     | Required                                         | Quality preference order; each entry requires `model`                                           |
| Candidate `notes` / `evidence` | Optional                                         | Capability guidance and its provenance, shown to the coordinator                                |
| Candidate `variant`            | Optional                                         | Model-specific reasoning variant; verify supported variants in OpenCode                         |
| Candidate `billingGroup`       | `premium` for Copilot                            | `premium`, `chat`, or `completions`; only override after verifying the model's billing behavior |
| `quotaTtlMs`                   | `60000`                                          | Quota cache freshness period                                                                    |
| `failureCooldownMs`            | `900000`                                         | Temporary per-model block after a recoverable provider failure                                  |
| `compatibilityCooldownMs`      | `86400000`                                       | Block a model for 24 hours after an unsupported account service tier                            |
| `retryDelayMs`                 | `1000`                                           | Delay before a recovery attempt                                                                 |
| `allowUnknownQuota`            | `true`                                           | Whether models with unconfirmed quota may be tried                                              |
| `preserveManualSelection`      | `true`                                           | Preserve eligible manually selected models inside configured routes                             |
| `authPath`                     | OpenCode's XDG data `auth.json`                  | Credential source for built-in quota queries                                                    |
| `statePath`                    | OpenCode's XDG state `quality-router/state.json` | Private normalized quota/cooldown state                                                         |
| `quota.<provider>.enabled`     | Disabled                                         | Explicitly enable a provider's quota query                                                      |

`model_order` can contain only unique models from that agent's allowlist. In quality mode unlisted candidates remain available afterward in configured order; in value mode child recovery uses only the selected model and listed alternatives. Explicit choices outside the allowlist are rejected. Manual conversation choices outside a configured route are preserved and do not receive managed fallback.

When a previous automatic fallback model is carried into a later turn, the router can return to a higher-preference model if its quota and cooldown permit it. It cannot always distinguish a manual re-selection of the same model from the UI carrying that automatic selection forward.

Setting `allowUnknownQuota: false` is stricter, but may leave no eligible candidates if credentials expire or a quota endpoint is unavailable.

## Quota integrations

| Provider ID      | Source                                          | Scope and limitations                                                                                |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `opencode-go`    | Authenticated `/zen/go/v1/usage`                | Rolling, weekly, and monthly windows; any exhausted window blocks candidates                         |
| `google`         | Antigravity Auth's `quota --json --refresh` CLI | Per-account Gemini/non-Gemini groups; one available account can keep a group eligible                |
| `github-copilot` | Authenticated `/copilot_internal/user`          | Premium/chat/completions snapshots and reset date; REST API rate-limit headers are not Copilot quota |
| `openai`         | Authenticated ChatGPT `/backend-api/wham/usage` | Account windows and reported model availability; uses OpenCode OAuth, not an OpenAI API key          |
| `opencode` (Zen) | Not implemented for API-key credentials         | Balance remains unknown; an API key accepting a model-list request does not prove available credit   |

These integrations include provider-internal endpoints and may change without notice. A failed query becomes `unknown`; it is never translated into a fabricated reset date or balance. OAuth refresh is handled by OpenCode/provider authentication integrations, not by this plugin's Go/Copilot/OpenAI quota fetcher. An expired access token may require refreshing authentication in OpenCode and retrying the quota query.

### Antigravity setup

Install a compatible `@cortexkit/opencode-antigravity-auth` CLI and set `quota.google.command` to its executable and arguments. The plugin calls it without a shell. For a local installation:

```json
{
  "quota": {
    "google": {
      "enabled": true,
      "command": [
        "node",
        "/absolute/path/to/node_modules/@cortexkit/opencode-antigravity-auth/dist/cli.js",
        "quota",
        "--json",
        "--refresh"
      ]
    }
  }
}
```

The router reads Antigravity's global `antigravity.json` (respecting `OPENCODE_CONFIG_DIR`) and the current project's `.opencode/antigravity.json`. The project setting takes precedence. Its default `soft_quota_threshold_percent: 80` reserves the last 20% of quota, so those accounts are excluded even when they still report capacity. To use the remaining quota, set `soft_quota_threshold_percent: 100` in Antigravity's configuration and restart every OpenCode instance. This does not replenish exhausted quota. If needed, set `antigravityConfigPath` or `quota.google.softQuotaThresholdPercent` in the router config; an explicit router override must match the authentication plugin's effective setting. Changing the threshold invalidates the quota cache.

Antigravity can return quota protection and account rate-limit notices as successful HTTP 200 text streams. For a newly delegated managed task, an exact Google quota-only response is rejected by the native task after-hook, so the host stores a task error rather than a completed specialist answer. The router recognizes exact notices from the Google provider, recovers the primary agent after it becomes idle, and returns a recovered specialist result to its parent through the native task hook. If an older completed quota-notice task cannot be recovered, it becomes an error in the parent model context; the original stored history remains available for audit. Ordinary explanations and quoted notices do not trigger recovery.

The example config uses `npx --no-install`; that works only when the package is already resolvable in the OpenCode process's working directory. Prefer an absolute installed CLI path for use across projects. Antigravity CLI may refresh credentials and update its own cache. Account rotation remains the authentication plugin's responsibility. Keep its account pool free of duplicates.

## Recovery behavior

The router attempts each candidate at most once per recovery chain. It handles quota exhaustion, provider authentication/access failures, unavailable models, HTTP 410, explicitly retired models, unsupported account service tiers (including the observed HTTP 400 `Unsupported service_tier: flex`), and selected transient network/provider errors. Unrelated HTTP 400 input errors remain terminal. It does not reroute safety refusals, canceled requests, rejected permissions, context overflow, or invalid tool schemas.

Known exhausted quota excludes the affected candidate until a refreshed observation indicates capacity. Reset timestamps are provider-reported; reaching one requires verification, not an assumption that every request will succeed. Undated exhaustion is rechecked on cache refresh. Query failures remain unknown; the local failure cooldown can still prevent repeated model attempts.

Models explicitly reported as deprecated/retired are persistently blocked until an operator clears the block; stale catalog membership does not re-enable them. Unsupported service tiers use `compatibilityCooldownMs` (24 hours by default), while ordinary failures use `failureCooldownMs`. Native catalog entries marked deprecated, retired or disabled are also excluded. If provider access is restored, clear only the relevant observed block:

```sh
node src/cli.mjs unblock --model provider/model --config /absolute/path/to/quality-router.json
```

Clearing a block does not bypass exhausted quota or a catalog deprecation flag. Availability reported by a quota adapter confirms capacity only; it does not prove that the account supports every catalog model or service tier.

Recovery continues the existing session with a synthetic instruction to inspect completed actions before proceeding. It does not replay the original task or attachments. This reduces repeated work but **does not guarantee exactly-once execution of external side effects**: an upstream operation may complete before a network failure is reported. Recovered child results are injected into the parent's model context; failed task history is retained for audit.

Foreground native tasks are supported. Managed background tasks are rejected because their completion and recovery semantics differ. Title generation and compaction requests are not covered. No task runs while OpenCode is closed, and interrupted work is not automatically resumed on restart. Configured candidate variants should be checked against the installed model catalog. After a restart, a child whose task-specific alternative list is no longer retained cannot silently use the full catalog in value mode; its parent must make a new justified delegation.

## Privacy and cost

Credentials are read only for authenticated quota queries and never included in normalized state. The Antigravity adapter invokes the authentication plugin instead of copying its credentials. Stored account identifiers are anonymous indexes, and state files use owner-only permissions with locked atomic updates.

The public repository contains no personal accounts, keys, runtime state, or local backups. Protect your own configuration and credential files. Logs contain model IDs, not tokens or original provider response bodies. A model rationale is visible in local task metadata; avoid including secrets in it.

There is no spending cap. Adding a paid model to a candidate allowlist authorizes the router to use it during normal selection and recovery. Both objectives may choose expensive models when the coordinator judges the task requirements justify them. Value mode is not a hard spending cap. Add only providers you intend to use.

## Diagnostics

```sh
node src/cli.mjs check --config /absolute/path/to/quality-router.json
node src/cli.mjs quota --config /absolute/path/to/quality-router.json
node src/cli.mjs unblock --model provider/model --config /absolute/path/to/quality-router.json
```

The quota command queries status, not model generation. Its output omits credentials and email addresses. A successful quota query confirms the status contract, not model output quality.

If no model is eligible, inspect exhausted windows, refresh authentication, confirm `opencode models`, or add another candidate with capacity. If task arguments do not include `model`, check that the primary agent can access `quota_candidates` and is following the injected routing instructions. Do not run two model-routing plugins together.

To uninstall, remove this plugin entry and restart OpenCode. Existing agent definitions remain valid. Restore your previous model settings if you changed them during installation. You can retain the private quota state or delete it manually.

## Development and verification

```sh
npm ci
npm run check
npm test
npm run test:integration
node test/native-integration.mjs --root
node test/native-integration.mjs --permissions
node test/native-integration.mjs --concurrent
node test/native-integration.mjs --order
node test/native-integration.mjs --synthetic
node test/native-integration.mjs --synthetic --root
node test/native-integration.mjs --value
node test/native-integration.mjs --value-exhausted
node test/native-integration.mjs --value-free --concurrent
node test/native-integration.mjs --migration
```

Unit tests cover independent quota windows, account groups, reset interpretation, privacy, concurrent state writes, bounded fallback, cancellation, duplicate events, recovered result delivery, explicit value decisions, unknown costs, account/catalog price separation, cell isolation and independent smoke verifiers.

Integration tests launch the real OpenCode server against a synthetic localhost LLM. They verify explicit model selection, specialist recovery, coordinator recovery, denied task permissions, concurrent delegation, value-oriented cost context stopping when all assessed alternatives fail, and using a free model for one task and a different model for another task on the same specialist, and replacing a carried old session model at its next user turn. They use isolated configuration and data directories and make no paid model calls. Set `OPENCODE_BIN` if OpenCode is not on your PATH. A cached OpenCode model catalog can avoid startup network requests.

## References

- [OpenCode Zen pricing](https://opencode.ai/docs/zen/#pricing)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode 1.18.31 native task implementation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/task.ts)
- [Antigravity Auth](https://github.com/cortexkit/antigravity-auth)
- [Quota endpoint reference implementation](https://github.com/slkiser/opencode-quota)

## License

MIT. See [LICENSE](LICENSE).
