/** Test-only sqlite3 callback shim for this ARM64 workstation's missing native binding. */
import { registerHooks } from "node:module";

const shim = `
  import { DatabaseSync } from "node:sqlite";
  class Database {
    constructor(file, mode) { this.inner = new DatabaseSync(file, mode === 1 ? { readOnly: true } : {}); }
    run(sql, params = [], callback = () => {}) {
      if (typeof params === "function") { callback = params; params = []; }
      try {
        const statement = this.inner.prepare(sql);
        const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
        callback.call({ changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) }, null);
      } catch (error) { callback(error); }
    }
    all(sql, params = [], callback = () => {}) {
      if (typeof params === "function") { callback = params; params = []; }
      try {
        const statement = this.inner.prepare(sql);
        callback(null, Array.isArray(params) ? statement.all(...params) : statement.all(params));
      } catch (error) { callback(error); }
    }
    get(sql, params = [], callback = () => {}) {
      if (typeof params === "function") { callback = params; params = []; }
      try {
        const statement = this.inner.prepare(sql);
        callback(null, Array.isArray(params) ? statement.get(...params) : statement.get(params));
      } catch (error) { callback(error); }
    }
    close(callback = () => {}) { try { this.inner.close(); callback(null); } catch (error) { callback(error); } }
  }
  export default { Database, OPEN_READONLY: 1 };
`;

const shimUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sqlite3") return { url: shimUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
