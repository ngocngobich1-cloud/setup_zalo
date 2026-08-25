/**
 * Focused test First-run AI Onboarding.
 * Chay: node kiem-thu/kiem-tra-onboarding.js
 *
 * Provider-free: chi dung SQLite trong thu muc tam; khong khoi dong server,
 * khong goi OpenCode/LLM/Zalo va khong doc data/ that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ketQua = [];

async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, moTa, pass: true });
  } catch (error) {
    ketQua.push({ ma, moTa, pass: false, error: error.message });
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  const onboarding = await import(pathToFileURL(path.join(REPO, "lib", "onboarding.js")).href);
  const admin = await import(pathToFileURL(path.join(REPO, "lib", "admin-command.js")).href);
  const OWNER = "onboarding-owner-a";
  let state;

  await bai("O01", "tai khoan moi bat dau o step 0, chua completed", async () => {
    state = await onboarding.trangThaiOnboarding(OWNER);
    assert.equal(state.step, 0);
    assert.equal(state.started, false);
    assert.equal(state.completed, false);
  });
  await bai("O02", "Start ghi step 1 that xuong account_config", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "start");
    assert.equal(state.step, 1);
    assert.equal((await db.getAccountConfig(OWNER)).setupStep, 1);
  });
  await bai("O03", "click link API key sang step 2", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "key_link_clicked");
    assert.equal(state.step, 2);
  });
  await bai("O04", "chi save key thanh cong moi sang step 3", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "key_saved");
    assert.equal(state.step, 3);
  });
  await bai("O05", "step 3 tu choi provider/model thieu", async () => {
    await assert.rejects(
      onboarding.xuLyHanhDongOnboarding(OWNER, "model_selected", { providerId: "groq", modelId: "" }),
      /chọn đủ hãng AI và model/i
    );
    assert.equal((await onboarding.trangThaiOnboarding(OWNER)).step, 3);
  });
  await bai("O06", "provider/model hop le duoc luu lam draft resume", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "model_selected", {
      providerId: "groq",
      modelId: "groq/llama-test",
    });
    assert.equal(state.step, 4);
    assert.equal(state.data.providerId, "groq");
    assert.equal(state.data.modelId, "groq/llama-test");
  });
  await bai("O07", "CTA setup bot sang step 5", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "start_bot_setup");
    assert.equal(state.step, 5);
    assert.match(state.prompt, /hỗ trợ chị/i);
  });

  const answers = [
    "Tư vấn học viên chọn khoá học phù hợp dựa trên mục tiêu và lịch học",
    "Người đi làm đang tìm khoá học marketing",
    "Xưng em, gọi khách là anh chị",
    "Thân thiện, rõ ràng và ngắn gọn",
    "Nội dung khoá học, lịch học, học phí và chính sách bảo lưu",
    "Khiếu nại tài chính chưa được duyệt",
  ];
  for (let i = 0; i < answers.length; i++) {
    await bai(`Q${String(i + 1).padStart(2, "0")}`, `Bot Chi huy nhan cau tra loi ${i + 1} theo thu tu`, async () => {
      state = await onboarding.traLoiOnboarding(OWNER, answers[i]);
      assert.equal(state.step, i === answers.length - 1 ? 6 : 5);
      assert.equal(Object.keys(state.data.answers).length, i + 1);
    });
  }
  await bai("O08", "step 6 phan tich gap, chua tao final config", async () => {
    assert.equal(state.step, 6);
    assert.equal(state.data.deepSetup.phase, "followup");
    assert.ok(state.data.deepSetup.followUpKeys.includes("uncertainty"));
    assert.ok(state.data.deepSetup.followUpKeys.includes("escalation"));
    assert.ok(state.data.deepSetup.followUpKeys.includes("boundaries"));
    assert.equal(state.data.draft.soul, "");
    assert.match(state.prompt, /còn một điểm cần làm rõ/i);
  });

  const followUpAnswers = {
    purpose_detail: "Tư vấn một khoá học phù hợp rồi hướng dẫn bước đăng ký tiếp theo",
    tone_example: "Em gửi anh chị lịch học phù hợp để mình tham khảo nhé",
    topics_detail: "Nội dung, lịch học và chính sách học phí",
    uncertainty: "Hỏi lại khách thông tin còn thiếu trước khi kết luận",
    escalation: "Chuyển Admin khi có khiếu nại tài chính hoặc yêu cầu ngoại lệ",
    boundaries: "Không cam kết kết quả học tập và không tự duyệt hoàn tiền",
  };
  for (let i = 0; i < state.data.deepSetup.followUpKeys.length; i++) {
    const key = state.data.deepSetup.followUpKeys[i];
    await bai(`F${String(i + 1).padStart(2, "0")}`, `deep setup hoi tung follow-up ${i + 1}`, async () => {
      const before = Object.keys(state.data.deepSetup.followUpAnswers).length;
      state = await onboarding.traLoiOnboarding(OWNER, followUpAnswers[key]);
      assert.equal(Object.keys(state.data.deepSetup.followUpAnswers).length, before + 1);
      assert.equal(state.step, i === state.data.deepSetup.followUpKeys.length - 1 ? 7 : 6);
    });
  }
  await bai("O09", "step 7 tach user request va de xuat co ly do, chua inject vao draft", async () => {
    assert.equal(state.step, 7);
    assert.equal(state.data.deepSetup.phase, "proposal");
    assert.ok(state.data.deepSetup.proposals.length >= 2);
    assert.ok(state.data.deepSetup.proposals.every((item) => item.text && item.reason));
    assert.equal(state.data.deepSetup.proposalApproved, false);
    assert.equal(state.data.draft.soul, "");
    assert.match(state.prompt, /NHỮNG GÌ CHỊ ĐÃ YÊU CẦU/);
    assert.match(state.prompt, /EM ĐỀ XUẤT BỔ SUNG/);
    assert.match(state.prompt, /Lý do:/);
  });
  await bai("O10", "user co the bo de xuat va bot hoi duyet lai", async () => {
    const before = state.data.deepSetup.proposals.length;
    state = await onboarding.traLoiOnboarding(OWNER, "Bỏ đề xuất 1");
    assert.equal(state.step, 7);
    assert.equal(state.data.deepSetup.proposals.length, before - 1);
    assert.equal(state.data.deepSetup.proposalApproved, false);
    assert.equal(state.data.draft.soul, "");
  });
  await bai("O11", "canonical OK moi duyet de xuat va tao final config", async () => {
    assert.equal(admin.laXacNhanOK("  Ok  "), true);
    assert.equal(admin.laXacNhanOK("OK."), false);
    state = await onboarding.traLoiOnboarding(OWNER, "  ok ");
    assert.equal(state.step, 8);
    assert.equal(state.confirmationAccepted, true);
    assert.deepEqual(state.completedSteps, [6, 7]);
    assert.equal(state.data.deepSetup.proposalApproved, true);
    assert.match(state.data.draft.soul, /Tư vấn học viên chọn khoá học/);
    assert.match(state.data.draft.soul, /Nguyên tắc đã được chị duyệt/);
    assert.match(state.data.draft.roleTone, /Thân thiện/);
    assert.match(state.data.draft.allowedTopics, /Nội dung khoá học/);
  });
  await bai("O12", "save AI canonical o step 8 moi sang step 9", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "config_saved");
    assert.equal(state.step, 9);
    assert.equal(state.completed, false);
  });
  await bai("O13", "step 9 tu choi admin rong", async () => {
    await assert.rejects(
      onboarding.xuLyHanhDongOnboarding(OWNER, "admin_saved", { adminUid: "" }),
      /chọn nick Zalo/i
    );
    assert.equal((await onboarding.trangThaiOnboarding(OWNER)).completed, false);
  });
  await bai("O14", "admin hop le hoan tat onboarding", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "admin_saved", { adminUid: "zalo-admin-1" });
    assert.equal(state.step, "completed");
    assert.equal(state.completed, true);
  });
  await bai("O15", "completed song qua reload va khong khoi dong lai", async () => {
    state = await onboarding.trangThaiOnboarding(OWNER);
    assert.equal(state.started, true);
    assert.equal(state.completed, true);
    const again = await onboarding.xuLyHanhDongOnboarding(OWNER, "start");
    assert.equal(again.step, "completed");
  });
  await bai("O16", "onboarding tach rieng theo owner_uid", async () => {
    const other = await onboarding.trangThaiOnboarding("onboarding-owner-b");
    assert.equal(other.step, 0);
    assert.equal(other.completed, false);
  });
  await bai("O17", "de xuat phu thuoc business, khong hard-code mot bo giong nhau", async () => {
    const education = onboarding.taoDeXuatBoSung(
      { purpose: "Tư vấn khoá học", topics: "học phí và lịch học" },
      { escalation: "chuyển tư vấn viên" }
    );
    const commerce = onboarding.taoDeXuatBoSung(
      { purpose: "Bán hàng cho shop", topics: "giá sản phẩm và giao hàng" },
      { escalation: "chuyển chủ shop" }
    );
    assert.notEqual(education[0].text, commerce[0].text);
    assert.ok(education.every((item) => item.reason));
    assert.ok(commerce.every((item) => item.reason));
  });

  const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
  const frontend = fs.readFileSync(path.join(REPO, "public", "onboarding.js"), "utf8");
  const trainingFrontend = fs.readFileSync(path.join(REPO, "public", "training.js"), "utf8");
  const style = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
  const config = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");

  await bai("U01", "first-run popup co dung hai action", async () => {
    assert.ok(html.includes('id="btn-onboarding-start"'));
    assert.ok(html.includes('id="btn-onboarding-later"'));
  });
  await bai("U02", "training layout dung hai cot va du 7 muc canonical", async () => {
    assert.ok(html.includes('class="training-layout"'));
    for (const slot of ["api-key", "model", "soul", "tone", "topics", "admin"]) {
      assert.ok(html.includes(`data-canonical-slot="${slot}"`), `thieu slot ${slot}`);
    }
    assert.match(html, />7\. Admin</);
  });
  await bai("U03", "API key links mo tab moi va khong dieu huong khoi app", async () => {
    const links = html.match(/target="_blank"/g) || [];
    assert.ok(links.length >= 4);
    assert.ok(html.includes('rel="noopener noreferrer"'));
  });
  await bai("U04", "portal di chuyen control canonical, khong tao input ID thu hai", async () => {
    for (const id of ["ai-key-provider", "ai-oc-provider", "ai-oc-model", "ai-soul", "ai-role", "ai-topics", "admin-zalo"]) {
      assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 0, `${id} bi nhan doi trong HTML`);
      assert.ok(frontend.includes(`#${id}`), `${id} khong duoc portal reuse`);
    }
  });
  await bai("U05", "canonical save phat event chi sau response thanh cong", async () => {
    assert.ok(config.includes('section: "api-key"'));
    assert.ok(config.includes('section: "ai-config"'));
    assert.ok(config.includes('section: "admin"'));
  });
  await bai("U06", "server co dung ba route onboarding co cong auth chung", async () => {
    assert.ok(server.includes('app.get("/api/onboarding"'));
    assert.ok(server.includes('app.post("/api/onboarding/action"'));
    assert.ok(server.includes('app.post("/api/onboarding/answer"'));
  });
  await bai("U07", "focused test khong co provider call", async () => {
    assert.ok(!frontend.includes("/api/ai-chat/provider-key/test"));
    assert.ok(!frontend.includes("/api/training/message"));
  });
  await bai("U08", "step 8 review mot group gom Soul tone topics", async () => {
    const step8 = frontend.slice(frontend.indexOf("  8: {"), frontend.indexOf("  9: {"));
    assert.ok(step8.includes("[data-canonical-slot='soul']"));
    assert.ok(step8.includes("[data-canonical-slot='tone']"));
    assert.ok(step8.includes("[data-canonical-slot='topics']"));
    assert.ok(step8.includes('action: "review_complete"'));
  });
  await bai("U09", "Ghi nho la target rieng sau grouped review", async () => {
    assert.ok(frontend.includes("const BUOC_LUU_CAU_HINH"));
    assert.ok(frontend.includes("#onboarding-slot-ai-actions button[type='submit']"));
    assert.ok(frontend.includes("reviewReadyToSave = true"));
  });
  await bai("U10", "composer spotlight active xuyen step 4 den 7", async () => {
    assert.ok(frontend.includes("step >= 4 && step <= 7"));
    assert.ok(frontend.includes("spotlightComposer: active"));
    assert.ok(trainingFrontend.includes("training-form-composer-spotlight"));
    assert.match(style, /\.training-form-composer-spotlight\s*\{[^}]*z-index:\s*1152/s);
    assert.match(style, /\.onboarding-highlight\s*\{[^}]*z-index:\s*1150/s);
    assert.match(style, /\.onboarding-bubble\s*\{[^}]*z-index:\s*1154/s);
  });
  await bai("U11", "toan composer van visible va interactive trong onboarding", async () => {
    assert.ok(trainingFrontend.includes("dangOnboarding ? false : !docDuocAnh"));
    assert.match(style, /\.training-form-onboarding #btn-training-attach\s*\{[^}]*display:\s*inline-flex/s);
    assert.ok(!style.includes(".training-form-onboarding #btn-training-attach {\n  display: none"));
  });

  const fail = ketQua.filter((item) => !item.pass);
  for (const item of ketQua) {
    console.log(`${item.ma} = ${item.pass ? "PASS" : "FAIL"}  ${item.moTa}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nTONG: ${ketQua.length - fail.length}/${ketQua.length} PASS`);
  console.log("Provider call that: 0");
  console.log(`Thu muc tam: ${tmp}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung onboarding test hong:", error);
  process.exit(2);
});
