/**
 * SEARCH AUTOFILL SEMANTIC HARDENING V1 focused DOM contract.
 *
 * This is DOM semantic regression evidence. It does not prove deterministic
 * browser or password-manager runtime behavior; real-browser UAT remains
 * required.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const document = new JSDOM(html).window.document;
const results = [];

function test(id, name, fn) {
  try {
    fn();
    results.push({ id, pass: true });
    console.log(`PASS ${id} ${name}`);
  } catch (error) {
    results.push({ id, pass: false });
    console.log(`FAIL ${id} ${name}\n  ${error.stack || error.message}`);
  }
}

const threadSearch = document.querySelector("#thread-search");
const forwardSearch = document.querySelector("#forward-search");

test("T1", "#thread-search exists and preserves its DOM placement", () => {
  assert.ok(threadSearch);
  assert.equal(threadSearch.getAttribute("placeholder"), "Tìm kiếm");
  assert.ok(threadSearch.parentElement?.classList.contains("thread-search-wrap"));
  assert.ok(threadSearch.parentElement?.parentElement?.classList.contains("thread-list"));
  assert.equal(threadSearch.previousElementSibling?.tagName, "svg");
  assert.equal(threadSearch.parentElement?.nextElementSibling?.id, "threads");
});
test("T2", "#thread-search tagName is INPUT", () => {
  assert.equal(threadSearch.tagName, "INPUT");
});
test("T3", "#thread-search has explicit search type", () => {
  assert.equal(threadSearch.getAttribute("type"), "search");
  assert.equal(threadSearch.type, "search");
});
test("T4", "#thread-search has non-credential name", () => {
  assert.equal(threadSearch.getAttribute("name"), "conversation-search");
});
test("T5", "#thread-search disables autocomplete", () => {
  assert.equal(threadSearch.getAttribute("autocomplete"), "off");
});
test("T6", "#thread-search disables autocapitalize", () => {
  assert.equal(threadSearch.getAttribute("autocapitalize"), "none");
});
test("T7", "#thread-search has exact spellcheck=false attribute", () => {
  assert.equal(threadSearch.getAttribute("spellcheck"), "false");
});
test("T8", "#thread-search uses search inputmode", () => {
  assert.equal(threadSearch.getAttribute("inputmode"), "search");
});
test("T9", "#thread-search has an exact accessible label", () => {
  assert.equal(threadSearch.getAttribute("aria-label"), "Tìm kiếm hội thoại");
});
test("T10", "#thread-search has no value attribute", () => {
  assert.equal(threadSearch.hasAttribute("value"), false);
});
test("T11", "#thread-search has no form owner", () => {
  assert.equal(threadSearch.form, null);
});

test("T12", "#forward-search exists and preserves its DOM placement", () => {
  assert.ok(forwardSearch);
  assert.equal(forwardSearch.getAttribute("placeholder"), "Tìm cuộc trò chuyện…");
  assert.ok(forwardSearch.parentElement?.classList.contains("forward-panel"));
  assert.ok(forwardSearch.previousElementSibling?.classList.contains("forward-header"));
  assert.equal(forwardSearch.nextElementSibling?.id, "forward-list");
});
test("T13", "#forward-search tagName is INPUT", () => {
  assert.equal(forwardSearch.tagName, "INPUT");
});
test("T14", "#forward-search has explicit search type", () => {
  assert.equal(forwardSearch.getAttribute("type"), "search");
  assert.equal(forwardSearch.type, "search");
});
test("T15", "#forward-search has non-credential name", () => {
  assert.equal(forwardSearch.getAttribute("name"), "forward-conversation-search");
});
test("T16", "#forward-search disables autocomplete", () => {
  assert.equal(forwardSearch.getAttribute("autocomplete"), "off");
});
test("T17", "#forward-search disables autocapitalize", () => {
  assert.equal(forwardSearch.getAttribute("autocapitalize"), "none");
});
test("T18", "#forward-search has exact spellcheck=false attribute", () => {
  assert.equal(forwardSearch.getAttribute("spellcheck"), "false");
});
test("T19", "#forward-search uses search inputmode", () => {
  assert.equal(forwardSearch.getAttribute("inputmode"), "search");
});
test("T20", "#forward-search has a meaningful accessible label", () => {
  assert.equal(forwardSearch.getAttribute("aria-label"), "Tìm kiếm hội thoại để chuyển tiếp");
});
test("T21", "#forward-search has no value attribute", () => {
  assert.equal(forwardSearch.hasAttribute("value"), false);
});
test("T22", "#forward-search has no form owner", () => {
  assert.equal(forwardSearch.form, null);
});

test("T23", "#thread-search ID is unique", () => {
  assert.equal(document.querySelectorAll("#thread-search").length, 1);
});
test("T24", "#forward-search ID is unique", () => {
  assert.equal(document.querySelectorAll("#forward-search").length, 1);
});
test("T25", "search fields use no credential autocomplete token", () => {
  const credentialTokens = new Set(["username", "email", "current-password", "new-password"]);
  for (const element of [threadSearch, forwardSearch]) {
    const tokens = String(element.getAttribute("autocomplete") || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    assert.equal(tokens.some((token) => credentialTokens.has(token)), false, element.id);
  }
});
test("T26", "#thread-search preserves class thread-search", () => {
  assert.equal(threadSearch.classList.contains("thread-search"), true);
});
test("T27", "#forward-search preserves class forward-search", () => {
  assert.equal(forwardSearch.classList.contains("forward-search"), true);
});

const failed = results.filter((result) => !result.pass);
console.log(`\nSEARCH AUTOFILL SEMANTICS: ${results.length - failed.length}/${results.length} PASS`);
console.log("DOM semantic regression evidence only; browser/password-manager UAT is still required.");
if (failed.length) process.exitCode = 1;
