import { useState } from "react";
import { Bot, Lock, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUser } from "@/lib/userContext";
import type { WhitelistedUser } from "@shared/schema";

export function EmailGate({ children }: { children: React.ReactNode }) {
  const { currentUser, setCurrentUser } = useUser();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "denied" | "error">("idle");
  const [firstAdmin, setFirstAdmin] = useState(false);

  if (currentUser) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("loading");

    try {
      const res = await fetch("/api/auth/check-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json();

      if (data.allowed && data.user) {
        if (data.isFirstAdmin) setFirstAdmin(true);
        setCurrentUser(data.user as WhitelistedUser);
      } else {
        setStatus("denied");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted/20 to-background p-4">
      <div className="w-full max-w-md">
        {/* Card */}
        <div className="bg-card border border-border rounded-2xl shadow-xl shadow-black/5 overflow-hidden">
          {/* Top accent */}
          <div className="h-1.5 bg-gradient-to-r from-primary via-primary/80 to-primary/40" />

          <div className="p-8">
            {/* Logo */}
            <div className="flex flex-col items-center mb-8">
              <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mb-4 border border-primary/20">
                <Bot className="w-8 h-8" />
              </div>
              <h1 className="text-2xl font-bold text-foreground text-center">Support AI</h1>
              <p className="text-muted-foreground text-sm text-center mt-1">
                Customer support assistant for escalation teams
              </p>
            </div>

            {/* Gate message */}
            <div className="flex items-center gap-2 bg-muted/50 border border-border rounded-xl p-3 mb-6">
              <Lock className="w-4 h-4 text-muted-foreground shrink-0" />
              <p className="text-sm text-muted-foreground">
                Enter your work email to verify access
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email-input">Work Email</Label>
                <Input
                  id="email-input"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  data-testid="input-email-gate"
                  onChange={e => { setEmail(e.target.value); setStatus("idle"); }}
                  disabled={status === "loading"}
                  autoFocus
                  className="h-11"
                />
              </div>

              {status === "denied" && (
                <div className="flex items-start gap-2 text-destructive bg-destructive/5 border border-destructive/20 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Access denied</p>
                    <p className="text-destructive/80 text-xs mt-0.5">Your email is not on the approved list. Please contact your administrator.</p>
                  </div>
                </div>
              )}

              {status === "error" && (
                <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg p-3">
                  Connection error. Please try again.
                </div>
              )}

              <Button
                type="submit"
                className="w-full h-11 gap-2"
                disabled={status === "loading" || !email.trim()}
                data-testid="button-email-submit"
              >
                {status === "loading" ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</>
                ) : (
                  "Continue"
                )}
              </Button>
            </form>

            <p className="text-center text-xs text-muted-foreground mt-6">
              First time? If no users exist yet, you'll automatically be set up as admin.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
