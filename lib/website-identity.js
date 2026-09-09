import crypto from "node:crypto";
import { normalizeEmail, normalizePhone } from "./website-data.js";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeIdentityEmail(value) {
  const normalized = normalizeEmail(value);
  return normalized && EMAIL_SHAPE.test(normalized) ? normalized : null;
}

function hashedKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${prefix}:${digest}`;
}

export function deriveWebsiteCustomerKey({ email, phone } = {}) {
  const emailNormalized = normalizeIdentityEmail(email);
  if (emailNormalized) {
    return {
      customerKey: hashedKey("legacy_email", emailNormalized),
      identityKind: "email",
      emailNormalized,
      phoneNormalized: normalizePhone(phone),
    };
  }

  const phoneNormalized = normalizePhone(phone);
  if (phoneNormalized) {
    return {
      customerKey: hashedKey("legacy_phone", phoneNormalized),
      identityKind: "phone",
      emailNormalized: null,
      phoneNormalized,
    };
  }

  return {
    customerKey: null,
    identityKind: null,
    emailNormalized: null,
    phoneNormalized: null,
    reason: "NO_IDENTITY",
  };
}
