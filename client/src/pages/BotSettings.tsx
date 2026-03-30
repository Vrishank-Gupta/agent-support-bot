import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useUser, useAuthHeaders } from "@/lib/userContext";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Save, RotateCcw, Bot, Clock, Info } from "lucide-react";
import { format } from "date-fns";

interface SettingsResponse {
  systemPrompt: string;
  updatedAt: string | null;
}

export function BotSettings() {
  const { isAdmin } = useUser();
  const authHeaders = useAuthHeaders();
  const { toast } = useToast();
  const [isWidgetMode, setIsWidgetMode] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);

  const { data, isLoading } = useQuery<SettingsResponse>({
    queryKey: ["/api/settings"],
    queryFn: () =>
      fetch("/api/settings", { headers: authHeaders }).then((r) => r.json()),
    enabled: isAdmin,
  });

  useEffect(() => {
    if (data?.systemPrompt && !isDirty) {
      setDraft(data.systemPrompt);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/settings", { systemPrompt: draft }, authHeaders),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      setIsDirty(false);
      toast({ title: "Saved", description: "Bot prompt updated successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save prompt.", variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/settings/reset", {}, authHeaders),
    onSuccess: (res: any) => {
      setDraft(res.systemPrompt);
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Reset", description: "Prompt restored to default." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reset prompt.", variant: "destructive" });
    },
  });

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Access restricted to admins.
      </div>
    );
  }

  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  const charCount = draft.length;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar isWidgetMode={isWidgetMode} onToggleWidget={() => setIsWidgetMode(!isWidgetMode)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <div className="border-b border-border bg-card/50 backdrop-blur px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary p-2 rounded-xl">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Bot Settings</h1>
              <p className="text-xs text-muted-foreground">
                Edit the system prompt that controls how the AI behaves
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {data?.updatedAt && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5 mr-2">
                <Clock className="w-3.5 h-3.5" />
                Last saved {format(new Date(data.updatedAt), "MMM d, h:mm a")}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Reset to default prompt? Any custom changes will be lost.")) {
                  resetMutation.mutate();
                }
              }}
              disabled={resetMutation.isPending}
              data-testid="button-reset-prompt"
            >
              <RotateCcw className="w-4 h-4 mr-1.5" />
              Reset to Default
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !isDirty}
              data-testid="button-save-prompt"
              className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
            >
              <Save className="w-4 h-4 mr-1.5" />
              {saveMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-4xl mx-auto space-y-4">

            {/* Info banner */}
            <div className="flex items-start gap-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl p-4 text-sm text-blue-800 dark:text-blue-300">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium mb-1">How this works</p>
                <p className="text-blue-700 dark:text-blue-400">
                  This prompt is sent to the AI at the start of every conversation, defining its role, rules, and behaviour.
                  The bot's knowledge base articles are automatically appended after this prompt — you don't need to add them here.
                </p>
              </div>
            </div>

            {/* Editor card */}
            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between bg-muted/30">
                <span className="text-sm font-medium text-foreground">System Prompt</span>
                <span className="text-xs text-muted-foreground">
                  {charCount.toLocaleString()} chars · {wordCount.toLocaleString()} words
                  {isDirty && <span className="ml-2 text-amber-500 font-medium">Unsaved changes</span>}
                </span>
              </div>

              {isLoading ? (
                <div className="h-[60vh] flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setIsDirty(true);
                  }}
                  className="w-full h-[60vh] p-4 bg-background text-sm font-mono text-foreground leading-relaxed resize-none focus:outline-none focus:ring-0 border-0"
                  placeholder="Enter the system prompt here..."
                  spellCheck={false}
                  data-testid="textarea-system-prompt"
                />
              )}
            </div>

            {/* Tips */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                {
                  title: "Core Rules",
                  tip: "Define what the bot must always do — like confirming product info before giving steps, or how many steps to return.",
                },
                {
                  title: "Tone & Language",
                  tip: "Set whether the bot should respond in Hindi or English, formal or casual, short or detailed.",
                },
                {
                  title: "Escalation Rules",
                  tip: 'Tell the bot when to escalate — e.g. "If no KB doc matches, say: No doc found. Please escalate."',
                },
              ].map((item) => (
                <div key={item.title} className="bg-muted/40 border border-border/50 rounded-lg p-3">
                  <p className="text-xs font-semibold text-foreground mb-1">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.tip}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
