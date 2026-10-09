import { candidateDetails } from "./decision.mjs";
import { availability } from "./routing.mjs";
export const DOMAINS = [
  "frontend",
  "coding",
  "debugging",
  "security",
  "devops",
  "analysis",
];
export const COMPLEXITIES = ["simple", "complex"];
export function validateAssessment(domain, complexity) {
  if (!DOMAINS.includes(domain) || !COMPLEXITIES.includes(complexity))
    throw new Error(
      "Classify this task with task_domain and task_complexity before comparing models",
    );
}
export function capabilityEvidence(state, model, domain, complexity) {
  const cells = (state.evaluations?.[model] ?? []).filter(
    (r) => r.domain === domain && r.complexity === complexity,
  );
  const scored = cells.filter(
    (r) => r.status === "scored" && typeof r.passed === "boolean",
  );
  return {
    domain,
    complexity,
    status: scored.length ? "measured" : "unmeasured",
    trials: scored.length,
    passed: scored.filter((r) => r.passed).length,
    passRate: scored.length
      ? scored.filter((r) => r.passed).length / scored.length
      : undefined,
    methods: [...new Set(scored.map((r) => r.method))],
    variants: [...new Set(scored.map((r) => r.variant ?? "provider-default"))],
    lastTestedAt: cells.at(-1)?.checkedAt,
    unavailableTrials: cells.filter((r) => r.status === "unavailable").length,
    confidence: scored.length
      ? "Limited evidence from these exact cases; not a universal quality ranking"
      : "No verified task result for this cell",
  };
}
export function matrixRows(config, catalog, state, now = Date.now()) {
  const profiles = new Map(
    Object.values(config.agents).flatMap((p) =>
      p.candidates.map((c) => [c.model, c]),
    ),
  );
  return [...catalog]
    .map(([model, metadata]) => {
      const candidate = profiles.get(model) ?? { model };
      const details = candidateDetails(config, candidate, metadata);
      const expectedFree =
        (candidate.economics ?? config.providerEconomics?.[model.split("/")[0]])
          ?.billing === "free";
      return {
        model,
        ...details,
        selectable:
          profiles.has(model) && metadata.capabilities?.toolcall !== false,
        availability:
          expectedFree && details.economics.billing !== "free"
            ? {
                status: "blocked",
                reason:
                  "Configured free offer no longer has confirmed zero catalog rates",
              }
            : availability(
                candidate,
                state.observations[model.split("/")[0]],
                state.blocks[model],
                now,
                config.quotaTtlMs,
              ),
        capabilities: Object.fromEntries(
          DOMAINS.map((domain) => [
            domain,
            Object.fromEntries(
              COMPLEXITIES.map((complexity) => [
                complexity,
                capabilityEvidence(state, model, domain, complexity),
              ]),
            ),
          ]),
        ),
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}
