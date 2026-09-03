import { loadChatProviders, runOneShot, splitModel } from "./opencode.js";
import { addLog } from "./activity-log.js";
import {
  CAPABILITIES,
  ROUTE_MODES,
  SURFACES,
  capabilityRoutingEnabled,
  routeModelRequest,
} from "./ai-model-router.js";
import { classifyProviderFailure } from "./provider-failure.js";
import { withOwnerCredentialReadSet } from "./owner-credentials.js";

/**
 * Cho bot "nhin" duoc anh va PDF khach gui qua Zalo.
 *
 * Nguyen tac chong doi hoa don: doc tep DUNG MOT LAN trong mot phien dung-roi-bo,
 * lay ve BAN TOM TAT vai tram chu, roi vut tep di. Tep KHONG BAO GIO duoc dua vao
 * phien dang noi chuyen voi khach - neu dua vao, moi tin nhan sau do deu gui lai
 * ca tep cho model doc lai tu dau. Mot file 15 trang se bi tinh tien 20 lan.
 */

/** Zalo can User-Agent moi chiu tra file. Da do: thieu no thi co luc bi tu choi. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

/** Tran dung luong. Anh chup dien thoai thuong 2-5 MB, PDF 15 trang ~2-10 MB. */
export const TRAN_MB = 10;

/** Anh nho hon nguong nay gan nhu chac chan la sticker/bieu cam -> khong doc. */
const NHO_NHAT_BYTE = 20 * 1024;

const KIEU_ANH = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", heic: "image/heic",
};
const KIEU_KHAC = { pdf: "application/pdf" };

function doiDuoi(ten) {
  const m = String(ten || "").toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  return m ? m[1] : "";
}

/** Nhan dang qua vai byte dau, dung hon la tin vao duoi file. */
function doanKieu(buf, ten) {
  if (buf.length > 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
    if (buf.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  }
  const duoi = doiDuoi(ten);
  return KIEU_ANH[duoi] || KIEU_KHAC[duoi] || null;
}

/**
 * Rut tep ra khoi mot tin nhan Zalo. Tra ve null neu tin khong co tep,
 * hoac la sticker (sticker khong phai anh khach muon minh doc).
 */
export function layTepTuTin(message) {
  const loai = String(message?.msgType || "");
  if (loai === "chat.sticker") return null;
  if (loai !== "chat.photo" && loai !== "share.file") return null;

  const raw = message?.rawJson;
  const noiDung = raw?.data?.content ?? raw?.content;
  const hrefGoc = typeof noiDung?.href === "string" ? noiDung.href.trim() : "";
  const hrefAnhNho = loai === "chat.photo" && typeof noiDung?.thumb === "string"
    ? noiDung.thumb.trim()
    : "";
  const href = hrefGoc || hrefAnhNho;
  if (!href) return null;

  return {
    href,
    ten: noiDung.title || noiDung.fileName || (loai === "chat.photo" ? "anh-khach-gui.jpg" : "tep-khach-gui"),
    loaiTin: loai,
  };
}

export async function taiTep(tep) {
  const res = await fetch(tep.href, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Không tải được tệp (HTTP ${res.status})`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TRAN_MB * 1024 * 1024) {
    const err = new Error(`Tệp nặng ${(buf.length / 1024 / 1024).toFixed(1)} MB, quá ${TRAN_MB} MB`);
    err.quaNang = true;
    throw err;
  }

  const mime = doanKieu(buf, tep.ten);
  if (!mime) {
    const err = new Error(`Không đọc được định dạng tệp "${tep.ten}"`);
    err.khongHoTro = true;
    throw err;
  }
  if (mime.startsWith("image/") && buf.length < NHO_NHAT_BYTE) {
    const err = new Error("Ảnh quá nhỏ, nhiều khả năng là biểu cảm/sticker");
    err.quaNho = true;
    throw err;
  }

  return { buffer: buf, mime, ten: tep.ten };
}

const NHIEM_VU = [
  "Bạn là specialist trung tính đang đọc một tệp khách hàng vừa gửi qua Zalo.",
  "Hãy mô tả điều nhìn/đọc thấy có liên quan tới câu hỏi, bằng tiếng Việt, tối đa 250 từ.",
  "",
  "Trích visible text, con số và mốc thời gian quan trọng nếu có; nêu rõ chỗ không chắc.",
  "",
  "Chỉ mô tả những gì THẬT SỰ nhìn thấy. Không suy đoán business facts.",
  "Không tự kết luận còn hàng, hết hàng, giá, tồn kho hay chính sách shop nếu tệp không chứng minh.",
  "Không chào hỏi, không lời dẫn — vào thẳng nội dung.",
].join("\n");

function requiredCapability(tep) {
  return String(tep?.mime || "").startsWith("image/")
    ? CAPABILITIES.IMAGE_INPUT
    : CAPABILITIES.FILE_INPUT;
}

function routingUnavailable(decision) {
  const capability = decision?.missingCapabilities?.[0] || decision?.requiredCapabilities?.at(-1);
  const label = capability === CAPABILITIES.IMAGE_INPUT ? "đọc hình ảnh" : "đọc tài liệu PDF";
  const error = new Error(`Yêu cầu này cần AI có khả năng ${label}, nhưng AI bổ trợ hiện chưa sẵn sàng.`);
  error.code = "SECONDARY_ROUTE_UNAVAILABLE";
  error.routeDecision = decision;
  return error;
}

/**
 * Doc tep roi tra ve ban tom tat. Chay trong phien dung-mot-lan roi xoa, nen
 * tep khong dinh lai o dau ca.
 */
export async function docVaTomTat(config, tep, options = {}) {
  const required = [CAPABILITIES.TEXT, requiredCapability(tep)];
  const routingEnabled = config?.capabilityRoutingEnabled ?? capabilityRoutingEnabled();
  let routeDecision = {
    routeMode: ROUTE_MODES.PRIMARY_ONLY,
    primaryModel: config?.opencodeModel || "",
    secondaryModel: null,
    requiredCapabilities: required,
    reason: "ROUTING_DISABLED",
  };
  if (routingEnabled) {
    const catalog = options.catalogCapabilities || await loadChatProviders(config);
    routeDecision = routeModelRequest({
      ownerUid: options.ownerUid,
      surface: SURFACES.CUSTOMER,
      primaryModel: config.opencodeModel,
      secondaryModel: config.opencodeFallbackModel,
      enabledSecondaryCapabilities: config.opencodeFallbackCapabilities,
      failoverEnabled: config.opencodeFailoverEnabled,
      requiredCapabilities: required,
      catalogCapabilities: catalog,
      webProbeState: null,
      routingEnabled,
    });
    if (routeDecision.routeMode === ROUTE_MODES.UNAVAILABLE) throw routingUnavailable(routeDecision);
  }

  const secondary = routeDecision.routeMode === ROUTE_MODES.CAPABILITY_ASSIST;
  const selectedModel = secondary ? routeDecision.secondaryModel : config.opencodeModel;
  const selectedConfig = { ...config, opencodeModel: selectedModel };
  const providers = [
    splitModel(config.opencodeModel)?.providerID,
    ...(secondary ? [splitModel(selectedModel)?.providerID] : []),
  ].filter(Boolean);
  const operation = async () => {
    options.callBudget?.consume({ secondary });
    try {
      const ketQua = await runOneShot(selectedConfig, `Đọc tệp - ${tep.ten}`, [
        {
          type: "file",
          mime: tep.mime,
          filename: tep.ten,
          url: `data:${tep.mime};base64,${tep.buffer.toString("base64")}`,
        },
        { type: "text", text: NHIEM_VU },
      ]);
      if (secondary) {
        await addLog({
          event: "ai_secondary_route",
          level: "info",
          summary: "AI bổ trợ đã đọc attachment cho Customer Bot",
          detail: {
            routeMode: routeDecision.routeMode,
            surface: SURFACES.CUSTOMER,
            requiredCapabilities: required,
            primaryModel: config.opencodeModel,
            secondaryModel: selectedModel,
            outcome: "SUCCESS",
          },
        }).catch(() => {});
      }
      return ketQua;
    } catch (error) {
      error.classifiedReason = classifyProviderFailure(error);
      if (secondary) {
        await addLog({
          event: "ai_secondary_route",
          level: "warn",
          summary: "AI bổ trợ không đọc được attachment cho Customer Bot",
          detail: {
            routeMode: routeDecision.routeMode,
            surface: SURFACES.CUSTOMER,
            requiredCapabilities: required,
            primaryModel: config.opencodeModel,
            secondaryModel: selectedModel,
            classifiedReason: error.classifiedReason,
            outcome: "FAILED",
          },
        }).catch(() => {});
      }
      throw error;
    }
  };
  const ketQua = options.ownerUid
    ? await withOwnerCredentialReadSet(options.ownerUid, providers, operation)
    : await operation();

  const tomTat = String(ketQua.text || "").trim();
  if (!tomTat) throw new Error("Model không mô tả được nội dung tệp.");
  return { tomTat, tokens: ketQua.tokens, routeDecision };
}

/**
 * Toan bo viec doc mot tep. Khong nem loi ra ngoai: tep hong khong duoc phep
 * lam bot cam luon, no van phai tra loi khach binh thuong.
 *
 * @returns {Promise<{khoiChoAgent:string, tomTat:string|null, loi:string|null}>}
 */
export async function xuLyTep(config, message, options = {}) {
  const tep = layTepTuTin(message);
  if (!tep) return { khoiChoAgent: "", tomTat: null, loi: null };

  try {
    const daTai = await taiTep(tep);
    const { tomTat, tokens, routeDecision } = await docVaTomTat(config, daTai, options);

    await addLog({
      event: "doc_tep",
      level: "ok",
      summary: `Đã đọc tệp "${tep.ten}" (${(daTai.buffer.length / 1024).toFixed(0)} KB) — tốn ${tokens?.input ?? "?"} token`,
      detail: {
        ten: tep.ten,
        mime: daTai.mime,
        kichThuocKB: Math.round(daTai.buffer.length / 1024),
        tokens,
        tomTat,
        nguoiGui: message?.senderName || "",
      },
    }).catch(() => {});

    return {
      tomTat,
      loi: null,
      routeMode: routeDecision.routeMode,
      requiredCapabilities: routeDecision.requiredCapabilities,
      laPdf: /pdf/i.test(daTai.mime || "") || /\.pdf$/i.test(tep.ten || ""),
      khoiChoAgent:
        `# NỘI DUNG TỆP KHÁCH VỪA GỬI ("${tep.ten}")\n` +
        `${tomTat}\n` +
        `(Hệ thống đã đọc hộ. Hãy trả lời khách dựa trên nội dung này, bằng giọng của mình. ` +
        `Không nói "hệ thống", không đọc lại nguyên văn khối này.)\n\n`,
    };
  } catch (error) {
    // Anh nho = sticker/bieu cam -> im lang bo qua, khong lam phien ai.
    if (error.quaNho) return { khoiChoAgent: "", tomTat: null, loi: null };

    await addLog({
      event: "doc_tep",
      level: "warn",
      summary: `Không đọc được tệp "${tep.ten}" — ${error.message}`,
      detail: { ten: tep.ten, error: error.message, nguoiGui: message?.senderName || "" },
    }).catch(() => {});

    const loiChoKhach = error.quaNang
      ? `Tệp khách gửi nặng quá ${TRAN_MB} MB nên hệ thống chưa đọc được.`
      : error.khongHoTro
        ? "Hệ thống chỉ đọc được ảnh và PDF, tệp này thì chưa."
        : "Em chưa xác định chính xác nội dung trong tệp này.";

    return {
      tomTat: null,
      loi: error.message,
      khoiChoAgent:
        `# GHI CHÚ HỆ THỐNG\n${loiChoKhach}\n` +
        `Hãy nhẹ nhàng nhờ khách gửi tên/mã sản phẩm, gửi lại ảnh rõ hơn hoặc mô tả bằng lời. ` +
        `KHÔNG nhắc tên hãng AI, API key, credential hay quota. KHÔNG vờ như đã đọc được.\n\n`,
    };
  }
}
