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

// ── "Anyone" public sharing link support (no credentials required) ────────────
//
// When a file/folder is shared with "Anyone - doesn't require sign-in",
// OneDrive/SharePoint generates a sharing link like:
//   https://heroelectronix1-my.sharepoint.com/:w:/g/personal/user/EaBC123?e=xyz
//
// These can be accessed via Graph API /shares/{shareId} endpoint WITHOUT
// Azure App Registration credentials.  The shareId is base64url(url) with u! prefix.

const SHARING_PATH_RE = /\/:([wbfxpovt]):/i; // matches /:w:/, /:b:/, /:f:/, /:x:/ etc.

/** Detect if this URL is an "Anyone" OneDrive/SharePoint sharing link */
export function isSharingLink(url: string): boolean {
  try {
    const u = new URL(url);
    return SHARING_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/** Detect if sharing link points to a folder (/:f:/) */
export function isSharingLinkFolder(url: string): boolean {
  try {
    const u = new URL(url);
    return /\/:f:/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Extract a human-readable filename from a sharing URL */
export function filenameFromSharingUrl(url: string): string {
  // SharePoint doesn't embed the filename in the URL by default, so we use the path
  // The last non-empty pathname segment gives a base64 ID, not a name.
  // We return a placeholder and rely on Graph API metadata for the real name.
  return "Shared Document";
}

/** Encode a sharing URL into a Graph API share ID */
function encodeShareId(sharingUrl: string): string {
  const base64 = Buffer.from(sharingUrl)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
  return `u!${base64}`;
}

export interface SharingLinkItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number;
  webUrl: string;
  serverRelativeUrl?: string; // SharePoint server-relative path for direct download
  fedAuthCookie?: string;     // FedAuth cookie for authenticated downloads
  shareId: string;
  sharingUrl: string;
}

// ── FedAuth cookie-based access (works for "Anyone with the link" SharePoint folders) ──

/** Extract the SharePoint site base URL (scheme + hostname) from a sharing URL */
function siteBaseFromSharingUrl(sharingUrl: string): string {
  const u = new URL(sharingUrl);
  return `${u.protocol}//${u.hostname}`;
}

/**
 * Follows the full SharePoint redirect chain (up to 8 hops) with redirect:manual,
 * accumulating all Set-Cookie values. Returns the first FedAuth cookie found
 * and the redirect location that contained it (or the last location seen).
 *
 * SharePoint sometimes sets FedAuth on hop 2 or 3 — a single-hop fetch misses it.
 */
async function fetchShareRedirect(sharingUrl: string): Promise<{ cookie: string; location: string }> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  let nextUrl: string = sharingUrl;
  const cookieJar: string[] = [];     // accumulate all cookies across hops
  let lastLocation = "";

  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(nextUrl, { redirect: "manual", headers });

    // Collect all cookies from this hop
    const raw = res.headers.get("set-cookie") || "";
    if (raw) {
      // set-cookie may be a comma-separated list of multiple cookies
      raw.split(/,(?=[^ ])/).forEach(c => {
        const pair = c.split(";")[0].trim();
        if (pair) cookieJar.push(pair);
      });
    }

    // If we now have a FedAuth cookie, we're done — return it
    const fedAuth = cookieJar.find(c => c.startsWith("FedAuth="));
    if (fedAuth) {
      // Also include rtFa if present (SharePoint sometimes requires both)
      const rtFa = cookieJar.find(c => c.startsWith("rtFa="));
      const cookie = [fedAuth, rtFa].filter(Boolean).join("; ");
      return { cookie, location: lastLocation || res.headers.get("location") || "" };
    }

    const location = res.headers.get("location") || "";
    if (!location) break;   // no more redirects
    lastLocation = location;

    // Resolve relative redirects
    try {
      nextUrl = new URL(location, nextUrl).href;
    } catch {
      nextUrl = location;
    }
  }

  // No FedAuth found — return whatever we accumulated (may be empty, caller will throw)
  const cookie = cookieJar.join("; ");
  return { cookie, location: lastLocation };
}

/** List all files in a shared folder using FedAuth cookie + SharePoint REST API (2 HTTP calls total) */
export async function listSharedFolder(sharingUrl: string): Promise<SharingLinkItem[]> {
  const { cookie, location } = await fetchShareRedirect(sharingUrl);
  if (!cookie) throw new Error("SharePoint session expired. Please re-import the file from the KB Manager → Import from SharePoint tab using a fresh sharing link.");
  if (!location) throw new Error("SharePoint sharing link did not redirect — the link may have expired. Please generate a new sharing link.");

  // Parse personal site path and folder path from the redirect location
  const personalMatch = location.match(/\/personal\/[^/?]+/);
  if (!personalMatch) throw new Error("Cannot determine SharePoint personal site path from the sharing link.");
  const personalPath = personalMatch[0]; // e.g. /personal/collaboration_heroelectronix_com

  const idMatch = decodeURIComponent(location).match(/id=([^&]+)/);
  if (!idMatch) throw new Error("Cannot determine folder path from the sharing link redirect.");
  const folderPath = idMatch[1]; // e.g. /personal/.../Cam360

  const siteBase = siteBaseFromSharingUrl(sharingUrl);
  const siteUrl = `${siteBase}${personalPath}`;

  // SharePoint REST API — list files in the folder
  const apiUrl = `${siteUrl}/_api/web/GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(folderPath)}')/Files?$select=Name,Length,ServerRelativeUrl,TimeLastModified`;
  const apiRes = await fetch(apiUrl, {
    headers: {
      "Accept": "application/json;odata=verbose",
      "Cookie": cookie,
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!apiRes.ok) {
    const body = await apiRes.text();
    throw new Error(`SharePoint API error (${apiRes.status}): ${body.slice(0, 300)}`);
  }

  const data = await apiRes.json();
  const files: any[] = data?.d?.results || [];

  return files.map((f: any) => ({
    id: f.ServerRelativeUrl,
    name: f.Name,
    mimeType: f.Name.match(/\.pdf$/i) ? "application/pdf"
      : f.Name.match(/\.docx?$/i) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/octet-stream",
    isFolder: false,
    size: Number(f.Length) || 0,
    webUrl: `${siteBase}${f.ServerRelativeUrl}`,
    serverRelativeUrl: f.ServerRelativeUrl,
    fedAuthCookie: cookie,
    shareId: "",
    sharingUrl,
  }));
}

/** Get metadata for a single shared file (individual "Anyone" sharing link) */
export async function getSharedItemMeta(sharingUrl: string): Promise<SharingLinkItem> {
  const { cookie, location } = await fetchShareRedirect(sharingUrl);

  const idMatch = decodeURIComponent(location || "").match(/id=([^&]+)/);
  const serverRelativeUrl = idMatch ? idMatch[1] : "";
  const name = serverRelativeUrl.split("/").pop() || "Shared Document";

  return {
    id: serverRelativeUrl || sharingUrl,
    name,
    mimeType: "application/octet-stream",
    isFolder: false,
    size: 0,
    webUrl: sharingUrl,
    serverRelativeUrl,
    fedAuthCookie: cookie,
    shareId: encodeShareId(sharingUrl),
    sharingUrl,
  };
}

/** Download and extract text from a shared file */
export async function extractSharedFileContent(item: SharingLinkItem): Promise<string> {
  let buffer: Buffer;

  if (item.serverRelativeUrl && item.fedAuthCookie) {
    // Primary: direct download via SharePoint server-relative URL + FedAuth cookie
    const siteBase = siteBaseFromSharingUrl(item.sharingUrl);
    const downloadUrl = `${siteBase}${item.serverRelativeUrl}`;
    const res = await fetch(downloadUrl, {
      headers: { "Cookie": item.fedAuthCookie, "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${item.name}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    // Fallback: try direct download via sharing URL with ?download=1
    const downloadUrl = item.sharingUrl.includes("?")
      ? `${item.sharingUrl}&download=1`
      : `${item.sharingUrl}?download=1`;
    const res = await fetch(downloadUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Cannot download file (${res.status}). Make sure the link is shared as "Anyone with the link".`);
    buffer = Buffer.from(await res.arrayBuffer());
  }

  return extractTextFromBuffer(buffer, item.name);
}

/** Shared text extraction helper used by both flows */
export async function extractTextFromBuffer(buffer: Buffer, name: string): Promise<string> {
  const lower = name.toLowerCase();

  if (lower.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return parsed.text.slice(0, 50000);
  }
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.slice(0, 50000);
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
    return buffer.toString("utf-8").slice(0, 50000);
  }
  // Generic fallback
  return buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").slice(0, 50000);
}
