import { Bot, User, BookOpen, FileText, FileSpreadsheet, Film, File as FileIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { format } from "date-fns";
import type { PendingFile } from "@/components/ChatInput";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  createdAt?: string | Date;
  isStreaming?: boolean;
  optimisticFiles?: PendingFile[];
}

function AttachmentPill({ pf }: { pf: PendingFile }) {
  const isImage = pf.file.type.startsWith("image/");
  const isVideo = pf.file.type.startsWith("video/");
  const isPdf = pf.file.type.includes("pdf");
  const isSheet = pf.file.type.includes("sheet") || pf.file.type.includes("excel");
  const isWord = pf.file.type.includes("word");

  if (isImage) {
    return (
      <img
        src={pf.localUrl}
        alt={pf.file.name}
        className="max-h-48 max-w-xs rounded-xl object-contain border border-white/20 shadow"
        data-testid="attachment-image-preview"
      />
    );
  }

  const icon = isVideo ? (
    <Film className="w-4 h-4 text-purple-400" />
  ) : isPdf ? (
    <FileText className="w-4 h-4 text-red-400" />
  ) : isSheet ? (
    <FileSpreadsheet className="w-4 h-4 text-green-400" />
  ) : isWord ? (
    <FileText className="w-4 h-4 text-blue-400" />
  ) : (
    <FileIcon className="w-4 h-4 text-white/60" />
  );

  return (
    <div className="flex items-center gap-1.5 bg-white/10 rounded-lg px-2.5 py-1.5 text-xs text-primary-foreground/90 border border-white/15">
      {icon}
      <span className="truncate max-w-[140px]">{pf.displayName ?? pf.file.name}</span>
    </div>
  );
}

export function MessageBubble({ role, content, sources, createdAt, isStreaming, optimisticFiles }: MessageBubbleProps) {
  const isUser = role === "user";
  const hasFiles = optimisticFiles && optimisticFiles.length > 0;

  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6 group`}>
      <div className={`flex max-w-[85%] ${isUser ? "flex-row-reverse" : "flex-row"} gap-4`}>
        
        {/* Avatar */}
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center shadow-sm border ${
          isUser 
            ? "bg-primary text-primary-foreground border-primary" 
            : "bg-white text-primary border-primary/20 shadow-primary/5"
        }`}>
          {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
        </div>

        {/* Message Content */}
        <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
          <div className={`px-5 py-3.5 rounded-2xl shadow-sm text-sm ${
            isUser 
              ? "bg-primary text-primary-foreground rounded-tr-sm" 
              : "bg-white border border-border/50 text-foreground rounded-tl-sm"
          }`}>
            {isUser ? (
              <div className="flex flex-col gap-2">
                {/* Attachment previews (optimistic only) */}
                {hasFiles && (
                  <div className="flex flex-wrap gap-2 mb-1">
                    {optimisticFiles!.map((pf, i) => (
                      <AttachmentPill key={i} pf={pf} />
                    ))}
                  </div>
                )}
                {/* Historical messages that mention attachments render the label text */}
                {content && <div className="whitespace-pre-wrap">{content}</div>}
              </div>
            ) : (
              <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:text-foreground prose-a:text-primary">
                {content ? (
                  <>
                    <ReactMarkdown>{content}</ReactMarkdown>
                    {sources && sources.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-border/50">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                          <BookOpen className="w-3 h-3" /> Sources Used
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {sources.map((s, i) => (
                            <span key={i} className="px-2 py-0.5 bg-muted rounded text-[10px] text-muted-foreground border border-border/50">
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex gap-1 py-1">
                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full typing-dot" />
                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full typing-dot" />
                    <div className="w-1.5 h-1.5 bg-primary/40 rounded-full typing-dot" />
                  </div>
                )}
              </div>
            )}
            
            {/* Blinking cursor for streaming */}
            {isStreaming && content && (
              <span className="inline-block w-1.5 h-4 ml-1 bg-primary/50 animate-pulse align-middle" />
            )}
          </div>
          
          {/* Timestamp */}
          {createdAt && (
            <span className="text-[10px] text-muted-foreground mt-1.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {format(new Date(createdAt), "h:mm a")}
            </span>
          )}
        </div>

      </div>
    </div>
  );
}
