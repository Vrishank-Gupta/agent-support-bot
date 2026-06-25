import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/pages/Layout";
import { KBManager } from "@/pages/KBManager";
import { AdminPanel } from "@/pages/AdminPanel";
import { BotSettings } from "@/pages/BotSettings";
import { KBSettings } from "@/pages/KBSettings";
import { TicketDraft } from "@/pages/TicketDraft";
import { UserProvider } from "@/lib/userContext";
import { EmailGate } from "@/components/EmailGate";

function Router() {
  return (
    <EmailGate>
      <Switch>
        <Route path="/" component={Layout} />
        <Route path="/chat/:id" component={Layout} />
        <Route path="/kb" component={KBManager} />
        <Route path="/admin" component={AdminPanel} />
        <Route path="/bot-settings" component={BotSettings} />
        <Route path="/kb-settings" component={KBSettings} />
        <Route path="/ticket-draft" component={TicketDraft} />
        <Route component={NotFound} />
      </Switch>
    </EmailGate>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <UserProvider>
          <Toaster />
          <Router />
        </UserProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
