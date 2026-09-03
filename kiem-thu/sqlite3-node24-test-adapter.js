/**
 * Test-only adapter: subset giao dien sqlite3 callback ma lib/db.js dang dung,
 * duoc backed boi node:sqlite co san trong Node 24.
 *
 * Khong duoc import adapter nay tu production.
 */
import { DatabaseSync } from "node:sqlite";

const openConnections = new Set();

function invoke(callback, context, error, value) {
  if (typeof callback === "function") callback.call(context, error, value);
}

function callShape(params, callback) {
  if (typeof params === "function") return { args: [], callback: params };
  if (params === undefined || params === null) return { args: [], callback };
  return { args: Array.isArray(params) ? params : [params], callback };
}

function plainRow(row) {
  return row === undefined ? undefined : Object.fromEntries(Object.entries(row));
}

export class Database {
  constructor(file, mode, callback) {
    const onOpen = typeof mode === "function" ? mode : callback;
    try {
      this.connection = new DatabaseSync(file);
      openConnections.add(this.connection);
      queueMicrotask(() => invoke(onOpen, this, null));
    } catch (error) {
      queueMicrotask(() => invoke(onOpen, this, error));
      if (typeof onOpen !== "function") throw error;
    }
  }

  run(sql, params = [], callback) {
    const call = callShape(params, callback);
    try {
      const result = this.connection.prepare(sql).run(...call.args);
      const context = {
        changes: Number(result.changes || 0),
        lastID: Number(result.lastInsertRowid || 0),
      };
      invoke(call.callback, context, null);
    } catch (error) {
      invoke(call.callback, this, error);
    }
    return this;
  }

  all(sql, params = [], callback) {
    const call = callShape(params, callback);
    try {
      const rows = this.connection.prepare(sql).all(...call.args).map(plainRow);
      invoke(call.callback, this, null, rows);
    } catch (error) {
      invoke(call.callback, this, error);
    }
    return this;
  }

  get(sql, params = [], callback) {
    const call = callShape(params, callback);
    try {
      invoke(call.callback, this, null, plainRow(this.connection.prepare(sql).get(...call.args)));
    } catch (error) {
      invoke(call.callback, this, error);
    }
    return this;
  }

  serialize(callback) {
    if (typeof callback === "function") callback();
    return this;
  }

  close(callback) {
    try {
      this.connection.close();
      openConnections.delete(this.connection);
      invoke(callback, this, null);
    } catch (error) {
      invoke(callback, this, error);
    }
  }
}

export function closeAllTestDatabases() {
  for (const connection of [...openConnections]) {
    try {
      connection.close();
    } finally {
      openConnections.delete(connection);
    }
  }
}

export default { Database, closeAllTestDatabases };
