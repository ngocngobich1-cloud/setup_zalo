import { MarkItDown } from "markitdown-ts";
import {
  createKnowledgeFile,
  deleteKnowledgeFile,
  getAllKnowledgeFiles,
  getKnowledgeFileById,
  getKnowledgeFilesByIds,
} from "./db.js";

export const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf", ".doc", ".docx"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_MAX_CHARS = 200000;
const TRUNCATED_NOTE = "\n\n...[đã cắt bớt]";

const markitdown = new MarkItDown();

function extensionOf(originalName) {
  const name = String(originalName || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

export function isAllowedFile(originalName) {
  return ALLOWED_EXTENSIONS.includes(extensionOf(originalName));
}

/**
 * Chuyen buffer file sang Markdown.
 * .txt/.md doc thang UTF-8; con lai day qua markitdown-ts.
 */
export async function fileToMarkdown(buffer, originalName) {
  const ext = extensionOf(originalName);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Định dạng không hỗ trợ: ${ext || "(không rõ)"}`);
  }

  let markdown = "";
  if (ext === ".txt" || ext === ".md") {
    markdown = buffer.toString("utf8");
  } else {
    // .doc cu khong co converter rieng, thu doc nhu .docx.
    const fileExtension = ext === ".doc" ? ".docx" : ext;
    const result = await markitdown.convertBuffer(buffer, { file_extension: fileExtension });
    markdown = result?.markdown || result?.text_content || "";
  }

  markdown = String(markdown).trim();
  if (markdown.length === 0) {
    throw new Error("Không trích xuất được nội dung văn bản từ file này.");
  }
  return markdown;
}

export async function listFiles() {
  return getAllKnowledgeFiles();
}

export async function addFile(buffer, originalName) {
  if (!buffer || buffer.length === 0) throw new Error("File rỗng.");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("File vượt quá 10MB.");
  if (!isAllowedFile(originalName)) {
    throw new Error(`Chỉ nhận ${ALLOWED_EXTENSIONS.join(", ")}`);
  }

  const contentMd = await fileToMarkdown(buffer, originalName);
  return createKnowledgeFile({
    originalName: String(originalName),
    fileExt: extensionOf(originalName),
    contentMd,
    fileSize: buffer.length,
  });
}

export async function removeFile(id) {
  return deleteKnowledgeFile(id);
}

/** Xem truoc: cat bot de khong day ca file khong lo ve trinh duyet. */
export async function getFileContent(id) {
  const file = await getKnowledgeFileById(id);
  if (!file) return null;

  const full = file.contentMd || "";
  const truncated = full.length > PREVIEW_MAX_CHARS;
  return {
    ...file,
    contentMd: truncated ? full.slice(0, PREVIEW_MAX_CHARS) + TRUNCATED_NOTE : full,
    truncated,
  };
}

/**
 * Ghep noi dung cac file thanh mot block de chen vao system prompt.
 * maxChars duoc chia deu cho cac file; file dai hon phan cua no thi bi cat.
 */
export async function getContentsForAi(fileIds, maxChars = 12000) {
  const files = await getKnowledgeFilesByIds(fileIds);
  if (files.length === 0) return "";

  const perFile = Math.max(500, Math.floor(maxChars / files.length));
  const blocks = files.map((file) => {
    const content = file.contentMd || "";
    const body = content.length > perFile ? content.slice(0, perFile) + TRUNCATED_NOTE : content;
    return `--- Tài liệu: ${file.originalName} ---\n${body}`;
  });

  return (
    "KHO TRI THỨC (chỉ dùng thông tin dưới đây khi trả lời, không bịa):\n\n" +
    blocks.join("\n\n")
  );
}
