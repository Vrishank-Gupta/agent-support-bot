# Customer Support AI Bot

## Project Overview
A chat-based AI bot for customer support agents and escalation staff. Supports English & Hindi. Acts as a human-like trainer/guide. Integrable with Zoho CRM as a widget.

## Architecture
- **Frontend**: React + TypeScript (Vite), TanStack Query, Shadcn UI, Wouter routing
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Drizzle ORM)
- **AI**: OpenAI via Replit AI Integrations (model: `gpt-5.2`, `max_completion_tokens`, no `temperature`)
- **Port**: 5000 (serves both frontend and backend)

## Key Files
- `shared/schema.ts` — Drizzle schema (conversations, messages, knowledge_base)
- `server/replit_integrations/chat/routes.ts` — All API routes including KB and chat SSE
- `server/replit_integrations/chat/storage.ts` — Database access layer
- `client/src/pages/ChatView.tsx` — Main chat UI with SSE streaming
- `client/src/pages/KBManager.tsx` — Knowledge Base Manager with file upload
- `client/src/components/MessageBubble.tsx` — Message rendering + source badges
- `client/src/components/Sidebar.tsx` — Navigation sidebar

## Features
1. **Chat with AI** — Streaming SSE responses from GPT-5.2
2. **Source Attribution** — Bot cites KB sources as `[Source: ...]` tags rendered as badges
3. **Knowledge Base Manager** — CRUD for KB entries, file upload (PDF/TXT/MD), type tagging, OneDrive URL import
4. **File Import** — Upload PDF/TXT/Markdown files; text extracted server-side using `pdf-parse` + multer
5. **Widget Mode** — Zoho CRM embed-ready via `?widget=true` query param
6. **Multi-language** — English and Hindi supported via system prompt
7. **Email Gate** — Users must enter a whitelisted email to access the app. First user auto-becomes admin.
8. **Admin Panel** (`/admin`) — Manage whitelisted users, set roles (admin/agent) and KB permissions
9. **Token Tracking** — Every AI response records prompt/completion/total tokens in `token_usage` table; viewable in admin panel

## Auth Flow
- On first visit, users see an email prompt (EmailGate component)
- Email is checked against `whitelisted_users` table via `POST /api/auth/check-email`
- If the whitelist is empty, the first user is automatically created as admin
- User info (role, canAddKB) is stored in `localStorage` and provided via `UserProvider` context
- Admin link appears in sidebar only for admin users
- Logout button in sidebar clears localStorage

## Permissions
- `role: "admin"` — can do everything including admin panel access
- `role: "agent"` with `canAddKB: true` — can add/edit/delete KB entries
- `role: "agent"` with `canAddKB: false` — read-only access to KB
- All admin API routes require `x-user-email` header and admin role check

## Key New Files
- `client/src/lib/userContext.tsx` — UserProvider and useUser/useAuthHeaders hooks
- `client/src/components/EmailGate.tsx` — Email verification overlay
- `client/src/pages/AdminPanel.tsx` — Admin panel (users + token stats)

## Environment Variables
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Set automatically by Replit AI integration
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Set automatically by Replit AI integration
- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — Express session secret

## OneDrive Integration (NOT YET CONNECTED)
- The Microsoft OneDrive connector exists (`ccfg_onedrive_01K4E4CFAKZ9ARQZBWZW4HD05Y`) but the user dismissed the OAuth flow.
- To connect OneDrive: run `proposeIntegration("connector:ccfg_onedrive_01K4E4CFAKZ9ARQZBWZW4HD05Y")` and have the user complete the OAuth authorization.
- Currently, file import works via local file upload (PDF, TXT, MD up to 20 MB).
- The "Connect OneDrive" button in the KB Manager is shown as "Coming Soon" until OAuth is authorized.

## KB Tagging
Every KB entry has two multi-value tag fields:
- **productCategories** (`text[]`) — Product category tags (e.g. "Router", "Switch", "Firewall")
- **modelNumbers** (`text[]`) — Model number tags (e.g. "RV340", "ASA5505")

On file upload, a tag dialog opens requiring the user to add at least one product category and one model number before the import proceeds. On manual entry, the same tag fields appear in the form. Tags are displayed as coloured chips on each KB card and are included in the system prompt context sent to the AI.

## KB Entry Types
- `onedrive` — Imported from OneDrive or local file upload
- `zoho_ticket` — Zoho CRM ticket data
- `zoho_kb` — Zoho KB article links/content
- `manual` — Manually entered content
