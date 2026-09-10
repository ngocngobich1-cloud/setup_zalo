import { MarkItDown } from "markitdown-ts";
import { chunkFile, buildCorpusStats, contentHash, retrieveKnowledge } from "./knowledge-retrieval.js";
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

export async function listFiles(ownerUid) {
  return getAllKnowledgeFiles(ownerUid);
}

export async function addFile(ownerUid, buffer, originalName) {
  if (!ownerUid) throw new Error("addFile: thieu ownerUid.");
  if (!buffer || buffer.length === 0) throw new Error("File rỗng.");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("File vượt quá 10MB.");
  if (!isAllowedFile(originalName)) {
    throw new Error(`Chỉ nhận ${ALLOWED_EXTENSIONS.join(", ")}`);
  }

  const contentMd = await fileToMarkdown(buffer, originalName);
  return createKnowledgeFile(ownerUid, {
    originalName: String(originalName),
    fileExt: extensionOf(originalName),
    contentMd,
    fileSize: buffer.length,
  });
}

export async function removeFile(ownerUid, id) {
  return deleteKnowledgeFile(ownerUid, id);
}

/** Xem truoc: cat bot de khong day ca file khong lo ve trinh duyet. */
export async function getFileContent(ownerUid, id) {
  const file = await getKnowledgeFileById(ownerUid, id);
  if (!file) return null;

  const full = file.contentMd || "";
  const truncated = full.length > PREVIEW_MAX_CHARS;
  return {
    ...file,
    contentMd: truncated ? full.slice(0, PREVIEW_MAX_CHARS) + TRUNCATED_NOTE : full,
    truncated,
  };
}

export const CHUNK_CACHE_MAX_FILES = 200;
const chunkCache = new Map();
const corpusStatsCache = new Map();

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CHUNK_CACHE_MAX_FILES) cache.delete(cache.keys().next().value);
  return value;
}

/** Always authorize fresh rows before consulting either cache. */
export async function retrieveForAi(ownerUid, knowledgeFileIds, query, ceiling = 12000) {
  const files = await getKnowledgeFilesByIds(ownerUid, knowledgeFileIds);
  let cacheHitFiles = 0;
  let cacheMissFiles = 0;
  const signatures = [];
  const chunks = [];
  for (const file of files) {
    const hash = contentHash(file.contentMd ?? file.content_md ?? "");
    const key = String(file.id);
    let cached = chunkCache.get(key);
    if (cached?.contentHash === hash) cacheHitFiles++;
    else {
      cacheMissFiles++;
      cached = { contentHash: hash, chunks: chunkFile(file) };
    }
    remember(chunkCache, key, cached);
    signatures.push(`${key}:${hash}`);
    // Titles are current owner-authorized metadata, never cache authority.
    for (const chunk of cached.chunks) chunks.push({ ...chunk, fileId: file.id, fileTitle: file.originalName || file.title || "Tài liệu" });
  }
  const statsKey = JSON.stringify([String(ownerUid), signatures.sort()]);
  const index = remember(corpusStatsCache, statsKey, corpusStatsCache.get(statsKey) || buildCorpusStats(chunks));
  const result = retrieveKnowledge({ query, corpus: { files, chunks, index }, ceiling });
  return { units: result.units, stats: { ...result.stats, cacheHitFiles, cacheMissFiles } };
}

/** Loc ID Knowledge theo dung owner; allOwned dung cho validation all-or-nothing. */
export async function validateOwnedFileIds(ownerUid, fileIds) {
  const rawIds = Array.isArray(fileIds) ? fileIds : [];
  const normalizedIds = rawIds.map(Number);
  const syntaxValid = Array.isArray(fileIds) && normalizedIds.every(Number.isInteger);
  if (!ownerUid || !syntaxValid || normalizedIds.length === 0) {
    return { ownedIds: [], allOwned: Boolean(ownerUid) && syntaxValid && normalizedIds.length === 0 };
  }

  const files = await getKnowledgeFilesByIds(ownerUid, normalizedIds);
  const ownedSet = new Set(files.map((file) => Number(file.id)));
  const ownedIds = normalizedIds.filter((id) => ownedSet.has(id));
  return { ownedIds, allOwned: ownedIds.length === normalizedIds.length };
}
