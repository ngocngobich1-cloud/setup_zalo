/** Chi dung qua --import trong test tren host Node 24 ARM64. */
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = pathToFileURL(path.join(HERE, "sqlite3-node24-test-adapter.js")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sqlite3") return { url: ADAPTER, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
