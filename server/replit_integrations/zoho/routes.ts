import type { Express, Request, Response } from "express";
import OpenAI from "openai";

const ZOHO_TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";
const ZOHO_BASE_URL = "https://desk.zoho.in/api/v1";

// In-memory token cache — refreshed automatically when expired
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN ?? "",
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID ?? "",
    client_secret: process.env.ZOHO_CLIENT_SECRET ?? "",
  });
  const resp = await fetch(`${ZOHO_TOKEN_URL}?${params.toString()}`, { method: "POST" });
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  if (!data.access_token) throw new Error("Zoho token refresh failed");
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function zohoGet(path: string, token: string): Promise<unknown> {
  const resp = await fetch(`${ZOHO_BASE_URL}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return resp.json();
}

// Normalize phone: keep last 10 digits (handles +91, 0 prefix, spaces, dashes)
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-10);
}

interface ZohoTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  phone?: string;
  email?: string;
  customFields?: Record<string, string>;
  threads?: ZohoThread[];
  [key: string]: unknown;
}

interface ZohoThread {
  id: string;
  direction: string;
  content?: string;
  summary?: string;
  author?: { name?: string };
  createdTime?: string;
}

async function searchTicketsByPhone(phone: string, token: string): Promise<string[]> {
  const normalized = normalizePhone(phone);
  const ids: string[] = [];
  let from = 0;
  const limit = 100;

  // Scan up to 500 recent tickets (last ~5-10 days at normal volume)
  for (let page = 0; page < 5; page++) {
    const data = (await zohoGet(
      `/tickets?limit=${limit}&from=${from}&sortBy=-createdTime`,
      token
    )) as { data?: ZohoTicket[] };
    const tickets = data.data ?? [];
    if (tickets.length === 0) break;

    for (const t of tickets) {
      if (t.phone && normalizePhone(t.phone) === normalized) {
        ids.push(t.id);
      }
    }

    from += limit;
    if (tickets.length < limit) break;
  }
  return ids;
}

async function searchTicketsByEmail(email: string, token: string): Promise<string[]> {
  const lower = email.toLowerCase().trim();
  const ids: string[] = [];
  let from = 0;
  const limit = 100;

  for (let page = 0; page < 5; page++) {
    const data = (await zohoGet(
      `/tickets?limit=${limit}&from=${from}&sortBy=-createdTime`,
      token
    )) as { data?: ZohoTicket[] };
    const tickets = data.data ?? [];
    if (tickets.length === 0) break;

    for (const t of tickets) {
      if (t.email && t.email.toLowerCase().trim() === lower) {
        ids.push(t.id);
      }
    }

    from += limit;
    if (tickets.length < limit) break;
  }
  return ids;
}

async function searchTicketsBySerial(serial: string, token: string): Promise<string[]> {
  // Serial number is in custom fields — we must fetch full detail per ticket.
  // Limit to 200 recent tickets to keep latency manageable.
  const upper = serial.toUpperCase().trim();
  const candidateIds: string[] = [];
  let from = 0;
  const limit = 100;

  for (let page = 0; page < 2; page++) {
    const data = (await zohoGet(
      `/tickets?limit=${limit}&from=${from}&sortBy=-createdTime`,
      token
    )) as { data?: ZohoTicket[] };
    const tickets = data.data ?? [];
    if (tickets.length === 0) break;
    candidateIds.push(...tickets.map((t) => t.id));
    from += limit;
    if (tickets.length < limit) break;
  }

  // Fetch details in parallel batches of 10 to check custom fields
  const matched: string[] = [];
  const BATCH = 10;
  for (let i = 0; i < candidateIds.length; i += BATCH) {
    const batch = candidateIds.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map((id) => zohoGet(`/tickets/${id}`, token) as Promise<ZohoTicket>)
    );
    for (const d of details) {
      const sn = d.customFields?.["Device Serial Number"] ?? "";
      if (sn.toUpperCase().trim() === upper) {
        matched.push(d.id);
      }
    }
  }
  return matched;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n")
    .trim();
}

async function fetchFullTicket(id: string, token: string): Promise<ZohoTicket> {
  const [detail, threadData] = await Promise.all([
    zohoGet(`/tickets/${id}`, token) as Promise<ZohoTicket>,
    zohoGet(`/tickets/${id}/threads`, token) as Promise<{ data?: ZohoThread[] }>,
  ]);

  // The thread list returns empty content; individual thread endpoint has the full HTML
  const threads = await Promise.all(
    (threadData.data ?? []).map(async (th) => {
      const full = (await zohoGet(`/tickets/${id}/threads/${th.id}`, token)) as ZohoThread & { content?: string };
      const rawContent = full.content ?? "";
      return {
        ...th,
        content: rawContent ? stripHtml(rawContent) : (th.summary ?? ""),
      };
    })
  );

  return { ...detail, threads };
}

function buildEmailContext(tickets: ZohoTicket[]): string {
  return tickets
    .map((t) => {
      const cf = t.customFields ?? {};
      const threadText = (t.threads ?? [])
        .map((th) => {
          const who = th.direction === "in" ? "Customer" : "Agent";
          const name = th.author?.name ? ` (${th.author.name})` : "";
          const body = th.content ?? th.summary ?? "(no content)";
          const time = th.createdTime ? ` [${th.createdTime}]` : "";
          return `[${who}${name}${time}]:\n${body}`;
        })
        .join("\n\n");

      return `
TICKET #${t.ticketNumber} — ${t.subject}
Status: ${t.status ?? "Unknown"}
Product: ${cf["Product"] ?? "Unknown"} | Model: ${cf["Device Model"] ?? "Unknown"}
Serial Number (SR ID): ${cf["Device Serial Number"] ?? "Unknown"}
Fault Code: ${[cf["Fault Code Level 1"], cf["Fault Code Level 2"], cf["Fault Code Level 3"]].filter(Boolean).join(" > ")}
Resolution: ${[cf["Resolution Code Level 1"], cf["Resolution Code Level 2"]].filter(Boolean).join(" > ")}
Warranty: ${cf["Device Warranty"] ?? "Unknown"}
Software Version: ${cf["Software Version"] ?? "Unknown"}
Customer Name: ${cf["Name"] ?? (t as ZohoTicket & { contact?: { fullName?: string } }).contact?.fullName ?? "Unknown"}
Customer Phone: ${t.phone ?? "Unknown"} | Email: ${t.email ?? "Unknown"}

CONVERSATION THREAD:
${threadText || "(no conversation threads)"}
      `.trim();
    })
    .join("\n\n" + "─".repeat(60) + "\n\n");
}

export function registerZohoRoutes(app: Express): void {
  // GET /api/zoho/lookup?phone=9816909508
  // GET /api/zoho/lookup?email=customer@example.com
  // GET /api/zoho/lookup?serialNumber=IN2213JWIK03781
  app.get("/api/zoho/lookup", async (req: Request, res: Response) => {
    const { phone, email, serialNumber } = req.query as Record<string, string | undefined>;

    if (!phone && !email && !serialNumber) {
      return res.status(400).json({ error: "Provide at least one of: phone, email, serialNumber" });
    }
    if (!process.env.ZOHO_REFRESH_TOKEN) {
      return res.status(503).json({ error: "Zoho integration not configured (missing env vars)" });
    }

    try {
      const token = await getZohoToken();
      let ticketIds: string[] = [];

      if (phone) {
        ticketIds = await searchTicketsByPhone(phone, token);
      } else if (email) {
        ticketIds = await searchTicketsByEmail(email, token);
      } else if (serialNumber) {
        ticketIds = await searchTicketsBySerial(serialNumber, token);
      }

      if (ticketIds.length === 0) {
        return res.json({ tickets: [] });
      }

      // Cap at 10 tickets to avoid very slow responses
      const limitedIds = ticketIds.slice(0, 10);
      const tickets = await Promise.all(limitedIds.map((id) => fetchFullTicket(id, token)));

      return res.json({ tickets, total: ticketIds.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[Zoho lookup error]", message);
      return res.status(500).json({ error: message });
    }
  });

  // POST /api/zoho/draft-email
  // Body: { tickets: ZohoTicket[] }
  app.post("/api/zoho/draft-email", async (req: Request, res: Response) => {
    const { tickets } = req.body as { tickets?: ZohoTicket[] };

    if (!tickets?.length) {
      return res.status(400).json({ error: "Provide at least one ticket in the request body" });
    }

    try {
      const context = buildEmailContext(tickets);
      const openai = new OpenAI({
        apiKey:
          process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
      });

      const systemInstructions = `You are a senior customer support specialist at Hero Electronix (brand: Qubo).
Your job is to draft a professional, empathetic email reply to the customer based on the ticket data provided.

Rules:
- Address the customer by name (use their first name)
- Acknowledge the issue clearly in the opening line
- Summarize what has been diagnosed or done so far (use thread history)
- Give clear next steps or the resolution
- Tone: warm but professional — not robotic, not overly formal
- Do NOT expose internal codes like Fault Code L1/L2 or internal ticket IDs in the email
- Always end with a placeholder: "Warm regards,\\n[Agent Name]\\nQubo Customer Support\\nHero Electronix Pvt. Ltd."
- Write ONLY the email body starting with the salutation. No subject line needed.
- If multiple tickets are provided, write one consolidated email covering all issues.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemInstructions },
          {
            role: "user",
            content: `Draft an email reply to the customer based on this ticket context:\n\n${context}`,
          },
        ],
      });

      const draft = completion.choices[0]?.message?.content ?? "";
      return res.json({ draft });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[Zoho draft-email error]", message);
      return res.status(500).json({ error: message });
    }
  });
}
