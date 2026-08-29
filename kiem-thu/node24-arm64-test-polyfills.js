/**
 * Host-test-only import guards for optional PDF canvas types.
 * STAB-03 suites below do not render PDF; pdfjs only requires these globals
 * while its module is evaluated after the optional native canvas load fails.
 */
if (typeof globalThis.DOMMatrix === "undefined") globalThis.DOMMatrix = class DOMMatrix {};
if (typeof globalThis.ImageData === "undefined") globalThis.ImageData = class ImageData {};
if (typeof globalThis.Path2D === "undefined") globalThis.Path2D = class Path2D {};

// Windows ARM64 Node 24 co the abort trong uv_close khi process.exit() cat ngang
// optional PDF handle. De event loop dong tu nhien, nhung van giu nguyen exit code.
process.exit = (code = 0) => {
  process.exitCode = Number(code) || 0;
};
