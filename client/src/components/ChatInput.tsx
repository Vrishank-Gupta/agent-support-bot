import { useState, useRef, useEffect } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  onStop: () => void;
}

export function ChatInput({ onSend, isStreaming, onStop }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const handleSubmit = () => {
    if (!input.trim() || isStreaming) return;
    onSend(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="p-4 bg-background/80 backdrop-blur-md border-t border-border/50">
      <div className="relative max-w-4xl mx-auto flex items-end gap-2 bg-card border-2 border-border/60 rounded-2xl p-2 shadow-sm focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10 transition-all duration-200">
        
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a support question in English or Hindi..."
          className="w-full max-h-[120px] min-h-[44px] bg-transparent border-0 resize-none py-2.5 px-3 text-sm focus:outline-none focus:ring-0 placeholder:text-muted-foreground/60 chat-scroll"
          rows={1}
          disabled={isStreaming}
        />

        {isStreaming ? (
          <Button 
            variant="destructive" 
            size="icon" 
            onClick={onStop}
            className="shrink-0 h-10 w-10 rounded-xl shadow-md"
          >
            <Square className="w-4 h-4 fill-current" />
          </Button>
        ) : (
          <Button 
            onClick={handleSubmit} 
            disabled={!input.trim()}
            size="icon"
            className="shrink-0 h-10 w-10 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20 transition-all"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </Button>
        )}
      </div>
      <div className="text-center mt-2">
        <p className="text-[10px] text-muted-foreground/70">
          Knowledge Base limited to OneDrive, Zoho links, and previous ticket data.
        </p>
      </div>
    </div>
  );
}
