import session from "express-session";
import { deleteSession, getSession, listSessions, setSession, touchSession } from "./db.js";

const MacDinh = session.Store;

/**
 * Luu phien dang nhap xuong SQLite thay vi bo nho.
 * MemoryStore mat sach moi lan restart - tren VPS nghia la cu khoi dong lai la
 * phai dang nhap lai. Luu cung file zalo.db de sao luu chi can copy mot thu muc.
 */
export class SqliteSessionStore extends MacDinh {
  get(sid, callback) {
    const operation = getSession(sid).then(async (data) => {
      if (data === null) return null;
      try {
        return JSON.parse(data);
      } catch {
        await deleteSession(sid);
        return null;
      }
    });
    operation.then(
      (phien) => callback(null, phien),
      (error) => callback(error)
    );
  }

  set(sid, phien, callback) {
    const hetHan = phien?.cookie?.expires
      ? new Date(phien.cookie.expires).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;
    setSession(sid, JSON.stringify(phien), hetHan).then(
      () => callback?.(null),
      (error) => callback?.(error)
    );
  }

  destroy(sid, callback) {
    deleteSession(sid).then(
      () => callback?.(null),
      (error) => callback?.(error)
    );
  }

  // express-session goi touch de gia han phien con dang dung.
  touch(sid, phien, callback) {
    const hetHan = phien?.cookie?.expires
      ? new Date(phien.cookie.expires).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;
    touchSession(sid, hetHan).then(
      () => callback?.(null),
      (error) => callback?.(error)
    );
  }

  length(callback) {
    listSessions().then(
      (rows) => callback(null, rows.length),
      (error) => callback(error)
    );
  }
}
