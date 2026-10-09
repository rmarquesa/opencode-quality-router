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
    /model.{0,120}(deprecated|retired|removed|no longer (available|supported))/i.test(
      message,
    )
  )
    return "retired";
  if (
    (status === 400 || status === 422 || !status) &&
    /unsupported\s+service[_ -]tier|service[_ -]tier.{0,20}(not supported|unsupported)/i.test(
      message,
    )
  )
    return "incompatible";
  if (
    [402, 404, 410].includes(status) ||
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
export function quotaNotice(text) {
  return /^(?:Quota protection: All \d+ account\(s\) are over \d+% usage for (?:gemini|claude)\. Quota resets in [^.]+\. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable\.|All \d+ account\(s\) rate-limited for (?:gemini|claude)\. Quota resets in [^.]+\. Add more accounts with `opencode auth login` or wait and retry\.)$/.test(
    text?.trim() ?? "",
  );
}
export function syntheticQuotaError(message) {
  if (
    message?.info?.role !== "assistant" ||
    message.info.providerID !== "google"
  )
    return;
  // Only a complete, exact provider notice qualifies; quoted notices and normal
  // answers containing an explanation must never trigger another model call.
  if (
    !message.parts?.every((p) =>
      ["text", "step-start", "step-finish"].includes(p.type),
    )
  )
    return;
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (quotaNotice(text))
    return { name: "APIError", data: { statusCode: 429, message: text } };
}

export function failureBlock(config, error, now = Date.now()) {
  const reason = classifyError(error);
  if (!reason) return;
  return {
    reason,
    observedAt: now,
    // A finite legacy deadline also protects already-running 0.2.0 processes.
    until:
      now +
      (reason === "retired"
        ? 365 * 86400000
        : reason === "incompatible"
          ? (config.compatibilityCooldownMs ?? 86400000)
          : (config.failureCooldownMs ?? 900000)),
    ...(reason === "retired" ? { permanent: true } : {}),
  };
}
