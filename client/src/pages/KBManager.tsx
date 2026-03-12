import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Trash2, Edit2, Save, X, Upload, FileText, Cloud,
  CheckCircle2, AlertCircle, Loader2, ExternalLink, BookOpen
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { KnowledgeBase } from "@shared/schema";

const typeLabels: Record<string, { label: string; color: string }> = {
  onedrive: { label: "OneDrive", color: "bg-blue-100 text-blue-700 border-blue-200" },
  zoho_ticket: { label: "Zoho Ticket", color: "bg-orange-100 text-orange-700 border-orange-200" },
  zoho_kb: { label: "Zoho KB", color: "bg-purple-100 text-purple-700 border-purple-200" },
  manual: { label: "Manual", color: "bg-gray-100 text-gray-700 border-gray-200" },
};

export function KBManager() {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", content: "", type: "manual" });
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: kbs, isLoading } = useQuery<KnowledgeBase[]>({ queryKey: ["/api/kb"] });

  const createMutation = useMutation({
    mutationFn: (data: typeof editForm) => apiRequest("POST", "/api/kb", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setIsAdding(false);
      setEditForm({ title: "", content: "", type: "manual" });
      toast({ title: "Source added", description: "Knowledge base updated successfully." });
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

  const handleFileUpload = async (file: File) => {
    setUploadStatus("uploading");
    setUploadMessage(`Uploading ${file.name}...`);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/kb/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setUploadStatus("success");
      setUploadMessage(`${file.name} imported successfully.`);
      toast({ title: "File imported", description: `${file.name} has been added to the knowledge base.` });
      setTimeout(() => setUploadStatus("idle"), 3000);
    } catch (err: any) {
      setUploadStatus("error");
      setUploadMessage(err.message || "Upload failed");
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
      setTimeout(() => setUploadStatus("idle"), 4000);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const onedrive = kbs?.filter(k => k.type === "onedrive") ?? [];
  const other = kbs?.filter(k => k.type !== "onedrive") ?? [];

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
              {kbs?.length ?? 0} source{kbs?.length !== 1 ? "s" : ""} — the bot uses all these when answering queries
            </p>
          </div>
          <Button onClick={() => { setIsAdding(true); setEditForm({ title: "", content: "", type: "manual" }); }} className="gap-2">
            <Plus className="w-4 h-4" /> Add Manually
          </Button>
        </div>

        <div className="p-8 max-w-5xl mx-auto w-full space-y-8">

          {/* File Upload Zone */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cloud className="w-5 h-5 text-blue-500" />
                Import from OneDrive / Local Files
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Drop zone */}
              <div
                data-testid="dropzone"
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
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
                      <p className="text-sm text-muted-foreground mt-1">Supports PDF, TXT, Markdown — up to 20 MB</p>
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
                    if (file) handleFileUpload(file);
                    e.target.value = "";
                  }}
                />
              </div>

              {/* OneDrive connect placeholder */}
              <div className="flex items-center gap-3 p-4 rounded-lg border border-dashed border-border bg-muted/20">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
                    <path d="M3 16.5C3 18.43 4.57 20 6.5 20h11C19.43 20 21 18.43 21 16.5c0-1.64-1.11-3.02-2.63-3.42-.07-.33-.19-.63-.34-.91A5.5 5.5 0 0 0 7.08 11.1 3.5 3.5 0 0 0 3 14.5" fill="#0078D4" fillOpacity=".2"/>
                    <path d="M13.5 8C11.57 8 10 9.57 10 11.5v.08A5.5 5.5 0 0 1 18.03 13.08C18.82 13.58 19.42 14.35 19.74 15.26A3.5 3.5 0 0 0 17.5 8.5a3.4 3.4 0 0 0-4-.5z" fill="#0078D4"/>
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Connect Microsoft OneDrive</p>
                  <p className="text-xs text-muted-foreground">Browse and import documents directly from your OneDrive</p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5 shrink-0" disabled>
                  <ExternalLink className="w-3.5 h-3.5" />
                  Coming Soon
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Add manually form */}
          {isAdding && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle className="text-base">Add Knowledge Source</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  placeholder="Title (e.g. Zoho KB: 2FA Setup Guide)"
                  value={editForm.title}
                  data-testid="input-kb-title"
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                />
                <div className="flex gap-2 flex-wrap">
                  {Object.entries(typeLabels).map(([val, { label, color }]) => (
                    <button
                      key={val}
                      onClick={() => setEditForm({ ...editForm, type: val })}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                        editForm.type === val ? color + " ring-2 ring-primary/40" : "border-border text-muted-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Textarea
                  placeholder="Paste or type the knowledge base content here..."
                  className="min-h-[200px] font-mono text-xs"
                  value={editForm.content}
                  data-testid="textarea-kb-content"
                  onChange={e => setEditForm({ ...editForm, content: e.target.value })}
                />
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button onClick={() => createMutation.mutate(editForm)} disabled={createMutation.isPending || !editForm.title || !editForm.content}>
                  {createMutation.isPending ? "Saving..." : "Save Source"}
                </Button>
                <Button variant="ghost" onClick={() => setIsAdding(false)}>Cancel</Button>
              </CardFooter>
            </Card>
          )}

          {/* KB Items */}
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2].map(i => <div key={i} className="h-32 bg-muted/40 rounded-xl animate-pulse" />)}
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
                      <div className="flex-1 min-w-0">
                        {isEditing === kb.id ? (
                          <Input
                            value={editForm.title}
                            onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                            className="font-medium"
                          />
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                            <h3 className="font-semibold text-foreground text-sm truncate">{kb.title}</h3>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${typeMeta.color}`}>
                              {typeMeta.label}
                            </span>
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
                            <Button size="icon" variant="ghost" data-testid={`button-edit-kb-${kb.id}`} onClick={() => {
                              setIsEditing(kb.id);
                              setEditForm({ title: kb.title, content: kb.content, type: kb.type });
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
                        <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed">
                          {kb.content}
                        </p>
                      )}
                    </CardContent>
                    <CardFooter className="pt-0 text-[11px] text-muted-foreground">
                      Last updated {new Date(kb.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
