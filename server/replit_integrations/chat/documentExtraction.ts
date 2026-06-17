import * as mammoth from "mammoth";
import * as pdfParseLib from "pdf-parse";
import * as XLSX from "xlsx";

const pdfParse = (pdfParseLib as any).default ?? (pdfParseLib as any);

export interface ExtractedDocumentText {
  text: string;
  method: "pdf" | "docx" | "spreadsheet" | "text" | "html";
  originalLength: number;
  truncated: boolean;
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  const printable = text.match(/[\x09\x0A\x0D\x20-\x7E]/g)?.length ?? 0;
  return printable / text.length;
}

function textLooksLikeOfficeXml(text: string): boolean {
  return /word\/document\.xml|_rels\/\.rels|\[Content_Types\]\.xml/i.test(text);
}

function isZipContainer(buffer: Buffer): boolean {
  return buffer.subarray(0, 2).toString("utf8") === "PK";
}

function ensureUsefulText(text: string, filename: string, buffer: Buffer, rejectZipContainer: boolean): string {
  const clean = normalizeText(text);
  if (clean.length < 20) {
    throw new Error(`Could not extract enough readable text from ${filename}.`);
  }
  if (textLooksLikeOfficeXml(clean) || (rejectZipContainer && isZipContainer(buffer)) || printableRatio(clean) < 0.85) {
    throw new Error(`Extracted content from ${filename} looks like binary data, not readable text.`);
  }
  return clean;
}

function finish(
  text: string,
  filename: string,
  buffer: Buffer,
  method: ExtractedDocumentText["method"],
  maxChars: number,
  rejectZipContainer = false,
): ExtractedDocumentText {
  const clean = ensureUsefulText(text, filename, buffer, rejectZipContainer);
  return {
    text: clean.slice(0, maxChars),
    method,
    originalLength: clean.length,
    truncated: clean.length > maxChars,
  };
}

function spreadsheetToText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    return `Sheet: ${sheetName}\n${csv}`;
  }).join("\n\n");
}

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType = "",
  maxChars = 50000,
): Promise<ExtractedDocumentText> {
  const ext = extensionOf(filename);
  const mime = mimeType.toLowerCase();

  if (ext === "pdf" || mime === "application/pdf") {
    const parsed = await pdfParse(buffer);
    return finish(parsed.text ?? "", filename, buffer, "pdf", maxChars);
  }

  if (
    ext === "docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return finish(result.value ?? "", filename, buffer, "docx", maxChars);
  }

  if (ext === "doc" || mime === "application/msword") {
    throw new Error("Legacy .doc files are not reliably supported. Please upload .docx, .pdf, .txt, .md, .csv, .xlsx, or .xls.");
  }

  if (
    ["xlsx", "xls", "csv"].includes(ext) ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv"
  ) {
    if (ext === "csv" || mime === "text/csv") {
      return finish(buffer.toString("utf8"), filename, buffer, "text", maxChars);
    }
    return finish(spreadsheetToText(buffer), filename, buffer, "spreadsheet", maxChars);
  }

  if (["txt", "md", "json", "xml", "log"].includes(ext) || mime.startsWith("text/")) {
    return finish(buffer.toString("utf8"), filename, buffer, "text", maxChars);
  }

  if (["html", "htm"].includes(ext) || mime === "text/html") {
    return finish(stripHtml(buffer.toString("utf8")), filename, buffer, "html", maxChars);
  }

  const asText = buffer.toString("utf8");
  if (!isZipContainer(buffer) && printableRatio(asText) > 0.95) {
    return finish(asText, filename, buffer, "text", maxChars, true);
  }

  throw new Error(`Unsupported or unreadable file type for ${filename}. Please upload .pdf, .docx, .txt, .md, .csv, .xlsx, or .xls.`);
}
