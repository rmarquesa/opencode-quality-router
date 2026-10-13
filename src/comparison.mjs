// Inspection priorities describe evidence coverage, never a quality ranking.
export function requirementsFor(input = {}) {
  const result = { toolCalling: true, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (key === "contextTokens") {
      if (!Number.isSafeInteger(value) || value < 1)
        throw Error("contextTokens must be a positive integer");
    } else if (
      !["toolCalling", "reasoning", "imageInput"].includes(key) ||
      typeof value !== "boolean"
    )
      throw Error("Invalid task requirement");
  }
  return Object.fromEntries(
    ["toolCalling", "reasoning", "imageInput", "contextTokens"]
      .filter((k) => k in result)
      .map((k) => [k, result[k]]),
  );
}

export function suitability(candidate, requirements) {
  const missing = [],
    unknown = [];
  for (const [key, required] of Object.entries(requirements)) {
    if (!required) continue;
    const actual = candidate.catalog[key];
    if (actual === undefined) unknown.push(key);
    else if (key === "contextTokens" ? actual < required : actual !== true)
      missing.push(key);
  }
  return {
    status: missing.length
      ? "incompatible"
      : unknown.length
        ? "unknown"
        : "compatible",
    missing,
    unknown,
  };
}

export function accessEvidence(state, model, ttl, now = Date.now()) {
  const recorded = state.access?.[model];
  const historical = (state.evaluations?.[model] ?? [])
    .filter(
      (r) =>
        r.status === "unavailable" &&
        [
          "auth",
          "quota",
          "unavailable",
          "incompatible",
          "retired",
          "transient",
        ].includes(r.reason) &&
        Number.isFinite(Date.parse(r.checkedAt)),
    )
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
  const record =
    historical &&
    Date.parse(historical.checkedAt) > (recorded?.lastFailureAt ?? 0)
      ? {
          ...recorded,
          lastFailureAt: Date.parse(historical.checkedAt),
          failureReason: historical.reason,
        }
      : recorded;
  const success = record?.lastSuccessAt;
  return {
    status:
      success && now - success <= ttl && success > (record.lastFailureAt ?? 0)
        ? "recent_success"
        : "unconfirmed",
    ...(success ? { lastSuccessAt: new Date(success).toISOString() } : {}),
    ...(record?.lastFailureAt
      ? {
          lastFailureAt: new Date(record.lastFailureAt).toISOString(),
          failureReason: record.failureReason,
        }
      : {}),
    meaning:
      "Observed model response, not remaining quota or verified task quality",
  };
}

export function comparisonShortlist(candidates, limit = 12) {
  const eligible = candidates.filter(
    (c) =>
      c.availability.status !== "blocked" &&
      c.suitability.status !== "incompatible",
  );
  const byEvidence = (a, b) =>
    Number(b.assessment?.status === "measured") -
      Number(a.assessment?.status === "measured") ||
    Number(b.access.status === "recent_success") -
      Number(a.access.status === "recent_success") ||
    a.model.localeCompare(b.model);
  const sorted = [...eligible].sort(byEvidence);
  const groups = [
    sorted.filter((c) => c.assessment?.status === "measured"),
    sorted.filter((c) => c.access.status === "recent_success"),
    sorted.filter((c) => c.economics.billing === "free"),
    sorted.filter((c) => c.economics.billing === "included"),
    // Known metered prices are inspectable, never assumed better or cheaper than included capacity.
    sorted.filter(
      (c) =>
        c.economics.billing === "metered" &&
        c.economics.apiReferencePrice.input !== undefined,
    ),
    sorted,
  ];
  const selected = new Map();
  for (let i = 0; selected.size < Math.min(limit, eligible.length); i++) {
    let found = false;
    for (const group of groups) {
      const c = group[i];
      if (c) {
        found = true;
        if (selected.size < limit) selected.set(c.model, c);
      }
    }
    if (!found) break;
  }
  return [...selected.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export function validateComparison(args, consultation) {
  if (!consultation)
    throw Error(
      "Consult quota_candidates and pass its comparison_id for this task",
    );
  const rows = args.model_comparison;
  if (!Array.isArray(rows) || !rows.length || rows.length > 20)
    throw Error(
      "Provide model_comparison with task-specific fit reasons for inspected candidates",
    );
  const byModel = new Map();
  for (const row of rows) {
    if (
      !row ||
      !consultation.inspected.has(row.model) ||
      byModel.has(row.model) ||
      !["suitable", "unsuitable"].includes(row.fit) ||
      typeof row.reason !== "string" ||
      !row.reason.trim()
    )
      throw Error(
        "Compare distinct inspected models with fit and concrete reason",
      );
    byModel.set(row.model, row);
  }
  if (consultation.eligibleCount > 1 && rows.length < 2)
    throw Error(
      "Inspect and compare at least one relevant alternative; choosing the same model is allowed",
    );
  for (const model of [args.model, ...args.model_order]) {
    if (byModel.get(model)?.fit !== "suitable")
      throw Error(
        "Selected model and every fallback must be inspected and assessed suitable",
      );
    if (consultation.inspected.get(model).suitability.status === "incompatible")
      throw Error("Selected model does not meet declared task requirements");
  }
  return rows.map(({ model, fit, reason }) => ({ model, fit, reason }));
}
