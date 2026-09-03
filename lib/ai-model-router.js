import { isFailoverEligible } from "./provider-failure.js";

export const CAPABILITIES = Object.freeze({
  TEXT: "TEXT",
  IMAGE_INPUT: "IMAGE_INPUT",
  FILE_INPUT: "FILE_INPUT",
  WEB_SEARCH: "WEB_SEARCH",
});

export const ROUTE_MODES = Object.freeze({
  PRIMARY_ONLY: "PRIMARY_ONLY",
  CAPABILITY_ASSIST: "CAPABILITY_ASSIST",
  RUNTIME_FAILOVER: "RUNTIME_FAILOVER",
  UNAVAILABLE: "UNAVAILABLE",
});

export const SURFACES = Object.freeze({
  COMMANDER: "COMMANDER",
  CUSTOMER: "CUSTOMER",
});

export const WEB_PROBE_STATES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  SUPPORTED: "SUPPORTED",
  UNSUPPORTED: "UNSUPPORTED",
});

export const MAX_AI_CALLS_PER_TURN = 2;

export const FALLBACK_CAPABILITY_ORDER = Object.freeze([
  CAPABILITIES.IMAGE_INPUT,
  CAPABILITIES.FILE_INPUT,
  CAPABILITIES.WEB_SEARCH,
]);

const FALLBACK_CAPABILITY_SET = new Set(FALLBACK_CAPABILITY_ORDER);

export function capabilityRoutingEnabled(env = process.env) {
  return /^(?:1|true)$/i.test(String(env?.AI_CAPABILITY_ROUTING_V1_ENABLED || "").trim());
}

/** Public API nhan array; storage co the dua JSON string vao cung validator nay. */
export function normalizeFallbackCapabilities(value, { publicApi = false } = {}) {
  let parsed = value;
  if (typeof parsed === "string" && !publicApi) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new TypeError("opencodeFallbackCapabilities phải là JSON array hợp lệ.");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("opencodeFallbackCapabilities phải là array of strings.");
  }
  for (const item of parsed) {
    if (typeof item !== "string" || !FALLBACK_CAPABILITY_SET.has(item)) {
      throw new TypeError(`Secondary capability không hợp lệ: ${String(item)}`);
    }
  }
  const selected = new Set(parsed);
  return FALLBACK_CAPABILITY_ORDER.filter((capability) => selected.has(capability));
}

export function normalizeFailoverEnabled(value, { publicApi = false } = {}) {
  if (publicApi && typeof value !== "boolean") {
    throw new TypeError("opencodeFailoverEnabled phải là boolean.");
  }
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  throw new TypeError("opencodeFailoverEnabled trong DB phải là 0 hoặc 1.");
}

export function flattenCatalog(providers = []) {
  const result = new Map();
  for (const provider of providers || []) {
    for (const model of provider?.models || []) result.set(String(model.id), model.capabilities || {});
  }
  return result;
}

export function modelCapabilitySet(catalogSnapshot, canonicalModel) {
  const catalog = catalogSnapshot instanceof Map ? catalogSnapshot : flattenCatalog(catalogSnapshot);
  const capabilities = catalog.get(String(canonicalModel || ""));
  if (!capabilities) return null;
  const result = new Set();
  if (capabilities.text === true) result.add(CAPABILITIES.TEXT);
  if (capabilities.image === true) result.add(CAPABILITIES.IMAGE_INPUT);
  if (capabilities.file === true) result.add(CAPABILITIES.FILE_INPUT);
  if (capabilities.web === true) result.add(CAPABILITIES.WEB_SEARCH);
  return result;
}

function canonicalRequired(requiredCapabilities) {
  const requested = new Set(requiredCapabilities || []);
  requested.add(CAPABILITIES.TEXT);
  return [
    CAPABILITIES.TEXT,
    CAPABILITIES.IMAGE_INPUT,
    CAPABILITIES.FILE_INPUT,
    CAPABILITIES.WEB_SEARCH,
  ].filter((capability) => requested.has(capability));
}

function hasAll(supported, required) {
  return Boolean(supported) && required.every((capability) => supported.has(capability));
}

function decision(input, routeMode, reason, extra = {}) {
  return Object.freeze({
    routeMode,
    ownerUid: String(input.ownerUid || ""),
    surface: input.surface,
    primaryModel: String(input.primaryModel || ""),
    secondaryModel: extra.secondaryModel || null,
    requiredCapabilities: Object.freeze([...canonicalRequired(input.requiredCapabilities)]),
    reason,
    ...extra,
  });
}

/**
 * Shared pure routing core cho ca Commander va Customer.
 * phase=INITIAL quyet Capability Assist; phase=FAILOVER quyet Runtime Failover.
 */
export function routeModelRequest(input) {
  const required = canonicalRequired(input.requiredCapabilities);
  const primary = modelCapabilitySet(input.catalogCapabilities, input.primaryModel);
  const secondary = modelCapabilitySet(input.catalogCapabilities, input.secondaryModel);
  const enabled = new Set(normalizeFallbackCapabilities(input.enabledSecondaryCapabilities || []));
  const phase = input.phase === "FAILOVER" ? "FAILOVER" : "INITIAL";
  if (
    required.includes(CAPABILITIES.WEB_SEARCH)
    && input.webProbeState !== WEB_PROBE_STATES.SUPPORTED
  ) {
    secondary?.delete(CAPABILITIES.WEB_SEARCH);
  }

  if (!input.routingEnabled) {
    return decision(input, ROUTE_MODES.PRIMARY_ONLY, "ROUTING_DISABLED");
  }
  if (input.surface === SURFACES.CUSTOMER && required.includes(CAPABILITIES.WEB_SEARCH)) {
    return decision(input, ROUTE_MODES.UNAVAILABLE, "CUSTOMER_WEB_DISABLED_V1");
  }

  if (phase === "FAILOVER") {
    if (!input.failoverEnabled) return decision(input, ROUTE_MODES.UNAVAILABLE, "FAILOVER_DISABLED");
    if (!isFailoverEligible(input.classifiedReason)) {
      return decision(input, ROUTE_MODES.UNAVAILABLE, "FAILURE_NOT_ELIGIBLE");
    }
    if (Number(input.callsUsed || 0) >= 2 || input.secondaryAlreadyUsed) {
      return decision(input, ROUTE_MODES.UNAVAILABLE, "CALL_BUDGET_EXHAUSTED");
    }
    if (!secondary) return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_MODEL_UNAVAILABLE");
    const nonText = required.filter((capability) => capability !== CAPABILITIES.TEXT);
    if (!nonText.every((capability) => enabled.has(capability))) {
      return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_CAPABILITY_NOT_PERMITTED");
    }
    if (!hasAll(secondary, required)) {
      return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_CAPABILITY_MISSING");
    }
    return decision(input, ROUTE_MODES.RUNTIME_FAILOVER, input.classifiedReason, {
      secondaryModel: String(input.secondaryModel),
    });
  }

  // Web V1 luon la specialist evidence tren Commander; Primary final van KHONG_TOOL.
  const webSpecialist = input.surface === SURFACES.COMMANDER && required.includes(CAPABILITIES.WEB_SEARCH);
  if (hasAll(primary, required) && !webSpecialist) {
    return decision(input, ROUTE_MODES.PRIMARY_ONLY, "PRIMARY_SUPPORTS_REQUIRED");
  }

  const missing = required.filter((capability) =>
    !primary?.has(capability)
    || (webSpecialist && capability === CAPABILITIES.WEB_SEARCH)
  );
  if (missing.length === 0) return decision(input, ROUTE_MODES.PRIMARY_ONLY, "PRIMARY_SUPPORTS_REQUIRED");
  if (missing.some((capability) => capability === CAPABILITIES.TEXT || !enabled.has(capability))) {
    return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_CAPABILITY_NOT_PERMITTED", {
      missingCapabilities: Object.freeze(missing),
    });
  }
  if (!secondary) {
    return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_MODEL_UNAVAILABLE", {
      missingCapabilities: Object.freeze(missing),
    });
  }
  if (!hasAll(secondary, [CAPABILITIES.TEXT, ...missing])) {
    return decision(input, ROUTE_MODES.UNAVAILABLE, "SECONDARY_CAPABILITY_MISSING", {
      missingCapabilities: Object.freeze(missing),
    });
  }
  return decision(input, ROUTE_MODES.CAPABILITY_ASSIST, "PRIMARY_MISSING_CAPABILITY", {
    secondaryModel: String(input.secondaryModel),
    missingCapabilities: Object.freeze(missing),
  });
}

export function createCallBudget() {
  let calls = 0;
  let secondaryUsed = false;
  return Object.freeze({
    consume({ secondary = false } = {}) {
      if (calls >= MAX_AI_CALLS_PER_TURN) {
        const error = new Error(`Đã dùng hết giới hạn ${MAX_AI_CALLS_PER_TURN} lượt gọi AI cho yêu cầu này.`);
        error.code = "AI_CALL_BUDGET_EXHAUSTED";
        throw error;
      }
      calls += 1;
      if (secondary) secondaryUsed = true;
      return calls;
    },
    snapshot() {
      return Object.freeze({ callsUsed: calls, secondaryUsed });
    },
  });
}

export function detectExplicitWebIntent(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
  return [
    "tìm trên web",
    "tìm trên mạng",
    "tra cứu trên mạng",
    "search web",
    "search the web",
    "web search",
  ].some((phrase) => normalized.includes(phrase));
}

export function validateRoutingConfig({
  primaryModel,
  secondaryModel,
  fallbackCapabilities,
  failoverEnabled,
  catalogCapabilities = null,
}) {
  const capabilities = normalizeFallbackCapabilities(fallbackCapabilities, { publicApi: true });
  const failover = normalizeFailoverEnabled(failoverEnabled, { publicApi: true });
  const primary = String(primaryModel || "").trim();
  const secondary = String(secondaryModel || "").trim();
  const active = capabilities.length > 0 || failover;
  if (active && !secondary) throw new TypeError("Hãy chọn AI bổ trợ trước khi bật routing.");
  if (active && primary === secondary) {
    throw new TypeError("AI chính và AI bổ trợ phải là hai provider/model khác nhau.");
  }
  if (active && catalogCapabilities && !modelCapabilitySet(catalogCapabilities, secondary)) {
    throw new TypeError("AI bổ trợ không còn khả dụng hoặc chưa có API credential.");
  }
  return { fallbackCapabilities: capabilities, failoverEnabled: failover };
}
