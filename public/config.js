// Tab LOG dang ky ham nhan log realtime vao day; app.js noi socket vao pushActivityLog.
let activityLogSink = null;

export function pushActivityLog(entry) {
  if (activityLogSink) activityLogSink(entry);
}

// Tab AI Chat dang ky ham nap lai danh sach nhom/nick vao day; app.js goi moi
// khi mo Cau hinh.
//
// Vi sao can: ca 7 tab deu mount MOT LAN luc tai trang, nen loadGroups() cung
// chi chay dung mot lan o thoi diem do. Neu luc ay Zalo chua dang nhap thi
// /api/zalo/groups tra 401, o chon nhom hien "Can dang nhap Zalo..." roi ket
// o do VINH VIEN - quet ma QR xong cung khong co gi nap lai, tru khi tai lai
// ca trang.
let aiEntityRefreshSink = null;
let aiConfigRefreshSink = null;

export function refreshAiChatEntities() {
  if (aiEntityRefreshSink) aiEntityRefreshSink();
}

/** Nap lai cau hinh AI canonical cua owner hien tai, ke ca khi modal dang dong. */
export async function refreshAiChatConfigForCurrentOwner() {
  if (!aiConfigRefreshSink) return false;
  return Boolean(await aiConfigRefreshSink());
}

/**
 * So dang ky cac ham nap lai du lieu dong cua tung tab.
 *
 * Cung mot ly do voi khoi ben tren, nhung khong chi rieng tab AI Chat: lich hen,
 * khach hang, nhat ky va nick OTP/Admin deu la du lieu THEO TAI KHOAN ZALO. Mount
 * mot lan luc tai trang nghia la neu doi tai khoan Zalo giua chung, cac tab do
 * van hien du lieu cua tai khoan cu cho toi khi tai lai ca trang.
 *
 * Day KHONG phai event bus: chi la mot mang ham, moi tab dang ky dung mot lan
 * trong mount() nen khong bao gio nhan doi.
 */
const soDangKyLamMoi = [];
let settingsOwnerGeneration = 0;
let settingsOwnerUid = null;
let invalidateAiOwnerSink = null;
let invalidateAdminOwnerSink = null;
let invalidateKnowledgeOwnerSink = null;
let invalidateScheduleOwnerSink = null;
let invalidateCustomersOwnerSink = null;
let invalidateLogsOwnerSink = null;
let invalidatePdfAutomationOwnerSink = null;
let invalidateAutoReplyOwnerSink = null;

function chupSettingsOwner() {
  return { ownerUid: settingsOwnerUid, ownerGeneration: settingsOwnerGeneration };
}

function settingsOwnerConHieuLuc(owner) {
  return owner.ownerGeneration === settingsOwnerGeneration && owner.ownerUid === settingsOwnerUid;
}

function dangKyLamMoi(ten, fn) {
  soDangKyLamMoi.push({ ten, fn });
}

/**
 * app.js goi moi khi mo Cau hinh. KHONG chan viec mo modal: moi ham chay doc lap,
 * hong cai nao thi chi cai do trong, khong keo do cac tab con lai.
 */
export function refreshSettingsDynamicData() {
  for (const muc of soDangKyLamMoi) {
    try {
      Promise.resolve(muc.fn()).catch((e) => console.warn("[cau-hinh] Khong nap lai duoc " + muc.ten, e));
    } catch (e) {
      console.warn("[cau-hinh] Loi khi nap lai " + muc.ten, e);
    }
  }
}

/** Xoa ngay DOM theo owner cu; request cu cung bi generation guard bo qua. */
export function setSettingsOwnerUid(nextOwnerUid) {
  settingsOwnerUid = nextOwnerUid ? String(nextOwnerUid) : null;
}

export function invalidateSettingsOwnerState() {
  settingsOwnerGeneration += 1;
  invalidateAutoReplyOwnerSink?.();
  invalidateKnowledgeOwnerSink?.();
  invalidateAiOwnerSink?.();
  invalidateAdminOwnerSink?.();
  invalidateScheduleOwnerSink?.();
  invalidateCustomersOwnerSink?.();
  invalidateLogsOwnerSink?.();
  invalidatePdfAutomationOwnerSink?.();
}

export const CONFIG_TABS = [
  {
    id: "auto-reply",
    label: "Trả lời tự động",
    mount(panel) {
      panel.innerHTML = `
        <div class="rule-list-header">
          <h3>Quy tắc hiện có</h3>
          <button id="btn-add-rule" class="secondary-button" type="button">Thêm quy tắc</button>
        </div>
        <div id="auto-reply-rules" class="rule-list"></div>

        <form id="auto-reply-form" class="rule-form hidden">
          <h4>Thêm/Sửa quy tắc</h4>
          <input type="hidden" id="rule-id" />
          <div class="form-group">
            <label>Lệnh (tiền tố /):</label>
            <div class="input-prefix">
              <span>/</span>
              <input type="text" id="rule-command" required autocomplete="off" />
            </div>
          </div>
          
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="rule-normalize" />
              Không phân biệt chữ hoa/thường, có dấu/không dấu
            </label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" name="rule-match" value="1" />
                Lệnh có thể nằm trong câu
              </label>
              <label class="radio-label">
                <input type="radio" name="rule-match" value="0" checked />
                Phải gõ chính xác lệnh này
              </label>
            </div>
          </div>

          <div class="form-group">
            <label>Trả lời:</label>
            <textarea id="rule-reply" rows="3" required></textarea>
          </div>

          <div class="form-actions">
            <button type="button" id="btn-cancel-rule" class="secondary-button">Huỷ</button>
            <button type="submit" class="primary-button">Lưu</button>
          </div>
        </form>
      `;

      // Attach events
      const ruleList = panel.querySelector("#auto-reply-rules");
      const btnAddRule = panel.querySelector("#btn-add-rule");
      const btnCancelRule = panel.querySelector("#btn-cancel-rule");
      const ruleForm = panel.querySelector("#auto-reply-form");
      const ruleId = panel.querySelector("#rule-id");
      const ruleCommand = panel.querySelector("#rule-command");
      const ruleNormalize = panel.querySelector("#rule-normalize");
      const ruleRadios = panel.querySelectorAll("input[name='rule-match']");
      const ruleReply = panel.querySelector("#rule-reply");

      let rulesData = [];

      async function fetchRules(owner = chupSettingsOwner()) {
        if (!owner.ownerUid) {
          if (settingsOwnerConHieuLuc(owner)) {
            rulesData = [];
            renderRules();
          }
          return false;
        }
        const res = await fetch("/api/auto-reply");
        const data = await res.json();
        if (!settingsOwnerConHieuLuc(owner)) return false;
        if (!res.ok) throw new Error(data.error || "Không tải được quy tắc trả lời tự động.");
        rulesData = Array.isArray(data) ? data : [];
        renderRules();
        return true;
      }

      function renderRules() {
        ruleList.innerHTML = "";
        if (rulesData.length === 0) {
          ruleList.innerHTML = "<div class='empty-hint' style='margin: 0; padding: 12px;'>Chưa có quy tắc nào.</div>";
          return;
        }
        for (const rule of rulesData) {
          const item = document.createElement("div");
          item.className = "rule-item";

          const info = document.createElement("div");
          info.className = "rule-info";

          const cmd = document.createElement("div");
          cmd.className = "rule-cmd";
          cmd.textContent = `/${rule.command}`;

          const meta = document.createElement("div");
          meta.className = "rule-meta";
          let metaText = rule.normalize ? "[Không phân biệt] " : "";
          metaText += rule.match_anywhere ? "Chứa trong câu" : "So khớp chính xác";
          meta.textContent = metaText;

          const reply = document.createElement("div");
          reply.className = "rule-reply-preview";
          reply.textContent = rule.reply_text;

          info.append(cmd, meta, reply);

          const actions = document.createElement("div");
          actions.className = "rule-actions";

          const btnEdit = document.createElement("button");
          btnEdit.className = "secondary-button";
          btnEdit.textContent = "Sửa";
          btnEdit.onclick = () => {
            ruleId.value = rule.id;
            ruleCommand.value = rule.command;
            ruleNormalize.checked = Boolean(rule.normalize);
            ruleRadios.forEach((r) => (r.checked = Number(r.value) === rule.match_anywhere));
            ruleReply.value = rule.reply_text;
            ruleForm.classList.remove("hidden");
          };

          const btnDelete = document.createElement("button");
          btnDelete.className = "secondary-button";
          btnDelete.textContent = "Xoá";
          btnDelete.onclick = async () => {
            if (!confirm("Bạn có chắc chắn muốn xoá quy tắc này?")) return;
            const owner = chupSettingsOwner();
            const res = await fetch(`/api/auto-reply/${rule.id}`, { method: "DELETE" });
            if (!settingsOwnerConHieuLuc(owner)) return;
            if (!res.ok) return;
            await fetchRules(owner);
          };

          actions.append(btnEdit, btnDelete);
          item.append(info, actions);
          ruleList.append(item);
        }
      }

      btnAddRule.addEventListener("click", () => {
        ruleForm.reset();
        ruleId.value = "";
        ruleForm.classList.remove("hidden");
      });

      btnCancelRule.addEventListener("click", () => {
        ruleForm.classList.add("hidden");
      });

      ruleForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        let matchAnywhere = 0;
        ruleRadios.forEach((r) => {
          if (r.checked) matchAnywhere = Number(r.value);
        });

        const payload = {
          command: ruleCommand.value.trim().replace(/^\/+/, ""),
          normalize: ruleNormalize.checked ? 1 : 0,
          match_anywhere: matchAnywhere,
          reply_text: ruleReply.value.trim(),
        };

        if (!payload.command || !payload.reply_text) return;

        const id = ruleId.value;
        const method = id ? "PUT" : "POST";
        const url = id ? `/api/auto-reply/${id}` : "/api/auto-reply";
        const owner = chupSettingsOwner();

        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!settingsOwnerConHieuLuc(owner)) return;
        if (!res.ok) return;
        ruleForm.classList.add("hidden");
        await fetchRules(owner);
      });

      invalidateAutoReplyOwnerSink = () => {
        rulesData = [];
        renderRules();
        ruleForm.reset();
        ruleId.value = "";
        ruleForm.classList.add("hidden");
      };
      dangKyLamMoi("tra loi tu dong", fetchRules);
      fetchRules();
    }
  },
  {
    id: "ai-chat",
    label: "AI Chat",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          AI chỉ trả lời khi tin liên quan chủ đề; quy tắc /lệnh được ưu tiên trước.
        </div>
        <form id="ai-chat-form" class="rule-form">
          <div class="form-group key-block">
            <label>1. API Key</label>
            <details class="ai-key-manager">
              <summary>Quản lý các kết nối AI...</summary>
              <div class="ai-key-manager-body">
                <div class="smtp-grid">
                  <select id="ai-key-provider" class="auth-input" aria-label="Hãng AI cần kết nối"></select>
                  <input type="password" id="ai-key-value" class="auth-input" placeholder="Dán API key của hãng…" autocomplete="new-password" />
                </div>
                <div id="ai-key-status" class="field-hint" style="font-size:12px; margin:6px 0 0; min-height:16px; color: var(--muted);"></div>
                <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
                  <button type="button" id="btn-key-save" class="secondary-button" style="padding:5px 12px; font-size:12px;">Lưu key</button>
                  <button type="button" id="btn-key-test" class="secondary-button" style="padding:5px 12px; font-size:12px;">Thử key</button>
                  <button type="button" id="btn-key-delete" class="secondary-button" style="padding:5px 12px; font-size:12px;">Gỡ key hãng này</button>
                  <button type="button" id="btn-key-clear" class="secondary-button" style="padding:5px 12px; font-size:12px;">Gỡ tất cả key của tôi</button>
                </div>
                <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 6px 0 0;">
                  Các key này chỉ thuộc tài khoản Zalo đang kết nối. Mỗi API key chỉ dùng cho đúng hãng tương ứng.
                </p>
              </div>
            </details>
          </div>

          <div class="form-group ai-model-config">
            <label class="portal-shared-label">Hãng AI và Model</label>
            <div class="ai-model-row">
              <h3 class="ai-model-kind">AI CHÍNH</h3>
              <div class="smtp-grid ai-model-grid">
                <label class="ai-model-field">
                  <span>Hãng AI</span>
                  <select id="ai-oc-provider" class="auth-input"></select>
                </label>
                <label class="ai-model-field">
                  <span>Model</span>
                  <select id="ai-oc-model" class="auth-input"></select>
                </label>
              </div>
            </div>
            <div class="ai-model-row">
              <div class="ai-model-kind-row">
                <h3 class="ai-model-kind">AI BỔ TRỢ</h3>
                <span class="field-hint">Không bắt buộc</span>
              </div>
              <div class="smtp-grid ai-model-grid">
                <label class="ai-model-field">
                  <span>Hãng AI</span>
                  <select id="ai-oc-fallback-provider" class="auth-input"></select>
                </label>
                <label class="ai-model-field">
                  <span>Model</span>
                  <select id="ai-oc-fallback-model" class="auth-input"></select>
                </label>
              </div>
              <div id="ai-routing-controls" class="ai-routing-controls">
                <p class="field-hint" style="margin:10px 0 6px;">Dùng AI bổ trợ khi AI chính thiếu:</p>
                <label class="checkbox-label">
                  <input type="checkbox" id="ai-fallback-image" /> Đọc hình ảnh
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" id="ai-fallback-file" /> Đọc tài liệu (PDF)
                </label>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <label class="checkbox-label" style="margin:0;">
                    <input type="checkbox" id="ai-fallback-web" /> Tìm kiếm web — chỉ Bot Chỉ huy
                  </label>
                  <button type="button" id="btn-ai-web-probe" class="secondary-button" style="padding:4px 10px; font-size:12px;">Kiểm tra Web</button>
                </div>
                <label class="checkbox-label" style="margin-top:8px;">
                  <input type="checkbox" id="ai-failover-enabled" /> Dùng AI bổ trợ khi AI chính tạm thời lỗi
                </label>
                <p id="ai-routing-status" class="field-hint" style="margin:6px 0 0; min-height:16px;"></p>
              </div>
            </div>
            <div class="ai-model-save-row">
              <p class="field-hint">
                Dùng khi AI chính thiếu capability đã chọn hoặc gặp lỗi tạm thời. Không bắt buộc.
              </p>
              <button type="button" id="btn-ai-model-save" class="primary-button ai-model-save">Lưu</button>
            </div>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 6px 0 0;">
              Chọn hãng và model muốn bot sử dụng, sau đó bấm <strong>Lưu</strong>. AI bổ trợ có thể để trống.
            </p>
          </div>

          <details class="form-group ai-opencode-advanced">
            <summary>Cấu hình OpenCode nâng cao</summary>
            <div class="smtp-grid ai-opencode-advanced-body">
              <input type="text" id="ai-oc-url" class="auth-input" placeholder="http://opencode:4096" autocomplete="off" aria-label="Địa chỉ OpenCode server" />
              <select id="ai-oc-agent" class="auth-input" aria-label="OpenCode agent"></select>
            </div>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 6px 0 0;">
              OpenCode chạy cùng trong <code>docker-compose</code> tại <code>http://opencode:4096</code>.
            </p>
          </details>

          <div class="form-group">
            <label class="portal-shared-label">Soul</label>
            <textarea id="ai-soul" rows="6" placeholder="Bạn là trợ lý của shop X. Bối cảnh, nguyên tắc, giới hạn..."></textarea>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">
              Soul mô tả nhân cách, bối cảnh và nguyên tắc trả lời của trợ lý.
            </p>
          </div>

          <div class="form-group">
            <label class="portal-shared-label">Các chủ đề cho phép</label>
            <textarea id="ai-topics" rows="5" placeholder="giá sản phẩm\ngiao hàng\nđổi trả" required></textarea>
          </div>

          <div class="form-group">
            <label class="portal-shared-label">Vai trò và giọng điệu</label>
            <textarea id="ai-role" rows="4" placeholder="Bạn là CSKH shop thời trang, thân thiện..." required></textarea>
          </div>

          <div class="form-group">
            <label>Chỉ trả lời trong nhóm chat:</label>
            <select id="ai-group" style="width: 100%; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 10px;">
              <option value="">— Tất cả (không giới hạn nhóm) —</option>
            </select>
          </div>

          <div class="form-group">
            <label>Chỉ trả lời từ nick Zalo:</label>
            <select id="ai-senders" multiple size="6" disabled style="width: 100%; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 10px;">
              <option value="">Chọn nhóm ở trên để tải danh sách nick</option>
            </select>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin-top: 4px; margin-bottom: 0;">Ctrl/Cmd chọn nhiều. Để trống = mọi nick trong nhóm đã chọn.</p>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="ai-use-knowledge" />
              Sử dụng tri thức để trả lời
            </label>
            <div id="ai-knowledge-wrap" class="hidden">
              <span class="knowledge-subtitle">Chọn file trong kho tri thức</span>
              <div id="ai-knowledge-files" class="knowledge-picker"></div>
              <p class="field-hint" style="color: var(--muted); font-size: 12px; margin-top: 4px; margin-bottom: 0;">Bot tham chiếu nội dung file đã tick. Thêm file ở tab Tri thức.</p>
            </div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="ai-doc-tep" />
              Cho bot đọc ảnh và PDF khách gửi
            </label>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin-top: 4px; margin-bottom: 0;">
              Chỉ trong chat riêng 1-1. Bot đọc tệp một lần rồi chỉ giữ bản tóm tắt, nên không đội chi phí
              ở những tin sau. Bỏ qua sticker và ảnh nhỏ. Tệp trên 10 MB thì bot xin bản nhẹ hơn.
              Mỗi lần đọc đều ghi số token vào tab LOG.
            </p>
            <span id="ai-doc-tep-bao" class="field-hint" style="font-size:12px"></span>
          </div>

          <div class="form-actions" style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
            <span id="ai-status" style="color: var(--muted); font-size: 14px; flex: 1; min-width: 0;"></span>
            <button type="button" id="btn-oc-test" class="secondary-button">Kiểm tra OpenCode</button>
            <button type="button" id="btn-oc-reset" class="secondary-button">Nạp lại Soul</button>
            <button type="submit" id="btn-ai-assistant-save" class="primary-button">Lưu cấu hình trợ lý</button>
          </div>
        </form>
      `;

      const form = panel.querySelector("#ai-chat-form");
      const ocUrl = panel.querySelector("#ai-oc-url");
      const ocAgent = panel.querySelector("#ai-oc-agent");
      const ocProvider = panel.querySelector("#ai-oc-provider");
      const ocModel = panel.querySelector("#ai-oc-model");
      const ocFallbackProvider = panel.querySelector("#ai-oc-fallback-provider");
      const ocFallbackModel = panel.querySelector("#ai-oc-fallback-model");
      const fallbackImage = panel.querySelector("#ai-fallback-image");
      const fallbackFile = panel.querySelector("#ai-fallback-file");
      const fallbackWeb = panel.querySelector("#ai-fallback-web");
      const failoverEnabled = panel.querySelector("#ai-failover-enabled");
      const routingStatus = panel.querySelector("#ai-routing-status");
      const btnWebProbe = panel.querySelector("#btn-ai-web-probe");
      const soulInput = panel.querySelector("#ai-soul");
      const topicsInput = panel.querySelector("#ai-topics");
      const roleInput = panel.querySelector("#ai-role");
      const groupSelect = panel.querySelector("#ai-group");
      const sendersSelect = panel.querySelector("#ai-senders");
      const statusText = panel.querySelector("#ai-status");
      const useKnowledge = panel.querySelector("#ai-use-knowledge");
      const knowledgeWrap = panel.querySelector("#ai-knowledge-wrap");
      const knowledgeFiles = panel.querySelector("#ai-knowledge-files");
      const docTep = panel.querySelector("#ai-doc-tep");
      const docTepBao = panel.querySelector("#ai-doc-tep-bao");

      // Luu ngay khi tick, khong doi bam "Ghi nho": bat/tat doc tep khong lam
      // doi Soul nen khong can nap lai phien - de chung form se reset phien oan.
      docTep.addEventListener("change", async () => {
        docTepBao.textContent = "Đang lưu…";
        docTepBao.style.color = "var(--muted)";
        try {
          const res = await fetch("/api/ai-chat/doc-tep", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bat: docTep.checked }),
          });
          if (!res.ok) throw new Error((await res.json()).error || "Lưu thất bại");
          docTepBao.textContent = docTep.checked
            ? "Đã bật — bot sẽ đọc ảnh/PDF khách gửi riêng."
            : "Đã tắt — bot không đọc tệp nữa.";
        } catch (e) {
          docTep.checked = !docTep.checked;
          docTepBao.textContent = "Lỗi: " + e.message;
          docTepBao.style.color = "var(--danger)";
        }
      });

      let currentMembers = [];

      async function loadKnowledgeFiles(selectedIds = [], generation = settingsOwnerGeneration) {
        knowledgeFiles.textContent = "Đang tải danh sách file...";
        try {
          const res = await fetch("/api/knowledge");
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          const files = data.files || [];
          knowledgeFiles.innerHTML = "";
          if (files.length === 0) {
            knowledgeFiles.innerHTML =
              "<div class='empty-hint' style='margin:0; padding:8px;'>Kho tri thức đang trống. Thêm file ở tab Tri thức.</div>";
            return;
          }
          for (const file of files) {
            const label = document.createElement("label");
            label.className = "checkbox-label knowledge-pick-item";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.name = "knowledge-file";
            box.value = String(file.id);
            if (selectedIds.map(Number).includes(Number(file.id))) box.checked = true;
            const text = document.createElement("span");
            text.textContent = `${file.originalName} (${file.charCount.toLocaleString("vi-VN")} ký tự)`;
            label.append(box, text);
            knowledgeFiles.append(label);
          }
        } catch (e) {
          console.error("Lỗi load kho tri thức", e);
          knowledgeFiles.textContent = "Không tải được kho tri thức.";
        }
      }

      // Danh sach hang + model lay THAT tu OpenCode; chi gom model chat duoc.
      let danhSachHang = [];
      // Phan biet "hoi duoc OpenCode va no bao khong co" voi "khong hoi duoc".
      // Hai truong hop nay nguyen nhan khac han nhau, ghi chu sai la di sua nham cho.
      let napDuocDanhSach = false;
      let modelMacDinhHeThong = "";
      let modelDaLuuTheoOwner = "";
      let fallbackModelDaLuuTheoOwner = "";
      let capabilityRoutingSystemEnabled = false;
      let fallbackCapabilitiesDaLuuTheoOwner = [];
      let failoverDaLuuTheoOwner = false;
      const ghiChuThieu = () =>
        napDuocDanhSach ? "không còn key" : "chưa kiểm tra được — OpenCode không phản hồi";

      function modelCoTrongDanhSach(model) {
        if (!model) return false;
        const hangId = model.split("/")[0];
        return Boolean(danhSachHang.find((hang) => hang.id === hangId)?.models
          .some((item) => item.id === model));
      }

      function chiTietModel(model) {
        if (!model) return null;
        const hangId = model.split("/")[0];
        return danhSachHang.find((hang) => hang.id === hangId)?.models
          .find((item) => item.id === model) || null;
      }

      function capNhatRoutingControls() {
        const secondaryModel = ocFallbackProvider.value ? ocFallbackModel.value : "";
        const providerId = secondaryModel ? secondaryModel.split("/")[0] : "";
        const model = chiTietModel(secondaryModel);
        const coCredential = Boolean(providerId && ownerKeyStatus.has(providerId));
        const systemReady = capabilityRoutingSystemEnabled === true;
        const modelReady = Boolean(model && coCredential);

        fallbackImage.disabled = !systemReady || !modelReady || model.capabilities?.image !== true;
        fallbackFile.disabled = !systemReady || !modelReady || model.capabilities?.file !== true;
        const webSupported = model?.capabilities?.toolcall === true
          && model?.webProbeState === "SUPPORTED"
          && model?.capabilities?.web === true;
        fallbackWeb.disabled = !systemReady || !modelReady || !webSupported;
        failoverEnabled.disabled = !systemReady || !modelReady;

        const canProbe = systemReady && modelReady && model.capabilities?.toolcall === true && !webSupported;
        btnWebProbe.hidden = !canProbe;
        btnWebProbe.disabled = !canProbe;

        if (!systemReady) {
          routingStatus.textContent = "Capability routing đang tắt ở cấp hệ thống.";
        } else if (!secondaryModel) {
          routingStatus.textContent = "Chọn AI bổ trợ để bật các quyền routing.";
        } else if (!coCredential) {
          routingStatus.textContent = "AI bổ trợ chưa có API credential.";
        } else if (!model) {
          routingStatus.textContent = "Model AI bổ trợ đã lưu không còn khả dụng.";
        } else if (model.capabilities?.toolcall !== true) {
          routingStatus.textContent = "Model này không hỗ trợ tool call nên Web bị tắt.";
        } else if (!webSupported) {
          routingStatus.textContent = "Web chưa được chứng minh trong runtime. Hãy bấm Kiểm tra Web.";
        } else {
          routingStatus.textContent = "AI bổ trợ sẵn sàng theo các capability được model công bố.";
        }
      }

      function modelHieuLucTheoOwner() {
        // Model owner da luu luon duoc giu tren UI, ke ca key vua bi go. Khong
        // am tham nhay sang model khac va cung khong ghi de persistence.
        return modelDaLuuTheoOwner || modelMacDinhHeThong;
      }

      function fallbackModelHieuLucTheoOwner() {
        if (fallbackModelDaLuuTheoOwner
          && (!napDuocDanhSach || modelCoTrongDanhSach(fallbackModelDaLuuTheoOwner))) {
          return fallbackModelDaLuuTheoOwner;
        }
        return fallbackModelDaLuuTheoOwner;
      }

      function veOModel(hangId, modelDangChon, modelSelect = ocModel, { optional = false } = {}) {
        modelSelect.innerHTML = "";

        if (!hangId) {
          modelSelect.append(new Option(optional ? "— Không dùng AI bổ trợ —" : "— Theo mặc định —", ""));
          modelSelect.disabled = true;
          return;
        }
        modelSelect.disabled = false;

        const models = danhSachHang.find((h) => h.id === hangId)?.models || [];
        for (const model of models) {
          const nhan =
            `${model.label}${model.beta ? " (beta)" : ""} · ${Math.round(model.context / 1000)}k ngữ cảnh`;
          modelSelect.append(new Option(nhan, model.id));
        }

        // Model da luu nhung khong con trong danh sach: van giu lai, khong tu nhay
        // sang model khac sau lung nguoi dung.
        const conDung = models.some((m) => m.id === modelDangChon);
        if (modelDangChon && !conDung) {
          modelSelect.append(new Option(`${modelDangChon} (${ghiChuThieu()})`, modelDangChon));
          modelSelect.value = modelDangChon;
        } else {
          modelSelect.value = conDung ? modelDangChon : models[0]?.id || "";
        }
      }

      function veOHang(modelDangChon, providerSelect = ocProvider, modelSelect = ocModel, { optional = false } = {}) {
        providerSelect.innerHTML = "";
        providerSelect.append(new Option(optional ? "— Không dùng AI bổ trợ —" : "— Mặc định của OpenCode —", ""));
        for (const hang of danhSachHang) providerSelect.append(new Option(hang.name, hang.id));

        const hangCuaModel = modelDangChon ? modelDangChon.split("/")[0] : "";
        if (hangCuaModel && !danhSachHang.some((h) => h.id === hangCuaModel)) {
          providerSelect.append(new Option(`${hangCuaModel} (${ghiChuThieu()})`, hangCuaModel));
        }
        providerSelect.value = hangCuaModel;
        veOModel(hangCuaModel, modelDangChon, modelSelect, { optional });
      }

      function chonModelKhongDungLaiDanhSach(modelDangChon) {
        const hangCuaModel = modelDangChon ? modelDangChon.split("/")[0] : "";
        ocProvider.value = hangCuaModel;
        veOModel(hangCuaModel, modelDangChon);
      }

      function chonFallbackKhongDungLaiDanhSach(modelDangChon) {
        const hangCuaModel = modelDangChon ? modelDangChon.split("/")[0] : "";
        ocFallbackProvider.value = hangCuaModel;
        veOModel(hangCuaModel, modelDangChon, ocFallbackModel, { optional: true });
        capNhatRoutingControls();
      }

      async function napAgentVaModel(modelTamThoi = null, fallbackTamThoi = null) {
        const generationLucBatDau = settingsOwnerGeneration;
        let names = ["general", "build", "plan"];
        try {
          const res = await fetch("/api/ai-chat/opencode-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opencodeBaseUrl: ocUrl.value.trim() }),
          });
          const data = await res.json();
          if (res.ok) {
            napDuocDanhSach = true;
            if (Array.isArray(data.agents) && data.agents.length) names = data.agents;
            if (Array.isArray(data.providers)) danhSachHang = data.providers;
            modelMacDinhHeThong = data.systemDefaultModel || "";
          }
        } catch { /* mat ket noi thi giu nguyen lua chon da luu */ }

        const agentDangChon = ocAgent.value || "general";
        if (agentDangChon && !names.includes(agentDangChon)) names = [agentDangChon, ...names];
        ocAgent.innerHTML = "";
        for (const name of names) ocAgent.append(new Option(name, name));
        ocAgent.value = agentDangChon || "general";

        // Catalog la global nen van cap nhat khi UID doi giua luc request dang chay.
        // Chi bo lua chon pending cu; lua chon owner moi se duoc merge o day.
        const modelPendingConHieuLuc = generationLucBatDau === settingsOwnerGeneration
          ? modelTamThoi
          : null;
        veOHang(modelPendingConHieuLuc || modelHieuLucTheoOwner());
        const fallbackPendingConHieuLuc = generationLucBatDau === settingsOwnerGeneration
          ? fallbackTamThoi
          : null;
        veOHang(
          fallbackPendingConHieuLuc === null ? fallbackModelHieuLucTheoOwner() : fallbackPendingConHieuLuc,
          ocFallbackProvider,
          ocFallbackModel,
          { optional: true }
        );
        capNhatRoutingControls();
      }

      // Doi hang thi model ben duoi nap lai theo hang do.
      // Đổi Hãng AI hoặc Model chỉ thay lựa chọn đang chờ; chỉ nút Lưu mới
      // được phép ghi lựa chọn canonical của owner hiện tại.
      ocProvider.addEventListener("change", () => veOModel(ocProvider.value, ""));
      ocFallbackProvider.addEventListener("change", () => {
        veOModel(ocFallbackProvider.value, "", ocFallbackModel, { optional: true });
        capNhatRoutingControls();
      });
      ocFallbackModel.addEventListener("change", capNhatRoutingControls);
      for (const control of [fallbackImage, fallbackFile, fallbackWeb, failoverEnabled]) {
        control.addEventListener("change", capNhatRoutingControls);
      }

      btnWebProbe.addEventListener("click", async () => {
        const model = ocFallbackProvider.value ? ocFallbackModel.value : "";
        if (!model) return;
        btnWebProbe.disabled = true;
        routingStatus.textContent = "Đang kiểm tra Web bằng một lượt tool-call…";
        try {
          const res = await fetch("/api/ai-chat/web-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Không kiểm tra được Web");
          if (data.state === "SUPPORTED") {
            routingStatus.textContent = "Web đã được chứng minh bằng tool execution evidence.";
          } else {
            routingStatus.textContent = data.error || "Web chưa được chứng minh trong runtime.";
          }
          await napAgentVaModel(ocModel.value, model);
        } catch (error) {
          routingStatus.textContent = error.message || "Không kiểm tra được Web lúc này.";
        } finally {
          capNhatRoutingControls();
        }
      });

      // --- Khoa API cua cac hang ---

      const keyProvider = panel.querySelector("#ai-key-provider");
      const keyValue = panel.querySelector("#ai-key-value");
      const keyStatus = panel.querySelector("#ai-key-status");
      const btnKeySave = panel.querySelector("#btn-key-save");
      const btnKeyTest = panel.querySelector("#btn-key-test");
      const btnKeyDelete = panel.querySelector("#btn-key-delete");
      const btnKeyClear = panel.querySelector("#btn-key-clear");
      const PHO_BIEN = ["anthropic", "openai", "google", "groq", "deepseek", "xai", "mistral", "opencode"];
      let ownerKeyStatus = new Map();
      let keyBusy = false;

      function baoKey(text, mau) {
        keyStatus.style.color = mau || "var(--muted)";
        keyStatus.textContent = text;
      }

      function tenHangKey(providerId) {
        const option = [...keyProvider.options].find((item) => item.value === providerId);
        return String(option?.textContent || providerId)
          .replace(/\s*·\s*đã có key\s*$/i, "")
          .trim();
      }

      const THONG_BAO_THU_KEY = Object.freeze({
        INVALID_KEY: "API key không hợp lệ.",
        NO_QUOTA: "API key hợp lệ nhưng tài khoản đã hết hạn mức hoặc cần thanh toán.",
        QUOTA_EXHAUSTED: "API key hợp lệ nhưng tài khoản đã hết hạn mức hoặc cần thanh toán.",
        TIMEOUT: "Nhà cung cấp AI phản hồi quá lâu. Vui lòng thử lại.",
        PROVIDER_UNAVAILABLE: "Nhà cung cấp AI đang tạm thời không khả dụng.",
        OPENCODE_RUNTIME_ERROR: "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại.",
      });

      function setKeyButton(button, enabled) {
        button.disabled = !enabled;
        button.setAttribute("aria-disabled", String(!enabled));
      }

      function updateKeyButtons() {
        const providerId = keyProvider.value;
        const saved = ownerKeyStatus.has(providerId);
        keyProvider.disabled = keyBusy;
        keyValue.disabled = keyBusy;
        setKeyButton(btnKeySave, !keyBusy && Boolean(providerId && keyValue.value.trim()));
        setKeyButton(btnKeyTest, !keyBusy && saved);
        setKeyButton(btnKeyDelete, !keyBusy && saved);
        setKeyButton(btnKeyClear, !keyBusy && ownerKeyStatus.size > 0);
      }

      async function napDanhSachHangChoKey({ preserveStatus = false } = {}) {
        const dangChon = keyProvider.value;
        try {
          const [catalogResponse, statusResponse] = await Promise.all([
            fetch("/api/ai-chat/providers"),
            fetch("/api/ai-chat/owner-credentials"),
          ]);
          const [catalogData, statusData] = await Promise.all([
            catalogResponse.json(),
            statusResponse.json(),
          ]);
          if (!catalogResponse.ok) throw new Error(catalogData.error || "Không tải được danh sách hãng");
          if (!statusResponse.ok) throw new Error(statusData.error || "Không tải được kết nối AI");

          ownerKeyStatus = new Map((statusData.providers || []).map((item) => [item.providerId, item]));
          const all = [...(catalogData.providers || [])];
          const known = new Set(all.map((provider) => provider.id));
          for (const status of ownerKeyStatus.values()) {
            if (!known.has(status.providerId)) {
              all.push({ id: status.providerId, name: status.providerName || status.providerId });
            }
          }
          const daCoKey = all.filter((p) => ownerKeyStatus.has(p.id));
          const phoBien = all.filter((p) => !ownerKeyStatus.has(p.id) && PHO_BIEN.includes(p.id));
          const conLai = all.filter((p) => !ownerKeyStatus.has(p.id) && !PHO_BIEN.includes(p.id));

          keyProvider.innerHTML = "";
          const nhom = (nhan, list, hauTo) => {
            if (!list.length) return;
            const g = document.createElement("optgroup");
            g.label = nhan;
            for (const p of list) g.append(new Option(p.name + (hauTo || ""), p.id));
            keyProvider.append(g);
          };
          nhom("Đã có key", daCoKey, " · đã có key");
          nhom("Phổ biến", phoBien);
          nhom("Tất cả hãng khác", conLai);

          if (dangChon && all.some((provider) => provider.id === dangChon)) keyProvider.value = dangChon;
          if (!preserveStatus) {
            baoKey(daCoKey.length ? `${daCoKey.length} hãng đã kết nối` : "Chưa có kết nối.");
          }
          capNhatRoutingControls();
        } catch (e) {
          if (preserveStatus) throw e;
          ownerKeyStatus = new Map();
          keyProvider.innerHTML = "";
          keyProvider.append(new Option("— Không kết nối được OpenCode —", ""));
          baoKey(e.message, "var(--danger)");
        } finally {
          updateKeyButtons();
          capNhatRoutingControls();
        }
      }

      async function loadGlobalAiCatalogs() {
        await Promise.allSettled([
          napAgentVaModel(),
          napDanhSachHangChoKey(),
        ]);
      }

      keyProvider.addEventListener("change", updateKeyButtons);
      keyValue.addEventListener("input", updateKeyButtons);
      updateKeyButtons();

      btnKeySave.addEventListener("click", async () => {
        if (!keyProvider.value) return baoKey("Chọn hãng trước đã.", "var(--danger)");
        if (!keyValue.value.trim()) {
          return baoKey("API key không được để trống.", "var(--danger)");
        }
        const providerId = keyProvider.value;
        const providerName = tenHangKey(providerId);
        keyBusy = true;
        updateKeyButtons();
        baoKey("Đang lưu...");
        try {
          const res = await fetch("/api/ai-chat/owner-credentials", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId, apiKey: keyValue.value.trim() }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Lưu thất bại");
          keyValue.value = "";
          ownerKeyStatus.set(providerId, {
            providerId,
            providerName,
            connected: true,
            updatedAt: data.updatedAt,
          });
          baoKey(`Đã lưu API key ${providerName} thành công`, "var(--ok)");
          window.dispatchEvent(new CustomEvent("zalo:canonical-save", {
            detail: { section: "api-key", providerId },
          }));

          keyBusy = false;
          updateKeyButtons();

          // Persisted save da PASS. Cac refresh UI phu chay sau boundary nay va
          // khong duoc phep bien ket qua Save thanh failure.
          try {
            await napDanhSachHangChoKey({ preserveStatus: true });
          } catch (refreshError) {
            console.error("Không làm mới được danh sách hãng sau khi lưu key", refreshError);
          }
          try {
            await napAgentVaModel(
              ocProvider.value ? ocModel.value : "",
              ocFallbackProvider.value ? ocFallbackModel.value : ""
            );
          } catch (refreshError) {
            console.error("Không làm mới được agent/model sau khi lưu key", refreshError);
          }
        } catch (e) {
          baoKey(e.message, "var(--danger)");
        } finally {
          keyBusy = false;
          updateKeyButtons();
        }
      });

      btnKeyTest.addEventListener("click", async () => {
        if (!keyProvider.value) return baoKey("Chọn hãng trước đã.", "var(--danger)");
        if (!ownerKeyStatus.has(keyProvider.value)) return baoKey("Hãy lưu key hãng này trước.", "var(--danger)");
        const providerId = keyProvider.value;
        const providerName = tenHangKey(providerId);
        keyBusy = true;
        updateKeyButtons();
        baoKey("Đang gọi thử một câu...");
        try {
          const res = await fetch("/api/ai-chat/owner-credentials/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId }),
          });
          const data = await res.json();
          if (!res.ok) {
            baoKey(
              THONG_BAO_THU_KEY[String(data.error || "")]
                || data.message
                || "Không kiểm tra được API key.",
              "var(--danger)"
            );
            return;
          }
          baoKey(`API key ${providerName} hoạt động bình thường.`, "var(--ok)");
        } catch (e) {
          baoKey(e.message || "Không kiểm tra được API key.", "var(--danger)");
        } finally {
          keyBusy = false;
          updateKeyButtons();
        }
      });

      btnKeyDelete.addEventListener("click", async () => {
        const providerId = keyProvider.value;
        if (!ownerKeyStatus.has(providerId)) return;
        if (!confirm("Chỉ API key hãng đang chọn của tài khoản Zalo hiện tại sẽ bị gỡ.\n\nGỡ key hãng này?")) return;
        keyBusy = true;
        updateKeyButtons();
        baoKey("Đang gỡ...");
        try {
          const res = await fetch(`/api/ai-chat/owner-credentials/${encodeURIComponent(providerId)}`, {
            method: "DELETE",
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Gỡ thất bại");
          await napDanhSachHangChoKey();
          await napAgentVaModel(
            ocProvider.value ? ocModel.value : "",
            ocFallbackProvider.value ? ocFallbackModel.value : ""
          );
          baoKey("Đã gỡ key hãng này.", "var(--ok)");
          window.dispatchEvent(new CustomEvent("zalo:credential-change", {
            detail: { action: "delete-selected", providerId },
          }));
        } catch (e) {
          baoKey(e.message, "var(--danger)");
        } finally {
          keyBusy = false;
          updateKeyButtons();
        }
      });

      btnKeyClear.addEventListener("click", async () => {
        if (!confirm("Chỉ các API key AI đã lưu của tài khoản Zalo hiện tại sẽ bị gỡ.\n\nGỡ tất cả key của tôi?")) return;
        keyBusy = true;
        updateKeyButtons();
        baoKey("Đang gỡ...");
        try {
          const res = await fetch("/api/ai-chat/owner-credentials", { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Gỡ thất bại");
          await napDanhSachHangChoKey();
          await napAgentVaModel(
            ocProvider.value ? ocModel.value : "",
            ocFallbackProvider.value ? ocFallbackModel.value : ""
          );
          baoKey("Đã gỡ tất cả key của tôi.", "var(--ok)");
          window.dispatchEvent(new CustomEvent("zalo:credential-change", {
            detail: { action: "delete-all" },
          }));
        } catch (e) {
          baoKey(e.message, "var(--danger)");
        } finally {
          keyBusy = false;
          updateKeyButtons();
        }
      });

      const refreshAfterCredentialChange = async () => {
        await Promise.allSettled([
          napDanhSachHangChoKey(),
          napAgentVaModel(
            ocProvider.value ? ocModel.value : "",
            ocFallbackProvider.value ? ocFallbackModel.value : ""
          ),
        ]);
      };
      window.addEventListener("zalo:credential-change", () => void refreshAfterCredentialChange());
      window.addEventListener("zalo:canonical-save", (event) => {
        if (event.detail?.section === "api-key") void refreshAfterCredentialChange();
      });

      panel.querySelector("#btn-oc-test").addEventListener("click", async () => {
        statusText.textContent = "Đang kiểm tra OpenCode...";
        try {
          const res = await fetch("/api/ai-chat/opencode-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ opencodeBaseUrl: ocUrl.value.trim() }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Không kết nối được.");
          const soModel = (data.providers || []).reduce((n, h) => n + h.models.length, 0);
          statusText.textContent =
            `OK · ${data.agents.length} agent · ${(data.providers || []).length} hãng · ${soModel} model chat được`;
          await napAgentVaModel(
            ocProvider.value ? ocModel.value : "",
            ocFallbackProvider.value ? ocFallbackModel.value : ""
          );
        } catch (err) {
          statusText.textContent = "Lỗi: " + err.message;
        }
      });

      panel.querySelector("#btn-oc-reset").addEventListener("click", async () => {
        if (!confirm("Xoá toàn bộ session OpenCode để nạp lại Soul từ đầu?")) return;
        await fetch("/api/ai-chat/reset-sessions", { method: "POST" });
        statusText.textContent = "Đã xoá session. Tin nhắn tới sẽ tạo session mới và nạp lại Soul.";
      });

      // Hãng/model là ranh giới kết nối AI độc lập. Nút này không submit form
      // trợ lý, vì Soul/giọng điệu/chủ đề chỉ tồn tại sau khi Bot Chỉ huy phỏng vấn.
      panel.querySelector("#btn-ai-model-save").addEventListener("click", async () => {
        const actionGeneration = settingsOwnerGeneration;
        if (!ocProvider.value || !ocModel.value) {
          statusText.textContent = "Hãy chọn đủ Hãng AI và Model.";
          return;
        }

        // Handler nay con duoc suite P9.17 tach rieng de chay voi fixture cua
        // giao dien cu (chua co control fallback). typeof giu callback tuong
        // thich trong fixture do, con production van doc du control Part 1.
        const fallbackProviderValue = typeof ocFallbackProvider === "undefined"
          ? ""
          : ocFallbackProvider.value;
        const fallbackModelValue = typeof ocFallbackModel === "undefined"
          ? ""
          : ocFallbackModel.value;
        const hadSavedFallback = typeof fallbackModelDaLuuTheoOwner !== "undefined"
          && Boolean(fallbackModelDaLuuTheoOwner);
        const fallbackCapabilitiesValue = typeof fallbackImage === "undefined"
          ? []
          : [
              ...(fallbackImage.checked ? ["IMAGE_INPUT"] : []),
              ...(fallbackFile.checked ? ["FILE_INPUT"] : []),
              ...(fallbackWeb.checked ? ["WEB_SEARCH"] : []),
            ];
        const failoverEnabledValue = typeof failoverEnabled === "undefined"
          ? false
          : failoverEnabled.checked;

        try {
          statusText.textContent = "Đang lưu Hãng AI và Model...";
          const res = await fetch("/api/ai-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              saveScope: "ai-connection",
              opencodeBaseUrl: ocUrl.value.trim(),
              opencodeAgent: ocAgent.value,
              opencodeModel: ocModel.value,
              ...(hadSavedFallback || fallbackProviderValue
                ? { opencodeFallbackModel: fallbackProviderValue ? fallbackModelValue : "" }
                : {}),
              opencodeFallbackCapabilities: fallbackCapabilitiesValue,
              opencodeFailoverEnabled: failoverEnabledValue,
            }),
          });
          const data = await res.json();
          if (actionGeneration !== settingsOwnerGeneration) return;
          if (!res.ok) throw new Error(data.error || "Lỗi lưu Hãng AI và Model");
          if (typeof modelDaLuuTheoOwner !== "undefined") {
            modelDaLuuTheoOwner = data.config?.opencodeModel || ocModel.value;
          }
          if (typeof fallbackModelDaLuuTheoOwner !== "undefined") {
            fallbackModelDaLuuTheoOwner = data.config?.opencodeFallbackModel || "";
          }
          if (typeof fallbackCapabilitiesDaLuuTheoOwner !== "undefined") {
            fallbackCapabilitiesDaLuuTheoOwner = data.config?.opencodeFallbackCapabilities || [];
            fallbackImage.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("IMAGE_INPUT");
            fallbackFile.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("FILE_INPUT");
            fallbackWeb.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("WEB_SEARCH");
            failoverDaLuuTheoOwner = data.config?.opencodeFailoverEnabled === true;
            failoverEnabled.checked = failoverDaLuuTheoOwner;
            capabilityRoutingSystemEnabled = data.config?.capabilityRoutingEnabled === true;
            capNhatRoutingControls();
          }
          statusText.textContent = "Đã lưu Hãng AI và Model.";
          window.dispatchEvent(new CustomEvent("zalo:canonical-save", {
            detail: {
              section: "ai-model",
              providerId: ocProvider.value,
              modelId: data.config?.opencodeModel || ocModel.value,
              fallbackProviderId: fallbackProviderValue,
              fallbackModelId: data.config?.opencodeFallbackModel || "",
            },
          }));
        } catch (error) {
          console.error(error);
          statusText.textContent = error.message || "Lỗi lưu Hãng AI và Model";
        }
      });

      useKnowledge.addEventListener("change", () => {
        knowledgeWrap.classList.toggle("hidden", !useKnowledge.checked);
        if (useKnowledge.checked) loadKnowledgeFiles();
      });

      function showGroupHint(text) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.disabled = true;
        opt.textContent = text;
        groupSelect.appendChild(opt);
      }

      async function loadGroups(generation = settingsOwnerGeneration) {
        try {
          const res = await fetch("/api/zalo/groups");
          if (!res.ok) {
            showGroupHint(
              res.status === 401
                ? "— Cần đăng nhập Zalo để tải danh sách nhóm —"
                : "— Không tải được danh sách nhóm —"
            );
            return;
          }
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          if (data.groups) {
            data.groups.forEach(g => {
              const opt = document.createElement("option");
              opt.value = g.id;
              opt.textContent = g.name;
              groupSelect.appendChild(opt);
            });
          }
        } catch (e) {
          console.error("Lỗi load groups", e);
          showGroupHint("— Không tải được danh sách nhóm —");
        }
      }

      async function loadMembers(groupId, selectedIds = [], generation = settingsOwnerGeneration) {
        sendersSelect.innerHTML = "<option value=''>Đang tải danh sách...</option>";
        sendersSelect.disabled = true;
        if (!groupId) {
          sendersSelect.innerHTML = "<option value=''>Chọn nhóm ở trên để tải danh sách nick</option>";
          return;
        }
        try {
          const res = await fetch(`/api/zalo/groups/${groupId}/members`);
          if (!res.ok) throw new Error("API failed");
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          currentMembers = data.members || [];
          
          sendersSelect.innerHTML = "";
          currentMembers.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.displayName || m.zaloName || m.id;
            if (selectedIds.includes(m.id)) opt.selected = true;
            sendersSelect.appendChild(opt);
          });
          sendersSelect.disabled = false;
        } catch (e) {
          console.error("Lỗi load members", e);
          sendersSelect.innerHTML = "<option value=''>Lỗi tải danh sách</option>";
        }
      }

      groupSelect.addEventListener("change", (e) => {
        loadMembers(e.target.value);
      });

      async function loadConfig() {
        const generation = settingsOwnerGeneration;
        try {
          invalidateAiOwnerSink?.();
          await loadGroups(generation);
          const res = await fetch("/api/ai-chat");
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return false;
          if (!res.ok) throw new Error(data.error || "Không tải được cấu hình AI");
          if (data.config) {
            ocUrl.value = data.config.opencodeBaseUrl || "";
            soulInput.value = data.config.soul || "";
            const agentDaLuu = data.config.opencodeAgent || "general";
            if (!Array.from(ocAgent.options).some((item) => item.value === agentDaLuu)) {
              ocAgent.append(new Option(agentDaLuu, agentDaLuu));
            }
            ocAgent.value = agentDaLuu;
            modelDaLuuTheoOwner = data.config.opencodeModel || "";
            fallbackModelDaLuuTheoOwner = data.config.opencodeFallbackModel || "";
            fallbackCapabilitiesDaLuuTheoOwner = Array.isArray(data.config.opencodeFallbackCapabilities)
              ? data.config.opencodeFallbackCapabilities
              : [];
            failoverDaLuuTheoOwner = data.config.opencodeFailoverEnabled === true;
            capabilityRoutingSystemEnabled = data.config.capabilityRoutingEnabled === true;
            fallbackImage.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("IMAGE_INPUT");
            fallbackFile.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("FILE_INPUT");
            fallbackWeb.checked = fallbackCapabilitiesDaLuuTheoOwner.includes("WEB_SEARCH");
            failoverEnabled.checked = failoverDaLuuTheoOwner;
            chonModelKhongDungLaiDanhSach(modelHieuLucTheoOwner());
            chonFallbackKhongDungLaiDanhSach(fallbackModelHieuLucTheoOwner());
            topicsInput.value = data.config.allowedTopics || "";
            roleInput.value = data.config.roleTone || "";
            
            if (data.config.allowedGroupId) {
              groupSelect.value = data.config.allowedGroupId;
              await loadMembers(data.config.allowedGroupId, data.config.allowedSenderIds || [], generation);
            }

            useKnowledge.checked = Boolean(data.config.useKnowledge);
            docTep.checked = Boolean(data.config.docTep);
            knowledgeWrap.classList.toggle("hidden", !useKnowledge.checked);
            if (useKnowledge.checked) {
              await loadKnowledgeFiles(data.config.knowledgeFileIds || [], generation);
            }
          }
          if (data.ready) {
            statusText.textContent = "AI Chat đang bật";
          } else {
            statusText.textContent = "Chưa cấu hình xong";
          }
          return true;
        } catch (err) {
          console.error(err);
          statusText.textContent = err.message || "Không tải được cấu hình AI";
          return false;
        }
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        
        const selectedSenders = Array.from(sendersSelect.selectedOptions).map(o => o.value).filter(v => v !== "");
        const selectedKnowledge = Array.from(
          knowledgeFiles.querySelectorAll("input[name='knowledge-file']:checked")
        ).map(o => Number(o.value));

        if (useKnowledge.checked && selectedKnowledge.length === 0) {
          alert("Đã bật dùng tri thức thì phải chọn ít nhất 1 file.");
          return;
        }

        try {
          statusText.textContent = "Đang lưu...";
          const res = await fetch("/api/ai-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              soul: soulInput.value.trim(),
              allowedTopics: topicsInput.value.trim(),
              roleTone: roleInput.value.trim(),
              allowedGroupId: groupSelect.value,
              allowedSenderIds: selectedSenders,
              useKnowledge: useKnowledge.checked,
              knowledgeFileIds: selectedKnowledge
            })
          });
          const data = await res.json();
          if (data.ok) {
            statusText.textContent = data.ready ? "Đã ghi nhớ · AI Chat đang bật" : "Đã ghi nhớ · Chưa đủ cấu hình";
            window.dispatchEvent(new CustomEvent("zalo:canonical-save", {
              detail: {
                section: "ai-config",
              },
            }));
          } else {
            alert(data.error || "Lỗi lưu cấu hình");
            statusText.textContent = "";
          }
        } catch (err) {
          console.error(err);
          statusText.textContent = "Lỗi lưu cấu hình";
        }
      });

      // Nap lai danh sach nhom + nick moi khi mo Cau hinh. Dung lai dung
      // loadGroups() / loadMembers() san co, khong viet them duong fetch nao.
      let dangNapLai = false;
      let napBanDau = null; // promise cua luot nap dau tien, gan o cuoi mount
      aiEntityRefreshSink = async () => {
        // Mo Cau hinh hai lan that nhanh thi hai luot nap se cung append vao
        // mot o chon -> danh sach nhan doi. Chan bang mot co don gian.
        if (dangNapLai) return;
        dangNapLai = true;
        try {
          // Bam Cau hinh ngay khi trang vua tai thi loadConfig() luc mount con
          // dang cho mang; no se append SAU khi ta don o chon -> danh sach nhan
          // doi. Cho luot nap dau tien xong roi hang lam. Lan sau promise nay
          // da xong san nen khong cho them gi.
          await napBanDau;

          const nhomDangChon = groupSelect.value;
          const nickDangChon = Array.from(sendersSelect.selectedOptions)
            .map((o) => o.value)
            .filter((v) => v !== "");

          // loadGroups() chi APPEND chu khong don o chon, nen phai tu don o day
          // - ke ca dong bao loi 401 con sot lai tu luot nap truoc. Giu option
          // dau tien vi do la muc tinh "— Tat ca (khong gioi han nhom) —" viet
          // san trong HTML.
          while (groupSelect.options.length > 1) groupSelect.remove(1);

          await loadGroups();

          // Nhom cu khong con trong danh sach nua thi value tu tro ve rong,
          // khong nem loi. Chi nap lai nick khi that su con mot nhom hop le.
          groupSelect.value = nhomDangChon;
          if (groupSelect.value) await loadMembers(groupSelect.value, nickDangChon);
        } finally {
          dangNapLai = false;
        }
      };

      invalidateAiOwnerSink = () => {
        soulInput.value = "";
        topicsInput.value = "";
        roleInput.value = "";
        useKnowledge.checked = false;
        knowledgeWrap.classList.add("hidden");
        knowledgeFiles.innerHTML = "";
        groupSelect.value = "";
        while (groupSelect.options.length > 1) groupSelect.remove(1);
        sendersSelect.innerHTML = "<option value=''>Chọn nhóm ở trên để tải danh sách nick</option>";
        sendersSelect.disabled = true;
        currentMembers = [];
        modelDaLuuTheoOwner = "";
        fallbackModelDaLuuTheoOwner = "";
        fallbackCapabilitiesDaLuuTheoOwner = [];
        failoverDaLuuTheoOwner = false;
        capabilityRoutingSystemEnabled = false;
        fallbackImage.checked = false;
        fallbackFile.checked = false;
        fallbackWeb.checked = false;
        failoverEnabled.checked = false;
        ownerKeyStatus = new Map();
        keyProvider.innerHTML = '<option value="">Chọn hãng</option>';
        keyProvider.value = "";
        keyValue.value = "";
        baoKey("Đang tải kết nối AI của tài khoản Zalo hiện tại…");
        updateKeyButtons();
        // Model va API key deu la lua chon owner; request cu bi generation guard bo qua.
        ocProvider.value = "";
        ocModel.value = "";
        ocFallbackProvider.value = "";
        ocFallbackModel.value = "";
        statusText.textContent = "Đang tải hồ sơ Zalo hiện tại…";
        capNhatRoutingControls();
      };

      // Giu lai promise cua luot nap dau tien de ham refresh o tren cho no.
      // Model/Soul/Tone/Topics va nhom/nick deu theo owner, phai nap lai ca form.
      aiConfigRefreshSink = async () => {
        const [ownerResult] = await Promise.allSettled([loadConfig(), loadGlobalAiCatalogs()]);
        return ownerResult.status === "fulfilled" ? ownerResult.value : false;
      };
      dangKyLamMoi("AI Chat", aiConfigRefreshSink);
      const napGlobalBanDau = loadGlobalAiCatalogs();
      const napOwnerBanDau = loadConfig();
      napBanDau = Promise.allSettled([napGlobalBanDau, napOwnerBanDau]);
    }
  },
  {
    id: "knowledge",
    label: "Tri thức",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          Tải file lên, hệ thống chuyển sang Markdown rồi lưu vào kho. Bot chỉ đọc file bạn tick ở tab AI Chat.
        </div>
        <div class="rule-list-header">
          <h3>File trong kho</h3>
          <div>
            <input type="file" id="kn-input" accept=".txt,.md,.pdf,.doc,.docx" class="hidden" />
            <button id="kn-add" class="secondary-button" type="button">Thêm file</button>
          </div>
        </div>
        <div id="kn-status" class="field-hint" style="color: var(--muted); font-size: 13px; min-height: 18px;"></div>
        <div id="kn-list" class="rule-list"></div>
      `;

      const input = panel.querySelector("#kn-input");
      const btnAdd = panel.querySelector("#kn-add");
      const list = panel.querySelector("#kn-list");
      const status = panel.querySelector("#kn-status");

      const modal = document.querySelector("#knowledge-preview-modal");
      const kpTitle = document.querySelector("#kp-title");
      const kpMeta = document.querySelector("#kp-meta");
      const kpContent = document.querySelector("#kp-content");
      document.querySelector("#kp-close")?.addEventListener("click", () => modal.classList.add("hidden"));

      function formatSize(bytes) {
        if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
        if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
        return bytes + " B";
      }

      async function openPreview(file, generation = settingsOwnerGeneration) {
        kpTitle.textContent = file.originalName;
        kpMeta.textContent = "Đang tải nội dung...";
        kpContent.textContent = "";
        modal.classList.remove("hidden");
        try {
          const res = await fetch(`/api/knowledge/${file.id}/content`);
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          if (!res.ok) throw new Error(data.error || "Không đọc được file");
          kpMeta.textContent =
            `${data.file.contentMd.length.toLocaleString("vi-VN")} ký tự hiển thị` +
            (data.file.truncated ? " · Đã cắt bớt vì file quá dài" : "");
          kpContent.textContent = data.file.contentMd;
        } catch (e) {
          if (generation !== settingsOwnerGeneration) return;
          kpMeta.textContent = "Lỗi: " + e.message;
        }
      }

      async function fetchList(generation = settingsOwnerGeneration) {
        try {
          const res = await fetch("/api/knowledge");
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          const files = data.files || [];
          list.innerHTML = "";
          if (files.length === 0) {
            list.innerHTML = "<div class='empty-hint' style='margin: 0; padding: 12px;'>Kho tri thức đang trống.</div>";
            return;
          }
          for (const file of files) {
            const item = document.createElement("div");
            item.className = "rule-item";

            const info = document.createElement("div");
            info.className = "rule-info";
            const name = document.createElement("div");
            name.className = "rule-cmd";
            name.textContent = file.originalName;
            const meta = document.createElement("div");
            meta.className = "rule-meta";
            meta.textContent = `${file.fileExt} · ${formatSize(file.fileSize)} · ${file.charCount.toLocaleString("vi-VN")} ký tự`;
            info.append(name, meta);

            const actions = document.createElement("div");
            actions.className = "rule-actions";

            const btnView = document.createElement("button");
            btnView.className = "secondary-button";
            btnView.type = "button";
            btnView.title = "Xem nội dung Markdown";
            btnView.textContent = "🔍";
            btnView.onclick = () => openPreview(file);

            const btnDelete = document.createElement("button");
            btnDelete.className = "secondary-button";
            btnDelete.type = "button";
            btnDelete.textContent = "Xoá";
            btnDelete.onclick = async () => {
              if (!confirm(`Xoá "${file.originalName}" khỏi kho tri thức?`)) return;
              const generation = settingsOwnerGeneration;
              await fetch(`/api/knowledge/${file.id}`, { method: "DELETE" });
              if (generation === settingsOwnerGeneration) await fetchList(generation);
            };

            actions.append(btnView, btnDelete);
            item.append(info, actions);
            list.append(item);
          }
        } catch (e) {
          if (generation !== settingsOwnerGeneration) return;
          console.error("Lỗi load kho tri thức", e);
          list.innerHTML = "<div class='empty-hint' style='margin: 0; padding: 12px;'>Không tải được danh sách.</div>";
        }
      }

      btnAdd.addEventListener("click", () => input.click());

      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        const generation = settingsOwnerGeneration;
        status.textContent = `Đang xử lý "${file.name}"...`;
        btnAdd.disabled = true;
        try {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch("/api/knowledge", { method: "POST", body });
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          if (!res.ok) throw new Error(data.error || "Tải lên thất bại");
          status.textContent = `Đã thêm "${data.file.originalName}" · ${data.file.charCount.toLocaleString("vi-VN")} ký tự`;
          await fetchList(generation);
        } catch (e) {
          if (generation !== settingsOwnerGeneration) return;
          status.textContent = "Lỗi: " + e.message;
        } finally {
          if (generation === settingsOwnerGeneration) {
            btnAdd.disabled = false;
            input.value = "";
          }
        }
      });

      invalidateKnowledgeOwnerSink = () => {
        list.innerHTML = "";
        status.textContent = "";
        kpTitle.textContent = "";
        kpMeta.textContent = "";
        kpContent.textContent = "";
        modal.classList.add("hidden");
        input.value = "";
        btnAdd.disabled = false;
      };
      dangKyLamMoi("tri thuc", fetchList);
      fetchList();
    }
  },
  {
    id: "lich-hen",
    label: "Lịch hẹn",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          Nhắn cho bot từ nick admin, ví dụ: <em>"8h sáng 10/8 gửi nhóm masterclass: mn ơi cho em xin
          ít cảm nhận về buổi học hôm qua với ạ"</em>. Bot sẽ đọc lại ngày giờ cho chị duyệt rồi mới đặt.
          Đúng giờ nó tự gửi. Lịch trễ quá 30 phút thì bot không gửi nữa mà nhắn báo chị.
        </div>
        <div class="rule-list-header">
          <h3>Lịch hẹn</h3>
          <button id="lh-reload" class="secondary-button" type="button">Làm mới</button>
        </div>
        <div id="lh-status" class="field-hint" style="color: var(--muted); font-size: 13px; min-height: 18px;"></div>
        <div id="lh-list" class="rule-list"></div>
      `;

      const list = panel.querySelector("#lh-list");
      const status = panel.querySelector("#lh-status");

      const NHAN = {
        cho: { chu: "Đang chờ", mau: "var(--ok)" },
        da_gui: { chu: "Đã gửi", mau: "var(--muted)" },
        bo_qua: { chu: "Lỡ giờ — không gửi", mau: "var(--warn)" },
        loi: { chu: "Gửi lỗi", mau: "var(--danger)" },
        da_huy: { chu: "Đã huỷ", mau: "var(--muted)" },
      };
      const LAP = { hang_ngay: "hằng ngày", hang_tuan: "hằng tuần" };

      const gio = (giay) =>
        new Date(Number(giay) * 1000).toLocaleString("vi-VN", {
          weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        });

      async function napDanhSach() {
        const owner = chupSettingsOwner();
        try {
          const res = await fetch("/api/lich-hen");
          const data = await res.json();
          if (!settingsOwnerConHieuLuc(owner)) return;
          const danhSach = data.lich || [];
          list.innerHTML = "";
          if (danhSach.length === 0) {
            list.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Chưa có lịch hẹn nào.</div>";
            return;
          }

          for (const l of danhSach) {
            const nhan = NHAN[l.trangThai] || { chu: l.trangThai, mau: "var(--muted)" };
            const item = document.createElement("div");
            item.className = "rule-item";

            const info = document.createElement("div");
            info.className = "rule-info";

            const dong1 = document.createElement("div");
            dong1.className = "rule-cmd";
            dong1.textContent = `#${l.id} · ${gio(l.lucGui)}${l.lapLai ? ` · ${LAP[l.lapLai] || l.lapLai}` : ""}`;

            const dong2 = document.createElement("div");
            dong2.className = "rule-meta";
            dong2.textContent = `${l.loai === "nhom" ? "Nhóm" : "Nick"} ${l.dichTen} — ${l.noiDung}`;

            const dong3 = document.createElement("div");
            dong3.className = "rule-meta";
            dong3.style.color = nhan.mau;
            dong3.textContent = nhan.chu + (l.ghiChu ? ` · ${l.ghiChu}` : "");

            info.append(dong1, dong2, dong3);

            const actions = document.createElement("div");
            actions.className = "rule-actions";
            if (l.trangThai === "cho") {
              const btnHuy = document.createElement("button");
              btnHuy.className = "secondary-button";
              btnHuy.type = "button";
              btnHuy.textContent = "Huỷ";
              btnHuy.onclick = async () => {
                if (!confirm(`Huỷ lịch #${l.id} gửi vào "${l.dichTen}" lúc ${gio(l.lucGui)}?`)) return;
                const r = await fetch(`/api/lich-hen/${l.id}`, { method: "DELETE" });
                const d = await r.json();
                status.textContent = r.ok ? `Đã huỷ lịch #${l.id}.` : `Lỗi: ${d.error}`;
                await napDanhSach();
              };
              actions.append(btnHuy);
            }

            item.append(info, actions);
            list.append(item);
          }
        } catch (e) {
          if (!settingsOwnerConHieuLuc(owner)) return;
          console.error("Loi nap lich hen", e);
          list.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Không tải được danh sách.</div>";
        }
      }

      panel.querySelector("#lh-reload").addEventListener("click", napDanhSach);
      invalidateScheduleOwnerSink = () => {
        list.innerHTML = "";
        status.textContent = "";
      };
      dangKyLamMoi("lich hen", napDanhSach);
      napDanhSach();
    }
  },
  {
    id: "customers",
    label: "Khách hàng",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          Bot tự ghi lại hồ sơ từng khách sau mỗi 6 lượt trò chuyện, và đọc lại hồ sơ đó
          mỗi khi khách nhắn tới — để không hỏi lại điều đã biết và không đổi giọng giữa các ngày.
          Hồ sơ chỉ nằm trong máy này. Bot có thể hiểu nhầm, chị nên đọc và sửa lại.
        </div>
        <div class="rule-list-header">
          <h3>Hồ sơ đã ghi</h3>
          <button id="cm-reload" class="secondary-button" type="button">Làm mới</button>
        </div>
        <div id="cm-status" class="field-hint" style="color: var(--muted); font-size: 13px; min-height: 18px;"></div>
        <div id="cm-list" class="rule-list"></div>
      `;

      const list = panel.querySelector("#cm-list");
      const status = panel.querySelector("#cm-status");
      const MAX = 1200;

      const ngay = (giay) =>
        giay ? new Date(giay * 1000).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

      function dungTrinhSua(khach, item, onDone) {
        const box = document.createElement("div");
        box.style.cssText = "flex-basis:100%; margin-top:10px;";

        const ta = document.createElement("textarea");
        ta.rows = 9;
        ta.value = khach.profile;
        ta.style.cssText = "width:100%; font-size:13px; line-height:1.5;";

        const dem = document.createElement("div");
        dem.className = "field-hint";
        dem.style.cssText = "font-size:12px; margin-top:4px;";
        const capNhatDem = () => {
          dem.textContent = `${ta.value.length}/${MAX} ký tự`;
          dem.style.color = ta.value.length > MAX ? "var(--danger)" : "var(--muted)";
        };
        ta.addEventListener("input", capNhatDem);
        capNhatDem();

        const hangKhoa = document.createElement("label");
        hangKhoa.style.cssText = "display:flex; gap:8px; align-items:center; margin:10px 0; font-size:13px;";
        const khoa = document.createElement("input");
        khoa.type = "checkbox";
        khoa.checked = khach.locked;
        hangKhoa.append(khoa, document.createTextNode("Khoá hồ sơ này — bot không được tự ghi đè nữa"));

        const hangNut = document.createElement("div");
        hangNut.style.cssText = "display:flex; gap:8px;";
        const btnLuu = document.createElement("button");
        btnLuu.className = "primary-button";
        btnLuu.type = "button";
        btnLuu.textContent = "Lưu";
        const btnHuy = document.createElement("button");
        btnHuy.className = "secondary-button";
        btnHuy.type = "button";
        btnHuy.textContent = "Huỷ";

        btnHuy.onclick = () => onDone(false);
        btnLuu.onclick = async () => {
          if (ta.value.length > MAX) {
            status.textContent = `Hồ sơ quá dài, tối đa ${MAX} ký tự.`;
            return;
          }
          btnLuu.disabled = true;
          try {
            const res = await fetch(`/api/customer-memory/${encodeURIComponent(khach.uid)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profile: ta.value, locked: khoa.checked }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Lưu thất bại");
            status.textContent = `Đã lưu hồ sơ "${khach.displayName || khach.uid}".`;
            onDone(true);
          } catch (e) {
            status.textContent = "Lỗi: " + e.message;
            btnLuu.disabled = false;
          }
        };

        hangNut.append(btnLuu, btnHuy);
        box.append(ta, dem, hangKhoa, hangNut);
        item.append(box);
        ta.focus();
        return box;
      }

      async function napDanhSach() {
        const owner = chupSettingsOwner();
        try {
          const res = await fetch("/api/customer-memory");
          const data = await res.json();
          if (!settingsOwnerConHieuLuc(owner)) return;
          const khachs = data.customers || [];
          list.innerHTML = "";
          if (khachs.length === 0) {
            list.innerHTML =
              "<div class='empty-hint' style='margin:0; padding:12px;'>Chưa có hồ sơ nào. Bot sẽ tự ghi sau khi khách trò chuyện đủ 6 lượt.</div>";
            return;
          }

          for (const khach of khachs) {
            const item = document.createElement("div");
            item.className = "rule-item";
            item.style.flexWrap = "wrap";

            const info = document.createElement("div");
            info.className = "rule-info";
            const ten = document.createElement("div");
            ten.className = "rule-cmd";
            ten.textContent = (khach.displayName || khach.uid) + (khach.locked ? "  🔒" : "");
            const meta = document.createElement("div");
            meta.className = "rule-meta";
            meta.textContent = khach.profile
              ? `${khach.profile.length} ký tự · cập nhật ${ngay(khach.updatedAt)} · ${khach.turns} lượt kể từ lần ghi gần nhất`
              : `Chưa có nội dung · ${khach.turns} lượt đã trò chuyện`;
            info.append(ten, meta);

            const actions = document.createElement("div");
            actions.className = "rule-actions";

            const btnSua = document.createElement("button");
            btnSua.className = "secondary-button";
            btnSua.type = "button";
            btnSua.textContent = "Xem / sửa";
            btnSua.onclick = () => {
              if (item.querySelector("textarea")) return;
              btnSua.disabled = true;
              const box = dungTrinhSua(khach, item, (daLuu) => {
                if (daLuu) return napDanhSach();
                box.remove();
                btnSua.disabled = false;
              });
            };

            const btnXoa = document.createElement("button");
            btnXoa.className = "secondary-button";
            btnXoa.type = "button";
            btnXoa.textContent = "Xoá";
            btnXoa.onclick = async () => {
              if (!confirm(`Xoá hồ sơ của "${khach.displayName || khach.uid}"? Bot sẽ ghi lại từ đầu.`)) return;
              await fetch(`/api/customer-memory/${encodeURIComponent(khach.uid)}`, { method: "DELETE" });
              await napDanhSach();
            };

            actions.append(btnSua, btnXoa);
            item.append(info, actions);
            list.append(item);
          }
        } catch (e) {
          if (!settingsOwnerConHieuLuc(owner)) return;
          console.error("Loi nap ho so khach", e);
          list.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Không tải được danh sách.</div>";
        }
      }

      panel.querySelector("#cm-reload").addEventListener("click", napDanhSach);
      invalidateCustomersOwnerSink = () => {
        list.innerHTML = "";
        status.textContent = "";
      };
      dangKyLamMoi("khach hang", napDanhSach);
      napDanhSach();
    }
  },
  {
    id: "logs",
    label: "LOG",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          Nhật ký luồng xử lý tin nhắn: tin nào qua lọc, prompt gửi LLM là gì, vì sao không trả lời.
        </div>
        <div class="rule-list-header">
          <h3>Nhật ký gần đây</h3>
          <div>
            <button id="log-refresh" class="secondary-button" type="button">Làm mới</button>
            <button id="log-clear" class="secondary-button" type="button">Xoá log</button>
          </div>
        </div>
        <div id="log-list" class="log-list"></div>
      `;

      const list = panel.querySelector("#log-list");

      function renderEntry(entry) {
        const item = document.createElement("div");
        item.className = `log-item log-${entry.level || "info"}`;

        const head = document.createElement("div");
        head.className = "log-head";

        const time = document.createElement("span");
        time.className = "log-time";
        time.textContent = new Date(entry.createdAt * 1000).toLocaleTimeString("vi-VN");

        const badge = document.createElement("span");
        badge.className = "log-badge";
        badge.textContent = entry.event;

        const summary = document.createElement("span");
        summary.className = "log-summary";
        summary.textContent = entry.summary;

        head.append(time, badge, summary);
        item.append(head);

        if (entry.detail) {
          const btn = document.createElement("button");
          btn.className = "secondary-button log-detail-btn";
          btn.type = "button";
          btn.textContent = "Chi tiết";
          const pre = document.createElement("pre");
          pre.className = "log-detail hidden";
          pre.textContent = JSON.stringify(entry.detail, null, 2);
          btn.onclick = () => pre.classList.toggle("hidden");
          item.append(btn, pre);
        }
        return item;
      }

      async function fetchLogs() {
        // Keep the renderer safe if reused in isolation; the mounted module always
        // has the owner helpers and therefore always captures the current identity.
        const owner = typeof chupSettingsOwner === "function" ? chupSettingsOwner() : null;
        try {
          const res = await fetch("/api/logs?limit=150");
          const data = await res.json();
          if (owner && !settingsOwnerConHieuLuc(owner)) return;
          if (!res.ok) throw new Error(data.error || "Không tải được nhật ký hoạt động");
          const logs = data.logs || [];
          list.innerHTML = "";
          if (logs.length === 0) {
            list.innerHTML = "<div class='empty-hint' style='margin: 0; padding: 12px;'>Chưa có log nào.</div>";
            return;
          }
          for (const entry of logs) list.append(renderEntry(entry));
        } catch (e) {
          if (owner && !settingsOwnerConHieuLuc(owner)) return;
          console.error("Lỗi load log", e);
          list.innerHTML = "<div class='empty-hint log-load-error' style='margin: 0; padding: 12px;'>Không thể tải nhật ký hoạt động.</div>";
        }
      }

      panel.querySelector("#log-refresh").addEventListener("click", fetchLogs);
      panel.querySelector("#log-clear").addEventListener("click", async () => {
        if (!confirm("Xoá toàn bộ nhật ký?")) return;
        await fetch("/api/logs", { method: "DELETE" });
        await fetchLogs();
      });

      // Socket day log moi -> chen len dau, khong can bam Lam moi.
      activityLogSink = (entry) => {
        const empty = list.querySelector(".empty-hint");
        if (empty) list.innerHTML = "";
        list.prepend(renderEntry(entry));
      };

      invalidateLogsOwnerSink = () => {
        list.innerHTML = "";
      };
      dangKyLamMoi("nhat ky", fetchLogs);
      fetchLogs();
    }
  },
  {
    id: "account",
    label: "Tài khoản",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom: 16px; color: var(--muted); font-size: 14px;">
          Đang đăng nhập: <strong id="acc-username">—</strong>
        </div>
        <form id="acc-username-form" class="rule-form">
          <h4 style="margin-top: 0;">Đổi tên đăng nhập</h4>
          <div class="form-group">
            <label>Mật khẩu hiện tại:</label>
            <input type="password" id="accu-password" class="auth-input" autocomplete="current-password" required />
          </div>
          <div class="form-group">
            <label>Tên đăng nhập mới:</label>
            <input type="text" id="accu-new" class="auth-input" autocomplete="username" required />
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">3-32 ký tự: chữ, số, dấu chấm, gạch ngang, gạch dưới.</p>
          </div>
          <div class="form-actions" style="display: flex; justify-content: space-between; align-items: center;">
            <span id="accu-status" style="font-size: 14px;"></span>
            <button type="submit" class="primary-button">Đổi tên đăng nhập</button>
          </div>
        </form>

        <hr class="section-divider" />

        <form id="acc-form" class="rule-form">
          <h4 style="margin-top: 0;">Đổi mật khẩu</h4>
          <div class="form-group">
            <label>Mật khẩu hiện tại:</label>
            <input type="password" id="acc-current" class="auth-input" autocomplete="current-password" required />
          </div>
          <div class="form-group">
            <label>Mật khẩu mới:</label>
            <input type="password" id="acc-new" class="auth-input" autocomplete="new-password" required />
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">Tối thiểu 6 ký tự.</p>
          </div>
          <div class="form-group">
            <label>Xác nhận mật khẩu mới:</label>
            <input type="password" id="acc-confirm" class="auth-input" autocomplete="new-password" required />
          </div>
          <div class="form-actions" style="display: flex; justify-content: space-between; align-items: center;">
            <span id="acc-status" style="font-size: 14px;"></span>
            <button type="submit" class="primary-button">Đổi mật khẩu</button>
          </div>
        </form>

        <hr class="section-divider" />

        <form id="otp-settings-form" class="rule-form">
          <h4 style="margin-top: 0;">Xác thực 2 bước (OTP)</h4>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="otp-enabled" />
              Yêu cầu nhập OTP sau khi đăng nhập thành công
            </label>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">
              Khi bật, sau bước mật khẩu sẽ phải nhập mã 6 số. Phải cấu hình ít nhất một kênh bên dưới.
            </p>
          </div>

          <div class="form-group">
            <label>Nick Zalo nhận OTP:</label>
            <select id="otp-zalo" class="auth-input"></select>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">
              Lấy từ các cuộc trò chuyện 1-1 hiện có. Cần Zalo đang đăng nhập mới gửi được.
            </p>
          </div>

          <div class="form-group">
            <label>Email nhận OTP:</label>
            <input type="email" id="otp-email" class="auth-input" placeholder="ten@vidu.com" autocomplete="off" />
          </div>

          <hr class="section-divider" />

          <h4>Điều khiển bot qua Zalo</h4>
          <div class="form-group">
            <label>Nick Zalo được ra lệnh cho bot:</label>
            <select id="admin-zalo" class="auth-input"></select>
            <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: 4px 0 0;">
              Nhắn <strong>riêng</strong> cho bot, ví dụ: <em>"nhắn vào nhóm lớp là coach MA đã mở bài test miễn phí, link:…"</em>
              Bot sẽ đọc lại nội dung và hỏi xác nhận, chị gõ <strong>OK</strong> thì mới gửi.
              Lệnh chỉ nhận trong chat riêng — trong nhóm thì không ai sai khiến được bot.
              Vẫn hoạt động cả khi nút gạt đang TẮT.
            </p>
          </div>

          <h4>Máy chủ gửi mail (SMTP)</h4>
          <p class="field-hint" style="color: var(--muted); font-size: 12px; margin: -6px 0 10px;">
            Chỉ cần khi dùng kênh Email.
          </p>
          <div class="smtp-grid">
            <div class="form-group">
              <label>Host:</label>
              <input type="text" id="smtp-host" class="auth-input" placeholder="smtp.gmail.com" autocomplete="off" />
            </div>
            <div class="form-group">
              <label>Port:</label>
              <input type="number" id="smtp-port" class="auth-input" value="587" />
            </div>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="smtp-secure" />
              Dùng SSL/TLS trực tiếp (thường là port 465)
            </label>
          </div>
          <div class="smtp-grid">
            <div class="form-group">
              <label>Tài khoản:</label>
              <input type="text" id="smtp-username" class="auth-input" autocomplete="off" />
            </div>
            <div class="form-group">
              <label>Mật khẩu:</label>
              <input type="password" id="smtp-password" class="auth-input" autocomplete="new-password" />
            </div>
          </div>
          <div class="form-group">
            <label>Gửi từ địa chỉ:</label>
            <input type="text" id="smtp-from" class="auth-input" placeholder="Zalo Web &lt;ten@vidu.com&gt;" autocomplete="off" />
          </div>

          <div class="form-actions" style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
            <span id="otp-settings-status" style="font-size: 14px; flex: 1; min-width: 0;"></span>
            <button type="button" id="btn-smtp-test" class="secondary-button">Kiểm tra SMTP</button>
            <button type="submit" class="primary-button">Lưu</button>
          </div>
        </form>
      `;

      const form = panel.querySelector("#acc-form");
      const current = panel.querySelector("#acc-current");
      const next = panel.querySelector("#acc-new");
      const confirmInput = panel.querySelector("#acc-confirm");
      const status = panel.querySelector("#acc-status");
      const usernameLabel = panel.querySelector("#acc-username");

      fetch("/api/auth/me")
        .then((r) => r.json())
        .then((d) => { usernameLabel.textContent = d.user?.username || "—"; })
        .catch(() => {});

      const formTen = panel.querySelector("#acc-username-form");
      const tenStatus = panel.querySelector("#accu-status");
      formTen.addEventListener("submit", async (e) => {
        e.preventDefault();
        tenStatus.style.color = "var(--muted)";
        tenStatus.textContent = "Đang đổi...";
        try {
          const res = await fetch("/api/auth/change-username", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentPassword: panel.querySelector("#accu-password").value,
              newUsername: panel.querySelector("#accu-new").value.trim(),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Đổi thất bại.");
          tenStatus.style.color = "var(--ok)";
          tenStatus.textContent = `Đã đổi thành "${data.username}". Lần sau đăng nhập bằng tên này.`;
          usernameLabel.textContent = data.username;
          const header = document.querySelector("#account-name");
          if (header) header.textContent = data.username;
          formTen.reset();
        } catch (err) {
          tenStatus.style.color = "var(--danger)";
          tenStatus.textContent = err.message;
        }
      });

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        status.style.color = "var(--muted)";

        if (next.value.length < 6) {
          status.style.color = "var(--danger)";
          status.textContent = "Mật khẩu mới phải từ 6 ký tự.";
          return;
        }
        if (next.value !== confirmInput.value) {
          status.style.color = "var(--danger)";
          status.textContent = "Xác nhận mật khẩu không khớp.";
          return;
        }

        status.textContent = "Đang đổi...";
        try {
          const res = await fetch("/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentPassword: current.value,
              newPassword: next.value,
              confirmPassword: confirmInput.value,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Đổi mật khẩu thất bại.");
          status.style.color = "var(--ok)";
          status.textContent = "Đã đổi mật khẩu.";
          form.reset();
        } catch (err) {
          status.style.color = "var(--danger)";
          status.textContent = err.message;
        }
      });

      // --- Cai dat OTP ---

      const otpForm = panel.querySelector("#otp-settings-form");
      const otpEnabled = panel.querySelector("#otp-enabled");
      const otpZalo = panel.querySelector("#otp-zalo");
      const adminZalo = panel.querySelector("#admin-zalo");
      const otpEmail = panel.querySelector("#otp-email");
      const otpStatus = panel.querySelector("#otp-settings-status");
      const smtp = {
        host: panel.querySelector("#smtp-host"),
        port: panel.querySelector("#smtp-port"),
        secure: panel.querySelector("#smtp-secure"),
        username: panel.querySelector("#smtp-username"),
        password: panel.querySelector("#smtp-password"),
        from: panel.querySelector("#smtp-from"),
      };

      function baoOtp(text, mau) {
        otpStatus.style.color = mau || "var(--muted)";
        otpStatus.textContent = text;
      }

      async function napCaiDatOtp() {
        const generation = settingsOwnerGeneration;
        try {
          const [resSettings, resBootstrap] = await Promise.all([
            fetch("/api/auth/otp-settings"),
            fetch("/api/bootstrap"),
          ]);
          const data = await resSettings.json();
          const boot = await resBootstrap.json();
          if (generation !== settingsOwnerGeneration) return;
          if (!resSettings.ok) throw new Error(data.error || "Không tải được cài đặt Admin");

          // Chi lay chat 1-1, nhom khong dung de nhan OTP
          const contacts = (boot.threads || []).filter((t) => Number(t.threadType) === 0);
          otpZalo.innerHTML = "";
          const none = document.createElement("option");
          none.value = "";
          none.textContent = "— Không dùng kênh Zalo —";
          otpZalo.append(none);
          for (const contact of contacts) {
            const opt = document.createElement("option");
            opt.value = contact.id;
            opt.textContent = contact.title || contact.id;
            otpZalo.append(opt);
          }
          // Nick da luu nhung khong con trong danh sach thi van phai giu lai
          if (data.otpZaloThreadId && !contacts.some((c) => c.id === data.otpZaloThreadId)) {
            const opt = document.createElement("option");
            opt.value = data.otpZaloThreadId;
            opt.textContent = `${data.otpZaloLabel || data.otpZaloThreadId} (không còn trong danh sách)`;
            otpZalo.append(opt);
          }
          otpZalo.value = data.otpZaloThreadId || "";

          // Cung danh sach chat 1-1, nhung la lua chon rieng: nick nhan OTP va
          // nick duoc ra lenh khong nhat thiet la mot.
          adminZalo.innerHTML = "";
          const khong = document.createElement("option");
          khong.value = "";
          khong.textContent = "— Không cho ai ra lệnh —";
          adminZalo.append(khong);
          for (const contact of contacts) {
            const opt = document.createElement("option");
            opt.value = contact.id;
            opt.textContent = contact.title || contact.id;
            adminZalo.append(opt);
          }
          if (data.adminZaloUid && !contacts.some((c) => c.id === data.adminZaloUid)) {
            const opt = document.createElement("option");
            opt.value = data.adminZaloUid;
            opt.textContent = (data.adminZaloLabel || data.adminZaloUid) + " (không còn trong danh sách)";
            adminZalo.append(opt);
          }
          adminZalo.value = data.adminZaloUid || "";

          otpEnabled.checked = Boolean(data.otpEnabled);
          otpEmail.value = data.otpEmail || "";
          smtp.host.value = data.smtp?.host || "";
          smtp.port.value = data.smtp?.port ?? 587;
          smtp.secure.checked = Boolean(data.smtp?.secure);
          smtp.username.value = data.smtp?.username || "";
          smtp.from.value = data.smtp?.fromAddress || "";
          smtp.password.placeholder = data.smtp?.hasPassword ? "(giữ nguyên mật khẩu đã lưu)" : "";
        } catch (e) {
          console.error("Lỗi tải cài đặt OTP", e);
          baoOtp("Không tải được cài đặt OTP.", "var(--danger)");
        }
      }

      invalidateAdminOwnerSink = () => {
        otpEnabled.checked = false;
        otpZalo.innerHTML = "<option value=''>— Chưa tải hồ sơ hiện tại —</option>";
        adminZalo.innerHTML = "<option value=''>— Chưa tải hồ sơ hiện tại —</option>";
        otpEmail.value = "";
        baoOtp("Đang tải hồ sơ Zalo hiện tại…");
      };

      otpForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (otpEnabled.checked && !otpZalo.value && !otpEmail.value.trim()) {
          baoOtp("Bật OTP thì phải chọn nick Zalo hoặc nhập email.", "var(--danger)");
          return;
        }
        baoOtp("Đang lưu...");
        try {
          const res = await fetch("/api/auth/otp-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              otpEnabled: otpEnabled.checked,
              otpZaloThreadId: otpZalo.value,
              otpZaloLabel: otpZalo.selectedOptions[0]?.textContent || "",
              otpEmail: otpEmail.value.trim(),
              adminZaloUid: adminZalo.value,
              adminZaloLabel: adminZalo.selectedOptions[0]?.textContent || "",
              smtp: {
                host: smtp.host.value.trim(),
                port: Number(smtp.port.value) || 587,
                secure: smtp.secure.checked,
                username: smtp.username.value.trim(),
                password: smtp.password.value,
                fromAddress: smtp.from.value.trim(),
              },
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Lưu thất bại.");
          smtp.password.value = "";
          baoOtp(otpEnabled.checked ? "Đã lưu · OTP đang BẬT" : "Đã lưu · OTP đang TẮT", "var(--ok)");
          window.dispatchEvent(new CustomEvent("zalo:canonical-save", {
            detail: { section: "admin", adminUid: adminZalo.value },
          }));
          await napCaiDatOtp();
        } catch (err) {
          baoOtp(err.message, "var(--danger)");
        }
      });

      panel.querySelector("#btn-smtp-test").addEventListener("click", async () => {
        baoOtp("Đang kiểm tra kết nối SMTP...");
        try {
          const res = await fetch("/api/auth/smtp-test", { method: "POST" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Không kết nối được.");
          baoOtp("Kết nối SMTP thành công.", "var(--ok)");
        } catch (err) {
          baoOtp("SMTP lỗi: " + err.message, "var(--danger)");
        }
      });

      // Nick OTP/Admin lay tu danh sach hoi thoai da gan tai khoan -> phai nap lai.
      dangKyLamMoi("tai khoan (OTP/Admin)", napCaiDatOtp);
      napCaiDatOtp();
    }
  },
  {
    id: "pdf-automation",
    label: "Tự động gửi tài liệu",
    mount(panel) {
      panel.innerHTML = `
        <div style="margin-bottom:16px; color:var(--muted); font-size:14px;">
          Khi tin khách chứa từ khóa, bot hỏi xác nhận. Chỉ khi chính người đó trả lời đúng <strong>OK</strong>, bot mới gửi PDF.
        </div>
        <form id="pdf-automation-form" class="rule-form">
          <input type="hidden" id="pdf-rule-id" />
          <div class="form-group">
            <label for="pdf-keyword">Tên tài liệu / từ khóa</label>
            <input type="text" id="pdf-keyword" required autocomplete="off" placeholder="Ví dụ: template" />
          </div>
          <div class="form-group">
            <label for="pdf-file">File PDF</label>
            <input type="file" id="pdf-file" accept=".pdf,application/pdf" />
            <div id="pdf-current-file" class="field-hint" style="font-size:12px; margin-top:5px;"></div>
          </div>
          <label class="checkbox-label" style="margin-bottom:12px;">
            <input type="checkbox" id="pdf-enabled" checked />
            Bật rule này
          </label>
          <div class="form-actions">
            <span id="pdf-status" style="color:var(--muted); font-size:13px; flex:1;"></span>
            <button type="button" id="pdf-cancel" class="secondary-button hidden">Huỷ sửa</button>
            <button type="submit" class="primary-button">Lưu</button>
          </div>
        </form>
        <div class="rule-list-header" style="margin-top:20px;">
          <h3>Tài liệu đã cấu hình</h3>
        </div>
        <div id="pdf-rule-list" class="rule-list"></div>
      `;

      const pdfForm = panel.querySelector("#pdf-automation-form");
      const pdfRuleId = panel.querySelector("#pdf-rule-id");
      const pdfKeyword = panel.querySelector("#pdf-keyword");
      const pdfFile = panel.querySelector("#pdf-file");
      const pdfEnabled = panel.querySelector("#pdf-enabled");
      const pdfCurrentFile = panel.querySelector("#pdf-current-file");
      const pdfStatus = panel.querySelector("#pdf-status");
      const pdfCancel = panel.querySelector("#pdf-cancel");
      const pdfRuleList = panel.querySelector("#pdf-rule-list");
      let pdfRules = [];

      function showPdfStatus(text, color = "var(--muted)") {
        pdfStatus.style.color = color;
        pdfStatus.textContent = text;
      }

      function resetPdfForm() {
        pdfForm.reset();
        pdfRuleId.value = "";
        pdfEnabled.checked = true;
        pdfCurrentFile.textContent = "Chọn một file PDF, tối đa 10 MB.";
        pdfCancel.classList.add("hidden");
      }

      function editPdfRule(rule, { chooseFile = false } = {}) {
        pdfRuleId.value = rule.id;
        pdfKeyword.value = rule.keyword;
        pdfFile.value = "";
        pdfEnabled.checked = Boolean(rule.enabled);
        pdfCurrentFile.textContent = `Đang dùng: ${rule.pdfName} · ${(rule.pdfSize / 1024).toFixed(rule.pdfSize >= 1024 * 1024 ? 0 : 1)} KB. Để trống nếu giữ file này.`;
        pdfCancel.classList.remove("hidden");
        pdfKeyword.focus();
        if (chooseFile) pdfFile.click();
      }

      function renderPdfRules() {
        pdfRuleList.innerHTML = "";
        if (!pdfRules.length) {
          pdfRuleList.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Chưa có tài liệu tự động nào.</div>";
          return;
        }

        for (const rule of pdfRules) {
          const item = document.createElement("div");
          item.className = "rule-item";
          const info = document.createElement("div");
          info.className = "rule-info";
          const keyword = document.createElement("div");
          keyword.className = "rule-cmd";
          keyword.textContent = rule.keyword;
          const file = document.createElement("div");
          file.className = "rule-reply-preview";
          file.textContent = `${rule.pdfName} · ${Math.max(1, Math.round(rule.pdfSize / 1024))} KB`;
          const state = document.createElement("div");
          state.className = "rule-meta";
          state.textContent = rule.enabled ? "Đang bật" : "Đang tắt";
          info.append(keyword, file, state);

          const actions = document.createElement("div");
          actions.className = "rule-actions";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "secondary-button";
          toggle.textContent = rule.enabled ? "Tắt" : "Bật";
          toggle.onclick = async () => {
            const owner = chupSettingsOwner();
            const body = new FormData();
            body.append("enabled", rule.enabled ? "false" : "true");
            const res = await fetch(`/api/pdf-automation-rules/${rule.id}`, { method: "PUT", body });
            const data = await res.json();
            if (!settingsOwnerConHieuLuc(owner)) return;
            if (!res.ok) return showPdfStatus(data.error || "Không đổi được trạng thái.", "var(--danger)");
            await loadPdfRules(owner.ownerGeneration);
          };

          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "secondary-button";
          edit.textContent = "Sửa từ khóa";
          edit.onclick = () => editPdfRule(rule);

          const replace = document.createElement("button");
          replace.type = "button";
          replace.className = "secondary-button";
          replace.textContent = "Đổi PDF";
          replace.onclick = () => editPdfRule(rule, { chooseFile: true });

          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "secondary-button";
          remove.textContent = "Xoá";
          remove.onclick = async () => {
            if (!confirm(`Xoá rule "${rule.keyword}" và PDF đi kèm?`)) return;
            const owner = chupSettingsOwner();
            const res = await fetch(`/api/pdf-automation-rules/${rule.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!settingsOwnerConHieuLuc(owner)) return;
            if (!res.ok) return showPdfStatus(data.error || "Không xoá được rule PDF.", "var(--danger)");
            resetPdfForm();
            await loadPdfRules(owner.ownerGeneration);
          };

          actions.append(toggle, edit, replace, remove);
          item.append(info, actions);
          pdfRuleList.append(item);
        }
      }

      async function loadPdfRules(generation = settingsOwnerGeneration) {
        pdfRuleList.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Đang tải…</div>";
        try {
          const res = await fetch("/api/pdf-automation-rules");
          const data = await res.json();
          if (generation !== settingsOwnerGeneration) return;
          if (!res.ok) throw new Error(data.error || "Không tải được tài liệu.");
          pdfRules = data.rules || [];
          renderPdfRules();
        } catch (error) {
          if (generation !== settingsOwnerGeneration) return;
          pdfRules = [];
          pdfRuleList.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Không tải được danh sách tài liệu.</div>";
          showPdfStatus(error.message, "var(--danger)");
        }
      }

      pdfFile.addEventListener("change", () => {
        const file = pdfFile.files?.[0];
        if (!file) return;
        if (!pdfRuleId.value) pdfKeyword.value = file.name.replace(/\.pdf$/i, "");
        pdfCurrentFile.textContent = `Đã chọn: ${file.name}`;
      });

      pdfCancel.addEventListener("click", () => {
        resetPdfForm();
        showPdfStatus("");
      });

      pdfForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const id = pdfRuleId.value;
        const file = pdfFile.files?.[0];
        if (!id && !file) return showPdfStatus("Hãy chọn file PDF.", "var(--danger)");
        const owner = chupSettingsOwner();
        const body = new FormData();
        body.append("keyword", pdfKeyword.value.trim());
        body.append("enabled", pdfEnabled.checked ? "true" : "false");
        if (file) body.append("file", file);
        showPdfStatus("Đang lưu…");
        try {
          const res = await fetch(id ? `/api/pdf-automation-rules/${id}` : "/api/pdf-automation-rules", {
            method: id ? "PUT" : "POST",
            body,
          });
          const data = await res.json();
          if (!settingsOwnerConHieuLuc(owner)) return;
          if (!res.ok) throw new Error(data.error || "Không lưu được rule PDF.");
          resetPdfForm();
          showPdfStatus("Đã lưu.", "var(--ok)");
          await loadPdfRules(owner.ownerGeneration);
        } catch (error) {
          if (settingsOwnerConHieuLuc(owner)) showPdfStatus(error.message, "var(--danger)");
        }
      });

      invalidatePdfAutomationOwnerSink = () => {
        pdfRules = [];
        pdfRuleList.innerHTML = "";
        resetPdfForm();
        showPdfStatus("Đang tải tài liệu của tài khoản Zalo hiện tại…");
      };
      dangKyLamMoi("Tự động gửi tài liệu", loadPdfRules);
      resetPdfForm();
      loadPdfRules();
    }
  }
];
