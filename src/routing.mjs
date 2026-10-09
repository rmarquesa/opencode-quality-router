export const keyOf = (m) => (m ? `${m.providerID}/${m.modelID}` : "");
export function modelOf(key, variant) {
  const i = key.indexOf("/");
  if (i < 1 || i === key.length - 1) throw new Error("Expected provider/model");
  return {
    providerID: key.slice(0, i),
    modelID: key.slice(i + 1),
    ...(variant ? { variant } : {}),
  };
}
export function validateConfig(config) {
  config.objective ??= "quality";
  if (!["quality", "value"].includes(config.objective))
    throw new Error("Invalid routing objective");
  const checkEconomics = (e) => {
    if (
      e?.billing !== undefined &&
      !["free", "included", "metered", "unknown"].includes(e.billing)
    )
      throw new Error("Invalid economics billing mode");
    if (
      e?.quotaUnitsPerRequest !== undefined &&
      (!Number.isFinite(e.quotaUnitsPerRequest) || e.quotaUnitsPerRequest < 0)
    )
      throw new Error("Invalid quota units per request");
  };
  for (const e of Object.values(config.providerEconomics ?? {}))
    checkEconomics(e);
  if (!config.agents || !Object.keys(config.agents).length)
    throw new Error("Configure at least one agent");
  for (const [agent, profile] of Object.entries(config.agents)) {
    if (!Array.isArray(profile.candidates) || !profile.candidates.length)
      throw new Error(`No candidates: ${agent}`);
    const models = new Set();
    for (const c of profile.candidates) {
      checkEconomics(c.economics);
      modelOf(c.model);
      if (models.has(c.model))
        throw new Error(`Duplicate candidate: ${agent}/${c.model}`);
      models.add(c.model);
      if (
        c.billingGroup &&
        !["premium", "chat", "completions"].includes(c.billingGroup)
      )
        throw new Error("Invalid Copilot billing group");
    }
  }
  for (const [k, fallback] of [
    ["quotaTtlMs", 60000],
    ["failureCooldownMs", 900000],
    ["retryDelayMs", 1000],
  ]) {
    config[k] ??= fallback;
    if (!Number.isFinite(config[k]) || config[k] < 0)
      throw new Error(`Invalid ${k}`);
  }
  return config;
}
export function classifyError(error) {
  if (!error) return undefined;
  const d = error.data ?? error;
  const message = `${d.message ?? ""} ${d.responseBody ?? ""} ${error.message ?? ""}`;
  if (
    /Abort|ContentFilter|ContextOverflow|Permission|Rejected|StructuredOutput/.test(
      error.name ?? "",
    ) ||
    /safety|content.?filter|context.{0,25}(length|window|limit)|invalid.{0,20}(schema|tool)|permission rejected|user.{0,15}(cancel|abort)/i.test(
      message,
    )
  )
    return undefined;
  const status = Number(d.statusCode ?? error.statusCode ?? error.status);
  if (
    /quota|rate.?limit|usage.{0,25}(exceed|exhaust|limit)|insufficient.{0,10}credits/i.test(
      message,
    ) ||
    status === 429
  )
    return "quota";
  if ([401, 403].includes(status) || /ProviderAuthError/.test(error.name ?? ""))
    return "auth";
  if (
    [402, 404].includes(status) ||
    /ModelNotFoundError/.test(error.name ?? "") ||
    /model.{0,30}(disabled|unavailable|not found|not supported)|no.{0,15}valid license/i.test(
      message,
    )
  )
    return "unavailable";
  if (
    [408, 500, 502, 503, 504, 529].includes(status) ||
    /ECONNRESET|ETIMEDOUT|fetch failed|service unavailable/i.test(message)
  )
    return "transient";
  return undefined;
}
export function availability(candidate, observation, block, now, ttl) {
  if (block?.until > now)
    return {
      status: "blocked",
      reason: block.reason,
      retryAt: new Date(block.until).toISOString(),
    };
  if (!observation)
    return { status: "unknown", reason: "No quota adapter or observation" };
  const age = now - observation.checkedAt;
  const stale = age > ttl || !!observation.error;
  const provider = candidate.model.split("/")[0];
  let windows = observation.windows ?? [];
  if (provider === "google") {
    const group = /gemini/i.test(candidate.model) ? "gemini" : "non-gemini";
    windows = windows.filter((w) => w.group === group);
    if (!windows.length)
      return { status: "unknown", reason: "No quota for this model group" };
    const accounts = [...new Set(windows.map((w) => w.account))];
    const states = accounts.map((a) => windows.filter((w) => w.account === a));
    const open = states.find((ws) => ws.every((w) => w.status === "available"));
    if (open) return { status: stale ? "unknown" : "available", windows: open };
    if (
      states.some(
        (ws) =>
          !ws.some(
            (w) =>
              w.status === "exhausted" &&
              (!stale || Date.parse(w.resetAt) > now),
          ) ||
          ws.some(
            (w) => w.status === "exhausted" && Date.parse(w.resetAt) <= now,
          ),
      )
    )
      return { status: "unknown", windows };
    const dates = states.map((ws) =>
      Math.max(
        ...ws
          .filter((w) => w.status === "exhausted")
          .map((w) => Date.parse(w.resetAt)),
      ),
    );
    const reset = Math.min(...dates);
    return {
      status: "blocked",
      reason: windows.some((w) => w.reason === "soft_quota_protection")
        ? "All accounts reached the Antigravity soft quota threshold"
        : "All accounts exhausted for this group",
      retryAt: Number.isFinite(reset)
        ? new Date(reset).toISOString()
        : undefined,
      windows,
    };
  }
  if (provider === "github-copilot")
    windows = windows.filter(
      (w) => w.group === (candidate.billingGroup ?? "premium"),
    );
  if (provider === "openai")
    windows = windows.filter(
      (w) => !w.model || candidate.model.endsWith("/" + w.model),
    );
  const exhausted = windows.filter(
    (w) => w.status === "exhausted" && (!stale || Date.parse(w.resetAt) > now),
  );
  if (exhausted.length) {
    const dates = exhausted.map((w) => Date.parse(w.resetAt));
    if (dates.some((t) => Number.isFinite(t) && t <= now))
      return {
        status: "unknown",
        reason: "Reset reached; quota needs rechecking",
        windows,
      };
    const retryAt = dates.every(Number.isFinite)
      ? new Date(Math.max(...dates)).toISOString()
      : undefined;
    return { status: "blocked", reason: "Quota exhausted", retryAt, windows };
  }
  return !stale &&
    windows.length &&
    windows.every((w) => w.status === "available")
    ? { status: "available", windows }
    : { status: "unknown", reason: observation.error, windows };
}
export function candidatesFor(config, agent, catalog, state, now = Date.now()) {
  const profile = config.agents[agent];
  if (!profile) return [];
  return profile.candidates
    .filter((c) => catalog.has(c.model))
    .map((c, rank) => ({
      ...c,
      rank: rank + 1,
      availability: availability(
        c,
        state.observations[c.model.split("/")[0]],
        state.blocks[c.model],
        now,
        config.quotaTtlMs,
      ),
    }));
}
export function selectCandidate(
  candidates,
  requested,
  attempted = new Set(),
  allowUnknown = true,
) {
  const eligible = candidates.filter(
    (c) =>
      !attempted.has(c.model) &&
      c.availability.status !== "blocked" &&
      (allowUnknown || c.availability.status === "available"),
  );
  // Quality order is independent of quota percentage. Unknown does not mean exhausted.
  return eligible.find((c) => c.model === requested) ?? eligible[0];
}
