# OpenCode Quality Router

Quality-first model selection and quota-aware fallback for native OpenCode agents.

Your primary agent chooses the model for each delegated task. The plugin checks that choice against the model catalog, your candidate allowlist, and current quota observations. If a provider fails, it continues the existing specialist session with the next eligible alternative.

**Tested with OpenCode 1.18.31 and Node.js 22+.** This is an experimental OpenCode 1.x plugin. Compatibility with OpenCode 2.x is not claimed.

## What it does

- Adds `quota_candidates` to inspect candidates, capability notes, quota, and reset times.
- Extends the native `task` tool with `model`, `model_reason`, and `model_order`.
- Keeps native agent prompts, task permissions, child sessions, and foreground cancellation behavior.
- Supports concurrent tasks with independent model choices, including tasks targeting the same specialist.
- Persists normalized quota observations and model failure cooldowns across restarts.
- Distinguishes provider-wide limits, model groups, account pools, and Copilot premium quota.
- Recovers primary agents without requiring an unavailable model to make a routing decision.
- Reports selected and actual models through logs, notifications, and task metadata.

## Quality policy

Quality is the objective. Cost, latency, and remaining quota percentage do not rank the models.

Each specialist has an allowlist of candidate models. Capability notes and evidence help the primary agent choose the best fit for a concrete task. The primary can also supply a task-specific alternative order through `model_order`.

The example ordering is an initial operator preference, **not a measured benchmark or a guarantee that one model is universally best**. Add your own task evaluations and update the notes as models change. The coordinator's judgment and the quality of these profiles determine the quality of selection. The plugin does not grade generated code or automatically escalate after a poor answer.

Quota is a separate eligibility check. A catalog entry does not prove available quota or account access. A percentage of available quota does not prove that every model in a group is usable.

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

1. Call `quota_candidates` for the specialist.
2. Read capability notes and availability.
3. Call native `task` with its selected model and quality rationale.

Example model-generated task arguments:

```json
{
  "description": "Improve dashboard accessibility",
  "subagent_type": "frontend-specialist",
  "model": "openai/gpt-6.1-sol",
  "model_reason": "Chosen for the implementation and verification demands of this task.",
  "model_order": [
    "openai/gpt-6.1-sol",
    "google/antigravity-claude-opus-4-6-thinking",
    "google/antigravity-gemini-3.1-pro"
  ],
  "prompt": "Inspect the existing dashboard. Fix keyboard navigation and contrast. Preserve its design language and verify the rendered result."
}
```

The example IDs are illustrative. A model must be in the specialist's allowlist and OpenCode's current catalog. Quota is rechecked before dispatch. If the requested model becomes blocked, the plugin chooses an eligible alternative from the task-specific order and then the configured order.

An unconfigured agent continues using native OpenCode behavior. A managed task without an explicit model uses the configured candidate order. Automatic model recovery does not change the specialist role.

## Configuration

The default file is `$XDG_CONFIG_HOME/opencode/quality-router.json`, or `~/.config/opencode/quality-router.json`. Set `OPENCODE_QUALITY_ROUTER_CONFIG` to an absolute path to use another file. Plugin tuple options can also specify `configPath` on hosts supporting that API.

| Setting                        | Default                                          | Meaning                                                                                         |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `agents`                       | Required                                         | Candidate profiles keyed by existing OpenCode agent name                                        |
| `agents.<name>.candidates`     | Required                                         | Quality preference order; each entry requires `model`                                           |
| Candidate `notes` / `evidence` | Optional                                         | Capability guidance and its provenance, shown to the coordinator                                |
| Candidate `variant`            | Optional                                         | Model-specific reasoning variant; verify supported variants in OpenCode                         |
| Candidate `billingGroup`       | `premium` for Copilot                            | `premium`, `chat`, or `completions`; only override after verifying the model's billing behavior |
| `quotaTtlMs`                   | `60000`                                          | Quota cache freshness period                                                                    |
| `failureCooldownMs`            | `900000`                                         | Temporary per-model block after a recoverable provider failure                                  |
| `retryDelayMs`                 | `1000`                                           | Delay before a recovery attempt                                                                 |
| `allowUnknownQuota`            | `true`                                           | Whether models with unconfirmed quota may be tried                                              |
| `preserveManualSelection`      | `true`                                           | Preserve eligible manually selected models inside configured routes                             |
| `authPath`                     | OpenCode's XDG data `auth.json`                  | Credential source for built-in quota queries                                                    |
| `statePath`                    | OpenCode's XDG state `quality-router/state.json` | Private normalized quota/cooldown state                                                         |
| `quota.<provider>.enabled`     | Disabled                                         | Explicitly enable a provider's quota query                                                      |

`model_order` can contain only unique models from that agent's allowlist. Unlisted candidates remain available afterward in configured order. Explicit choices outside the allowlist are rejected. Manual conversation choices outside a configured route are preserved and do not receive managed fallback.

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

Antigravity can return quota protection and account rate-limit notices as successful HTTP 200 text streams. The router recognizes exact notices from the Google provider, recovers the primary agent after it becomes idle, and returns a recovered specialist result to its parent through the native task hook. Ordinary explanations and quoted notices do not trigger recovery.

The example config uses `npx --no-install`; that works only when the package is already resolvable in the OpenCode process's working directory. Prefer an absolute installed CLI path for use across projects. Antigravity CLI may refresh credentials and update its own cache. Account rotation remains the authentication plugin's responsibility. Keep its account pool free of duplicates.

## Recovery behavior

The router attempts each candidate at most once per recovery chain. It handles quota exhaustion, provider authentication/access failures, unavailable models, and selected transient network/provider errors. It does not reroute safety refusals, canceled requests, rejected permissions, context overflow, or invalid tool schemas.

Known exhausted quota excludes the affected candidate until a refreshed observation indicates capacity. Reset timestamps are provider-reported; reaching one requires verification, not an assumption that every request will succeed. Undated exhaustion is rechecked on cache refresh. Query failures remain unknown; the local failure cooldown can still prevent repeated model attempts.

Recovery continues the existing session with a synthetic instruction to inspect completed actions before proceeding. It does not replay the original task or attachments. This reduces repeated work but **does not guarantee exactly-once execution of external side effects**: an upstream operation may complete before a network failure is reported. Recovered child results are injected into the parent's model context; failed task history is retained for audit.

Foreground native tasks are supported. Managed background tasks are rejected because their completion and recovery semantics differ. Title generation and compaction requests are not covered. No task runs while OpenCode is closed, and interrupted work is not automatically resumed on restart. Configured candidate variants should be checked against the installed model catalog.

## Privacy and cost

Credentials are read only for authenticated quota queries and never included in normalized state. The Antigravity adapter invokes the authentication plugin instead of copying its credentials. Stored account identifiers are anonymous indexes, and state files use owner-only permissions with locked atomic updates.

The public repository contains no personal accounts, keys, runtime state, or local backups. Protect your own configuration and credential files. Logs contain model IDs, not tokens or original provider response bodies. A model rationale is visible in local task metadata; avoid including secrets in it.

There is no spending cap. Adding a paid model to a candidate allowlist authorizes the router to use it during normal selection and recovery. Quality-first selection may choose expensive models. Add only providers you intend to use.

## Diagnostics

```sh
node src/cli.mjs check --config /absolute/path/to/quality-router.json
node src/cli.mjs quota --config /absolute/path/to/quality-router.json
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
```

Unit tests cover independent quota windows, account groups, reset interpretation, privacy, concurrent state writes, bounded fallback, cancellation, duplicate events, and recovered result delivery.

Integration tests launch the real OpenCode server against a synthetic localhost LLM. They verify explicit model selection, specialist recovery, coordinator recovery, denied task permissions, and concurrent delegation. They use isolated configuration and data directories and make no paid model calls. Set `OPENCODE_BIN` if OpenCode is not on your PATH. A cached OpenCode model catalog can avoid startup network requests.

## References

- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode 1.18.31 native task implementation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/task.ts)
- [Antigravity Auth](https://github.com/cortexkit/antigravity-auth)
- [Quota endpoint reference implementation](https://github.com/slkiser/opencode-quota)

## License

MIT. See [LICENSE](LICENSE).
