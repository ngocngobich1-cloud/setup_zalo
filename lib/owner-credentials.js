import {
  deleteAllOwnerProviderCredentials,
  deleteOwnerProviderCredential,
  getAiRuntimeConfig,
  listOwnerProviderCredentialStatus,
  listOwnerProviderCredentialsForProjection,
  saveOwnerProviderCredential,
} from "./db.js";
import {
  SYSTEM_DEFAULT_PROVIDER_ID,
  allocateCredentialProjectionDirectory,
  credentialProjectionDiscoveryDirectory,
  credentialPlaneState,
  deleteProviderAuth,
  getProviderState,
  markCredentialPlaneFailed,
  markCredentialPlaneReady,
  putProviderAuth,
  splitModel,
  testProviderKey,
  withCredentialPlaneRead,
  withCredentialPlaneWrite,
} from "./opencode.js";

let currentOwnerResolver = () => null;

export function configureCurrentOwnerResolver(resolver) {
  currentOwnerResolver = typeof resolver === "function" ? resolver : () => null;
}

function ownerCredentialError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function canonicalOwner(ownerUid) {
  const owner = String(ownerUid || "").trim();
  if (!owner) throw ownerCredentialError("NO_ACTIVE_OWNER", "Chưa đăng nhập Zalo.");
  return owner;
}

function canonicalProvider(providerId) {
  const provider = String(providerId || "").trim();
  if (!provider) throw ownerCredentialError("UNKNOWN_PROVIDER", "Hãy chọn hãng AI.");
  return provider;
}

function assertCapturedOwnerStillCurrent(ownerUid) {
  const state = credentialPlaneState();
  const currentOwner = currentOwnerResolver();
  if (
    state.credentialPlaneReady !== true
    || state.projectedOwnerUid !== ownerUid
    || String(currentOwner || "") !== ownerUid
  ) {
    throw ownerCredentialError(
      "OWNER_CONTEXT_CHANGED",
      "Tài khoản Zalo đã thay đổi trong lúc yêu cầu đang chờ."
    );
  }
}

function captureProjectedOwner(ownerUid) {
  const state = credentialPlaneState();
  if (state.credentialPlaneReady !== true || state.projectedOwnerUid !== ownerUid) {
    throw ownerCredentialError(
      "OWNER_CONTEXT_CHANGED",
      "Tài khoản Zalo đang chuyển đổi. Hãy tải lại rồi thử lại."
    );
  }
}

function providerCatalog(snapshot) {
  return new Map((snapshot?.all || []).map((provider) => [
    String(provider.id),
    { id: String(provider.id), name: String(provider.name || provider.id) },
  ]));
}

async function liveProviderCatalogUnlocked(config) {
  return providerCatalog(await getProviderState(config));
}

async function validateProviderUnlocked(config, providerId) {
  const catalog = await liveProviderCatalogUnlocked(config);
  if (!catalog.has(providerId)) {
    throw ownerCredentialError("UNKNOWN_PROVIDER", "Hãng AI không có trong OpenCode hiện tại.");
  }
  return catalog.get(providerId);
}

/** Cleanup luon danh dau NOT READY, ke ca mot DELETE trong cleanup bi loi. */
async function failClosedCleanupUnlocked(config, candidateDirectory) {
  const cleanupFailures = [];
  try {
    const snapshot = await getProviderState(config, { directory: candidateDirectory });
    for (const providerId of new Set((snapshot.connected || []).map(String))) {
      try {
        await deleteProviderAuth(config, providerId);
      } catch {
        cleanupFailures.push(providerId);
      }
    }
  } catch {
    cleanupFailures.push("PROVIDER_STATE_UNAVAILABLE");
  } finally {
    markCredentialPlaneFailed();
  }
  return cleanupFailures;
}

function projectionFailure(error, cleanupFailures) {
  if (error?.code === "CREDENTIAL_DECRYPTION_FAILED") return error;
  const decryptFailure = /Không giải mã được|mã hoá hỏng|API credential không ở định dạng/i
    .test(String(error?.message || ""));
  if (decryptFailure) {
    return ownerCredentialError(
      "CREDENTIAL_DECRYPTION_FAILED",
      `Không thể giải mã API credential: ${error.message}`,
      error
    );
  }
  const cleanupSuffix = cleanupFailures.length
    ? " Dọn trạng thái OpenCode không hoàn tất; AI đã bị khoá an toàn."
    : "";
  return ownerCredentialError(
    "CREDENTIAL_PROJECTION_FAILED",
    `Không thể chuẩn bị kết nối AI cho tài khoản Zalo hiện tại.${cleanupSuffix}`,
    error
  );
}

/** Caller da giu WRITE lock. DB la desired authority duy nhat. */
async function projectOwnerCredentialsUnlocked(targetOwnerUid, config) {
  const owner = targetOwnerUid === null || targetOwnerUid === undefined
    ? null
    : canonicalOwner(targetOwnerUid);
  let candidateDirectory = null;
  try {
    const rows = owner ? await listOwnerProviderCredentialsForProjection(owner) : [];
    const desired = new Map(rows.map((row) => [row.providerId, row.apiKey]));
    const discoveryDirectory = credentialProjectionDiscoveryDirectory();
    const before = discoveryDirectory
      ? await getProviderState(config, { directory: discoveryDirectory })
      : await getProviderState(config, { allowDefaultContext: true });
    const catalog = providerCatalog(before);

    for (const providerId of desired.keys()) {
      if (!catalog.has(providerId)) {
        throw ownerCredentialError(
          "UNKNOWN_PROVIDER",
          `Credential đã lưu tham chiếu hãng không còn trong OpenCode: ${providerId}`
        );
      }
    }

    for (const providerId of new Set((before.connected || []).map(String))) {
      if (!desired.has(providerId)) await deleteProviderAuth(config, providerId);
    }
    for (const [providerId, apiKey] of desired) {
      await putProviderAuth(config, providerId, apiKey);
    }

    // OpenCode 1.18.4 cache Provider theo directory. Candidate phai duoc tao
    // SAU PUT/DELETE; cung candidate nay se duoc publish cho catalog/session.
    candidateDirectory = allocateCredentialProjectionDirectory();
    const after = await getProviderState(config, { directory: candidateDirectory });
    const connected = new Set((after.connected || []).map(String));
    const missing = [...desired.keys()].filter((providerId) => !connected.has(providerId));
    // OpenCode Zen (`opencode`) la provider noi tai va van hien connected khi
    // auth.json rong. Reader gate ben duoi van cam inference neu owner khong co
    // credential row cho provider nay; ngoai le nay khong tao legacy fallback.
    const unexpected = [...connected].filter(
      (providerId) => !desired.has(providerId) && providerId !== SYSTEM_DEFAULT_PROVIDER_ID
    );
    if (missing.length || unexpected.length) {
      throw ownerCredentialError(
        "CREDENTIAL_PROJECTION_VERIFY_FAILED",
        "OpenCode không phản ánh đúng tập credential mong muốn."
      );
    }

    markCredentialPlaneReady(owner, [...desired.keys()], candidateDirectory);
    return {
      ownerUid: owner,
      providerIds: [...desired.keys()],
      credentialDirectory: candidateDirectory,
      projectionGeneration: credentialPlaneState().projectionGeneration,
    };
  } catch (error) {
    // Neu loi xay ra giua cac PUT, tao candidate duy nhat luc nay de thay toan
    // bo auth file moi nhat va cleanup. Candidate that bai KHONG duoc publish.
    // mkdir failure da co exact candidate tren error; khong allocate/mkdir lai
    // trong catch vi lan hai cung se fail va bo qua fail-closed normalization.
    if (!candidateDirectory) {
      candidateDirectory = String(error?.credentialDirectory || "").trim()
        || allocateCredentialProjectionDirectory();
    }
    const cleanupFailures = await failClosedCleanupUnlocked(config, candidateDirectory);
    throw projectionFailure(error, cleanupFailures);
  }
}

export async function projectOwnerCredentials(targetOwnerUid, options = {}) {
  return withCredentialPlaneWrite(async () => {
    const config = options.config || await getAiRuntimeConfig();
    return projectOwnerCredentialsUnlocked(targetOwnerUid, config);
  });
}

export async function saveCurrentOwnerCredential(ownerUid, providerId, apiKey, options = {}) {
  const owner = canonicalOwner(ownerUid);
  const provider = canonicalProvider(providerId);
  captureProjectedOwner(owner);
  let plain = String(apiKey || "").trim();
  if (!plain) throw ownerCredentialError("EMPTY_API_KEY", "API key không được để trống.");
  try {
    return await withCredentialPlaneWrite(async () => {
      assertCapturedOwnerStillCurrent(owner);
      const config = options.config || await getAiRuntimeConfig();
      await validateProviderUnlocked(config, provider);
      const saved = await saveOwnerProviderCredential(owner, provider, plain);
      await projectOwnerCredentialsUnlocked(owner, config);
      return saved;
    });
  } finally {
    plain = "";
  }
}

export async function deleteCurrentOwnerCredential(ownerUid, providerId, options = {}) {
  const owner = canonicalOwner(ownerUid);
  const provider = canonicalProvider(providerId);
  captureProjectedOwner(owner);
  return withCredentialPlaneWrite(async () => {
    assertCapturedOwnerStillCurrent(owner);
    const config = options.config || await getAiRuntimeConfig();
    await validateProviderUnlocked(config, provider);
    const removed = await deleteOwnerProviderCredential(owner, provider);
    await projectOwnerCredentialsUnlocked(owner, config);
    return { providerId: provider, removed };
  });
}

export async function deleteAllCurrentOwnerCredentials(ownerUid, options = {}) {
  const owner = canonicalOwner(ownerUid);
  captureProjectedOwner(owner);
  return withCredentialPlaneWrite(async () => {
    assertCapturedOwnerStillCurrent(owner);
    const config = options.config || await getAiRuntimeConfig();
    const removed = await deleteAllOwnerProviderCredentials(owner);
    await projectOwnerCredentialsUnlocked(owner, config);
    return { removed };
  });
}

export async function listCurrentOwnerCredentialStatus(ownerUid, options = {}) {
  const owner = canonicalOwner(ownerUid);
  const config = options.config || await getAiRuntimeConfig();
  const rows = await listOwnerProviderCredentialStatus(owner);
  if (String(currentOwnerResolver() || "") !== owner) {
    throw ownerCredentialError("OWNER_CONTEXT_CHANGED", "Tài khoản Zalo đã thay đổi trong lúc yêu cầu đang chờ.");
  }
  if (rows.length === 0) return { providers: [] };
  let names = new Map();
  try {
    names = await withCredentialPlaneRead({ ownerUid: owner }, async () =>
      providerCatalog(await getProviderState(config))
    );
  } catch (error) {
    if (error?.code === "OWNER_CONTEXT_CHANGED") throw error;
    // DB van la status authority khi sidecar dang fail-closed/offline.
  }
  if (String(currentOwnerResolver() || "") !== owner) {
    throw ownerCredentialError("OWNER_CONTEXT_CHANGED", "Tài khoản Zalo đã thay đổi trong lúc yêu cầu đang chờ.");
  }
  return {
    providers: rows.map((row) => ({
      providerId: row.providerId,
      providerName: names.get(row.providerId)?.name || row.providerId,
      connected: true,
      updatedAt: row.updatedAt,
    })),
  };
}

/** Catalog live, nhung connected duoc tinh tu DB owner authority, khong tu sidecar. */
export async function listCurrentOwnerProviderCatalog(ownerUid, options = {}) {
  const owner = canonicalOwner(ownerUid);
  const config = options.config || await getAiRuntimeConfig();
  const [rows, catalog] = await withCredentialPlaneRead({ ownerUid: owner }, async () => Promise.all([
    listOwnerProviderCredentialStatus(owner),
    liveProviderCatalogUnlocked(config),
  ]));
  const stored = new Set(rows.map((row) => row.providerId));
  return [...catalog.values()]
    .map((provider) => ({ ...provider, connected: stored.has(provider.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function testCurrentOwnerCredential(ownerUid, providerId, options = {}) {
  const owner = canonicalOwner(ownerUid);
  const provider = canonicalProvider(providerId);
  const config = options.config || await getAiRuntimeConfig();
  await withCredentialPlaneRead({ ownerUid: owner }, () => validateProviderUnlocked(config, provider));
  const stored = (await listOwnerProviderCredentialStatus(owner))
    .some((row) => row.providerId === provider);
  if (!stored) {
    throw ownerCredentialError("CREDENTIAL_NOT_SAVED", "Hãng AI này chưa có API key đã lưu.");
  }
  return withCredentialPlaneRead(
    { ownerUid: owner, providerId: provider },
    () => testProviderKey(config, provider)
  );
}

/**
 * Outer boundary cho Zalo/training/onboarding. Khi router dang bat, provider
 * chi duoc chot sau capability decision, nen boundary ngoai chi khoa owner;
 * routed inference se giu provider-set lease bang withOwnerCredentialReadSet.
 */
export async function withCurrentOwnerCredentialRead(ownerUid, config, operation) {
  const owner = canonicalOwner(ownerUid);
  if (config?.capabilityRoutingEnabled === true) {
    return withCredentialPlaneRead({ ownerUid: owner }, async (signal) => {
      assertCapturedOwnerStillCurrent(owner);
      return operation(signal);
    });
  }
  const providerId = splitModel(config?.opencodeModel)?.providerID;
  if (!providerId) {
    throw ownerCredentialError("OWNER_PROVIDER_CREDENTIAL_MISSING", "Chưa chọn hãng AI và model.");
  }
  return withCredentialPlaneRead({ ownerUid: owner, providerId }, async (signal) => {
    assertCapturedOwnerStillCurrent(owner);
    return operation(signal);
  });
}

/**
 * Routed-turn lease: capture owner + projection generation, verify the complete
 * provider set before inference, and keep the READ lock until the whole turn ends.
 */
export async function withOwnerCredentialReadSet(ownerUid, requiredProviderIds, operation) {
  const owner = canonicalOwner(ownerUid);
  const providers = [...new Set((requiredProviderIds || []).map((id) => canonicalProvider(id)))];
  return withCredentialPlaneRead({ ownerUid: owner }, async (signal) => {
    assertCapturedOwnerStillCurrent(owner);
    const before = credentialPlaneState();
    for (const providerId of providers) {
      if (!before.projectedProviderIds.includes(providerId)) {
        throw ownerCredentialError(
          "OWNER_PROVIDER_CREDENTIAL_MISSING",
          `AI bổ trợ chưa có API credential cho hãng ${providerId}.`
        );
      }
    }
    const result = await operation({
      signal,
      ownerUid: owner,
      projectionGeneration: before.projectionGeneration,
      providerIds: Object.freeze([...providers]),
    });
    const after = credentialPlaneState();
    const currentOwner = currentOwnerResolver();
    if (
      after.projectionGeneration !== before.projectionGeneration
      || after.projectedOwnerUid !== owner
      || String(currentOwner || "") !== owner
    ) {
      throw ownerCredentialError(
        "OWNER_CONTEXT_CHANGED",
        "Tài khoản Zalo hoặc credential generation đã thay đổi trong lúc xử lý."
      );
    }
    return result;
  });
}

export async function withCurrentOwnerPlaneRead(ownerUid, operation) {
  const owner = canonicalOwner(ownerUid);
  return withCredentialPlaneRead({ ownerUid: owner }, operation);
}

export function ownerCredentialReadyForConfig(ownerUid, config) {
  const owner = String(ownerUid || "").trim();
  const providerId = splitModel(config?.opencodeModel)?.providerID;
  const state = credentialPlaneState();
  return Boolean(
    owner
    && providerId
    && state.credentialPlaneReady
    && state.projectedOwnerUid === owner
    && state.projectedProviderIds.includes(providerId)
  );
}

export function ownerCredentialHttpError(error) {
  const code = String(error?.code || "UNKNOWN");
  if (code === "NO_ACTIVE_OWNER") return { status: 400, code, message: "Chưa đăng nhập Zalo." };
  if (code === "OWNER_CONTEXT_CHANGED") {
    return { status: 409, code, message: "Tài khoản Zalo đã thay đổi. Hãy tải lại rồi thử lại." };
  }
  if (["UNKNOWN_PROVIDER", "EMPTY_API_KEY", "CREDENTIAL_NOT_SAVED"].includes(code)) {
    return { status: 400, code, message: error.message };
  }
  if ([
    "INVALID_KEY",
    "NO_QUOTA",
    "RATE_LIMITED",
    "QUOTA_EXHAUSTED",
    "BAD_REQUEST",
    "PROVIDER_UNAVAILABLE",
    "TIMEOUT",
    "UNKNOWN",
  ].includes(code)) {
    return { status: 400, code, message: error.message };
  }
  if (code === "OPENCODE_RUNTIME_ERROR") {
    return { status: 503, code, message: "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại." };
  }
  return {
    status: 503,
    code: ["CREDENTIAL_DECRYPTION_FAILED", "CREDENTIAL_PROJECTION_FAILED"].includes(code)
      ? code
      : "CREDENTIAL_SERVICE_UNAVAILABLE",
    message: "Kết nối AI chưa sẵn sàng. Hãy thử lại sau.",
  };
}
