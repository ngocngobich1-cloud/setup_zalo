import path from "node:path";

// Resolve at each entrypoint/import boundary instead of caching the first cwd.
// Test harnesses deliberately load db.js under multiple isolated cwd fixtures.
export function resolveDatabasePaths(cwd = process.cwd()) {
  const dataDir = path.resolve(cwd, "data");
  return { dataDir, dbPath: path.join(dataDir, "zalo.db") };
}
