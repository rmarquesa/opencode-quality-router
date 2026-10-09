const QUALITY =
  "Maximize task-specific quality. Cost and latency do not rank models.";
const VALUE =
  "First analyze this concrete task, even if the same agent handled a different task before. Assess complexity, risk, required capabilities, context, acceptance checks and likely retries. Judge task-specific suitability and expected quality before comparing cost. Model size, price, provider and configured rank are not evidence of quality. For simple work, a verified free model may be sufficient. For complex work choose the best-suited model, which may also be free or smaller; do not default to the largest model. Compare costs among sufficiently suitable options and pay more only for a meaningful expected quality gain for this task. Subscription quota is a resource, not an API token charge. Unknown cost is not zero cost. Catalog API prices are reference rates, not proof of what this account pays. Do not invent quality scores or quota multipliers.";
export function selectionPolicy(config) {
  return `Quality Router objective: ${config.objective}. ${config.objective === "value" ? VALUE : QUALITY} Before every delegation to a managed agent, call quota_candidates with agent, a concise task summary, task_domain (frontend/coding/debugging/security/devops/analysis) and task_complexity (simple/complex). In value mode, candidate_index covers every eligible model; detail rows are paged. Use models to inspect task-suitable entries from that index, including free/included options, or offset to page further before deciding. Inspect the matching capability assessment cell: unmeasured is unknown, not zero; a small smoke test is limited evidence, not a benchmark of an entire domain. Do not transfer a simple-task result to complex work or a result across providers. Compare eligible candidates using capability notes, evidence, catalog capabilities and economics. Use native task with the same task_domain and task_complexity, model, model_reason (explain task requirements, the quality/cost tradeoff and a relevant alternative), and model_order. ${config.objective === "value" ? "These fields are required. Include only acceptable alternatives, ordered by value for this task; omitted models will not be used for child recovery." : "Order alternatives by quality for this task."} Candidate order is an operator preference, not a measured benchmark. Unknown quota is not confirmed capacity. Include context, constraints and acceptance checks in task.prompt. Verify specialist results and reassess task fit with a new justified model choice if acceptance checks fail; provider fallback does not grade quality. Preserve native task permissions and do not repeat completed actions after recovery.`;
}

const number = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
function rates(cost) {
  if (!cost) return;
  const input = number(cost.input),
    output = number(cost.output);
  if (input === undefined || output === undefined) return;
  return {
    input,
    output,
    cacheRead: number(cost.cache?.read),
    cacheWrite: number(cost.cache?.write),
  };
}
export function candidateDetails(config, candidate, model) {
  const provider = candidate.model.split("/")[0];
  const economics =
    candidate.economics ?? config.providerEconomics?.[provider] ?? {};
  const price = rates(model?.cost);
  const verifiedZero =
    price &&
    price.input === 0 &&
    price.output === 0 &&
    (price.cacheRead ?? 0) === 0 &&
    (price.cacheWrite ?? 0) === 0 &&
    (model.cost.tiers ?? []).every((t) => t.input === 0 && t.output === 0) &&
    (!model.cost.experimentalOver200K ||
      (model.cost.experimentalOver200K.input === 0 &&
        model.cost.experimentalOver200K.output === 0));
  const billing =
    economics.billing === "free" && !verifiedZero
      ? "unknown"
      : (economics.billing ?? "unknown");
  return {
    catalog: {
      name: model?.name,
      contextTokens: number(model?.limit?.context),
      outputTokens: number(model?.limit?.output),
      reasoning: model?.capabilities?.reasoning,
      toolCalling: model?.capabilities?.toolcall,
      imageInput: model?.capabilities?.input?.image,
      status: model?.status,
    },
    economics: {
      billing,
      source: economics.source ?? "unconfigured",
      notes: economics.notes,
      quotaUnitsPerRequest: number(economics.quotaUnitsPerRequest),
      apiReferencePrice: price
        ? {
            source: "OpenCode model catalog",
            currency: "USD",
            unit: "per_million_tokens",
            ...price,
            contextTiers: model.cost.tiers?.map((t) => ({
              contextTokens: number(t.tier?.size),
              ...rates(t),
            })),
            over200k: rates(model.cost.experimentalOver200K),
            actualChargeConfirmed: false,
          }
        : { source: "unavailable", actualChargeConfirmed: false },
      usageGuidance:
        billing === "free"
          ? "Configured verified free offer and current catalog has zero rates. Access and rate-limit capacity remain subject to provider verification."
          : economics.billing === "free"
            ? "Configured free offer cannot be confirmed against current catalog rates; do not dispatch this candidate as free."
            : billing === "included"
              ? "Uses included plan capacity; API reference price is not an incremental token charge. Quota impact is unknown unless configured."
              : "Actual charges and quota impact depend on this account's contract; unknown fields must not be treated as free.",
    },
  };
}

export function taskDecision(config, agent, args) {
  const models = config.agents[agent].candidates.map((c) => c.model);
  if (args.model && !models.includes(args.model))
    throw new Error(`Model is outside candidate allowlist for ${agent}`);
  const order = args.model_order;
  if (
    order !== undefined &&
    (!Array.isArray(order) ||
      new Set(order).size !== order.length ||
      order.some((m) => !models.includes(m)))
  )
    throw new Error("Invalid task-specific model order");
  if (config.objective === "value") {
    if (
      !args.model ||
      typeof args.model_reason !== "string" ||
      !args.model_reason.trim() ||
      !Array.isArray(order)
    )
      throw new Error(
        "Value routing requires model, a nonempty model_reason comparing quality/cost, and model_order (use [] for no acceptable alternatives). Consult quota_candidates and assess this task before delegating.",
      );
    return [...new Set([args.model, ...order])];
  }
  return order;
}

export function compactCandidate(c) {
  if (c.availability.status === "blocked")
    return {
      model: c.model,
      availability: {
        status: "blocked",
        reason: c.availability.reason,
        retryAt: c.availability.retryAt,
      },
    };
  const price = c.economics.apiReferencePrice;
  return {
    model: c.model,
    ...(c.evidence?.kind && c.evidence.kind !== "catalog-metadata"
      ? { notes: c.notes, evidence: c.evidence }
      : {}),
    catalog: {
      contextTokens: c.catalog.contextTokens,
      outputTokens: c.catalog.outputTokens,
      reasoning: c.catalog.reasoning,
      toolCalling: c.catalog.toolCalling,
      imageInput: c.catalog.imageInput,
    },
    economics: {
      billing: c.economics.billing,
      quotaUnitsPerRequest: c.economics.quotaUnitsPerRequest,
      apiReferencePrice: {
        input: price.input,
        output: price.output,
        cacheRead: price.cacheRead,
        contextTiers: price.contextTiers,
        over200k: price.over200k,
        actualChargeConfirmed: false,
      },
    },
    availability: {
      status: c.availability.status,
      reason: c.availability.reason,
      retryAt: c.availability.retryAt,
    },
    assessment:
      c.assessment?.status === "measured"
        ? c.assessment
        : { status: "unmeasured" },
  };
}
