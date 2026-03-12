import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useUser, useAuthHeaders } from "@/lib/userContext";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ShieldCheck, Users, Plus, Trash2, Zap, BookOpen, TrendingUp,
  AlertCircle, X, Edit2, Save, Coins
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { WhitelistedUser } from "@shared/schema";
import { useLocation } from "wouter";

interface TokenStats {
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
  byConversation: { conversationId: number; total: number }[];
}

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-3xl font-bold text-foreground mt-1">{typeof value === "number" ? value.toLocaleString() : value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function AdminPanel() {
  const { isAdmin, currentUser } = useUser();
  const authHeaders = useAuthHeaders();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // New user form
  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState({ email: "", name: "", role: "agent", canAddKB: false });

  // Edit user
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", role: "agent", canAddKB: false });

  if (!isAdmin) {
    return (
      <div className="flex h-screen w-full bg-background overflow-hidden">
        <Sidebar isWidgetMode={false} onToggleWidget={() => {}} />
        <div className="flex-1 flex items-center justify-center flex-col gap-4">
          <AlertCircle className="w-12 h-12 text-muted-foreground opacity-30" />
          <p className="text-muted-foreground">Admin access required.</p>
          <Button variant="outline" onClick={() => setLocation("/")}>Go Home</Button>
        </div>
      </div>
    );
  }

  // Fetch users
  const { data: users, isLoading: usersLoading } = useQuery<WhitelistedUser[]>({
    queryKey: ["/api/admin/users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { headers: authHeaders });
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
  });

  // Fetch token stats
  const { data: tokenStats } = useQuery<TokenStats>({
    queryKey: ["/api/admin/tokens"],
    queryFn: async () => {
      const res = await fetch("/api/admin/tokens", { headers: authHeaders });
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    refetchInterval: 15000,
  });

  // Add user mutation
  const addUser = useMutation({
    mutationFn: async (data: typeof newUser) => {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setShowAdd(false);
      setNewUser({ email: "", name: "", role: "agent", canAddKB: false });
      toast({ title: "User added to whitelist" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  // Update user mutation
  const updateUser = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<typeof editForm> }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update user");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setEditingId(null);
      toast({ title: "User updated" });
    },
  });

  // Delete user mutation
  const deleteUser = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: authHeaders });
      if (!res.ok) throw new Error("Failed to delete user");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User removed from whitelist" });
    },
  });

  const roleBadge = (role: string) => (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
      role === "admin" ? "bg-violet-100 text-violet-700 border-violet-200" : "bg-sky-100 text-sky-700 border-sky-200"
    }`}>{role}</span>
  );

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar isWidgetMode={false} onToggleWidget={() => {}} />
      <div className="flex-1 flex flex-col overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-8 py-5">
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
            Admin Panel
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage access, permissions, and monitor usage</p>
        </div>

        <div className="p-8 max-w-5xl mx-auto w-full space-y-8">

          {/* Token Usage Stats */}
          <section>
            <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" /> Token Usage
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                label="Prompt Tokens"
                value={tokenStats?.totalPrompt ?? 0}
                sub="Input tokens sent to AI"
                icon={Zap}
                color="bg-amber-100 text-amber-600"
              />
              <StatCard
                label="Completion Tokens"
                value={tokenStats?.totalCompletion ?? 0}
                sub="Tokens generated by AI"
                icon={Coins}
                color="bg-emerald-100 text-emerald-600"
              />
              <StatCard
                label="Total Tokens Used"
                value={tokenStats?.totalTokens ?? 0}
                sub={`Across ${tokenStats?.byConversation?.length ?? 0} conversations`}
                icon={TrendingUp}
                color="bg-blue-100 text-blue-600"
              />
            </div>

            {/* Per-conversation breakdown */}
            {tokenStats && tokenStats.byConversation.length > 0 && (
              <div className="mt-4 bg-muted/30 rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Per-Conversation Breakdown</p>
                </div>
                <div className="divide-y divide-border">
                  {tokenStats.byConversation
                    .sort((a, b) => b.total - a.total)
                    .slice(0, 10)
                    .map(row => (
                      <div key={row.conversationId} className="px-4 py-2.5 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Conversation #{row.conversationId}</span>
                        <span className="font-medium text-foreground">{row.total.toLocaleString()} tokens</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </section>

          {/* User Whitelist */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" /> Whitelisted Users
              </h2>
              <Button size="sm" className="gap-2" onClick={() => setShowAdd(true)} data-testid="button-add-user">
                <Plus className="w-3.5 h-3.5" /> Add User
              </Button>
            </div>

            {/* Add user form */}
            {showAdd && (
              <Card className="mb-4 border-primary/20 bg-primary/5">
                <CardHeader>
                  <CardTitle className="text-sm">Add User to Whitelist</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Email *</Label>
                      <Input
                        placeholder="user@company.com"
                        type="email"
                        value={newUser.email}
                        data-testid="input-new-user-email"
                        onChange={e => setNewUser({ ...newUser, email: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Name</Label>
                      <Input
                        placeholder="Full name (optional)"
                        value={newUser.name}
                        onChange={e => setNewUser({ ...newUser, name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div className="space-y-1">
                      <Label>Role</Label>
                      <Select value={newUser.role} onValueChange={v => setNewUser({ ...newUser, role: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="agent">Agent</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2 pb-0.5">
                      <Switch
                        id="new-can-add-kb"
                        checked={newUser.canAddKB}
                        onCheckedChange={v => setNewUser({ ...newUser, canAddKB: v })}
                      />
                      <Label htmlFor="new-can-add-kb" className="flex items-center gap-1.5 cursor-pointer">
                        <BookOpen className="w-3.5 h-3.5" /> Can add to KB
                      </Label>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => addUser.mutate(newUser)}
                      disabled={addUser.isPending || !newUser.email}
                      data-testid="button-save-new-user"
                    >
                      {addUser.isPending ? "Adding…" : "Add User"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Users table */}
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="grid grid-cols-[1fr_120px_80px_100px_80px] gap-0 bg-muted/40 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                <span>User</span>
                <span>Role</span>
                <span>KB Access</span>
                <span>Joined</span>
                <span></span>
              </div>

              {usersLoading ? (
                <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
              ) : users?.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">No users yet.</div>
              ) : (
                <div className="divide-y divide-border">
                  {users?.map(user => (
                    <div key={user.id} className="grid grid-cols-[1fr_120px_80px_100px_80px] gap-0 items-center px-4 py-3" data-testid={`row-user-${user.id}`}>
                      {editingId === user.id ? (
                        <>
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-foreground">{user.email}</p>
                            <Input
                              className="h-7 text-xs"
                              value={editForm.name}
                              placeholder="Display name"
                              onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                            />
                          </div>
                          <Select value={editForm.role} onValueChange={v => setEditForm({ ...editForm, role: v })}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="agent">Agent</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex justify-center">
                            <Switch
                              checked={editForm.canAddKB}
                              onCheckedChange={v => setEditForm({ ...editForm, canAddKB: v })}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(user.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                          </span>
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => updateUser.mutate({ id: user.id, data: editForm })}>
                              <Save className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <p className="text-sm font-medium text-foreground">{user.name || user.email}</p>
                            {user.name && <p className="text-xs text-muted-foreground">{user.email}</p>}
                          </div>
                          <div>{roleBadge(user.role)}</div>
                          <div className="flex justify-center">
                            <span className={`text-xs font-medium ${user.canAddKB || user.role === "admin" ? "text-emerald-600" : "text-muted-foreground"}`}>
                              {user.canAddKB || user.role === "admin" ? "Yes" : "No"}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(user.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })}
                          </span>
                          <div className="flex gap-1">
                            <Button
                              size="icon" variant="ghost" className="h-7 w-7"
                              onClick={() => {
                                setEditingId(user.id);
                                setEditForm({ name: user.name || "", role: user.role, canAddKB: user.canAddKB });
                              }}
                              data-testid={`button-edit-user-${user.id}`}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                              disabled={user.email === currentUser?.email}
                              onClick={() => { if (confirm(`Remove ${user.email} from whitelist?`)) deleteUser.mutate(user.id); }}
                              data-testid={`button-delete-user-${user.id}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
