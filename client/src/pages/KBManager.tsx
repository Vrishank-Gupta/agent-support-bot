import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Sidebar } from "@/components/Sidebar";
import { Plus, Trash2, Edit2, Save, X } from "lucide-react";
import type { KnowledgeBase } from "@shared/schema";

export function KBManager() {
  const [isEditing, setIsEditing] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", content: "", type: "manual" });

  const { data: kbs, isLoading } = useQuery<KnowledgeBase[]>({ queryKey: ["/api/kb"] });

  const createMutation = useMutation({
    mutationFn: (data: typeof editForm) => apiRequest("POST", "/api/kb", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setIsAdding(false);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<typeof editForm> }) => 
      apiRequest("PATCH", `/api/kb/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/kb"] });
      setIsEditing(null);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/kb/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/kb"] })
  });

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar isWidgetMode={false} onToggleWidget={() => {}} />
      <div className="flex-1 flex flex-col overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto w-full">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold">Knowledge Base Manager</h1>
            <Button onClick={() => setIsAdding(true)} className="gap-2">
              <Plus className="w-4 h-4" /> Add Source
            </Button>
          </div>

          {isAdding && (
            <Card className="mb-8 border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle>Add New Source</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input 
                  placeholder="Title (e.g. OneDrive: Troubleshooting Guide)" 
                  onChange={e => setEditForm({...editForm, title: e.target.value})}
                />
                <Textarea 
                  placeholder="Paste source content here..." 
                  className="min-h-[200px]"
                  onChange={e => setEditForm({...editForm, content: e.target.value})}
                />
                <div className="flex gap-2">
                  <Button onClick={() => createMutation.mutate(editForm)}>Save Source</Button>
                  <Button variant="ghost" onClick={() => setIsAdding(false)}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6">
            {kbs?.map(kb => (
              <Card key={kb.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-lg">
                    {isEditing === kb.id ? (
                      <Input 
                        value={editForm.title || kb.title} 
                        onChange={e => setEditForm({...editForm, title: e.target.value})}
                      />
                    ) : kb.title}
                  </CardTitle>
                  <div className="flex gap-2">
                    {isEditing === kb.id ? (
                      <>
                        <Button size="icon" variant="ghost" onClick={() => updateMutation.mutate({ id: kb.id, data: editForm })}>
                          <Save className="w-4 h-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setIsEditing(null)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="icon" variant="ghost" onClick={() => {
                          setIsEditing(kb.id);
                          setEditForm({ title: kb.title, content: kb.content, type: kb.type });
                        }}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="text-destructive" onClick={() => {
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
                      value={editForm.content || kb.content} 
                      className="min-h-[150px]"
                      onChange={e => setEditForm({...editForm, content: e.target.value})}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground line-clamp-3">{kb.content}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
