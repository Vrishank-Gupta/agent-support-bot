import { useState } from "react";
import { Route, Switch } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/pages/ChatView";
import { Search, Bell, LayoutDashboard, Menu, X } from "lucide-react";

export function Layout() {
  const [isWidgetMode, setIsWidgetMode] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const MainApp = (
    <div className="flex h-full w-full bg-background overflow-hidden rounded-inherit">
      {/* Sidebar - hidden on mobile unless toggled */}
      <div className={`${isMobileMenuOpen ? 'absolute inset-y-0 left-0 z-50' : 'hidden'} md:block h-full`}>
        <Sidebar isWidgetMode={isWidgetMode} onToggleWidget={() => setIsWidgetMode(!isWidgetMode)} />
      </div>
      
      {/* Mobile overlay */}
      {isMobileMenuOpen && (
        <div 
          className="absolute inset-0 bg-black/20 z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header */}
        <div className="md:hidden h-14 border-b border-border bg-card flex items-center px-4 shrink-0">
          <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 text-muted-foreground">
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display font-semibold ml-2 text-foreground">Support AI</span>
        </div>
        
        <Switch>
          <Route path="/" component={ChatView} />
          <Route path="/chat/:id" component={ChatView} />
        </Switch>
      </div>
    </div>
  );

  if (!isWidgetMode) {
    return <div className="h-screen w-full">{MainApp}</div>;
  }

  // --- FAUX CRM BACKGROUND FOR WIDGET PREVIEW ---
  return (
    <div className="h-screen w-full bg-[#f3f4f6] flex flex-col relative overflow-hidden">
      {/* Fake CRM Navbar */}
      <header className="h-14 bg-[#1e293b] flex items-center justify-between px-6 text-white shrink-0 shadow-md z-0">
        <div className="flex items-center gap-6">
          <div className="font-bold tracking-wider flex items-center gap-2">
            <div className="w-6 h-6 bg-blue-500 rounded-md"></div>
            ZOHO CRM PREVIEW
          </div>
          <div className="hidden lg:flex gap-4 text-sm font-medium text-slate-300">
            <span className="text-white">Dashboard</span>
            <span>Leads</span>
            <span>Contacts</span>
            <span>Tickets</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Search className="w-4 h-4 text-slate-300" />
          <Bell className="w-4 h-4 text-slate-300" />
          <div className="w-8 h-8 bg-slate-600 rounded-full border-2 border-slate-500"></div>
        </div>
      </header>

      {/* Fake CRM Content */}
      <main className="flex-1 p-8 grid grid-cols-1 lg:grid-cols-3 gap-6 opacity-60 pointer-events-none select-none">
        <div className="lg:col-span-2 space-y-6">
          <div className="h-32 bg-white rounded-xl border border-slate-200 shadow-sm"></div>
          <div className="h-96 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
            <div className="h-14 border-b border-slate-100 flex items-center px-6">
              <div className="w-32 h-4 bg-slate-200 rounded"></div>
            </div>
            <div className="p-6 space-y-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-12 bg-slate-50 rounded-lg border border-slate-100"></div>
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="h-64 bg-white rounded-xl border border-slate-200 shadow-sm"></div>
          <div className="h-64 bg-white rounded-xl border border-slate-200 shadow-sm"></div>
        </div>
      </main>

      {/* Floating Widget Container */}
      <div className="absolute bottom-6 right-6 z-50 flex flex-col items-end">
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.5 }}
            className="w-[400px] h-[600px] bg-background rounded-2xl shadow-2xl shadow-black/20 border border-border/50 overflow-hidden flex flex-col mb-4 origin-bottom-right rounded-inherit"
          >
            {MainApp}
          </motion.div>
        </AnimatePresence>

        {/* Exit Preview Button */}
        <button 
          onClick={() => setIsWidgetMode(false)}
          className="bg-slate-800 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg hover:bg-slate-700 transition-colors flex items-center gap-2"
        >
          <X className="w-4 h-4" /> Exit Widget Preview
        </button>
      </div>
    </div>
  );
}
