import { getAdminZalo } from "./db.js";

/**
 * Canonical private-Admin route. The recipient always comes from getAdminZalo;
 * callers only provide the existing outbound primitive and captured authority.
 */
export async function sendAdminNotification({
  ownerUid,
  text,
  send,
  admin: resolvedAdmin = null,
  originToken = null,
  sendOptions = undefined,
}) {
  const admin = resolvedAdmin || await getAdminZalo(ownerUid);
  if (!admin?.uid) return { sent: false, reason: "ADMIN_NOT_CONFIGURED", message: null };
  const message = await send({
    threadId: String(admin.uid),
    threadType: 0,
    text: String(text || ""),
    ...(originToken ? { originToken } : {}),
  }, sendOptions);
  if (!message) return { sent: false, reason: "SEND_NOT_CONFIRMED", message: null };
  return { sent: true, reason: null, message };
}
