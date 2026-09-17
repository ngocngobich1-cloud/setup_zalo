/**
 * Dieu phoi mot lane AI cho moi owner + thread.
 *
 * Module nay khong biet DB, OpenCode hay Zalo. Runner nhan work theo thu tu
 * arrival va mot generation token de chot customer outbound tai bien provider.
 */

function khoaHoiThoai(ownerUid, threadId) {
  return `${String(ownerUid)}\u0000${String(threadId)}`;
}

function senderCua(tin) {
  return String(tin?.senderId ?? "");
}

function idCua(tin) {
  if (tin?.id === null || tin?.id === undefined) return null;
  return String(tin.id);
}

function tachContiguousTheoSender(tins, automaticWork) {
  const segments = [];
  for (const tin of tins || []) {
    const senderId = senderCua(tin);
    const cuoi = segments[segments.length - 1];
    if (cuoi && cuoi.senderId === senderId) {
      cuoi.tins.push(tin);
      continue;
    }
    segments.push({
      senderId,
      tins: [tin],
      automaticWork,
      preAiDone: false,
      aiEligible: true,
      staleProviderHistory: false,
    });
  }
  return segments;
}

function idsDangGiu(lane) {
  const ids = new Set();
  if (lane.active && !lane.active.cancelled) {
    for (const tin of lane.active.work.tins) {
      const id = idCua(tin);
      if (id !== null) ids.add(id);
    }
  }
  for (const segment of lane.pending) {
    for (const tin of segment.tins) {
      const id = idCua(tin);
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

function locTrungLap(tins, idsDaCo) {
  const ketQua = [];
  for (const tin of tins || []) {
    const id = idCua(tin);
    if (id !== null && idsDaCo.has(id)) continue;
    if (id !== null) idsDaCo.add(id);
    ketQua.push(tin);
  }
  return ketQua;
}

function layWorkKeTiep(lane) {
  const dau = lane.pending.shift();
  if (!dau) return null;
  const segments = [dau];
  while (lane.pending[0]?.senderId === dau.senderId) {
    segments.push(lane.pending.shift());
  }
  return {
    ownerUid: lane.ownerUid,
    threadId: lane.threadId,
    senderId: dau.senderId,
    segments,
    tins: segments.flatMap((segment) => segment.tins),
    staleProviderHistory: segments.some((segment) => segment.staleProviderHistory),
  };
}

function requeueStaleWork(lane, work, providerHistoryTouched) {
  if (providerHistoryTouched) {
    for (const segment of work.segments) segment.staleProviderHistory = true;
  }

  // STALE_INPUTS dung truoc NEW_PENDING_INPUTS. Loc theo chinh tin.id dang co
  // tren object normalized; khong normalize lai nen fallback id khong doi.
  const ids = new Set();
  const rebuilt = [];
  for (const segment of [...work.segments, ...lane.pending]) {
    const tins = locTrungLap(segment.tins, ids);
    if (tins.length) rebuilt.push({ ...segment, tins });
  }
  lane.pending = rebuilt;
}

/**
 * @param {object} options
 * @param {(work: object, generation: object) => Promise<void>} options.chay
 * @param {(event: object) => void|Promise<void>} [options.ghiSuKien]
 * @param {(work: object, generation: object) => void|Promise<void>} [options.truocGeneration]
 * @param {(work: object, generation: object) => void|Promise<void>} [options.khiStale]
 * @param {(work: object, generation: object, error: Error|null) => void|Promise<void>} [options.khiHoanTat]
 * @param {(work: object, reason: string) => void|Promise<void>} [options.khiHuy]
 */
export function taoDieuPhoiHoiThoai({
  chay,
  ghiSuKien = () => {},
  truocGeneration = () => {},
  khiStale = () => {},
  khiHoanTat = () => {},
  khiHuy = () => {},
}) {
  if (typeof chay !== "function") throw new TypeError("Dieu phoi hoi thoai can runner.");

  const lanes = new Map();
  let generationSequence = 0;

  function phat(event, detail = {}) {
    Promise.resolve(ghiSuKien({ event, ...detail })).catch(() => {});
  }

  function taoLane(ownerUid, threadId) {
    return {
      ownerUid: String(ownerUid),
      threadId: String(threadId),
      pending: [],
      active: null,
      draining: false,
      generationsStarted: 0,
      waiters: new Set(),
    };
  }

  function hoanTatLane(key, lane) {
    if (lane.active || lane.pending.length) return;
    if (lanes.get(key) === lane) lanes.delete(key);
    for (const resolve of lane.waiters) resolve();
    lane.waiters.clear();
  }

  function taoGeneration(lane, work) {
    const generation = {
      id: ++generationSequence,
      ownerUid: lane.ownerUid,
      threadId: lane.threadId,
      work,
      stale: false,
      cancelled: false,
      accepted: false,
      outboundReserved: false,
      staleDeferred: false,
      sendUnknown: false,
      outboundContextAdvanced: false,
      providerHistoryTouched: false,
      staleOutboundLogged: false,
      conHieuLuc() {
        return lane.active === generation
          && !generation.cancelled
          && (generation.accepted || !generation.stale);
      },
      chapNhanOutbound() {
        if (!generation.conHieuLuc()) return false;
        generation.accepted = true;
        return true;
      },
      giuChoOutbound() {
        if (!generation.conHieuLuc() || generation.outboundReserved) return false;
        generation.outboundReserved = true;
        return true;
      },
      // Provider success la fact: khong re-check stale/authority sau khi da gui.
      xacNhanOutbound() {
        generation.accepted = true;
        generation.outboundReserved = false;
        generation.staleDeferred = false;
        generation.sendUnknown = false;
      },
      traLaiOutbound() {
        generation.outboundReserved = false;
        if (generation.staleDeferred && !generation.accepted) {
          generation.stale = true;
        }
        generation.staleDeferred = false;
      },
      danhDauSendUnknown() {
        generation.outboundReserved = false;
        generation.sendUnknown = true;
        generation.staleDeferred = false;
      },
      outboundContextDaTienLen() {
        return generation.outboundContextAdvanced;
      },
      daChapNhanOutbound() {
        return generation.accepted;
      },
      danhDauProviderHistory() {
        generation.providerHistoryTouched = true;
      },
      danhDauStaleOutboundSkipped() {
        if (generation.staleOutboundLogged) return false;
        generation.staleOutboundLogged = true;
        return true;
      },
    };
    return generation;
  }

  async function drain(key, lane) {
    if (lane.draining) return;
    lane.draining = true;
    try {
      while (lane.pending.length) {
        const work = layWorkKeTiep(lane);
        if (!work) break;
        if (lane.generationsStarted > 0) {
          phat("pending_drain_start", {
            ownerUid: lane.ownerUid,
            threadId: lane.threadId,
            senderId: work.senderId,
            pendingCount: lane.pending.length,
          });
        }

        const generation = taoGeneration(lane, work);
        lane.active = generation;
        lane.generationsStarted += 1;
        phat("conversation_inflight_start", {
          ownerUid: lane.ownerUid,
          threadId: lane.threadId,
          senderId: work.senderId,
          generationId: generation.id,
          messageCount: work.tins.length,
        });

        let runnerError = null;
        try {
          // P1 generation membership is assigned at the work/generation
          // boundary, after same-sender pending segments have been merged.
          await truocGeneration(work, generation);
          await chay(work, generation);
        } catch (error) {
          runnerError = error;
          phat("conversation_inflight_error", {
            ownerUid: lane.ownerUid,
            threadId: lane.threadId,
            senderId: work.senderId,
            generationId: generation.id,
            error: error?.message || String(error),
          });
        }

        if (generation.stale && !generation.cancelled && !generation.accepted) {
          await Promise.resolve(khiStale(work, generation)).catch((error) => phat("conversation_inflight_error", {
            ownerUid: lane.ownerUid,
            threadId: lane.threadId,
            generationId: generation.id,
            error: error?.message || String(error),
          }));
          requeueStaleWork(lane, work, generation.providerHistoryTouched);
        }

        await Promise.resolve(khiHoanTat(work, generation, runnerError)).catch((error) => phat("conversation_inflight_error", {
          ownerUid: lane.ownerUid,
          threadId: lane.threadId,
          generationId: generation.id,
          error: error?.message || String(error),
        }));

        lane.active = null;
        phat("conversation_inflight_end", {
          ownerUid: lane.ownerUid,
          threadId: lane.threadId,
          senderId: work.senderId,
          generationId: generation.id,
          stale: generation.stale,
          cancelled: generation.cancelled,
          accepted: generation.accepted,
          failed: Boolean(runnerError),
          pendingCount: lane.pending.length,
        });
      }
    } finally {
      lane.draining = false;
      hoanTatLane(key, lane);
      // Enqueue co the chen vao dung luc runner vua ket thuc.
      if (!lane.active && lane.pending.length) void drain(key, lane);
    }
  }

  function them({ ownerUid, threadId, tins, automaticWork = null }) {
    const owner = String(ownerUid || "").trim();
    const thread = String(threadId || "").trim();
    if (!owner || !thread) return Promise.resolve();

    const key = khoaHoiThoai(owner, thread);
    const lane = lanes.get(key) || taoLane(owner, thread);
    if (!lanes.has(key)) lanes.set(key, lane);

    const idsDaCo = idsDangGiu(lane);
    const tinsMoi = locTrungLap(tins, idsDaCo);
    const segments = tachContiguousTheoSender(tinsMoi, automaticWork);
    if (!segments.length) return choRanh(owner, thread);

    lane.pending.push(...segments);
    if (lane.active && !lane.active.cancelled) {
      lane.active.outboundContextAdvanced = true;
      if (!lane.active.accepted && lane.active.outboundReserved) {
        if (!lane.active.staleDeferred) {
          lane.active.staleDeferred = true;
          phat("generation_stale_deferred", {
            ownerUid: owner,
            threadId: thread,
            senderId: lane.active.work.senderId,
            generationId: lane.active.id,
          });
        }
      } else if (!lane.active.accepted && !lane.active.sendUnknown && !lane.active.stale) {
        lane.active.stale = true;
        phat("generation_marked_stale", {
          ownerUid: owner,
          threadId: thread,
          senderId: lane.active.work.senderId,
          generationId: lane.active.id,
        });
      }
    }
    phat("conversation_pending_queued", {
      ownerUid: owner,
      threadId: thread,
      senderId: segments[0].senderId,
      messageCount: tinsMoi.length,
      pendingCount: lane.pending.length,
    });

    void drain(key, lane);
    return choRanh(owner, thread);
  }

  function dangBan(ownerUid, threadId, senderId) {
    const lane = lanes.get(khoaHoiThoai(ownerUid, threadId));
    if (!lane) return false;
    const sender = String(senderId ?? "");
    const activeHasSender = Boolean(
      lane.active
      && !lane.active.cancelled
      && lane.active.work.segments.some((segment) => segment.senderId === sender)
    );
    return activeHasSender || lane.pending.some((segment) => segment.senderId === sender);
  }

  function threadDangBan(ownerUid, threadId) {
    const lane = lanes.get(khoaHoiThoai(ownerUid, threadId));
    return Boolean(
      lane
      && ((lane.active && !lane.active.cancelled) || lane.pending.length)
    );
  }

  function huyLane(key, lane, reason) {
    const pendingCleared = lane.pending.length;
    const cancelledWork = {
      activeTins: lane.active?.work?.tins || [],
      pendingTins: lane.pending.flatMap((segment) => segment.tins || []),
      activeGeneration: lane.active || null,
    };
    lane.pending = [];
    if (lane.active) lane.active.cancelled = true;
    Promise.resolve(khiHuy(cancelledWork, reason)).catch(() => {});
    phat("conversation_inflight_cancel", {
      ownerUid: lane.ownerUid,
      threadId: lane.threadId,
      generationId: lane.active?.id || null,
      pendingCleared,
      reason,
    });
    hoanTatLane(key, lane);
  }

  function huyTheoThread(ownerUid, threadId, reason = "thread_cancelled") {
    const key = khoaHoiThoai(ownerUid, threadId);
    const lane = lanes.get(key);
    if (!lane) return 0;
    huyLane(key, lane, reason);
    return 1;
  }

  function huyTatCa(reason = "all_cancelled") {
    let count = 0;
    for (const [key, lane] of lanes) {
      huyLane(key, lane, reason);
      count += 1;
    }
    return count;
  }

  function choRanh(ownerUid, threadId) {
    const lane = lanes.get(khoaHoiThoai(ownerUid, threadId));
    if (!lane || (!lane.active && !lane.pending.length)) return Promise.resolve();
    return new Promise((resolve) => lane.waiters.add(resolve));
  }

  return {
    them,
    dangBan,
    threadDangBan,
    huyTheoThread,
    huyTatCa,
    choRanh,
    soLane: () => lanes.size,
  };
}

export { khoaHoiThoai };
