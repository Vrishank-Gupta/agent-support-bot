import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Search, Loader2, ChevronDown, ChevronUp, Mail, Copy, CheckCheck,
  Phone, AtSign, Hash, AlertCircle, Ticket,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ZohoThread {
  id: string;
  direction: string;
  content?: string;
  summary?: string;
  author?: { name?: string };
  createdTime?: string;
}

interface ZohoTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  phone?: string;
  email?: string;
  customFields?: Record<string, string>;
  contact?: { fullName?: string };
  threads?: ZohoThread[];
}

type SearchType = "phone" | "email" | "serialNumber";

// ─── Thread viewer ─────────────────────────────────────────────────────────────

function ThreadViewer({ threads }: { threads: ZohoThread[] }) {
  if (!threads.length) return <p className="text-sm text-muted-foreground italic">No conversation threads.</p>;

  return (
    <div className="space-y-3 mt-3">
      {threads.map((th) => {
        const isCustomer = th.direction === "in";
        const body = th.content ?? th.summary ?? "";
        const stripped = body.replace(/<[^>]+>/g, "").trim();
        return (
          <div key={th.id} className={`flex gap-2 ${isCustomer ? "" : "flex-row-reverse"}`}>
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                isCustomer
                  ? "bg-muted text-foreground rounded-tl-none"
                  : "bg-primary/10 text-foreground rounded-tr-none"
              }`}
            >
              <p className={`text-[10px] font-semibold mb-1 ${isCustomer ? "text-muted-foreground" : "text-primary"}`}>
                {isCustomer ? "Customer" : th.author?.name ?? "Agent"}
                {th.createdTime ? ` · ${new Date(th.createdTime).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
              </p>
              {stripped ? (
                <p className="whitespace-pre-wrap leading-relaxed">{stripped}</p>
              ) : (
                <p className="italic text-muted-foreground">(attachment or empty message)</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Ticket card ───────────────────────────────────────────────────────────────

function TicketCard({
  ticket,
  selected,
  onToggle,
}: {
  ticket: ZohoTicket;
  selected: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cf = ticket.customFields ?? {};

  const statusColor: Record<string, string> = {
    Open: "bg-yellow-100 text-yellow-800",
    Closed: "bg-green-100 text-green-800",
    "On Hold": "bg-orange-100 text-orange-800",
    Resolved: "bg-blue-100 text-blue-800",
  };

  const faultChain = [cf["Fault Code Level 1"], cf["Fault Code Level 2"], cf["Fault Code Level 3"]]
    .filter(Boolean)
    .join(" › ");
  const resolutionChain = [cf["Resolution Code Level 1"], cf["Resolution Code Level 2"]]
    .filter(Boolean)
    .join(" › ");

  return (
    <div
      className={`border rounded-xl transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border bg-card"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 h-4 w-4 cursor-pointer accent-primary"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-muted-foreground">#{ticket.ticketNumber}</span>
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                statusColor[ticket.status] ?? "bg-muted text-muted-foreground"
              }`}
            >
              {ticket.status}
            </span>
            {cf["Device Warranty"] && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                {cf["Device Warranty"]}
              </span>
            )}
          </div>
          <p className="font-medium text-sm mt-1 leading-snug">{ticket.subject}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
            {cf["Product"] && <span>{cf["Product"]}{cf["Device Model"] ? ` · ${cf["Device Model"]}` : ""}</span>}
            {cf["Device Serial Number"] && <span>SR: {cf["Device Serial Number"]}</span>}
            {cf["Software Version"] && <span>FW: {cf["Software Version"]}</span>}
          </div>
          {faultChain && (
            <p className="text-xs mt-1.5 text-red-600">Fault: {faultChain}</p>
          )}
          {resolutionChain && (
            <p className="text-xs mt-0.5 text-green-700">Resolution: {resolutionChain}</p>
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
          title={expanded ? "Collapse thread" : "View thread"}
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Thread */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border/60 pt-3">
          <ThreadViewer threads={ticket.threads ?? []} />
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function TicketDraft() {
  const { toast } = useToast();

  // Search state
  const [searchType, setSearchType] = useState<SearchType>("phone");
  const [query, setQuery] = useState("");

  // Results state
  const [tickets, setTickets] = useState<ZohoTicket[]>([]);
  const [totalFound, setTotalFound] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Draft state
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  // ── Search mutation ──
  const searchMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams({ [searchType]: query.trim() });
      const res = await apiRequest("GET", `/api/zoho/lookup?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Lookup failed" }));
        throw new Error(err.error ?? "Lookup failed");
      }
      return res.json() as Promise<{ tickets: ZohoTicket[]; total: number }>;
    },
    onSuccess: (data) => {
      setTickets(data.tickets);
      setTotalFound(data.total);
      setSelectedIds(new Set(data.tickets.map((t) => t.id)));
      setDraft("");
    },
    onError: (err: Error) => {
      toast({ title: "Lookup failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Draft mutation ──
  const draftMutation = useMutation({
    mutationFn: async () => {
      const selected = tickets.filter((t) => selectedIds.has(t.id));
      const res = await apiRequest("POST", "/api/zoho/draft-email", { tickets: selected });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Draft failed" }));
        throw new Error(err.error ?? "Draft failed");
      }
      return res.json() as Promise<{ draft: string }>;
    },
    onSuccess: (data) => {
      setDraft(data.draft);
    },
    onError: (err: Error) => {
      toast({ title: "Draft failed", description: err.message, variant: "destructive" });
    },
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const searchTypeOptions: { value: SearchType; label: string; icon: React.ReactNode; placeholder: string }[] = [
    { value: "phone", label: "Phone", icon: <Phone className="w-3.5 h-3.5" />, placeholder: "e.g. 9816909508" },
    { value: "email", label: "Email", icon: <AtSign className="w-3.5 h-3.5" />, placeholder: "e.g. customer@gmail.com" },
    { value: "serialNumber", label: "Serial No (SR ID)", icon: <Hash className="w-3.5 h-3.5" />, placeholder: "e.g. IN2213JWIK03781" },
  ];

  const currentPlaceholder = searchTypeOptions.find((o) => o.value === searchType)?.placeholder ?? "";

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <div className="hidden md:block h-full">
        <Sidebar isWidgetMode={false} onToggleWidget={() => {}} />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="h-14 border-b border-border bg-card flex items-center px-6 shrink-0 gap-3">
          <Ticket className="w-5 h-5 text-primary" />
          <span className="font-display font-semibold text-lg">Ticket Lookup & Email Draft</span>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* ── Search card ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Look up tickets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Search type selector */}
              <div className="flex gap-2 flex-wrap">
                {searchTypeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => { setSearchType(opt.value); setQuery(""); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      searchType === opt.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {opt.icon}
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Search input */}
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={currentPlaceholder}
                  onKeyDown={(e) => e.key === "Enter" && query.trim() && searchMutation.mutate()}
                  className="flex-1"
                />
                <Button
                  onClick={() => searchMutation.mutate()}
                  disabled={!query.trim() || searchMutation.isPending}
                >
                  {searchMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  <span className="ml-2">Search</span>
                </Button>
              </div>

              {searchType === "serialNumber" && (
                <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                  Serial number search scans the 200 most recent tickets — may miss older tickets.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Results ── */}
          {tickets.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                  {tickets.length} ticket{tickets.length !== 1 ? "s" : ""} found
                  {totalFound > tickets.length && (
                    <span className="font-normal text-muted-foreground ml-1">
                      (showing {tickets.length} of {totalFound})
                    </span>
                  )}
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedIds(new Set(tickets.map((t) => t.id)))}
                    className="text-xs text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-muted-foreground text-xs">·</span>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Deselect all
                  </button>
                </div>
              </div>

              {tickets.map((t) => (
                <TicketCard
                  key={t.id}
                  ticket={t}
                  selected={selectedIds.has(t.id)}
                  onToggle={() => toggleSelect(t.id)}
                />
              ))}

              {/* Draft button */}
              <div className="pt-2 flex justify-end">
                <Button
                  onClick={() => draftMutation.mutate()}
                  disabled={selectedIds.size === 0 || draftMutation.isPending}
                  className="gap-2"
                >
                  {draftMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  {draftMutation.isPending
                    ? "Drafting…"
                    : `Draft email for ${selectedIds.size} ticket${selectedIds.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          )}

          {/* No results */}
          {searchMutation.isSuccess && tickets.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Ticket className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No tickets found</p>
              <p className="text-sm mt-1">Try a different search value or check the details.</p>
            </div>
          )}

          {/* ── Email draft ── */}
          {draft && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Mail className="w-4 h-4 text-primary" />
                    Drafted Email
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => draftMutation.mutate()}
                      disabled={draftMutation.isPending}
                      className="gap-1.5 text-xs"
                    >
                      {draftMutation.isPending ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        "Regenerate"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleCopy}
                      className="gap-1.5 text-xs"
                    >
                      {copied ? (
                        <>
                          <CheckCheck className="w-3 h-3" /> Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" /> Copy
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Edit below before copying. Your changes here are not saved anywhere.
                </p>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={18}
                  className="font-mono text-sm resize-y"
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
