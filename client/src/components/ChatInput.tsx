import { useState, useRef, useEffect } from "react";
import { Send, Square, Paperclip, X, FileText, FileSpreadsheet, Film, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface PendingFile {
  file: File;
  localUrl: string; // object URL for image previews
  displayName?: string; // overrides file.name for display (e.g. pasted images)
}

interface ChatInputProps {
  onSend: (message: string, files: File[]) => void;
  isStreaming: boolean;
  onStop: () => void;
}

const ACCEPTED_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "video/mp4", "video/quicktime", "video/x-msvideo", "video/webm",
];
const ACCEPT_ATTR = ".jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.mp4,.mov,.avi,.webm";
const MAX_FILE_MB = 100;

function fileIcon(file: File) {
  if (file.type.startsWith("image/")) return null; // show thumbnail instead
  if (file.type.startsWith("video/")) return <Film className="w-4 h-4 text-purple-500" />;
  if (file.type.includes("pdf")) return <FileText className="w-4 h-4 text-red-500" />;
  if (file.type.includes("sheet") || file.type.includes("excel")) return <FileSpreadsheet className="w-4 h-4 text-green-600" />;
  if (file.type.includes("word")) return <FileText className="w-4 h-4 text-blue-500" />;
  return <FileIcon className="w-4 h-4 text-muted-foreground" />;
}

export function ChatInput({ onSend, isStreaming, onStop }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Clean up object URLs on unmount / removal
  const removeFile = (idx: number) => {
    setPendingFiles(prev => {
      const f = prev[idx];
      if (f && f.localUrl) URL.revokeObjectURL(f.localUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const toAdd: PendingFile[] = [];
    Array.from(files).forEach(file => {
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        alert(`${file.name} exceeds the ${MAX_FILE_MB} MB limit.`);
        return;
      }
      if (!ACCEPTED_TYPES.includes(file.type)) {
        alert(`${file.name} is not a supported file type.`);
        return;
      }
      toAdd.push({ file, localUrl: URL.createObjectURL(file) });
    });
    setPendingFiles(prev => [...prev, ...toAdd]);
  };

  const handleSubmit = () => {
    if ((!input.trim() && pendingFiles.length === 0) || isStreaming) return;
    onSend(input.trim(), pendingFiles.map(p => p.file));
    setInput("");
    setPendingFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(item => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    // Prevent default only when there are images to capture
    e.preventDefault();
    const toAdd: PendingFile[] = [];
    imageItems.forEach((item, idx) => {
      const file = item.getAsFile();
      if (!file) return;
      const ext = item.type.split("/")[1] || "png";
      const displayName = `pasted-image-${Date.now()}-${idx}.${ext}`;
      toAdd.push({ file, localUrl: URL.createObjectURL(file), displayName });
    });
    if (toAdd.length > 0) setPendingFiles(prev => [...prev, ...toAdd]);
  };

  const canSend = (input.trim().length > 0 || pendingFiles.length > 0) && !isStreaming;

  return (
    <div
      className="p-4 bg-background/80 backdrop-blur-md border-t border-border/50"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {/* Attachment previews */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-1 max-w-4xl mx-auto">
          {pendingFiles.map((pf, idx) => (
            <div
              key={idx}
              className="relative group flex items-center gap-1.5 bg-muted border border-border/60 rounded-xl px-2 py-1.5 text-xs text-foreground max-w-[180px]"
              data-testid={`attachment-chip-${idx}`}
            >
              {pf.file.type.startsWith("image/") ? (
                <img
                  src={pf.localUrl}
                  alt={pf.file.name}
                  className="w-7 h-7 object-cover rounded-md shrink-0"
                />
              ) : (
                <span className="shrink-0">{fileIcon(pf.file)}</span>
              )}
              <span className="truncate max-w-[110px]">{pf.displayName ?? pf.file.name}</span>
              <button
                onClick={() => removeFile(idx)}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                data-testid={`remove-attachment-${idx}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative max-w-4xl mx-auto flex items-end gap-2 bg-card border-2 border-border/60 rounded-2xl p-2 shadow-sm focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10 transition-all duration-200">

        {/* Paperclip */}
        <Button
          variant="ghost"
          size="icon"
          type="button"
          disabled={isStreaming}
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 h-10 w-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60"
          data-testid="button-attach-file"
          title="Attach file (image, PDF, Word, Excel, video)"
        >
          <Paperclip className="w-4 h-4" />
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
          data-testid="input-file-upload"
        />

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask a support question in English or Hindi..."
          className="w-full max-h-[120px] min-h-[44px] bg-transparent border-0 resize-none py-2.5 px-3 text-sm focus:outline-none focus:ring-0 placeholder:text-muted-foreground/60 chat-scroll"
          rows={1}
          disabled={isStreaming}
          data-testid="input-chat-message"
        />

        {isStreaming ? (
          <Button
            variant="destructive"
            size="icon"
            onClick={onStop}
            className="shrink-0 h-10 w-10 rounded-xl shadow-md"
            data-testid="button-stop-stream"
          >
            <Square className="w-4 h-4 fill-current" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={!canSend}
            size="icon"
            className="shrink-0 h-10 w-10 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-md shadow-primary/20 transition-all"
            data-testid="button-send-message"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </Button>
        )}
      </div>

      <div className="text-center mt-2">
        <p className="text-[10px] text-muted-foreground/70">
          Attach images, PDFs, Word docs, Excel sheets, or videos — drag & drop supported.
        </p>
      </div>
    </div>
  );
}
