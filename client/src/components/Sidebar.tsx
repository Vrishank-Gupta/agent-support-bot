import { Link, useLocation } from "wouter";
import { Plus, MessageSquare, Trash2, Settings, Bot, BookOpen, ShieldCheck, LogOut, User } from "lucide-react";
import { useConversations, useCreateConversation, useDeleteConversation } from "@/hooks/use-chat";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { useUser } from "@/lib/userContext";

export function Sidebar({ isWidgetMode, onToggleWidget }: { isWidgetMode: boolean, onToggleWidget: () => void }) {
  const [location, setLocation] = useLocation();
  const { data: conversations, isLoading } = useConversations();
  const createChat = useCreateConversation();
  const deleteChat = useDeleteConversation();
  const { currentUser, isAdmin, logout } = useUser();

  const handleCreate = () => {
    createChat.mutate("New Support Session", {
      onSuccess: (newChat) => {
        setLocation(`/chat/${newChat.id}`);
      }
    });
  };

  return (
    <div className="w-72 bg-card border-r border-border h-full flex flex-col shadow-xl shadow-black/5 z-10 relative">
      {/* Header */}
      <div className="p-4 border-b border-border/50 flex items-center justify-between">
        <Link href="/">
          <div className="flex items-center gap-2 cursor-pointer">
            <div className="bg-primary/10 text-primary p-2 rounded-xl">
              <Bot className="w-5 h-5" />
            </div>
            <span className="font-display font-semibold text-lg text-foreground">Support AI</span>
          </div>
        </Link>
      </div>

      {/* Nav Links */}
      <div className="px-4 pt-4 space-y-1">
        <Link href="/kb">
          <Button
            variant="ghost"
            className={`w-full justify-start gap-2 ${location === "/kb" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <BookOpen className="w-4 h-4" />
            Knowledge Base
          </Button>
        </Link>

        {isAdmin && (
          <Link href="/admin">
            <Button
              variant="ghost"
              className={`w-full justify-start gap-2 ${location === "/admin" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <ShieldCheck className="w-4 h-4" />
              Admin Panel
            </Button>
          </Link>
        )}
      </div>

      {/* New Chat Button */}
      <div className="p-4">
        <Button
          onClick={handleCreate}
          disabled={createChat.isPending}
          className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200"
        >
          <Plus className="w-4 h-4" />
          {createChat.isPending ? "Creating..." : "New Session"}
        </Button>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto chat-scroll px-3 pb-4 flex flex-col gap-1">
        <div className="px-2 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Recent Sessions
        </div>

        {isLoading ? (
          <div className="space-y-2 px-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-10 bg-muted/50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : conversations?.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8 px-4">
            No past sessions found. Start a new one to begin.
          </div>
        ) : (
          conversations?.map((conv) => {
            const isActive = location === `/chat/${conv.id}`;
            return (
              <div
                key={conv.id}
                className={`group flex items-center justify-between p-2 rounded-xl transition-all duration-200 cursor-pointer border ${
                  isActive
                    ? "bg-primary/5 border-primary/20 text-primary shadow-sm"
                    : "hover:bg-muted border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setLocation(`/chat/${conv.id}`)}
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <MessageSquare className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/70"}`} />
                  <div className="flex flex-col overflow-hidden">
                    <span className="text-sm font-medium truncate">{conv.title}</span>
                    <span className="text-[10px] opacity-70">
                      {format(new Date(conv.createdAt), "MMM d, h:mm a")}
                    </span>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this session?")) deleteChat.mutate(conv.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded-md transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border/50 space-y-2">
        {/* Current user info */}
        {currentUser && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/40 text-sm">
            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <User className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{currentUser.name || currentUser.email}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{currentUser.role}</p>
            </div>
            <button
              onClick={logout}
              className="p-1 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground"
              title="Sign out"
              data-testid="button-logout"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <Button
          variant="outline"
          onClick={onToggleWidget}
          className="w-full justify-start gap-2 bg-background hover:bg-muted border-border/50 shadow-sm"
        >
          <Settings className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm">
            {isWidgetMode ? "Exit Widget Preview" : "Preview Widget Mode"}
          </span>
        </Button>
      </div>
    </div>
  );
}
