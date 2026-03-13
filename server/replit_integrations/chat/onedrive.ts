/**
 * Microsoft Graph API helpers for OneDrive / SharePoint file access.
 * Uses client credentials flow — requires MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Token cache ─────────────────────────────────────────────────────────────
let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error("Microsoft credentials not configured. Please set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET.");
  }

  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed: ${err}`);
  }

  const data: any = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _tokenCache.token;
}

// ── URL parser ───────────────────────────────────────────────────────────────
export interface ParsedOdUrl {
  type: "personal" | "sharepoint";
  upn: string;        // user principal name derived from URL
  drivePath: string;  // path relative to drive root, e.g. /Documents/SOP/Cam360
  raw: string;
}

/** Convert personal site segment like "collaboration_heroelectronix_com" → "collaboration@heroelectronix.com" */
function personalSiteToUpn(segment: string): string {
  // Split on underscores and reassemble: first part = user, rest = domain
  // e.g. "john_doe_contoso_com" → "john_doe@contoso.com"
  const parts = segment.split("_");
  // TLD is always the last, domain is second-to-last, username is everything before
  if (parts.length >= 3) {
    const tld = parts[parts.length - 1];
    const domain = parts[parts.length - 2];
    const username = parts.slice(0, parts.length - 2).join("_");
    return `${username}@${domain}.${tld}`;
  }
  return segment; // fallback
}

export function parseOdUrl(rawUrl: string): ParsedOdUrl {
  const url = new URL(rawUrl);

  // SharePoint personal OneDrive: hostname contains "-my.sharepoint.com"
  // and pathname contains "/personal/{encoded_upn}/"
  const personalMatch = url.pathname.match(/^\/personal\/([^/]+)/);
  if (personalMatch) {
    const upn = personalSiteToUpn(personalMatch[1]);

    // The `id` param contains the full absolute drive path
    const idParam = url.searchParams.get("id");
    let drivePath = "";
    if (idParam) {
      const decoded = decodeURIComponent(idParam);
      // Strip the /personal/xxx prefix to get the relative path from drive root
      const stripped = decoded.replace(/^\/personal\/[^/]+/, "");
      drivePath = stripped; // e.g. /Documents/Knowledge resources .../Cam360
    }

    return { type: "personal", upn, drivePath, raw: rawUrl };
  }

  throw new Error("Unsupported OneDrive/SharePoint URL format. Please use a sharing link from your OneDrive or SharePoint.");
}

// ── Graph API calls ──────────────────────────────────────────────────────────

async function graphGet(path: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error (${res.status}): ${body}`);
  }
  return res.json();
}

async function graphGetBuffer(path: string): Promise<Buffer> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API download error (${res.status}): ${body}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface OdFileItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number;
  webUrl: string;
  downloadUrl?: string;
  path: string; // relative drive path
}

/** List files in a OneDrive folder. */
export async function listFolder(parsed: ParsedOdUrl): Promise<OdFileItem[]> {
  const { upn, drivePath } = parsed;

  // Encode path for Graph: /users/{upn}/drive/root:{drivePath}:/children
  const encodedPath = encodeURIComponent(drivePath).replace(/%2F/g, "/");
  const endpoint = drivePath && drivePath !== "/"
    ? `/users/${encodeURIComponent(upn)}/drive/root:${drivePath}:/children`
    : `/users/${encodeURIComponent(upn)}/drive/root/children`;

  const data = await graphGet(`${endpoint}?$select=id,name,file,folder,size,webUrl,@microsoft.graph.downloadUrl`);

  return (data.value || []).map((item: any) => ({
    id: item.id,
    name: item.name,
    mimeType: item.file?.mimeType || "folder",
    isFolder: !!item.folder,
    size: item.size || 0,
    webUrl: item.webUrl,
    downloadUrl: item["@microsoft.graph.downloadUrl"],
    path: `${drivePath}/${item.name}`,
  }));
}

/** Extract text content from a file item. */
export async function extractFileContent(file: OdFileItem, upn: string): Promise<string> {
  const name = file.name.toLowerCase();

  let buffer: Buffer;
  if (file.downloadUrl) {
    buffer = await fetchBuffer(file.downloadUrl);
  } else {
    // Fallback: get item metadata first to get fresh download URL
    const meta = await graphGet(`/users/${encodeURIComponent(upn)}/drive/items/${file.id}?$select=@microsoft.graph.downloadUrl`);
    const url = meta["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("No download URL available for file");
    buffer = await fetchBuffer(url);
  }

  if (name.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return parsed.text.slice(0, 50000);
  }

  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.slice(0, 50000);
  }

  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) {
    return buffer.toString("utf-8").slice(0, 50000);
  }

  // Try plain text as fallback
  return buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").slice(0, 50000);
}

/** Check whether MS credentials are configured. */
export function msCredentialsConfigured(): boolean {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}
