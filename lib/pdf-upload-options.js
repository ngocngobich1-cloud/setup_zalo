import multer from "multer";
import { PDF_AUTOMATION_MAX_BYTES } from "./pdf-automation.js";

export const PDF_AUTOMATION_MULTER_OPTIONS = {
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: PDF_AUTOMATION_MAX_BYTES },
  defParamCharset: "utf8",
};
