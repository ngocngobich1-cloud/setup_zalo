import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-register.js");
const REGISTER_URL = pathToFileURL(REGISTER).href;

function pass(id, name) {
  console.log(`${id} = PASS — ${name}`);
}

async function worker() {
const { deriveWebsiteCustomerKey } = await import(pathToFileURL(path.join(REPO, "lib", "website-identity.js")).href);
const {
  capHinhGoiMang,
  capHinhKhoBiMat,
  capHinhTraDiaChi,
  fetchWebsiteCustomers,
  fetchWebsiteCustomersRaw,
  testWebsiteConnection,
  validateWebsiteResponse,
} = await import(pathToFileURL(path.join(REPO, "lib", "website.js")).href);

const email = deriveWebsiteCustomerKey({ email: "person@example.com", phone: "0901234567" });
assert.match(email.customerKey, /^legacy_email:[a-f0-9]{64}$/);
assert.equal(email.identityKind, "email");
pass("ID1", "valid email wins even when phone exists");

const phone = deriveWebsiteCustomerKey({ phone: "0901234567" });
assert.match(phone.customerKey, /^legacy_phone:[a-f0-9]{64}$/);
pass("ID2", "valid phone is the fallback identity");

assert.equal(
  deriveWebsiteCustomerKey({ email: " Person@Example.COM " }).customerKey,
  deriveWebsiteCustomerKey({ email: "person@example.com" }).customerKey
);
pass("ID3", "email case and surrounding spaces normalize to one key");

const phoneForms = ["0901234567", "+84901234567", "84901234567", "090 123-4567"];
assert.equal(new Set(phoneForms.map((value) => deriveWebsiteCustomerKey({ phone: value }).customerKey)).size, 1);
pass("ID4", "equivalent phone forms normalize to one key");

assert.equal(deriveWebsiteCustomerKey({ email: null, phone: "12345" }).reason, "NO_IDENTITY");
pass("ID5", "invalid phone without email has no identity");

assert.equal(deriveWebsiteCustomerKey({ email: "khongco", phone: "0901234567" }).identityKind, "phone");
pass("ID6", "junk email falls back to a valid phone");

assert.ok(!email.customerKey.includes("person@example.com"));
assert.ok(!phone.customerKey.includes("84901234567"));
pass("ID7", "identity keys contain no raw email or phone");

assert.equal(
  deriveWebsiteCustomerKey({ email: "same@example.com", name: "A", result_id: "one" }).customerKey,
  deriveWebsiteCustomerKey({ email: "same@example.com", name: "B", result_id: "two" }).customerKey
);
pass("ID8", "name and result_id do not participate in identity");

const secrets = new Map([
  ["website_connection_name", "Fixture"],
  ["website_api_url", "https://example.com/customer-snapshot"],
  ["website_api_token", "secret-test-token"],
  ["website_connection_verified", "1"],
]);
capHinhKhoBiMat({ get: (key) => secrets.get(key), set: (key, value) => secrets.set(key, value) });
capHinhTraDiaChi(async () => [{ address: "8.8.8.8", family: 4 }]);
capHinhGoiMang(async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ customers: [
    { ten: "Phone only", phone: "0901234567" },
    { ten: "Legacy preview", phone: "0907654321", email: " Preview@Example.com ", extra: "kept only raw" },
  ] }),
}));
const raw = await fetchWebsiteCustomersRaw();
assert.equal(raw.customers.length, 2);
assert.equal(raw.customers[0].ten, "Phone only");
assert.equal(raw.customers[0].email, undefined);
pass("SY1", "phone-only row survives the full raw fetch path");

const legacyValidated = validateWebsiteResponse({ customers: raw.customers });
assert.deepEqual(legacyValidated.customers, [{ phone: "0907654321", email: "preview@example.com" }]);
assert.equal(legacyValidated.skipped, 1);
assert.deepEqual(await fetchWebsiteCustomers(), legacyValidated);
const connection = await testWebsiteConnection();
assert.equal(connection.customerCount, 1);
assert.equal(connection.skipped, 1);
pass("WR1", "legacy validator, preview fetch and connection test preserve their contract");

capHinhGoiMang(null);
capHinhTraDiaChi(null);
capHinhKhoBiMat(null);
console.log("RAW_FETCH_USES_VALIDATE_WEBSITE_RESPONSE = NO");
console.log("PHONE_ONLY_ROW_SURVIVES_RAW_FETCH = YES");
console.log("WEBSITE_EXISTING_BEHAVIOR_PRESERVED = YES");
console.log("ID1_ID8_SY1 = PASS");
}

if (process.argv[2] === "--worker") {
  await worker();
} else {
  const child = spawnSync(process.execPath, [...process.execArgv, "--import", REGISTER_URL, THIS_FILE, "--worker"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env },
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
