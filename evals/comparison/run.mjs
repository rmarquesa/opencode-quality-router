import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.mjs";
import { StateStore } from "../../src/store.mjs";
import { candidatesFor } from "../../src/routing.mjs";
import { capabilityEvidence } from "../../src/matrix.mjs";
import {
  candidateDetails,
  compactCandidate,
  selectionPolicy,
} from "../../src/decision.mjs";
import {
  accessEvidence,
  suitability,
  requirementsFor,
  comparisonShortlist,
} from "../../src/comparison.mjs";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
for (const name of ["--config", "--catalog", "--baseline", "--report-dir"])
  if (!args.includes(name)) throw Error(name + " required");
const config = await loadConfig({ configPath: arg("--config") });
if (config.providerEconomics?.openai?.billing !== "included")
  throw Error(
    "Evaluation requires a verified included OpenAI primary; metered calls are not authorized by this runner",
  );
const catalog = new Map(
  Object.entries(JSON.parse(await readFile(arg("--catalog"), "utf8"))),
);
const state = await new StateStore(config.statePath).read();
if (args.includes("--access"))
  state.access = {
    ...state.access,
    ...JSON.parse(await readFile(arg("--access"), "utf8")),
  };
const baseline = await import(pathToFileURL(arg("--baseline")));
const frozenNow = Date.now();
for (const [model, access] of Object.entries(state.access ?? {}))
  if (
    access.failureReason === "incompatible" &&
    access.lastFailureAt > (access.lastSuccessAt ?? 0) &&
    access.lastFailureAt + 86400000 > frozenNow
  )
    state.blocks[model] = {
      reason: "incompatible",
      until: access.lastFailureAt + 86400000,
    };
const allCases = [
  {
    id: "source-extraction",
    domain: "analysis",
    complexity: "simple",
    task: "Extract five explicit facts from a 200-word local document into a supplied JSON schema. Read-only, exact source anchors, parent verifies every field. Choose an adequate model without claiming broad domain superiority.",
    requirements: { toolCalling: true, contextTokens: 16000 },
  },
  {
    id: "small-html",
    domain: "frontend",
    complexity: "simple",
    task: "Adjust the label and aria-label of one existing HTML button. Preserve behavior and styling. Verify the exact diff and keyboard activation. No image input or architecture work is required.",
    requirements: { toolCalling: true, contextTokens: 16000 },
  },
  {
    id: "large-checkout",
    domain: "frontend",
    complexity: "complex",
    task: "Analyze 320000 tokens of supplied source as a single required context to redesign concurrent checkout state transitions, idempotency and payment error recovery. The context cannot be split for this case. Require reasoning, tools and executable state-transition tests.",
    requirements: { toolCalling: true, reasoning: true, contextTokens: 320000 },
  },
  {
    id: "visual-accessibility",
    domain: "frontend",
    complexity: "simple",
    task: "Compare attached before/after screenshots and fix a small contrast and focus-ring regression. Direct image-input support is mandatory; verify keyboard behavior and rendered result.",
    requirements: { toolCalling: true, imageInput: true, contextTokens: 16000 },
  },
  {
    id: "deployment-review",
    domain: "devops",
    complexity: "complex",
    task: "Independently review a deployment rollback plan with credential boundaries, durable volume migrations, concurrent release jobs and failure recovery. Require reasoning/tools, source evidence, isolated failure tests, and explicit unresolved risks.",
    requirements: { toolCalling: true, reasoning: true, contextTokens: 100000 },
  },
  {
    id: "bounded-debug",
    domain: "debugging",
    complexity: "simple",
    task: "A four-line seek-offset bug has an established root cause. Apply a minimal standard-library fix and run two deterministic regression tests. Do not invent a new architecture or infer model quality from its price.",
    requirements: { toolCalling: true, contextTokens: 16000 },
  },
];
const selectedCases = args.includes("--cases")
  ? arg("--cases").split(",")
  : allCases.map((c) => c.id);
const cases = allCases.filter((c) => selectedCases.includes(c.id));
if (
  !cases.length ||
  selectedCases.some((id) => !allCases.some((c) => c.id === id))
)
  throw Error("Unknown diagnostic case");
const modes = args.includes("--mode") ? [arg("--mode")] : ["before", "after"];
if (modes.some((m) => !["before", "after"].includes(m)))
  throw Error("Invalid diagnostic mode");
function comparison(c, mode) {
  const rows = candidatesFor(
    config,
    "frontend-specialist",
    catalog,
    state,
    frozenNow,
  )
    .map((x) => {
      const details = candidateDetails(config, x, catalog.get(x.model));
      const expectedFree = x.economics?.billing === "free";
      return {
        ...x,
        ...details,
        ...(expectedFree && details.economics.billing !== "free"
          ? { availability: { status: "blocked" } }
          : {}),
        assessment: capabilityEvidence(state, x.model, c.domain, c.complexity),
        access: accessEvidence(state, x.model, config.accessTtlMs, frozenNow),
        suitability: suitability(details, requirementsFor(c.requirements)),
      };
    })
    .filter((x) => x.availability.status !== "blocked")
    .sort((a, b) => a.model.localeCompare(b.model));
  const inspected =
    mode === "before" ? rows.slice(0, 12) : comparisonShortlist(rows);
  return {
    fullRows: rows,
    inspected,
    context: {
      objective: "value",
      requirements: c.requirements,
      candidate_index: rows.map((x) => ({
        model: x.model,
        billing: x.economics.billing,
      })),
      candidates: inspected.map(
        mode === "before" ? baseline.compactCandidate : compactCandidate,
      ),
      guidance:
        "Assess the concrete task using provided facts. Index membership does not mean model access is proven. Unknown quality is not failure.",
    },
  };
}
const reportDir = arg("--report-dir");
await mkdir(reportDir, { recursive: true, mode: 0o700 });
const temp = await mkdtemp(join(tmpdir(), "quality-comparison-live-"));
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const env = {
  ...process.env,
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    share: "disabled",
    autoupdate: false,
    small_model: "openai/gpt-6.1-sol",
    provider: {
      openai: {
        models: { "gpt-6.1-sol": { limit: { context: 400000, output: 4096 } } },
      },
    },
    agent: {
      "comparison-evaluation": {
        mode: "primary",
        permission: { "*": "deny" },
        prompt:
          "This is a read-only model-choice diagnostic. Generate no code or tool calls. Return the requested JSON only.",
      },
    },
  }),
};
delete env.OPENCODE_SERVER_PASSWORD;
delete env.OPENCODE_SERVER_USERNAME;
const host = spawn(
  process.env.OPENCODE_BIN ?? "opencode",
  ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "",
  base;
host.stdout.on("data", (x) => (logs += x));
host.stderr.on("data", (x) => (logs += x));
const api = async (path, method = "GET", body) => {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Error("Native API HTTP " + r.status);
  return r.status === 204 ? undefined : r.json();
};
const records = [];
try {
  const deadline = Date.now() + 30000;
  while (!base) {
    base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (Date.now() > deadline) throw Error("Evaluation host startup timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const c of cases)
    for (const mode of modes) {
      const data = comparison(c, mode);
      let session;
      const record = {
        case: c.id,
        mode,
        inspectedModels: data.inspected.map((x) => x.model),
        status: "invalid",
      };
      try {
        session = await api("/session", "POST", {
          title: "Router comparison " + c.id + " " + mode,
        });
        const policy =
          mode === "before"
            ? baseline.selectionPolicy(config)
            : selectionPolicy(config);
        const response = await api(`/session/${session.id}/message`, "POST", {
          agent: "comparison-evaluation",
          model: { providerID: "openai", modelID: "gpt-6.1-sol" },
          variant: "high",
          parts: [
            {
              type: "text",
              text:
                policy +
                "\nFor this diagnostic the candidate consultation is supplied below. Do not call tools or delegate. You may choose from the index, but identify which comparisons rely on inspected facts.\nTASK: " +
                c.task +
                "\n" +
                JSON.stringify(data.context) +
                "\nReturn JSON: {selectedModel, modelReason, comparison:[{model,fit:suitable|unsuitable,reason}], alternatives:[model IDs]}. Every chosen/fallback model must be suitable; explain the task-specific tradeoff. Do not claim this proves model quality.",
            },
          ],
        });
        const text = response.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        record.actualPrimary =
          response.info.providerID + "/" + response.info.modelID;
        record.requestedVariant = "high";
        record.reportedVariant = response.info.variant;
        record.finish = response.info.finish;
        record.tokens = response.info.tokens;
        record.reportedCost = response.info.cost;
        await writeFile(
          join(reportDir, c.id + "-" + mode + "-trace.json"),
          JSON.stringify(
            {
              info: {
                providerID: response.info.providerID,
                modelID: response.info.modelID,
                variant: response.info.variant,
                finish: response.info.finish,
                errorName: response.info.error?.name,
                tokens: response.info.tokens,
                cost: response.info.cost,
              },
              parts: response.parts.filter((p) =>
                ["text", "reasoning"].includes(p.type),
              ),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        if (response.info.error || response.info.finish !== "stop")
          throw Error("Provider error or incomplete answer");
        const answer = JSON.parse(
          text
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, ""),
        );
        const choices = [answer.selectedModel, ...(answer.alternatives ?? [])];
        const byModel = new Map(
          (answer.comparison ?? []).map((x) => [x.model, x]),
        );
        record.answer = answer;
        record.checks = {
          eligible: choices.every((m) =>
            data.fullRows.some((x) => x.model === m),
          ),
          requirements: choices.every(
            (m) =>
              data.fullRows.find((x) => x.model === m)?.suitability.status !==
              "incompatible",
          ),
          inspectedChoices: choices.every((m) =>
            data.inspected.some((x) => x.model === m),
          ),
          explicitSuitableChoices: choices.every(
            (m) => byModel.get(m)?.fit === "suitable",
          ),
          distinctInspectedComparison:
            new Set(
              (answer.comparison ?? [])
                .filter((x) => data.inspected.some((c) => c.model === x.model))
                .map((x) => x.model),
            ).size >= Math.min(2, data.fullRows.length),
          reasons:
            (answer.comparison ?? []).every(
              (x) => typeof x.reason === "string" && x.reason.trim(),
            ) && !!answer.modelReason,
        };
        record.status = "scored";
        record.passed = Object.values(record.checks).every(Boolean);
      } catch (e) {
        record.error = e.message;
      } finally {
        if (session) {
          await api(`/session/${session.id}/abort`, "POST").catch(() => {});
          await api(`/session/${session.id}`, "DELETE").catch(() => {});
        }
      }
      records.push(record);
      await writeFile(
        join(reportDir, "results.json"),
        JSON.stringify(
          {
            frozenAt: new Date(frozenNow).toISOString(),
            scope:
              "Bounded choice diagnostic, not generated-task quality or complete delegation loop",
            records,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          case: c.id,
          mode,
          status: record.status,
          passed: record.passed,
          selected: record.answer?.selectedModel,
          error: record.error,
        }),
      );
    }
} finally {
  host.kill("SIGKILL");
  host.stdout.destroy();
  host.stderr.destroy();
}
