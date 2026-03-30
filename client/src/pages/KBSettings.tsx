import { useState, useRef, KeyboardEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useAuthHeaders } from "@/lib/userContext";
import { format } from "date-fns";
import {
  Database, Edit2, Search, X, Plus, Cpu, Smartphone, Tag, CheckCircle2
} from "lucide-react";
import type { KnowledgeBase } from "@shared/schema";

// ── Tag input component ──────────────────────────────────────────────────────
function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput("");
  };

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    if (e.key === "Backspace" && !input && value.length) {
      remove(value[value.length - 1]);
    }
  };

  return (
    <div
      className="flex flex-wrap gap-1.5 min-h-[2.5rem] w-full rounded-md border border-input bg-background px-3 py-2 text-sm cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-1 bg-primary/10 text-primary text-xs rounded-full px-2 py-0.5">
          {tag}
          <button type="button" onClick={() => remove(tag)} className="hover:text-destructive">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[6rem] bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export function KBSettings() {
  const { toast } = useToast();
  const authHeaders = useAuthHeaders();
  const [isWidgetMode, setIsWidgetMode] = useState(false);
  const [search, setSearch] = useState("");
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null);

  // Sheet form state
  const [form, setForm] = useState({
    title: "",
    productCategories: [] as string[],
    modelNumbers: [] as string[],
    firmwareRequired: "",
    appVersionRequired: "",
  });

  const { data: kbs, isLoading } = useQuery<KnowledgeBase[]>({
    queryKey: ["/api/kb"],
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: object }) =>
      apiRequest("PATCH", `/api/kb/${id}`, data, authHeaders).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setEditingKb(null);
      toast({ title: "Saved", description: "KB entry updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save changes.", variant: "destructive" });
    },
  });

  const openEdit = (kb: KnowledgeBase) => {
    setEditingKb(kb);
    setForm({
      title: kb.title,
      productCategories: kb.productCategories ?? [],
      modelNumbers: kb.modelNumbers ?? [],
      firmwareRequired: kb.firmwareRequired ?? "not_applicable",
      appVersionRequired: kb.appVersionRequired ?? "not_applicable",
    });
  };

  const handleSave = () => {
    if (!editingKb) return;
    updateMutation.mutate({ id: editingKb.id, data: form });
  };

  const filtered = (kbs ?? []).filter((kb) => {
    const q = search.toLowerCase();
    return (
      kb.title.toLowerCase().includes(q) ||
      kb.productCategories?.some((c) => c.toLowerCase().includes(q)) ||
      kb.modelNumbers?.some((m) => m.toLowerCase().includes(q))
    );
  });

  const displayName = (title: string) =>
    title.replace(/^OneDrive:\s*/i, "").replace(/\.docx$/i, "");

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar isWidgetMode={isWidgetMode} onToggleWidget={() => setIsWidgetMode(!isWidgetMode)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <div className="border-b border-border bg-card/50 backdrop-blur px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary p-2 rounded-xl">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Knowledge Base Settings</h1>
              <p className="text-xs text-muted-foreground">
                {kbs?.length ?? 0} entries — view and edit metadata for each KB article
              </p>
            </div>
          </div>

          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search KB entries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
              data-testid="input-kb-search"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mr-3" />
              Loading KB entries…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
              <Database className="w-8 h-8 opacity-30" />
              <p className="text-sm">{search ? "No entries match your search." : "No KB entries found."}</p>
            </div>
          ) : (
            <table className="w-full text-sm" data-testid="table-kb-settings">
              <thead className="sticky top-0 bg-muted/60 backdrop-blur z-10 border-b border-border">
                <tr>
                  <th className="text-left px-5 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">KB Name</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Category</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                    <span className="flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5" />Firmware</span>
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                    <span className="flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5" />App Version</span>
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Models</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Last Synced</th>
                  <th className="px-4 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filtered.map((kb) => (
                  <tr
                    key={kb.id}
                    className="hover:bg-muted/30 transition-colors group"
                    data-testid={`row-kb-${kb.id}`}
                  >
                    {/* Name */}
                    <td className="px-5 py-3">
                      <p className="font-medium text-foreground leading-snug max-w-[220px] truncate" title={displayName(kb.title)}>
                        {displayName(kb.title)}
                      </p>
                    </td>

                    {/* Category */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(kb.productCategories ?? []).length > 0
                          ? kb.productCategories.map((c) => (
                              <Badge key={c} variant="secondary" className="text-xs px-2 py-0">{c}</Badge>
                            ))
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </div>
                    </td>

                    {/* Firmware */}
                    <td className="px-4 py-3">
                      {kb.firmwareRequired && kb.firmwareRequired !== "not_applicable" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-full px-2.5 py-0.5">
                          <Cpu className="w-3 h-3" />{kb.firmwareRequired}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Any
                        </span>
                      )}
                    </td>

                    {/* App Version */}
                    <td className="px-4 py-3">
                      {kb.appVersionRequired && kb.appVersionRequired !== "not_applicable" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-full px-2.5 py-0.5">
                          <Smartphone className="w-3 h-3" />{kb.appVersionRequired}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Any
                        </span>
                      )}
                    </td>

                    {/* Models */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(kb.modelNumbers ?? []).length > 0
                          ? kb.modelNumbers.map((m) => (
                              <Badge key={m} variant="outline" className="text-xs px-2 py-0 font-mono">{m}</Badge>
                            ))
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </div>
                    </td>

                    {/* Last Synced */}
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {kb.updatedAt ? format(new Date(kb.updatedAt), "MMM d, yyyy · h:mm a") : "—"}
                    </td>

                    {/* Edit button */}
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(kb)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity h-7 px-2"
                        data-testid={`button-edit-kb-${kb.id}`}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit Sheet */}
      <Sheet open={!!editingKb} onOpenChange={(open) => !open && setEditingKb(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="mb-6">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Edit2 className="w-4 h-4 text-primary" />
              Edit KB Metadata
            </SheetTitle>
            {editingKb && (
              <p className="text-xs text-muted-foreground mt-1 truncate">
                {displayName(editingKb.title)}
              </p>
            )}
          </SheetHeader>

          <div className="space-y-5">
            {/* KB Name */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                KB Name
              </Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Entry title"
                data-testid="input-edit-title"
              />
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" /> Category
              </Label>
              <TagInput
                value={form.productCategories}
                onChange={(v) => setForm({ ...form, productCategories: v })}
                placeholder="Type and press Enter…"
              />
              <p className="text-xs text-muted-foreground">e.g. Cam360, DashCam, BabyCam</p>
            </div>

            {/* Associated Models */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Associated Models
              </Label>
              <TagInput
                value={form.modelNumbers}
                onChange={(v) => setForm({ ...form, modelNumbers: v })}
                placeholder="Type model number and press Enter…"
              />
              <p className="text-xs text-muted-foreground">e.g. HE-CAM360, HE-DC200</p>
            </div>

            {/* Firmware Required */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> Latest Firmware Required
              </Label>
              <Input
                value={form.firmwareRequired === "not_applicable" ? "" : form.firmwareRequired}
                onChange={(e) =>
                  setForm({ ...form, firmwareRequired: e.target.value.trim() || "not_applicable" })
                }
                placeholder="e.g. v2.1.4  (leave blank if not applicable)"
                data-testid="input-edit-firmware"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank if no minimum firmware is required.
              </p>
            </div>

            {/* App Version Required */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Smartphone className="w-3.5 h-3.5" /> Latest App Version Required
              </Label>
              <Input
                value={form.appVersionRequired === "not_applicable" ? "" : form.appVersionRequired}
                onChange={(e) =>
                  setForm({ ...form, appVersionRequired: e.target.value.trim() || "not_applicable" })
                }
                placeholder="e.g. 3.5.0  (leave blank if not applicable)"
                data-testid="input-edit-app-version"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank if no minimum app version is required.
              </p>
            </div>

            {/* Last Synced — read-only info */}
            {editingKb && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Last Synced
                </Label>
                <div className="text-sm text-foreground bg-muted/40 border border-border rounded-md px-3 py-2">
                  {editingKb.updatedAt
                    ? format(new Date(editingKb.updatedAt), "MMMM d, yyyy 'at' h:mm a")
                    : "—"}
                </div>
              </div>
            )}
          </div>

          <SheetFooter className="mt-8 flex gap-2">
            <Button
              variant="outline"
              onClick={() => setEditingKb(null)}
              className="flex-1"
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
              data-testid="button-save-edit"
            >
              {updateMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
