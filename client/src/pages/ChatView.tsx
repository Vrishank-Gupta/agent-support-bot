import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Bot, Info } from "lucide-react";
import { useConversation, useChatStream } from "@/hooks/use-chat";
import { MessageBubble } from "@/components/MessageBubble";
import { ChatInput } from "@/components/ChatInput";

export function ChatView() {
  const params = useParams();
  const id = params.id ? parseInt(params.id) : null;
  
  const { data: conversation, isLoading } = useConversation(id);
  const { sendMessage, isStreaming, streamedContent, stopStream } = useChatStream(id);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Local state for optimistic user messages
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [conversation?.messages, streamedContent, optimisticMessage]);

  // Clear optimistic message when stream starts/ends or new messages arrive
  useEffect(() => {
    if (!isStreaming && streamedContent === "") {
      setOptimisticMessage(null);
    }
  }, [isStreaming, streamedContent, conversation?.messages]);

  const handleSend = async (content: string) => {
    setOptimisticMessage(content);
    await sendMessage(content);
  };

  if (!id) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-muted/10 text-center p-8">
        <div className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center mb-6 shadow-sm border border-primary/20">
          <Bot className="w-10 h-10 text-primary" />
        </div>
        <h2 className="text-2xl font-display font-bold text-foreground mb-2">Agent Support Assistant</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          Select a session from the sidebar or create a new one to start resolving customer escalations.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-muted/10">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground font-medium">Loading session...</p>
        </div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center bg-muted/10">
        <p className="text-muted-foreground">Conversation not found.</p>
      </div>
    );
  }

  const hasMessages = conversation.messages && conversation.messages.length > 0;

  return (
    <div className="flex-1 flex flex-col h-full bg-[#fcfdfd] relative overflow-hidden">
      {/* Chat Header */}
      <div className="h-16 px-6 border-b border-border/50 bg-white/80 backdrop-blur-sm flex items-center justify-between shrink-0 sticky top-0 z-10">
        <div>
          <h3 className="font-semibold text-foreground">{conversation.title}</h3>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Connected to Knowledge Base
          </div>
        </div>
        <button className="p-2 text-muted-foreground hover:bg-muted rounded-full transition-colors">
          <Info className="w-5 h-5" />
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto chat-scroll p-4 md:p-6" ref={scrollRef}>
        <div className="max-w-4xl mx-auto w-full">
          {!hasMessages && !optimisticMessage && (
            <div className="py-20 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
                <Bot className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">How can I help you today?</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Ask me troubleshooting questions. I can search previous Zoho tickets and the Microsoft OneDrive knowledge base.
              </p>
            </div>
          )}

          {conversation.messages.map((msg) => (
            <MessageBubble 
              key={msg.id}
              role={msg.role as "user" | "assistant"}
              content={msg.content}
              createdAt={msg.createdAt}
            />
          ))}

          {/* Optimistic User Message */}
          {optimisticMessage && (
            <MessageBubble 
              role="user"
              content={optimisticMessage}
              createdAt={new Date()}
            />
          )}

          {/* Streaming Assistant Message */}
          {isStreaming && (
            <MessageBubble 
              role="assistant"
              content={streamedContent}
              isStreaming={true}
            />
          )}
        </div>
      </div>

      {/* Input Area */}
      <ChatInput onSend={handleSend} isStreaming={isStreaming} onStop={stopStream} />
    </div>
  );
}
