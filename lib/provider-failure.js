export const FAILURE_CODES = Object.freeze({
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  INVALID_KEY: "INVALID_KEY",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  BAD_REQUEST: "BAD_REQUEST",
  BUSINESS_ERROR: "BUSINESS_ERROR",
  UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR",
  OWNER_CONTEXT_CHANGED: "OWNER_CONTEXT_CHANGED",
  CREDENTIAL_PLANE_NOT_READY: "CREDENTIAL_PLANE_NOT_READY",
  OWNER_PROVIDER_CREDENTIAL_MISSING: "OWNER_PROVIDER_CREDENTIAL_MISSING",
  CREDENTIAL_OPERATION_ABORTED: "CREDENTIAL_OPERATION_ABORTED",
});

const CREDENTIAL_CONTROL_CODES = new Set([
  FAILURE_CODES.OWNER_CONTEXT_CHANGED,
  FAILURE_CODES.CREDENTIAL_PLANE_NOT_READY,
  FAILURE_CODES.OWNER_PROVIDER_CREDENTIAL_MISSING,
  FAILURE_CODES.CREDENTIAL_OPERATION_ABORTED,
]);

const FAILOVER_ELIGIBLE = new Set([
  FAILURE_CODES.TIMEOUT,
  FAILURE_CODES.RATE_LIMITED,
  FAILURE_CODES.PROVIDER_UNAVAILABLE,
]);

function visitFailure(value, seen, facts) {
  if (value === null || value === undefined || seen.has(value)) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    facts.text.push(String(value));
    return;
  }
  if (typeof value !== "object") return;
  seen.add(value);

  for (const key of ["status", "statusCode"]) {
    const status = Number(value[key]);
    if (Number.isInteger(status) && status >= 100 && status <= 599) facts.statuses.add(status);
  }
  for (const key of ["code", "name", "message", "type", "responseBody"]) {
    const item = value[key];
    if (["string", "number", "boolean"].includes(typeof item)) facts.text.push(String(item));
  }
  for (const key of ["infoError", "error", "data", "cause", "opencodeDiagnostic", "metadata"]) {
    visitFailure(value[key], seen, facts);
  }
}

function failureFacts(error) {
  const facts = { statuses: new Set(), text: [] };
  visitFailure(error, new Set(), facts);
  return {
    statuses: facts.statuses,
    text: facts.text.join(" ").toLowerCase(),
    code: String(error?.code || "").toUpperCase(),
  };
}

/**
 * Taxonomy duy nhat cho provider response.info.error va transport exception.
 * Unknown luon fail closed: tuyet doi khong "thu Secondary xem sao".
 */
export function classifyProviderFailure(error) {
  const { statuses, text, code } = failureFacts(error);

  if (CREDENTIAL_CONTROL_CODES.has(code)) return code;
  if (/owner_context_changed|credential_plane_not_ready|owner_provider_credential_missing|credential_operation_aborted/.test(text)) {
    if (/owner_context_changed/.test(text)) return FAILURE_CODES.OWNER_CONTEXT_CHANGED;
    if (/credential_plane_not_ready/.test(text)) return FAILURE_CODES.CREDENTIAL_PLANE_NOT_READY;
    if (/owner_provider_credential_missing/.test(text)) return FAILURE_CODES.OWNER_PROVIDER_CREDENTIAL_MISSING;
    return FAILURE_CODES.CREDENTIAL_OPERATION_ABORTED;
  }

  if (
    statuses.has(401)
    || statuses.has(403)
    || /invalid\s*(api\s*)?key|unauthori[sz]ed|forbidden credential|authentication failed/.test(text)
  ) return FAILURE_CODES.INVALID_KEY;

  // Billing/quota markers phai thang generic "rate limit" trong cung payload.
  if (
    statuses.has(402)
    || /quota exhausted|insufficient quota|insufficient[_ -]?(credit|funds)|\bcredit\b|\bbilling\b|payment required/.test(text)
  ) return FAILURE_CODES.QUOTA_EXHAUSTED;

  if (
    statuses.has(400)
    || /model not found|invalid model|unsupported (input|capability)|invalid (request|config)|bad request/.test(text)
  ) return FAILURE_CODES.BAD_REQUEST;

  if (
    code === "OPENCODE_TIMEOUT"
    || code === "TIMEOUT"
    || /\btimeout\b|timed out|deadline exceeded|qu[aá] th[oờ]i gian ch[oờ]/.test(text)
  ) return FAILURE_CODES.TIMEOUT;

  if (statuses.has(429) || /rate.?limit|too many requests/.test(text)) {
    return FAILURE_CODES.RATE_LIMITED;
  }

  if (
    [...statuses].some((status) => status >= 500)
    || /econnrefused|econnreset|fetch failed|provider unavailable|service unavailable|kh[oô]ng k[eế]t n[oố]i/.test(text)
  ) return FAILURE_CODES.PROVIDER_UNAVAILABLE;

  if (code === "BUSINESS_ERROR" || /business[_ -]?error/.test(text)) {
    return FAILURE_CODES.BUSINESS_ERROR;
  }
  return FAILURE_CODES.UNKNOWN_PROVIDER_ERROR;
}

export function isFailoverEligible(code) {
  return FAILOVER_ELIGIBLE.has(String(code || ""));
}

export function isCredentialControlFailure(code) {
  return CREDENTIAL_CONTROL_CODES.has(String(code || ""));
}

export function ownerFacingFailureMessage(code, actor = "AI chính") {
  const label = String(actor || "AI chính").trim() || "AI chính";
  switch (code) {
    case FAILURE_CODES.INVALID_KEY:
      return `API credential của ${label} không hợp lệ. Chị kiểm tra lại key đã lưu.`;
    case FAILURE_CODES.QUOTA_EXHAUSTED:
      return `Tài khoản ${label} đã hết hạn mức hoặc cần cập nhật thanh toán.`;
    case FAILURE_CODES.BAD_REQUEST:
      return `${label} từ chối yêu cầu hoặc model đã chọn không còn phù hợp.`;
    case FAILURE_CODES.TIMEOUT:
      return `${label} phản hồi quá thời gian cho phép.`;
    case FAILURE_CODES.RATE_LIMITED:
      return `${label} đang giới hạn tần suất yêu cầu. Chị thử lại sau một lát.`;
    case FAILURE_CODES.PROVIDER_UNAVAILABLE:
      return `Hãng của ${label} đang tạm thời không phản hồi.`;
    case FAILURE_CODES.OWNER_CONTEXT_CHANGED:
    case FAILURE_CODES.CREDENTIAL_OPERATION_ABORTED:
      return "Tài khoản Zalo đã thay đổi trong lúc yêu cầu đang chạy.";
    case FAILURE_CODES.CREDENTIAL_PLANE_NOT_READY:
    case FAILURE_CODES.OWNER_PROVIDER_CREDENTIAL_MISSING:
      return "Kết nối AI của tài khoản Zalo hiện tại chưa sẵn sàng.";
    default:
      return "AI không hoàn tất được yêu cầu và hệ thống không tự chuyển model khi chưa rõ nguyên nhân.";
  }
}
