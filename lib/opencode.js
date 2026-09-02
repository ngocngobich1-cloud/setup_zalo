import {
  deleteOpencodeSession,
  getOpencodeSessionInfo,
  saveOpencodeSession,
} from "./db.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 240000;
export const CREDENTIAL_DRAIN_DEADLINE_MS = 20000;
const configuredContextRoot = String(process.env.OPENCODE_CONTEXT_ROOT || "").trim();
export const OPENCODE_CONTEXT_ROOT = path.resolve(
  configuredContextRoot || path.join(process.cwd(), ".opencode-context")
);

export const SYSTEM_DEFAULT_PROVIDER_ID = "opencode";
export const SYSTEM_DEFAULT_MODEL_ID = "nemotron-3-ultra-free";
export const SYSTEM_DEFAULT_CANONICAL_MODEL =
  `${SYSTEM_DEFAULT_PROVIDER_ID}/${SYSTEM_DEFAULT_MODEL_ID}`;

/**
 * Phien dai bao nhieu luot thi xoay sang phien moi.
 *
 * Moi luot bo them ~200 token vao lich su va lich su duoc gui lai TOAN BO o moi
 * cau tra loi, nen phien khong xoay se tang gia mai khong dung. Xoay het ~2900
 * token (Soul + lich su), nen xoay qua som cung phi. 30 luot giu dau vao quanh
 * 12k token - van an toan ke ca khi doi sang model chi co 32k ngu canh.
 *
 * Xoay khong lam mat tri nho: phien moi duoc nap lai Soul + tin gan nhat tu
 * SQLite + ho so khach.
 */
export const PHIEN_MAX_LUOT = 30;

/**
 * Tat sach tool cua agent. Ca hai luong deu chi can agent VIET CHU:
 *  - bot tra loi khach: khach la nguoi la, mot cau du kheo la agent chay lenh
 *    trong container OpenCode - noi dang giu key API.
 *  - xuong huan luyen: chi can doc anh va viet Soul, khong can dong toi he thong.
 * Fail closed: liet ke tat het thay vi tin vao mac dinh cua OpenCode.
 */
export const KHONG_TOOL = {
  bash: false,
  read: false,
  write: false,
  edit: false,
  glob: false,
  grep: false,
  task: false,
  apply_patch: false,
  webfetch: false,
  websearch: false,
  skill: false,
  todowrite: false,
  question: false,
};

function baseUrl(config) {
  return String(config.opencodeBaseUrl || "").replace(/\/+$/, "");
}

function credentialPlaneError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Writer-priority: khi co writer xep hang, reader moi khong duoc chen vao. */
export class WriterPriorityRwLock {
  constructor({ drainDeadlineMs = CREDENTIAL_DRAIN_DEADLINE_MS, onDrainDeadline = () => {} } = {}) {
    this.drainDeadlineMs = drainDeadlineMs;
    this.onDrainDeadline = onDrainDeadline;
    this.activeReaders = 0;
    this.writerActive = false;
    this.waitingReaders = [];
    this.waitingWriters = [];
  }

  acquireRead() {
    return new Promise((resolve) => {
      this.waitingReaders.push(resolve);
      this.#pump();
    });
  }

  acquireWrite() {
    return new Promise((resolve) => {
      this.waitingWriters.push({ resolve, timer: null });
      this.#pump();
    });
  }

  snapshot() {
    return {
      activeReaders: this.activeReaders,
      writerActive: this.writerActive,
      waitingReaders: this.waitingReaders.length,
      waitingWriters: this.waitingWriters.length,
    };
  }

  #releaseOnce(release) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  #armDrainDeadline() {
    if (this.writerActive || this.activeReaders === 0 || this.waitingWriters.length === 0) return;
    const first = this.waitingWriters[0];
    if (first.timer) return;
    first.timer = setTimeout(() => {
      first.timer = null;
      this.onDrainDeadline();
    }, this.drainDeadlineMs);
  }

  #pump() {
    if (this.writerActive) return;

    if (this.waitingWriters.length > 0) {
      if (this.activeReaders > 0) {
        this.#armDrainDeadline();
        return;
      }
      const next = this.waitingWriters.shift();
      if (next.timer) clearTimeout(next.timer);
      this.writerActive = true;
      next.resolve(this.#releaseOnce(() => {
        this.writerActive = false;
        this.#pump();
      }));
      return;
    }

    if (this.waitingReaders.length === 0) return;
    const readers = this.waitingReaders.splice(0);
    this.activeReaders += readers.length;
    for (const resolve of readers) {
      resolve(this.#releaseOnce(() => {
        this.activeReaders -= 1;
        this.#pump();
      }));
    }
  }
}

const credentialOperationContext = new AsyncLocalStorage();
const activeCredentialAbortControllers = new Set();
const credentialBootId = randomUUID();
const sessionDirectoryById = new Map();
const credentialPlaneLock = new WriterPriorityRwLock({
  onDrainDeadline: () => {
    for (const controller of activeCredentialAbortControllers) controller.abort();
  },
});

let projectedOwnerUid = null;
let credentialPlaneReady = false;
let projectionGeneration = 0;
let projectedProviderIds = new Set();
let credentialDirectory = null;
let lastCredentialDirectory = null;
let pendingCredentialDirectory = null;

export function credentialPlaneState() {
  return {
    projectedOwnerUid,
    credentialPlaneReady,
    projectionGeneration,
    projectedProviderIds: [...projectedProviderIds],
    credentialDirectory,
    sessionDirectoryBindings: sessionDirectoryById.size,
    lock: credentialPlaneLock.snapshot(),
    activeAbortControllers: activeCredentialAbortControllers.size,
  };
}

/**
 * Publish chi directory da verify cua projection hien tai. Production va test
 * deu bat buoc truyen directory; khong co test-only credential bypass.
 */
export function markCredentialPlaneReady(ownerUid, providerIds = [], directory = null) {
  const normalizedDirectory = String(directory || "").trim();
  if (!normalizedDirectory) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_REQUIRED",
      "Projection credential phải publish một OpenCode directory đã xác minh."
    );
  }
  if (
    normalizedDirectory
    && pendingCredentialDirectory
    && normalizedDirectory !== pendingCredentialDirectory
  ) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_CANDIDATE_MISMATCH",
      "Directory publish không khớp candidate của projection hiện tại."
    );
  }
  projectedOwnerUid = ownerUid === null || ownerUid === undefined ? null : String(ownerUid);
  projectedProviderIds = new Set((providerIds || []).map((id) => String(id)));
  credentialDirectory = normalizedDirectory;
  lastCredentialDirectory = normalizedDirectory;
  pendingCredentialDirectory = null;
  credentialPlaneReady = true;
  projectionGeneration += 1;
  return credentialPlaneState();
}

export function markCredentialPlaneFailed() {
  projectedOwnerUid = null;
  projectedProviderIds = new Set();
  credentialDirectory = null;
  pendingCredentialDirectory = null;
  credentialPlaneReady = false;
  projectionGeneration += 1;
  return credentialPlaneState();
}

function assertCredentialWriteContext() {
  if (credentialOperationContext.getStore()?.mode !== "write") {
    throw credentialPlaneError(
      "CREDENTIAL_WRITE_LOCK_REQUIRED",
      "Directory projection chỉ được quản lý trong WRITE lock."
    );
  }
}

/** Mot candidate duy nhat cho lan projection; chi publish sau verify PASS. */
export function allocateCredentialProjectionDirectory() {
  assertCredentialWriteContext();
  if (pendingCredentialDirectory) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_ALREADY_ALLOCATED",
      "Projection hiện tại đã có directory candidate."
    );
  }
  const candidateDirectory = path.join(
    OPENCODE_CONTEXT_ROOT,
    `zalo-owner-credential-context-${credentialBootId}-${projectionGeneration + 1}`
  );
  pendingCredentialDirectory = candidateDirectory;
  try {
    // OpenCode 1.18.4 chi realpath directory khi message inference bat dau.
    // Tao vat ly TRUOC provider verification/publish de catalog PASS khong the
    // che lap mot directory chi ton tai tren chuoi.
    mkdirSync(candidateDirectory, { recursive: true });
  } catch (cause) {
    pendingCredentialDirectory = null;
    const error = credentialPlaneError(
      "CREDENTIAL_DIRECTORY_CREATE_FAILED",
      "Không thể tạo thư mục ngữ cảnh OpenCode cho credential projection."
    );
    error.credentialDirectory = candidateDirectory;
    error.cause = cause;
    throw error;
  }
  lastCredentialDirectory = candidateDirectory;
  return candidateDirectory;
}

/** Writer co the doc context cu/ung vien gan nhat; reader khong bao gio thay no. */
export function credentialProjectionDiscoveryDirectory() {
  assertCredentialWriteContext();
  return credentialDirectory || lastCredentialDirectory || null;
}

function assertCredentialPlane({ ownerUid = undefined, providerId = undefined } = {}) {
  if (!credentialPlaneReady) {
    throw credentialPlaneError(
      "CREDENTIAL_PLANE_NOT_READY",
      "Kết nối AI chưa sẵn sàng cho tài khoản Zalo hiện tại."
    );
  }
  if (ownerUid !== undefined) {
    const expected = ownerUid === null ? null : String(ownerUid);
    if (expected !== projectedOwnerUid) {
      throw credentialPlaneError(
        "OWNER_CONTEXT_CHANGED",
        "Tài khoản Zalo đã thay đổi trong lúc yêu cầu đang chờ."
      );
    }
  }
  if (providerId !== undefined && providerId !== null && providerId !== "") {
    const provider = String(providerId);
    if (!projectedProviderIds.has(provider)) {
      throw credentialPlaneError(
        "OWNER_PROVIDER_CREDENTIAL_MISSING",
        "Hãng AI đang chọn chưa có API key của tài khoản Zalo hiện tại."
      );
    }
  }
}

export async function withCredentialPlaneRead(expectation = {}, operation) {
  const current = credentialOperationContext.getStore();
  if (current) {
    if (current.mode === "read") assertCredentialPlane(expectation);
    return operation(current.signal);
  }

  const release = await credentialPlaneLock.acquireRead();
  const controller = new AbortController();
  activeCredentialAbortControllers.add(controller);
  try {
    assertCredentialPlane(expectation);
    return await credentialOperationContext.run(
      {
        mode: "read",
        signal: controller.signal,
        directory: credentialDirectory,
        projectionGeneration,
      },
      () => operation(controller.signal)
    );
  } finally {
    activeCredentialAbortControllers.delete(controller);
    release();
  }
}

export async function withCredentialPlaneWrite(operation) {
  if (credentialOperationContext.getStore()) {
    throw credentialPlaneError("CREDENTIAL_LOCK_NESTED_WRITE", "Không được lồng credential WRITE lock.");
  }
  const release = await credentialPlaneLock.acquireWrite();
  try {
    return await credentialOperationContext.run({
      mode: "write",
      signal: null,
      directory: credentialDirectory,
      projectionGeneration,
    }, operation);
  } finally {
    release();
  }
}

function appendCredentialDirectory(path, directory) {
  const separator = String(path).includes("?") ? "&" : "?";
  return `${path}${separator}directory=${encodeURIComponent(directory)}`;
}

function classifySessionRequest(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  const pathname = String(path || "").split("?", 1)[0];
  if (pathname === "/session" && method === "POST") {
    return { type: "create", sessionId: null };
  }
  const match = pathname.match(/^\/session\/([^/]+)(\/message)?$/);
  if (!match) return null;
  let sessionId;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    sessionId = match[1];
  }
  if (!match[2] && method === "GET") return { type: "get", sessionId };
  if (!match[2] && method === "DELETE") return { type: "delete", sessionId };
  if (match[2] && method === "POST") return { type: "message", sessionId };
  return null;
}

function sessionContextNotFound(code, message) {
  const error = credentialPlaneError(code, message);
  error.status = 404;
  return error;
}

function credentialRequestForContext(path, options, needsCredentialContext) {
  const sessionRequest = classifySessionRequest(path, options);
  if (!needsCredentialContext) return { path, directory: null, sessionRequest };
  const current = credentialOperationContext.getStore();
  const explicit = String(options?.credentialDirectory || "").trim() || null;
  if (current?.mode === "read" && explicit && explicit !== current.directory) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_CONTEXT_CHANGED",
      "Reader không được dùng directory ngoài projection đang active."
    );
  }
  const activeDirectory = explicit || current?.directory || null;
  if (!activeDirectory) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_REQUIRED",
      "OpenCode credential operation thiếu active projection directory."
    );
  }

  let directory = activeDirectory;
  if (sessionRequest && sessionRequest.type !== "create") {
    const sessionId = String(sessionRequest.sessionId);
    const boundDirectory = sessionDirectoryById.get(sessionId);
    if (!boundDirectory) {
      throw sessionContextNotFound(
        "OPENCODE_SESSION_DIRECTORY_UNKNOWN",
        "Session OpenCode không có directory binding trong app boot hiện tại."
      );
    }
    if (explicit && explicit !== boundDirectory) {
      throw credentialPlaneError(
        "CREDENTIAL_DIRECTORY_CONTEXT_CHANGED",
        "Directory chỉ định không khớp directory đã bind của session OpenCode."
      );
    }
    if (sessionRequest.type !== "delete" && boundDirectory !== activeDirectory) {
      sessionDirectoryById.delete(sessionId);
      throw sessionContextNotFound(
        "OPENCODE_SESSION_CONTEXT_STALE",
        "Session OpenCode thuộc projection directory cũ và phải được tạo lại."
      );
    }
    // DELETE la cleanup, nen duoc quay lai dung directory ma session da tao.
    directory = boundDirectory;
  }

  return {
    path: appendCredentialDirectory(path, directory),
    directory,
    sessionRequest,
  };
}

function requestNeedsCredentialRead(path, options) {
  const pathname = String(path || "").split("?", 1)[0];
  if (pathname === "/provider" || pathname === "/config/providers") return true;
  return Boolean(classifySessionRequest(path, options));
}

async function callUnlocked(config, path, options = {}) {
  const {
    timeoutMs = REQUEST_TIMEOUT_MS,
    credentialDependent: _credentialDependent,
    credentialMutation: _credentialMutation,
    credentialDirectory: _credentialDirectory,
    signal: callerSignal,
    ...fetchOptions
  } = options;
  const url = `${baseUrl(config)}${path}`;
  const controller = new AbortController();
  const contextSignal = credentialOperationContext.getStore()?.signal || null;
  const externalSignals = [...new Set([contextSignal, callerSignal].filter(Boolean))];
  const abortFromOutside = () => controller.abort();
  for (const signal of externalSignals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromOutside, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Raw upstream body co the chua du lieu nhay cam; khong giu/tra ve.
      }
      const safeName = [parsed?.name, parsed?.error?.name]
        .find((value) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(String(value || "")));
      const safeRef = [parsed?.ref, parsed?.data?.ref, parsed?.error?.ref, parsed?.error?.data?.ref]
        .find((value) => /^err_[A-Za-z0-9_-]{1,64}$/.test(String(value || "")));
      const runtimeFailure = response.status >= 500;
      const error = new Error(runtimeFailure
        ? "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại."
        : `OpenCode từ chối yêu cầu (HTTP ${response.status}).`);
      error.status = response.status;
      error.code = runtimeFailure ? "OPENCODE_RUNTIME_ERROR" : "OPENCODE_HTTP_ERROR";
      error.opencodeDiagnostic = Object.freeze({
        status: response.status,
        ...(safeName ? { name: String(safeName) } : {}),
        ...(safeRef ? { ref: String(safeRef) } : {}),
      });
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      if (!timedOut && externalSignals.some((signal) => signal.aborted)) {
        throw credentialPlaneError(
          "CREDENTIAL_OPERATION_ABORTED",
          "Tác vụ AI cũ đã dừng để chuyển tài khoản Zalo."
        );
      }
      const timeoutError = new Error("OpenCode không phản hồi (quá thời gian chờ).");
      timeoutError.code = "OPENCODE_TIMEOUT";
      throw timeoutError;
    }
    if (error.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(error.message)) {
      throw new Error(`Không kết nối được OpenCode tại ${baseUrl(config)}. Đã chạy "opencode serve" chưa?`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of externalSignals) signal.removeEventListener("abort", abortFromOutside);
  }
}

export async function call(config, path, options = {}) {
  const current = credentialOperationContext.getStore();
  if (options.credentialMutation === true && current?.mode !== "write") {
    throw credentialPlaneError(
      "CREDENTIAL_WRITE_LOCK_REQUIRED",
      "Credential OpenCode chỉ được thay đổi trong WRITE lock."
    );
  }
  const sessionRequest = classifySessionRequest(path, options);
  const structurallyCredentialDependent = requestNeedsCredentialRead(path, options);
  // Session routes cannot opt out. /provider keeps one WRITE-only default
  // discovery seam before the first projection directory exists.
  const needsRead = Boolean(sessionRequest)
    || (options.credentialDependent ?? structurallyCredentialDependent);
  if (needsRead && !current) {
    return withCredentialPlaneRead({}, () => call(config, path, options));
  }
  const request = credentialRequestForContext(path, options, needsRead);
  try {
    const response = await callUnlocked(config, request.path, options);
    if (request.sessionRequest?.type === "create") {
      const sessionId = String(response?.id || "").trim();
      if (!sessionId) {
        throw credentialPlaneError(
          "OPENCODE_SESSION_ID_REQUIRED",
          "OpenCode không trả về session id để bind projection directory."
        );
      }
      sessionDirectoryById.set(sessionId, request.directory);
    } else if (request.sessionRequest?.type === "delete") {
      sessionDirectoryById.delete(String(request.sessionRequest.sessionId));
    }
    return response;
  } catch (error) {
    if (request.sessionRequest?.sessionId && error.status === 404) {
      sessionDirectoryById.delete(String(request.sessionRequest.sessionId));
    }
    throw error;
  }
}

/**
 * Ngu canh toi thieu de chua noi Soul. Soul + chu de + vai tro da vai nghin ky tu,
 * cong kho tri thuc toi da 12000 ky tu nua; model 4096 token khong chua noi.
 */
const CHAT_MIN_CONTEXT = 8192;

/** Chi giu model chat duoc: vao chu, ra chu, va du ngu canh. */
function isChatModel(model) {
  const capabilities = model?.capabilities || {};
  return (
    capabilities.input?.text === true &&
    capabilities.output?.text === true &&
    Number(model?.limit?.context || 0) >= CHAT_MIN_CONTEXT
  );
}

/**
 * Catalog chat canonical lay truc tiep tu OpenCode. Khong them model ao: neu
 * provider/model bien mat khoi runtime thi ket qua cung bien mat theo.
 */
export async function loadChatProviders(config) {
  return withCredentialPlaneRead({}, async () => {
    const response = await call(config, "/config/providers", { method: "GET" });
    const allowedProviders = new Set(credentialPlaneState().projectedProviderIds);
    return (response.providers || [])
      .filter((provider) => allowedProviders.has(String(provider.id)))
      .map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        models: Object.entries(provider.models || {})
          .filter(([, model]) => isChatModel(model))
          .map(([id, model]) => ({
            id: `${provider.id}/${id}`,
            label: model.name || id,
            context: model.limit?.context || 0,
            beta: model.status === "beta",
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .filter((provider) => provider.models.length > 0);
  });
}

/** System default chi ton tai khi exact canonical ID dang co trong catalog. */
export function systemDefaultFromProviders(providers = []) {
  const provider = providers.find((item) => item.id === SYSTEM_DEFAULT_PROVIDER_ID);
  return provider?.models?.some((model) => model.id === SYSTEM_DEFAULT_CANONICAL_MODEL)
    ? SYSTEM_DEFAULT_CANONICAL_MODEL
    : "";
}

/**
 * User-saved model luon thang. Chi resolve system default khi canonical field
 * dang rong; loi catalog hoac model bien mat thi giu fallback rong hien co.
 */
export async function resolveEffectiveModelConfig(config, providers) {
  const current = String(config?.opencodeModel || "").trim();
  if (current) return { ...(config || {}), opencodeModel: current };

  try {
    const catalog = Array.isArray(providers) ? providers : await loadChatProviders(config || {});
    return {
      ...(config || {}),
      opencodeModel: systemDefaultFromProviders(catalog),
    };
  } catch {
    return { ...(config || {}), opencodeModel: "" };
  }
}

/**
 * "groq/openai/gpt-oss-120b" -> { providerID: "groq", modelID: "openai/gpt-oss-120b" }
 * Cat o dau gach cheo DAU TIEN: id model cua Groq co san dau gach ben trong
 * (openai/gpt-oss-120b, groq/compound, meta-llama/...), cat het la sai.
 */
export function splitModel(value) {
  const raw = String(value || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/**
 * Hai endpoint doi hai dang KHAC NHAU cho cung mot thu:
 *   POST /session              -> model: { providerID, id }
 *   POST /session/{id}/message -> model: { providerID, modelID }
 * Gui sai dang thi OpenCode tra 400 truoc khi cham toi model nao.
 */
function modelForSession(config) {
  const model = splitModel(config.opencodeModel);
  return model ? { model: { providerID: model.providerID, id: model.modelID } } : {};
}

function modelForMessage(config) {
  const model = splitModel(config.opencodeModel);
  return model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {};
}

export async function ping(config) {
  return withCredentialPlaneRead({}, async () => {
    const agents = await call(config, "/agent", { method: "GET" });
    const tools = await call(config, "/experimental/tool/ids", { method: "GET" }).catch(() => []);

    // Provider nao dang co credential thi OpenCode moi tra ve; khong tu bia them.
    let providers = [];
    try {
      providers = await loadChatProviders(config);
    } catch {
      // Khong lay duoc danh sach thi de trong, UI se giu nguyen lua chon da luu.
    }

    return {
      agents: agents.map((a) => a.name),
      tools,
      providers,
      models: providers.flatMap((p) => p.models.map((m) => m.id)),
      systemDefaultModel: systemDefaultFromProviders(providers),
    };
  });
}

/**
 * Tin nhan MO DAU nap vao session moi: Soul + nhiem vu + danh sach tool.
 * Chi gui dung mot lan khi session vua duoc tao.
 */
export function buildBootstrapMessage({ soul, roleTone, allowedTopics, knowledgeSection, recentHistory }) {
  const parts = [];
  parts.push("# SOUL");
  parts.push(soul?.trim() || "(chưa cấu hình Soul)");

  if (roleTone?.trim()) {
    parts.push("", "# VAI TRÒ & GIỌNG ĐIỆU", roleTone.trim());
  }
  if (allowedTopics?.trim()) {
    parts.push("", "# CHỦ ĐỀ ĐƯỢC PHÉP TRẢ LỜI", allowedTopics.trim());
  }
  if (knowledgeSection) {
    parts.push("", "# " + knowledgeSection);
  }

  parts.push(
    "",
    "# NHIỆM VỤ",
    "Bạn đang tư vấn khách hàng qua Zalo. Mỗi tin nhắn tiếp theo tôi gửi vào phiên này là MỘT tin nhắn của khách.",
    "Với mỗi tin, hãy trả lời ĐÚNG nội dung sẽ gửi cho khách, không thêm lời dẫn, không markdown, không giải thích quá trình.",
    "Nếu tin nhắn KHÔNG liên quan đến các chủ đề được phép ở trên, trả lời ĐÚNG MỘT từ: SKIP",
    "Dùng tiếng Việt, ngắn gọn, đúng vai trò và giọng điệu đã mô tả.",
    'Tin có dạng "Tên: nội dung" thì "Tên" là người gửi (chat nhóm), không phải một phần nội dung.',
    'Nếu tin có kèm khối "# HỒ SƠ NGƯỜI ĐANG NHẮN", đó là ghi chú nội bộ để bạn hiểu ngữ cảnh — dùng để trả lời cho nhất quán, KHÔNG đọc lại cho khách.',
    "",
    "# CÁCH TÁCH TIN NHẮN (BẮT BUỘC)",
    "Không viết một đoạn dài. Tách câu trả lời thành 1, 2 hoặc 3 tin nhắn riêng biệt — nhiều hơn nếu thật sự cần — sao cho phù hợp với câu hỏi của khách.",
    "Mỗi tin chỉ từ 1 đến 2 câu ngắn.",
    "Ngăn cách các tin bằng MỘT DÒNG TRỐNG. Hệ thống sẽ cắt theo dòng trống đó và gửi thành từng tin Zalo riêng.",
    'KHÔNG tự viết nhãn "Bubble 1:", "Tin 1:" hay đánh số — khách sẽ nhìn thấy đúng những ký tự đó.',
    "Nếu có KHO TRI THỨC ở trên, ưu tiên thông tin trong tài liệu, tuyệt đối không bịa.",
    "",
    "# CÁCH TIN ĐƯỢC GỬI ĐI",
    "Hệ thống Zalo Web sẽ tự lấy phần trả lời của bạn và gửi vào đúng cuộc trò chuyện.",
    "Bạn KHÔNG cần gọi tool nào để gửi tin, và KHÔNG được tự gửi — làm vậy khách sẽ nhận trùng hai lần."
  );

  parts.push(
    "",
    "# CÔNG CỤ",
    "Phiên này KHÔNG có tool nào. Bạn chỉ trả lời bằng chữ, không chạy lệnh, không đọc/ghi tệp.",
    "Nếu cần thông tin không có sẵn, hãy nói thẳng là chưa có thay vì tìm cách tra cứu."
  );

  // Dat SAT CUOI, sau toan bo phan tinh. Soul + tri thuc giong het nhau o moi
  // cuoc tro chuyen nen duoc nha cung cap cache lai; nhet lich su (khac nhau
  // tung nguoi) vao giua se lam vo cache cua tat ca nhung gi dung sau no.
  if (recentHistory) {
    parts.push(
      "",
      "# CUỘC TRÒ CHUYỆN TRƯỚC ĐÓ",
      "Dưới đây là các tin đã trao đổi trước đây trong ĐÚNG cuộc trò chuyện này — cũ ở trên, mới ở dưới.",
      'Dòng bắt đầu bằng "Bạn (đã trả lời):" là lời của chính bạn.',
      "Hãy nhớ những gì đã nói để không hỏi lại điều đã biết, không mâu thuẫn với chính mình, không đổi giọng.",
      "KHÔNG trả lời lại các tin này — chúng chỉ để bạn nắm ngữ cảnh.",
      "",
      recentHistory
    );
  }

  parts.push("", "Nếu bạn đã nắm nhiệm vụ, trả lời đúng một từ: READY");
  return parts.join("\n");
}

/**
 * Xoa han cac session ben OpenCode. Loi cua tung session khong duoc lam hong
 * ca me: doi Soul la viec chi vua bam Luu, khong the vi mot session da chet ma
 * bao loi ve giao dien.
 */
export async function deleteSessions(config, sessionIds) {
  let daXoa = 0;
  for (const id of sessionIds || []) {
    try {
      await call(config, `/session/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentialDependent: true,
      });
      daXoa++;
    } catch (error) {
      if (error.status !== 404) {
        console.warn("[opencode] Khong xoa duoc session", id, error.message);
      }
    }
  }
  return daXoa;
}

/**
 * Chay mot viec le bang session dung-mot-lan roi xoa ngay. Dung cho cac tac vu
 * he thong (duc ket ho so khach) - chung KHONG duoc lot vao phien dang noi
 * chuyen voi khach, neu khong cau lenh ghi chep se nam trong lich su va anh
 * huong den moi cau tra loi sau do.
 */
/** @param {string|Array} prompt chuoi chu, hoac mang part (co the kem tep). */
async function runOneShotUnlocked(config, title, prompt) {
  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({
      title,
      agent: config.opencodeAgent || "general",
      ...modelForSession(config),
    }),
  });

  try {
    const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: config.opencodeAgent || "general",
        ...modelForMessage(config),
        tools: KHONG_TOOL,
        parts: Array.isArray(prompt) ? prompt : [{ type: "text", text: prompt }],
      }),
    });
    if (response?.info?.error) {
      throw new Error(`OpenCode lỗi: ${JSON.stringify(response.info.error).slice(0, 300)}`);
    }
    return { text: extractReply(response), tokens: response?.info?.tokens || null };
  } finally {
    await deleteSessions(config, [session.id]);
  }
}

export async function runOneShot(config, title, prompt) {
  const providerId = splitModel(config?.opencodeModel)?.providerID;
  return withCredentialPlaneRead({ providerId }, () => runOneShotUnlocked(config, title, prompt));
}

/** Lay session cua thread; chua co, da chet hoac qua dai thi tao moi va nap Soul. */
async function ensureSessionUnlocked(config, ownerUid, threadId, bootstrapContext, onEvent) {
  if (!ownerUid) throw new Error("ensureSession: thieu ownerUid - khong dung phien cua tai khoan khac.");
  let existing = await getOpencodeSessionInfo(ownerUid, threadId);
  let xoayTuPhien = null;
  let soLuotCu = 0;

  if (existing && existing.turns >= PHIEN_MAX_LUOT) {
    // Xoay phien. An toan vi phien moi duoc nap lai Soul + lich su + ho so.
    xoayTuPhien = existing.sessionId;
    soLuotCu = existing.turns;
    await deleteSessions(config, [existing.sessionId]);
    await deleteOpencodeSession(ownerUid, threadId);
  } else if (existing) {
    try {
      await call(config, `/session/${encodeURIComponent(existing.sessionId)}`, {
        method: "GET",
      });
      return { sessionId: existing.sessionId, created: false, turns: existing.turns };
    } catch (error) {
      // Session bien mat phia OpenCode (restart, xoa...) -> bo di va tao lai.
      if (error.status !== 404) throw error;
      await deleteOpencodeSession(ownerUid, threadId);
    }
  }

  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({
      title: `Zalo - ${bootstrapContext.threadTitle || threadId}`,
      agent: config.opencodeAgent || "general",
      ...modelForSession(config),
    }),
  });

  await saveOpencodeSession(ownerUid, threadId, session.id);

  const bootstrap = buildBootstrapMessage(bootstrapContext);
  await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      tools: KHONG_TOOL,
      parts: [{ type: "text", text: bootstrap }],
    }),
  });
  await onEvent?.({ sessionId: session.id, bootstrap, xoayTuPhien, soLuotCu });

  return { sessionId: session.id, created: true, turns: 0, xoayTuPhien, soLuotCu };
}

export async function ensureSession(config, ownerUid, threadId, bootstrapContext, onEvent) {
  const providerId = splitModel(config?.opencodeModel)?.providerID;
  return withCredentialPlaneRead(
    { ownerUid, providerId },
    () => ensureSessionUnlocked(config, ownerUid, threadId, bootstrapContext, onEvent)
  );
}

/**
 * Chi lay cac part type="text". Part "reasoning" la suy nghi noi bo cua agent,
 * gui cho khach la lo toan bo mach suy luan.
 */
export function extractReply(response) {
  return (response?.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/* --- QUAN LY KHOA API CUA CAC HANG --- */

/** Danh muc day du cac hang OpenCode ho tro + hang nao dang co key. */
export async function listAllProviders(config) {
  return withCredentialPlaneRead({}, async () => {
    const response = await getProviderState(config);
    const connected = new Set(response.connected || []);
    return (response.all || [])
      .map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        connected: connected.has(provider.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * Reader tu dong dung active projection directory. Writer projection co the
 * truyen candidate ro rang; default context chi duoc dung de discovery luc
 * chua tung co directory nao, khong bao gio la verification/inference context.
 */
export async function getProviderState(
  config,
  { directory = null, allowDefaultContext = false } = {}
) {
  const explicitDirectory = String(directory || "").trim() || null;
  if (allowDefaultContext && explicitDirectory) {
    throw credentialPlaneError(
      "CREDENTIAL_DIRECTORY_INPUT_CONFLICT",
      "Không được vừa chỉ định directory vừa yêu cầu default context."
    );
  }
  if (allowDefaultContext && credentialOperationContext.getStore()?.mode !== "write") {
    throw credentialPlaneError(
      "CREDENTIAL_WRITE_LOCK_REQUIRED",
      "Default provider discovery chỉ được dùng trong WRITE projection."
    );
  }
  return call(config, "/provider", {
    method: "GET",
    credentialDependent: !allowDefaultContext,
    ...(explicitDirectory ? { credentialDirectory: explicitDirectory } : {}),
  });
}

/** Hai primitive credential duy nhat; WRITE context la bat buoc. */
export async function putProviderAuth(config, providerId, apiKey) {
  const id = String(providerId || "").trim();
  const key = String(apiKey || "").trim();
  if (!id || !key) throw credentialPlaneError("INVALID_CREDENTIAL_INPUT", "Thiếu hãng AI hoặc API key.");
  return call(config, `/auth/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ type: "api", key }),
    credentialDependent: false,
    credentialMutation: true,
  });
}

export async function deleteProviderAuth(config, providerId) {
  const id = String(providerId || "").trim();
  if (!id) throw credentialPlaneError("INVALID_CREDENTIAL_INPUT", "Thiếu hãng AI.");
  return call(config, `/auth/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentialDependent: false,
    credentialMutation: true,
  });
}

/**
 * Goi that mot cau bang model cua hang do. Bat buoc phai co: danh sach model van
 * hien day du ngay ca khi key da het han, nhin giao dien khong the biet key song hay chet.
 */
const TEST_MAX_MODELS = 3;
export const PROVIDER_TEST_TIMEOUT_MS = 20000;

function classifyProviderTestFailure(error) {
  if (error?.code === "OPENCODE_TIMEOUT" || error?.code === "CREDENTIAL_OPERATION_ABORTED") return "TIMEOUT";
  if (error?.code === "OPENCODE_RUNTIME_ERROR") return "OPENCODE_RUNTIME_ERROR";
  const status = Number(error?.status || error?.data?.status || error?.statusCode || 0);
  const text = (() => {
    try {
      return JSON.stringify({
        message: error?.message || "",
        detail: error?.info?.error || error?.data || {},
      }).toLowerCase();
    } catch {
      return "";
    }
  })();
  if ([401, 403].includes(status) || /unauthor|invalid[_ -]?(api[_ -]?)?key|authentication/.test(text)) {
    return "INVALID_KEY";
  }
  if ([402, 429].includes(status) || /quota|credit|billing|rate.?limit/.test(text)) return "NO_QUOTA";
  if (status >= 500) return "OPENCODE_RUNTIME_ERROR";
  if (/unavailable|econnrefused|fetch failed|không kết nối/.test(text)) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "UNKNOWN";
}

const PROVIDER_TEST_SAFE_MESSAGES = {
  INVALID_KEY: "API key không hợp lệ.",
  NO_QUOTA: "Tài khoản hãng AI đã hết hạn mức.",
  PROVIDER_UNAVAILABLE: "Hãng AI đang tạm thời không phản hồi.",
  OPENCODE_RUNTIME_ERROR: "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại.",
  TIMEOUT: "Hãng AI phản hồi quá thời gian cho phép.",
  UNKNOWN: "Không kiểm tra được API key.",
};

function providerTestError(code) {
  return credentialPlaneError(code, PROVIDER_TEST_SAFE_MESSAGES[code] || PROVIDER_TEST_SAFE_MESSAGES.UNKNOWN);
}

export async function testProviderKey(config, providerId) {
  const id = String(providerId || "").trim();
  if (!id) throw providerTestError("PROVIDER_UNAVAILABLE");
  try {
    return await withCredentialPlaneRead({ providerId: id }, async () => {
      let sessionId = null;
      try {
        const providers = await call(config, "/config/providers", { method: "GET" });
        const provider = (providers.providers || []).find((p) => p.id === id);
        const all = Object.entries(provider?.models || {})
          .filter(([, model]) => isChatModel(model))
          .map(([modelId]) => modelId);
        if (all.length === 0) throw providerTestError("PROVIDER_UNAVAILABLE");

        const dangChon = splitModel(config.opencodeModel);
        const uuTien = dangChon?.providerID === id ? dangChon.modelID : null;
        const danhSach = [...new Set([uuTien, ...all].filter(Boolean))].slice(0, TEST_MAX_MODELS);

        const session = await call(config, "/session", {
          method: "POST",
          timeoutMs: PROVIDER_TEST_TIMEOUT_MS,
          body: JSON.stringify({ title: "Kiem tra key", agent: config.opencodeAgent || "general" }),
        });
        sessionId = session.id;

        const failures = [];
        let daThu = 0;
        for (const modelID of danhSach) {
          daThu += 1;
          try {
            const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
              method: "POST",
              timeoutMs: PROVIDER_TEST_TIMEOUT_MS,
              body: JSON.stringify({
                agent: config.opencodeAgent || "general",
                model: { providerID: id, modelID },
                tools: KHONG_TOOL,
                parts: [{ type: "text", text: "Trả lời đúng một từ: OK" }],
              }),
            });
            if (response?.info?.error) {
              failures.push(classifyProviderTestFailure(response.info.error));
              continue;
            }
            return { model: `${id}/${modelID}`, reply: extractReply(response), daThu };
          } catch (error) {
            failures.push(classifyProviderTestFailure(error));
          }
        }

        const priority = [
          "INVALID_KEY",
          "NO_QUOTA",
          "TIMEOUT",
          "OPENCODE_RUNTIME_ERROR",
          "PROVIDER_UNAVAILABLE",
          "UNKNOWN",
        ];
        throw providerTestError(priority.find((code) => failures.includes(code)) || "UNKNOWN");
      } finally {
        // Cleanup dung CHINH directory da tao/test session, roi moi nha READ.
        if (sessionId) {
          await call(config, `/session/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            timeoutMs: 5000,
            credentialDependent: true,
          }).catch(() => {});
        }
      }
    });
  } catch (error) {
    if (PROVIDER_TEST_SAFE_MESSAGES[error?.code]) throw error;
    throw providerTestError(classifyProviderTestFailure(error));
  }
}

export async function sendPrompt(config, sessionId, text) {
  const providerId = splitModel(config?.opencodeModel)?.providerID;
  return withCredentialPlaneRead({ providerId }, async () => {
    const response = await call(config, `/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: config.opencodeAgent || "general",
        ...modelForMessage(config),
        tools: KHONG_TOOL,
        parts: [{ type: "text", text }],
      }),
    });

    if (response?.info?.error) {
      throw new Error(`OpenCode lỗi: ${JSON.stringify(response.info.error).slice(0, 300)}`);
    }
    return {
      reply: extractReply(response),
      tokens: response?.info?.tokens || null,
      model: `${response?.info?.providerID || "?"}/${response?.info?.modelID || "?"}`,
    };
  });
}
