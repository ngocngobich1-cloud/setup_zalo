export const PDF_AUTOMATION_HANDLED = "HANDLED";
export const PDF_AUTOMATION_CONTINUE = "CONTINUE";
export const PDF_AUTOMATION_MAX_BYTES = 10 * 1024 * 1024;

const pendingConfirmations = new Map();

function pendingKey(ownerUid, threadId) {
  return `${String(ownerUid)}\u0000${String(threadId)}`;
}

export function normalizePdfKeyword(value) {
  return String(value || "").trim().normalize("NFC").toLowerCase();
}

export function preparePdfKeyword(value) {
  const keyword = String(value || "").trim().normalize("NFC");
  const keywordNorm = normalizePdfKeyword(keyword);
  if (!keywordNorm) throw new Error("Tên tài liệu / từ khóa không được để trống.");
  return { keyword, keywordNorm };
}

export function parsePdfEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

/** Kiem tra bytes that; khong tin rieng ten file hay MIME browser gui. */
export function validatePdfUpload(file) {
  if (!file) throw new Error("Thiếu file PDF.");
  const pdfName = String(file.originalname || file.filename || "").split(/[\\/]/).pop()?.trim() || "";
  const pdfMime = String(file.mimetype || file.mime || "").trim().toLowerCase();
  const pdfData = file.buffer;
  const pdfSize = Buffer.isBuffer(pdfData) ? pdfData.length : Number(file.size) || 0;

  if (!/\.pdf$/i.test(pdfName)) throw new Error("File phải có phần mở rộng .pdf.");
  if (pdfMime !== "application/pdf") throw new Error("MIME của file phải là application/pdf.");
  if (!Buffer.isBuffer(pdfData) || pdfSize <= 0) throw new Error("File PDF trống hoặc không hợp lệ.");
  if (pdfSize > PDF_AUTOMATION_MAX_BYTES) throw new Error("File PDF vượt quá 10 MB.");
  if (pdfData.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new Error("Nội dung file không có chữ ký PDF hợp lệ.");
  }

  return { pdfName, pdfMime: "application/pdf", pdfSize, pdfData };
}

export function hasExactPdfConfirmation(tins) {
  return Array.isArray(tins) && tins.some((message) => (
    String(message?.content || "").trim().toLowerCase() === "ok"
  ));
}

export function selectPdfAutomationRule(rules, customerContent) {
  const normalizedContent = normalizePdfKeyword(customerContent);
  if (!normalizedContent) return null;
  const matches = (Array.isArray(rules) ? rules : []).filter((rule) => {
    const keywordNorm = normalizePdfKeyword(rule?.keywordNorm ?? rule?.keyword);
    return Boolean(rule?.enabled !== false && keywordNorm && normalizedContent.includes(keywordNorm));
  });
  matches.sort((a, b) => {
    const lengthDifference = normalizePdfKeyword(b.keywordNorm ?? b.keyword).length
      - normalizePdfKeyword(a.keywordNorm ?? a.keyword).length;
    return lengthDifference || Number(a.id) - Number(b.id);
  });
  return matches[0] || null;
}

export function getPendingPdfConfirmation(ownerUid, threadId) {
  if (!ownerUid || !threadId) return null;
  return pendingConfirmations.get(pendingKey(ownerUid, threadId)) || null;
}

export function setPendingPdfConfirmation(ownerUid, threadId, pending) {
  if (!ownerUid || !threadId || !pending?.ruleId) return false;
  pendingConfirmations.set(pendingKey(ownerUid, threadId), {
    ownerUid: String(ownerUid),
    threadId: String(threadId),
    ruleId: Number(pending.ruleId),
    runtimeGeneration: Number(pending.runtimeGeneration),
  });
  return true;
}

export function clearPendingPdfConfirmation(ownerUid, threadId) {
  if (!ownerUid || !threadId) return false;
  return pendingConfirmations.delete(pendingKey(ownerUid, threadId));
}

export function clearPendingPdfConfirmationsForRule(ownerUid, ruleId) {
  let cleared = 0;
  for (const [key, pending] of pendingConfirmations) {
    if (pending.ownerUid === String(ownerUid) && pending.ruleId === Number(ruleId)) {
      pendingConfirmations.delete(key);
      cleared += 1;
    }
  }
  return cleared;
}

export function clearAllPendingPdfConfirmations() {
  const count = pendingConfirmations.size;
  pendingConfirmations.clear();
  return count;
}

function confirmationText(keyword) {
  return `Em gửi file "${keyword}" cho mình nhé?\nNếu đồng ý, trả lời OK.`;
}

/**
 * Orchestrator co dependency seams hep de acceptance test khong can Zalo that.
 * Runtime production tiem DB/send/origin canonical vao mot lan trong zalo-service.
 */
export function createPdfAutomationHandler({
  listEnabledRules,
  getRuleWithBlob,
  sendMessage,
  isOriginCurrent,
  getOwnerUid,
  getRuntimeGeneration,
  log,
}) {
  const originIsCurrent = (originToken) => !originToken || isOriginCurrent(originToken);
  const safeLog = async (outcome, level, summary, detail = {}) => {
    try {
      await log?.({
        event: "pdf_automation",
        level,
        summary,
        detail: { outcome, ...detail },
      });
    } catch {
      // Nhat ky khong duoc lam thay doi quyet dinh gui file.
    }
  };

  return async function handlePdfAutomation({ tins, tin, originToken = null }) {
    if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;

    const ownerUid = String(originToken?.originOwnerUid || getOwnerUid?.() || "").trim();
    const threadId = String(tin?.threadId || tins?.[0]?.threadId || "").trim();
    if (!ownerUid || !threadId) return PDF_AUTOMATION_CONTINUE;

    const pending = getPendingPdfConfirmation(ownerUid, threadId);
    if (pending) {
      clearPendingPdfConfirmation(ownerUid, threadId);

      if (!hasExactPdfConfirmation(tins)) {
        await safeLog("confirmation_cancelled", "info", "Khách không xác nhận đúng OK — đã hủy chờ gửi PDF", {
          threadId,
          ruleId: pending.ruleId,
        });
      } else {
        const currentGeneration = Number(originToken?.originRuntimeGeneration ?? getRuntimeGeneration?.());
        if (!originIsCurrent(originToken) || pending.runtimeGeneration !== currentGeneration) {
          if (originIsCurrent(originToken)) {
            await safeLog("stale_origin_aborted", "warn", "Đã hủy gửi PDF từ runtime cũ", {
              threadId,
              ruleId: pending.ruleId,
            });
          }
          return PDF_AUTOMATION_HANDLED;
        }

        let rule;
        try {
          rule = await getRuleWithBlob(ownerUid, pending.ruleId);
        } catch (error) {
          if (originIsCurrent(originToken)) {
            await safeLog("pdf_send_failed", "error", "Không đọc được PDF đã xác nhận", {
              threadId,
              ruleId: pending.ruleId,
              error: error.message,
            });
          }
          return PDF_AUTOMATION_HANDLED;
        }
        if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;
        if (!rule?.enabled) {
          await safeLog("rule_missing_or_disabled", "warn", "Rule PDF đã bị xóa hoặc tắt trước khi gửi", {
            threadId,
            ruleId: pending.ruleId,
          });
          return PDF_AUTOMATION_CONTINUE;
        }

        try {
          if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;
          await sendMessage({
            threadId: tin.threadId,
            threadType: tin.threadType,
            text: "",
            attachment: {
              buffer: rule.pdfData,
              filename: rule.pdfName,
              size: rule.pdfSize,
              mime: rule.pdfMime,
            },
            originToken,
          });
        } catch (error) {
          if (originIsCurrent(originToken)) {
            await safeLog("pdf_send_failed", "error", `Không gửi được PDF "${rule.pdfName}"`, {
              threadId,
              ruleId: rule.id,
              pdfName: rule.pdfName,
              error: error.message,
            });
          }
          return PDF_AUTOMATION_HANDLED;
        }
        if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;
        await safeLog("pdf_send_success", "ok", `Đã gửi PDF "${rule.pdfName}"`, {
          threadId,
          ruleId: rule.id,
          pdfName: rule.pdfName,
          pdfSize: rule.pdfSize,
        });
        return PDF_AUTOMATION_HANDLED;
      }
    }

    let rules;
    try {
      rules = await listEnabledRules(ownerUid);
    } catch (error) {
      await safeLog("rule_lookup_failed", "error", "Không đọc được danh sách PDF automation", {
        threadId,
        error: error.message,
      });
      return PDF_AUTOMATION_CONTINUE;
    }
    if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;

    const matched = selectPdfAutomationRule(rules, tin?.content);
    if (!matched) return PDF_AUTOMATION_CONTINUE;

    try {
      if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;
      await sendMessage({
        threadId: tin.threadId,
        threadType: tin.threadType,
        text: confirmationText(matched.keyword),
        originToken,
      });
    } catch (error) {
      if (originIsCurrent(originToken)) {
        await safeLog("confirmation_send_failed", "error", `Không gửi được xác nhận PDF "${matched.keyword}"`, {
          threadId,
          ruleId: matched.id,
          error: error.message,
        });
      }
      return PDF_AUTOMATION_CONTINUE;
    }
    if (!originIsCurrent(originToken)) return PDF_AUTOMATION_HANDLED;

    setPendingPdfConfirmation(ownerUid, threadId, {
      ruleId: matched.id,
      runtimeGeneration: Number(originToken?.originRuntimeGeneration ?? getRuntimeGeneration?.()),
    });
    await safeLog("confirmation_sent", "ok", `Đã hỏi xác nhận gửi PDF "${matched.keyword}"`, {
      threadId,
      ruleId: matched.id,
      keyword: matched.keyword,
    });
    return PDF_AUTOMATION_HANDLED;
  };
}
