/**
 * Chan ruot gan cua bot lot ra ngoai cho khach doc.
 *
 * Da xay ra that trong nhom Admin AI ngay 08/08/2026:
 *    [tool_call: glob for pattern '**\/*BRIEF_ke-hoach-truyen-thong...']
 *    [tool_call: bash for 'ls -F']
 * Khach nhin thay may dong nay thi biet ngay dang noi chuyen voi may, chua ke
 * lo ca duong dan tep trong may chu shop.
 */

/** Mot DONG chi chua dau hieu noi bo -> bo ca dong. */
const DAU_RUOT_GAN = /^\s*\[(?:tool_call|tool_result|tool_use|thinking|system|function_call)\b[^\]]*\]?\s*$/i;

/**
 * @returns {{sach: string, daCat: boolean, soDongCat: number}}
 */
export function locRuotGan(text) {
  const goc = String(text ?? "");
  if (!goc.includes("[")) return { sach: goc, daCat: false, soDongCat: 0 };

  const dong = goc.split("\n");
  const giu = dong.filter((d) => !DAU_RUOT_GAN.test(d));
  const soDongCat = dong.length - giu.length;
  if (!soDongCat) return { sach: goc, daCat: false, soDongCat: 0 };

  return { sach: giu.join("\n").trim(), daCat: true, soDongCat };
}
