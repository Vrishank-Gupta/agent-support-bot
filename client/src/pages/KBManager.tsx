import { useState, useRef, KeyboardEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sidebar } from "@/components/Sidebar";
import {
  Plus, Trash2, Edit2, Save, X, Upload, FileText, Cloud,
  CheckCircle2, AlertCircle, Loader2, ExternalLink, BookOpen, Tag, Link2, Lock,
  Folder, FolderOpen, File as FileIcon, Download, RefreshCw, Settings2, RotateCcw, RefreshCcw
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useUser, useAuthHeaders } from "@/lib/userContext";
import type { KnowledgeBase } from "@shared/schema";

interface OdFileItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number;
  webUrl: string;
  path: string;
}

/* ── Tag chip input ─────────────────────────────────── */
function TagInput({
  label,
  placeholder,
  values,
  onChange,
  testId,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
    setDraft("");
  };

  const remove = (v: string) => onChange(values.filter(x => x !== v));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    if (e.key === "Backspace" && !draft && values.length) remove(values[values.length - 1]);
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5 min-h-10 p-2 border border-input rounded-md bg-background focus-within:ring-2 focus-within:ring-ring">
        {values.map(v => (
          <span key={v} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium border border-primary/20">
            {v}
            <button type="button" onClick={() => remove(v)} className="hover:text-destructive transition-colors"><X className="w-3 h-3" /></button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          placeholder={values.length === 0 ? placeholder : "Add another…"}
          value={draft}
          data-testid={testId}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">Press Enter or comma to add each value</p>
    </div>
  );
}

/* ── Type badge config ──────────────────────────────── */
const typeLabels: Record<string, { label: string; color: string }> = {
  onedrive: { label: "OneDrive", color: "bg-blue-100 text-blue-700 border-blue-200" },
  zoho_ticket: { label: "Zoho Ticket", color: "bg-orange-100 text-orange-700 border-orange-200" },
  zoho_kb: { label: "Zoho KB", color: "bg-purple-100 text-purple-700 border-purple-200" },
  manual: { label: "Manual", color: "bg-gray-100 text-gray-700 border-gray-200" },
};

/* ── Pending file state for tag dialog ──────────────── */
interface PendingFile {
  file: File;
  productCategories: string[];
  modelNumbers: string[];
}

/* ══════════════════════════════════════════════════════
   KBManager
══════════════════════════════════════════════════════ */
export function KBManager() {
  const { toast } = useToast();
  const { canAddKB } = useUser();
  const authHeaders = useAuthHeaders();

  // Editing / adding state
  const [isEditing, setIsEditing] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editForm, setEditForm] = useState({
    title: "", content: "", type: "manual",
    productCategories: [] as string[],
    modelNumbers: [] as string[],
  });

  // File upload state
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tag dialog for file upload
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);

  // OneDrive browser state
  const [odUrl, setOdUrl] = useState("");
  const [odUrlStatus, setOdUrlStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [odPendingTags, setOdPendingTags] = useState<{ productCategories: string[]; modelNumbers: string[] } | null>(null);
  const [odBrowseStatus, setOdBrowseStatus] = useState<"idle" | "browsing" | "done" | "error">("idle");
  const [odFiles, setOdFiles] = useState<OdFileItem[]>([]);
  const [odUpn, setOdUpn] = useState("");
  const [odBrowseError, setOdBrowseError] = useState("");
  const [odSelected, setOdSelected] = useState<Set<string>>(new Set());
  const [odImportTags, setOdImportTags] = useState({ productCategories: [] as string[], modelNumbers: [] as string[] });
  const [odImportStatus, setOdImportStatus] = useState<"idle" | "importing" | "done">("idle");
  const [odImportProgress, setOdImportProgress] = useState({ done: 0, total: 0 });
  // URL type detection: "sharing-file" | "sharing-folder" | "folder-url" | "unknown"
  const [odUrlType, setOdUrlType] = useState<"sharing-file" | "sharing-folder" | "folder-url" | "unknown">("unknown");
  const [odSingleImportStatus, setOdSingleImportStatus] = useState<"idle" | "importing" | "done" | "error">("idle");
  // Check if MS credentials are configured
  const { data: odStatus } = useQuery<{ configured: boolean }>({ queryKey: ["/api/onedrive/status"] });

  const { data: kbs, isLoading } = useQuery<KnowledgeBase[]>({ queryKey: ["/api/kb"] });

  /* mutations */
  const createMutation = useMutation({
    mutationFn: (data: typeof editForm) => apiRequest("POST", "/api/kb", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setIsAdding(false);
      setEditForm({ title: "", content: "", type: "manual", productCategories: [], modelNumbers: [] });
      toast({ title: "Source added" });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<typeof editForm> }) =>
      apiRequest("PATCH", `/api/kb/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setIsEditing(null);
      toast({ title: "Source updated" });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/kb/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      toast({ title: "Source deleted" });
    }
  });

  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [spExpiredOpen, setSpExpiredOpen] = useState(false);
  const [importTab, setImportTab] = useState("file");
  const importCardRef = useRef<HTMLDivElement>(null);

  // SharePoint master link sync state
  const [spMasterLink, setSpMasterLink] = useState("");
  const [spMasterLinkDraft, setSpMasterLinkDraft] = useState("");
  const [spLinkSaving, setSpLinkSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncResult, setSyncResult] = useState<{
    updated: number; added: number; removed: number;
    addedFiles: string[]; removedFiles: string[]; errors: string[]; total: number;
  } | null>(null);
  const [syncError, setSyncError] = useState("");

  // Load stored master link on mount
  const { data: spLinkData } = useQuery<{ link: string }>({ queryKey: ["/api/settings/sharepoint-master-link"] });

  const handleSaveMasterLink = async () => {
    if (!spMasterLinkDraft.trim()) return;
    setSpLinkSaving(true);
    try {
      await apiRequest("PUT", "/api/settings/sharepoint-master-link", { link: spMasterLinkDraft.trim() }, authHeaders);
      setSpMasterLink(spMasterLinkDraft.trim());
      queryClient.invalidateQueries({ queryKey: ["/api/settings/sharepoint-master-link"] });
      toast({ title: "Master link saved" });
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message, variant: "destructive" });
    } finally {
      setSpLinkSaving(false);
    }
  };

  const handleSyncSharePoint = async () => {
    setSyncStatus("syncing");
    setSyncResult(null);
    setSyncError("");
    try {
      const res = await apiRequest("POST", "/api/kb/sync-sharepoint", {}, authHeaders);
      const result = await res.json() as {
        updated: number; added: number; removed: number;
        addedFiles: string[]; removedFiles: string[]; errors: string[]; total: number;
      };
      setSyncResult(result);
      setSyncStatus("done");
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      toast({ title: `Sync complete — ${result.updated} updated, ${result.added} added, ${result.removed} removed` });
    } catch (err: any) {
      let msg = err?.message || "Sync failed";
      try { const j = JSON.parse(msg.replace(/^\d+:\s*/, "")); msg = j?.error || msg; } catch { /* noop */ }
      setSyncError(msg);
      setSyncStatus("error");
      toast({ title: "Sync failed", description: msg, variant: "destructive" });
    }
  };

  const handleRefreshKB = async (id: number) => {
    setRefreshingId(id);
    try {
      await apiRequest("POST", `/api/kb/${id}/refresh`, {});
      await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      toast({ title: "KB entry refreshed", description: "Content has been pulled fresh from SharePoint." });
    } catch (err: any) {
      // Parse the JSON body from "503: {...}" error strings
      let code = "refresh_failed";
      try {
        const jsonPart = err?.message?.replace(/^\d+:\s*/, "");
        const parsed = JSON.parse(jsonPart);
        code = parsed?.code ?? code;
      } catch { /* not JSON — ignore */ }

      if (code === "sharepoint_expired") {
        setSpExpiredOpen(true);
      } else {
        toast({ title: "Refresh failed", description: err?.message || "Could not refresh this entry.", variant: "destructive" });
      }
    } finally {
      setRefreshingId(null);
    }
  };

  /* sync spLinkData into draft when it loads */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spLinkLoaded = spLinkData?.link ?? "";
  if (spLinkLoaded && spMasterLink !== spLinkLoaded) {
    setSpMasterLink(spLinkLoaded);
    setSpMasterLinkDraft(spLinkLoaded);
  }

  /* file upload with tags */
  const executeUpload = async (pending: PendingFile) => {
    setPendingFile(null);
    setUploadStatus("uploading");
    setUploadMessage(`Uploading ${pending.file.name}…`);

    const formData = new FormData();
    formData.append("file", pending.file);
    formData.append("productCategories", JSON.stringify(pending.productCategories));
    formData.append("modelNumbers", JSON.stringify(pending.modelNumbers));

    try {
      const res = await fetch("/api/kb/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setUploadStatus("success");
      setUploadMessage(`${pending.file.name} imported successfully.`);
      toast({ title: "File imported", description: `${pending.file.name} added to the knowledge base.` });
      setTimeout(() => setUploadStatus("idle"), 3000);
    } catch (err: any) {
      setUploadStatus("error");
      setUploadMessage(err.message || "Upload failed");
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
      setTimeout(() => setUploadStatus("idle"), 4000);
    }
  };

  /* open tag dialog when a file is picked */
  const openTagDialog = (file: File) => {
    setPendingFile({ file, productCategories: [], modelNumbers: [] });
  };

  /* OneDrive URL submit — opens tag dialog */
  const handleOdUrlSubmit = () => {
    if (!odUrl.trim()) return;
    setOdPendingTags({ productCategories: [], modelNumbers: [] });
  };

  /* Extract a human-readable name from OneDrive / SharePoint sharing URLs */
  const extractOdTitle = (url: string): string => {
    try {
      const parsed = new URL(url);
      // SharePoint pattern: ?id=/path/to/FileName or ?id=...%2FFileName
      const idParam = parsed.searchParams.get("id");
      if (idParam) {
        const decoded = decodeURIComponent(idParam);
        const segment = decoded.split("/").filter(Boolean).pop();
        if (segment) return `OneDrive: ${segment}`;
      }
      // OneDrive personal pattern: extract from path segments, ignore known system paths
      const skipSegments = new Set(["_layouts", "15", "onedrive.aspx", "download.aspx", "embed", "view.aspx"]);
      const pathParts = parsed.pathname.split("/").filter(p => p && !skipSegments.has(p));
      const last = pathParts.pop();
      if (last) return `OneDrive: ${decodeURIComponent(last).replace(/\?.*$/, "")}`;
    } catch {}
    return "OneDrive Document";
  };

  const executeOdImport = async () => {
    if (!odUrl.trim() || !odPendingTags) return;
    setOdPendingTags(null);
    setOdUrlStatus("loading");
    try {
      const title = extractOdTitle(odUrl);
      await apiRequest("POST", "/api/kb", {
        title,
        content: `[OneDrive Link] ${odUrl}\n\n⚠️ Content not yet pasted. Edit this entry and paste the document text so the AI can use it.`,
        type: "onedrive",
        productCategories: odPendingTags.productCategories,
        modelNumbers: odPendingTags.modelNumbers,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setOdUrlStatus("success");
      setOdUrl("");
      toast({ title: "OneDrive link added", description: "Edit the entry to paste document content for AI access." });
      setTimeout(() => setOdUrlStatus("idle"), 3000);
    } catch {
      setOdUrlStatus("error");
      setTimeout(() => setOdUrlStatus("idle"), 4000);
    }
  };

  // Detect URL type when URL changes
  const detectUrlType = async (url: string) => {
    if (!url.trim()) { setOdUrlType("unknown"); return; }
    try {
      const res = await apiRequest("POST", "/api/onedrive/detect", { url }) as { type: string };
      setOdUrlType(res.type as any);
    } catch {
      setOdUrlType("unknown");
    }
  };

  // Import a single publicly shared file (no credentials)
  const handleOdImportSingleFile = async () => {
    if (!odUrl.trim()) return;
    setOdSingleImportStatus("importing");
    try {
      await apiRequest("POST", "/api/onedrive/import-shared-file", {
        url: odUrl,
        productCategories: odImportTags.productCategories,
        modelNumbers: odImportTags.modelNumbers,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setOdSingleImportStatus("done");
      toast({ title: "File imported from OneDrive!" });
      setTimeout(() => {
        setOdSingleImportStatus("idle");
        setOdUrl("");
        setOdUrlType("unknown");
        setOdImportTags({ productCategories: [], modelNumbers: [] });
      }, 2000);
    } catch (err: any) {
      setOdSingleImportStatus("error");
      toast({ title: "Import failed", description: err?.message, variant: "destructive" });
      setTimeout(() => setOdSingleImportStatus("idle"), 3000);
    }
  };

  // New: browse a folder URL via Graph API
  const handleOdBrowse = async () => {
    if (!odUrl.trim()) return;
    setOdBrowseStatus("browsing");
    setOdBrowseError("");
    setOdFiles([]);
    setOdSelected(new Set());
    try {
      // Route to the right endpoint based on URL type
      let data: { files: OdFileItem[] };
      if (odUrlType === "sharing-folder") {
        const res = await apiRequest("POST", "/api/onedrive/browse-shared", { url: odUrl });
        data = res as { files: OdFileItem[] };
      } else {
        const res = await apiRequest("POST", "/api/onedrive/browse", { url: odUrl });
        data = res as { files: OdFileItem[]; parsed: { upn: string; drivePath: string } };
        setOdUpn((res as any).parsed?.upn || "");
      }
      setOdFiles((data.files || []).filter(f => !f.isFolder));
      setOdBrowseStatus("done");
    } catch (err: any) {
      setOdBrowseError(err?.message || "Failed to browse folder");
      setOdBrowseStatus("error");
    }
  };

  // New: import selected files from OneDrive
  const handleOdImportSelected = async () => {
    const selected = odFiles.filter(f => odSelected.has(f.id));
    if (!selected.length) return;
    setOdImportStatus("importing");
    setOdImportProgress({ done: 0, total: selected.length });

    const isSharedFolder = odUrlType === "sharing-folder";

    let done = 0;
    for (const file of selected) {
      try {
        const endpoint = isSharedFolder
          ? "/api/onedrive/import-shared-folder-file"
          : "/api/onedrive/import-file";
        const body = isSharedFolder
          ? { fileItem: file, productCategories: odImportTags.productCategories, modelNumbers: odImportTags.modelNumbers, folderUrl: odUrl }
          : { fileItem: file, upn: odUpn, productCategories: odImportTags.productCategories, modelNumbers: odImportTags.modelNumbers };
        await apiRequest("POST", endpoint, body);
        done++;
        setOdImportProgress({ done, total: selected.length });
      } catch (err: any) {
        toast({ title: `Failed to import ${file.name}`, description: err?.message, variant: "destructive" });
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
    setOdImportStatus("done");
    toast({ title: `${done}/${selected.length} files imported to KB` });
    setTimeout(() => {
      setOdImportStatus("idle");
      setOdBrowseStatus("idle");
      setOdFiles([]);
      setOdSelected(new Set());
      setOdUrl("");
      setOdImportTags({ productCategories: [], modelNumbers: [] });
    }, 2000);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) openTagDialog(file);
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar isWidgetMode={false} onToggleWidget={() => {}} />
      <div className="flex-1 flex flex-col overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-8 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-primary" />
              Knowledge Base
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {kbs?.length ?? 0} source{kbs?.length !== 1 ? "s" : ""} · bot uses all sources when answering
            </p>
          </div>
          {canAddKB ? (
            <Button
              onClick={() => { setIsAdding(true); setEditForm({ title: "", content: "", type: "manual", productCategories: [], modelNumbers: [] }); }}
              className="gap-2"
              data-testid="button-add-source"
            >
              <Plus className="w-4 h-4" /> Add Manually
            </Button>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-1.5">
              <Lock className="w-3.5 h-3.5" /> View only
            </div>
          )}
        </div>

        <div className="p-8 max-w-5xl mx-auto w-full space-y-8">

          {/* ── SharePoint session expired dialog ── */}
          <Dialog open={spExpiredOpen} onOpenChange={setSpExpiredOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                  SharePoint Session Expired
                </DialogTitle>
              </DialogHeader>
              <div className="text-sm text-muted-foreground space-y-2 py-1">
                <p>The automatic refresh couldn't reconnect to SharePoint — the session token has expired.</p>
                <p>To update this file's content, paste the original SharePoint sharing link into the <strong>OneDrive URL</strong> import tab below. That will pull a fresh copy and update the KB entry.</p>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSpExpiredOpen(false)}>Close</Button>
                <Button onClick={() => {
                  setSpExpiredOpen(false);
                  setImportTab("url");
                  setTimeout(() => importCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                }}>
                  Open Import Tab
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ── SharePoint Master Sync ── */}
          {canAddKB && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <RefreshCcw className="w-5 h-5 text-green-600" />
                  Sync from SharePoint
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Store your master SharePoint folder link here. Clicking <strong>Sync Now</strong> re-downloads every
                  matching KB entry from that folder — no browsing needed.
                </p>

                <div className="flex gap-2">
                  <Input
                    placeholder="Paste SharePoint folder sharing link…"
                    value={spMasterLinkDraft}
                    data-testid="input-sp-master-link"
                    onChange={e => setSpMasterLinkDraft(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    onClick={handleSaveMasterLink}
                    disabled={spLinkSaving || !spMasterLinkDraft.trim() || spMasterLinkDraft === spMasterLink}
                    data-testid="button-save-master-link"
                  >
                    {spLinkSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    <span className="ml-1.5">Save</span>
                  </Button>
                </div>

                {spMasterLink && (
                  <div className="flex items-center justify-between p-3 rounded-lg bg-green-50 border border-green-100">
                    <div className="flex items-center gap-2 text-sm text-green-700 min-w-0">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span className="truncate font-medium">Master link saved</span>
                    </div>
                    <Button
                      onClick={handleSyncSharePoint}
                      disabled={syncStatus === "syncing"}
                      data-testid="button-sync-sharepoint"
                      className="ml-3 shrink-0"
                    >
                      {syncStatus === "syncing" ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</>
                      ) : (
                        <><RefreshCcw className="w-4 h-4 mr-2" />Sync Now</>
                      )}
                    </Button>
                  </div>
                )}

                {syncStatus === "done" && syncResult && (
                  <div className="rounded-lg border border-border p-4 space-y-2 text-sm">
                    <p className="font-medium text-foreground">Sync complete — {syncResult.total} files in SharePoint</p>
                    <p className="text-green-700">✓ {syncResult.updated} updated</p>
                    {syncResult.added > 0 && (
                      <div>
                        <p className="text-blue-600 font-medium">+ {syncResult.added} new file{syncResult.added > 1 ? "s" : ""} added to KB:</p>
                        <ul className="mt-1 ml-4 list-disc text-muted-foreground space-y-0.5">
                          {syncResult.addedFiles.map(f => <li key={f}>{f}</li>)}
                        </ul>
                      </div>
                    )}
                    {syncResult.removed > 0 && (
                      <div>
                        <p className="text-amber-600 font-medium">− {syncResult.removed} removed (no longer in SharePoint):</p>
                        <ul className="mt-1 ml-4 list-disc text-muted-foreground space-y-0.5">
                          {syncResult.removedFiles.map(f => <li key={f}>{f}</li>)}
                        </ul>
                      </div>
                    )}
                    {syncResult.errors.length > 0 && (
                      <div>
                        <p className="text-destructive font-medium">✗ {syncResult.errors.length} error{syncResult.errors.length > 1 ? "s" : ""}:</p>
                        <ul className="mt-1 ml-4 list-disc text-muted-foreground space-y-0.5">
                          {syncResult.errors.map(e => <li key={e}>{e}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {syncStatus === "error" && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{syncError}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Upload zone ── */}
          {canAddKB && (
            <Card ref={importCardRef}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cloud className="w-5 h-5 text-blue-500" />
                  Import from OneDrive / Local Files
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs value={importTab} onValueChange={setImportTab}>
                  <TabsList className="mb-4">
                    <TabsTrigger value="file" className="gap-2"><Upload className="w-3.5 h-3.5" /> Upload File</TabsTrigger>
                    <TabsTrigger value="url" className="gap-2"><Link2 className="w-3.5 h-3.5" /> OneDrive URL</TabsTrigger>
                  </TabsList>

                  {/* File upload tab */}
                  <TabsContent value="file" className="space-y-4">
                    <div
                      data-testid="dropzone"
                      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => uploadStatus === "idle" && fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                        isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/40"
                      }`}
                    >
                      {uploadStatus === "uploading" ? (
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-10 h-10 text-primary animate-spin" />
                          <p className="text-sm text-muted-foreground">{uploadMessage}</p>
                        </div>
                      ) : uploadStatus === "success" ? (
                        <div className="flex flex-col items-center gap-3">
                          <CheckCircle2 className="w-10 h-10 text-green-500" />
                          <p className="text-sm text-green-600 font-medium">{uploadMessage}</p>
                        </div>
                      ) : uploadStatus === "error" ? (
                        <div className="flex flex-col items-center gap-3">
                          <AlertCircle className="w-10 h-10 text-destructive" />
                          <p className="text-sm text-destructive">{uploadMessage}</p>
                          <p className="text-xs text-muted-foreground">Click to try again</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3">
                          <Upload className="w-10 h-10 text-muted-foreground" />
                          <div>
                            <p className="font-medium text-foreground">Drag & drop files here, or click to browse</p>
                            <p className="text-sm text-muted-foreground mt-1">PDF, TXT, Markdown — up to 20 MB · You'll tag product & model before import</p>
                          </div>
                        </div>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.txt,.md,.doc,.docx"
                        className="hidden"
                        data-testid="input-file-upload"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) openTagDialog(file);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  </TabsContent>

                  {/* OneDrive URL tab */}
                  <TabsContent value="url" className="space-y-4">
                    <div className="space-y-3">

                      {/* Info banner */}
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700">
                        <svg className="w-5 h-5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none">
                          <path d="M3 16.5C3 18.43 4.57 20 6.5 20h11C19.43 20 21 18.43 21 16.5c0-1.64-1.11-3.02-2.63-3.42-.07-.33-.19-.63-.34-.91A5.5 5.5 0 0 0 7.08 11.1 3.5 3.5 0 0 0 3 14.5" fill="#0078D4" fillOpacity=".3"/>
                          <path d="M13.5 8C11.57 8 10 9.57 10 11.5v.08A5.5 5.5 0 0 1 18.03 13.08C18.82 13.58 19.42 14.35 19.74 15.26A3.5 3.5 0 0 0 17.5 8.5a3.4 3.4 0 0 0-4-.5z" fill="#0078D4"/>
                        </svg>
                        <div>
                          Paste a OneDrive/SharePoint link. The system auto-detects the type.{" "}
                          <span className="font-medium">For zero-credential access</span>, set your file or folder to{" "}
                          <span className="font-medium">"Anyone – doesn't require sign-in"</span> before copying the link.
                        </div>
                      </div>

                      {/* URL input */}
                      <div className="space-y-2">
                        <Label>OneDrive / SharePoint URL</Label>
                        <Input
                          placeholder="Paste sharing link or folder URL…"
                          value={odUrl}
                          data-testid="input-onedrive-url"
                          onChange={e => {
                            const v = e.target.value;
                            setOdUrl(v);
                            setOdBrowseStatus("idle");
                            setOdBrowseError("");
                            setOdSingleImportStatus("idle");
                            setOdFiles([]);
                            setOdSelected(new Set());
                            detectUrlType(v);
                          }}
                        />

                        {/* URL type badge */}
                        {odUrl.trim() && odUrlType !== "unknown" && (
                          <div className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full w-fit ${
                            odUrlType === "sharing-file"   ? "bg-green-100 text-green-700" :
                            odUrlType === "sharing-folder" ? "bg-green-100 text-green-700" :
                                                             "bg-amber-100 text-amber-700"
                          }`}>
                            {odUrlType === "sharing-file"   && <><CheckCircle2 className="w-3 h-3" /> Public sharing link – single file (no credentials needed)</>}
                            {odUrlType === "sharing-folder" && <><CheckCircle2 className="w-3 h-3" /> Public sharing link – folder (no credentials needed)</>}
                            {odUrlType === "folder-url"     && <><Settings2 className="w-3 h-3" /> Internal folder URL (Azure credentials required)</>}
                          </div>
                        )}
                      </div>

                      {/* ── CASE 1: Single publicly shared file ── */}
                      {odUrlType === "sharing-file" && (
                        <div className="border rounded-lg p-3 bg-muted/30 space-y-3">
                          <p className="text-sm font-medium">Tag & Import</p>
                          <TagInput
                            label="Product Categories"
                            placeholder="e.g. Cam360"
                            values={odImportTags.productCategories}
                            onChange={v => setOdImportTags(t => ({ ...t, productCategories: v }))}
                            testId="input-od-categories"
                          />
                          <TagInput
                            label="Model Numbers"
                            placeholder="e.g. HE-CAM360"
                            values={odImportTags.modelNumbers}
                            onChange={v => setOdImportTags(t => ({ ...t, modelNumbers: v }))}
                            testId="input-od-models"
                          />
                          <Button
                            className="w-full"
                            onClick={handleOdImportSingleFile}
                            disabled={odSingleImportStatus === "importing"}
                            data-testid="button-onedrive-import-single"
                          >
                            {odSingleImportStatus === "importing" ? (
                              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Downloading & importing…</>
                            ) : odSingleImportStatus === "done" ? (
                              <><CheckCircle2 className="w-4 h-4 mr-2" />Imported!</>
                            ) : (
                              <><Download className="w-4 h-4 mr-2" />Import file</>
                            )}
                          </Button>
                          {odSingleImportStatus === "error" && (
                            <p className="text-xs text-destructive text-center">
                              Import failed. Make sure the link is set to "Anyone – doesn't require sign-in".
                            </p>
                          )}
                        </div>
                      )}

                      {/* ── CASE 2 & 3: Folder (shared or credentialed) ── */}
                      {(odUrlType === "sharing-folder" || odUrlType === "folder-url") && (
                        <>
                          {/* Credentials warning for internal URLs */}
                          {odUrlType === "folder-url" && odStatus && !odStatus.configured && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                              <Settings2 className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>
                                This is an internal folder URL. Azure credentials are required:{" "}
                                <code className="font-mono text-xs bg-amber-100 px-1 rounded">MS_TENANT_ID</code>,{" "}
                                <code className="font-mono text-xs bg-amber-100 px-1 rounded">MS_CLIENT_ID</code>,{" "}
                                <code className="font-mono text-xs bg-amber-100 px-1 rounded">MS_CLIENT_SECRET</code>.
                              </span>
                            </div>
                          )}

                          <div className="flex gap-2">
                            <Button
                              className="flex-1"
                              onClick={handleOdBrowse}
                              disabled={
                                odBrowseStatus === "browsing" ||
                                (odUrlType === "folder-url" && !odStatus?.configured)
                              }
                              data-testid="button-onedrive-browse"
                              variant="outline"
                            >
                              {odBrowseStatus === "browsing"
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading files…</>
                                : <><FolderOpen className="w-4 h-4 mr-2" />Browse folder</>
                              }
                            </Button>
                          </div>

                          {odBrowseError && (
                            <p className="text-sm text-destructive flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />{odBrowseError}
                            </p>
                          )}

                          {odBrowseStatus === "done" && odFiles.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-4">No supported files found.</p>
                          )}

                          {odBrowseStatus === "done" && odFiles.length > 0 && (
                            <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium">{odFiles.length} files found</p>
                                <div className="flex gap-2 text-xs text-muted-foreground">
                                  <button className="underline hover:text-foreground" onClick={() => setOdSelected(new Set(odFiles.map(f => f.id)))}>Select all</button>
                                  <button className="underline hover:text-foreground" onClick={() => setOdSelected(new Set())}>Clear</button>
                                </div>
                              </div>

                              <div className="max-h-48 overflow-y-auto space-y-1">
                                {odFiles.map(file => (
                                  <label key={file.id} className="flex items-center gap-2 p-2 rounded-md hover:bg-muted cursor-pointer text-sm" data-testid={`checkbox-odfile-${file.id}`}>
                                    <input
                                      type="checkbox"
                                      className="rounded"
                                      checked={odSelected.has(file.id)}
                                      onChange={e => {
                                        const next = new Set(odSelected);
                                        if (e.target.checked) next.add(file.id); else next.delete(file.id);
                                        setOdSelected(next);
                                      }}
                                    />
                                    <FileIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                                    <span className="truncate flex-1">{file.name}</span>
                                    <span className="text-xs text-muted-foreground shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
                                  </label>
                                ))}
                              </div>

                              <div className="border-t pt-3 space-y-3">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tag imported files</p>
                                <TagInput label="Product Categories" placeholder="e.g. Cam360" values={odImportTags.productCategories} onChange={v => setOdImportTags(t => ({ ...t, productCategories: v }))} testId="input-od-categories" />
                                <TagInput label="Model Numbers" placeholder="e.g. HE-CAM360" values={odImportTags.modelNumbers} onChange={v => setOdImportTags(t => ({ ...t, modelNumbers: v }))} testId="input-od-models" />
                              </div>

                              <Button
                                className="w-full"
                                onClick={handleOdImportSelected}
                                disabled={odSelected.size === 0 || odImportStatus === "importing"}
                                data-testid="button-onedrive-import"
                              >
                                {odImportStatus === "importing" ? (
                                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing {odImportProgress.done}/{odImportProgress.total}…</>
                                ) : odImportStatus === "done" ? (
                                  <><CheckCircle2 className="w-4 h-4 mr-2" />Imported!</>
                                ) : (
                                  <><Download className="w-4 h-4 mr-2" />Import {odSelected.size || ""} selected file{odSelected.size !== 1 ? "s" : ""}</>
                                )}
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}

          {/* ── Manual add form ── */}
          {isAdding && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle className="text-base">Add Knowledge Source</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    placeholder="e.g. Zoho KB: 2FA Setup Guide"
                    value={editForm.title}
                    data-testid="input-kb-title"
                    onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                  />
                </div>

                {/* Type selector */}
                <div className="space-y-2">
                  <Label>Source Type</Label>
                  <div className="flex gap-2 flex-wrap">
                    {Object.entries(typeLabels).map(([val, { label, color }]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setEditForm({ ...editForm, type: val })}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                          editForm.type === val ? color + " ring-2 ring-primary/40" : "border-border text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tag inputs */}
                <TagInput
                  label="Product Category"
                  placeholder="e.g. Router, Switch, Modem"
                  values={editForm.productCategories}
                  onChange={v => setEditForm({ ...editForm, productCategories: v })}
                  testId="input-product-category"
                />
                <TagInput
                  label="Model Number"
                  placeholder="e.g. RV340, WS-C3850"
                  values={editForm.modelNumbers}
                  onChange={v => setEditForm({ ...editForm, modelNumbers: v })}
                  testId="input-model-number"
                />

                <div className="space-y-2">
                  <Label>Content</Label>
                  <Textarea
                    placeholder="Paste or type the knowledge base content here..."
                    className="min-h-[200px] font-mono text-xs"
                    value={editForm.content}
                    data-testid="textarea-kb-content"
                    onChange={e => setEditForm({ ...editForm, content: e.target.value })}
                  />
                </div>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button
                  onClick={() => createMutation.mutate(editForm)}
                  disabled={createMutation.isPending || !editForm.title || !editForm.content}
                  data-testid="button-save-source"
                >
                  {createMutation.isPending ? "Saving…" : "Save Source"}
                </Button>
                <Button variant="ghost" onClick={() => setIsAdding(false)}>Cancel</Button>
              </CardFooter>
            </Card>
          )}

          {/* ── KB list ── */}
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2].map(i => <div key={i} className="h-36 bg-muted/40 rounded-xl animate-pulse" />)}
            </div>
          ) : kbs?.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No sources yet</p>
              <p className="text-sm">Upload a file or add a source manually to get started.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {kbs?.map(kb => {
                const typeMeta = typeLabels[kb.type] ?? typeLabels.manual;
                return (
                  <Card key={kb.id} data-testid={`card-kb-${kb.id}`}>
                    <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
                      <div className="flex-1 min-w-0 space-y-2">
                        {isEditing === kb.id ? (
                          <Input
                            value={editForm.title}
                            onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                            className="font-medium"
                          />
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                            <h3 className="font-semibold text-foreground text-sm">{kb.title}</h3>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${typeMeta.color}`}>
                              {typeMeta.label}
                            </span>
                          </div>
                        )}

                        {/* Tag badges row */}
                        {isEditing === kb.id ? (
                          <div className="space-y-3 pt-1">
                            <TagInput
                              label="Product Category"
                              placeholder="e.g. Router, Switch"
                              values={editForm.productCategories}
                              onChange={v => setEditForm({ ...editForm, productCategories: v })}
                              testId={`input-edit-category-${kb.id}`}
                            />
                            <TagInput
                              label="Model Number"
                              placeholder="e.g. RV340"
                              values={editForm.modelNumbers}
                              onChange={v => setEditForm({ ...editForm, modelNumbers: v })}
                              testId={`input-edit-model-${kb.id}`}
                            />
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {kb.productCategories?.map(cat => (
                              <span key={cat} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
                                <Tag className="w-2.5 h-2.5" /> {cat}
                              </span>
                            ))}
                            {kb.modelNumbers?.map(m => (
                              <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 text-[11px] font-medium">
                                # {m}
                              </span>
                            ))}
                            {(!kb.productCategories?.length && !kb.modelNumbers?.length) && (
                              <span className="text-[11px] text-muted-foreground italic">No tags — click edit to add</span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-1 shrink-0">
                        {isEditing === kb.id ? (
                          <>
                            <Button size="icon" variant="ghost" onClick={() => updateMutation.mutate({ id: kb.id, data: editForm })} disabled={updateMutation.isPending}>
                              <Save className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => setIsEditing(null)}>
                              <X className="w-4 h-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            {canAddKB && (
                              <>
                                {kb.sourceUrl && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                    title="Refresh content from OneDrive"
                                    data-testid={`button-refresh-kb-${kb.id}`}
                                    disabled={refreshingId === kb.id}
                                    onClick={() => handleRefreshKB(kb.id)}
                                  >
                                    {refreshingId === kb.id
                                      ? <Loader2 className="w-4 h-4 animate-spin" />
                                      : <RotateCcw className="w-4 h-4" />
                                    }
                                  </Button>
                                )}
                                <Button size="icon" variant="ghost" data-testid={`button-edit-kb-${kb.id}`} onClick={() => {
                                  setIsEditing(kb.id);
                                  setEditForm({
                                    title: kb.title,
                                    content: kb.content,
                                    type: kb.type,
                                    productCategories: kb.productCategories ?? [],
                                    modelNumbers: kb.modelNumbers ?? [],
                                  });
                                }}>
                                  <Edit2 className="w-4 h-4" />
                                </Button>
                                <Button size="icon" variant="ghost" className="text-destructive" data-testid={`button-delete-kb-${kb.id}`} onClick={() => {
                                  if (confirm("Delete this source?")) deleteMutation.mutate(kb.id);
                                }}>
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent>
                      {isEditing === kb.id ? (
                        <Textarea
                          value={editForm.content}
                          className="min-h-[150px] font-mono text-xs"
                          onChange={e => setEditForm({ ...editForm, content: e.target.value })}
                        />
                      ) : (
                        <>
                          {/* Warn when OneDrive entry has no real content yet */}
                          {kb.type === "onedrive" && kb.content.includes("Content not yet pasted") && (
                            <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
                              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                              <span>Document content not yet pasted — the AI can see the link but cannot read the file. Edit this entry and paste the document text.</span>
                            </div>
                          )}
                          <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed">{kb.content}</p>
                        </>
                      )}
                    </CardContent>

                    <CardFooter className="pt-0 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        Last updated {new Date(kb.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {kb.sourceUrl && (
                        <span className="flex items-center gap-1 text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5">
                          <RotateCcw className="w-2.5 h-2.5" /> Auto-refreshable from OneDrive
                        </span>
                      )}
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── OneDrive URL tag dialog ── */}
      <Dialog open={!!odPendingTags} onOpenChange={open => { if (!open) setOdPendingTags(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-5 h-5 text-primary" />
              Tag this OneDrive document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1 py-1">
            <p className="text-xs text-muted-foreground break-all font-mono bg-muted/40 rounded p-2">{odUrl}</p>
            <p className="text-xs text-muted-foreground pt-1">Add product category and model number tags so this entry is easy to find and filter.</p>
          </div>
          <div className="space-y-5 py-2">
            <TagInput
              label="Product Category *"
              placeholder="e.g. Router, Switch, Firewall"
              values={odPendingTags?.productCategories ?? []}
              onChange={v => setOdPendingTags(p => p ? { ...p, productCategories: v } : null)}
              testId="input-od-dialog-product-category"
            />
            <TagInput
              label="Model Number *"
              placeholder="e.g. RV340, ASA5505"
              values={odPendingTags?.modelNumbers ?? []}
              onChange={v => setOdPendingTags(p => p ? { ...p, modelNumbers: v } : null)}
              testId="input-od-dialog-model-number"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setOdPendingTags(null)}>Cancel</Button>
            <Button
              onClick={executeOdImport}
              disabled={!odPendingTags?.productCategories.length || !odPendingTags?.modelNumbers.length || odUrlStatus === "loading"}
              data-testid="button-od-dialog-import"
            >
              {odUrlStatus === "loading" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Link2 className="w-4 h-4 mr-2" />}
              Add to KB
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Tag dialog (shown after file selected, before upload) ── */}
      <Dialog open={!!pendingFile} onOpenChange={open => { if (!open) setPendingFile(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-5 h-5 text-primary" />
              Tag this document
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-1 py-1">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{pendingFile?.file.name}</span>
            </p>
            <p className="text-xs text-muted-foreground">Add product category and model number tags so the knowledge base stays organised. Both fields support multiple values.</p>
          </div>

          <div className="space-y-5 py-2">
            <TagInput
              label="Product Category *"
              placeholder="e.g. Router, Switch, Firewall"
              values={pendingFile?.productCategories ?? []}
              onChange={v => setPendingFile(p => p ? { ...p, productCategories: v } : null)}
              testId="input-dialog-product-category"
            />
            <TagInput
              label="Model Number *"
              placeholder="e.g. RV340, ASA5505"
              values={pendingFile?.modelNumbers ?? []}
              onChange={v => setPendingFile(p => p ? { ...p, modelNumbers: v } : null)}
              testId="input-dialog-model-number"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setPendingFile(null)}>Cancel</Button>
            <Button
              onClick={() => pendingFile && executeUpload(pendingFile)}
              disabled={!pendingFile?.productCategories.length || !pendingFile?.modelNumbers.length}
              data-testid="button-dialog-import"
            >
              <Upload className="w-4 h-4 mr-2" />
              Import Document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
