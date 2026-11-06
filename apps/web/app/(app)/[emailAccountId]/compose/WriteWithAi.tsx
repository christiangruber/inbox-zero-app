"use client";

import { useEffect, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import { writeReplyDraftAction } from "@/utils/actions/assistant-activity";

/** Writes a reply into the open composer and reports progress while it runs. */
export function useWriteWithAi({
  emailAccountId,
  threadId,
  insertHtml,
}: {
  emailAccountId: string;
  threadId: string | undefined;
  insertHtml: (html: string) => boolean;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const write = async () => {
    if (!threadId || startedAt) return;
    setStartedAt(Date.now());
    const result = await writeReplyDraftAction(emailAccountId, { threadId });
    setStartedAt(null);
    if (result?.data?.html && insertHtml(result.data.html)) return;
    toastError({
      title: "The assistant could not write a reply",
      description: result?.serverError ?? "Please try again.",
    });
  };

  return { available: Boolean(threadId), writing: startedAt, write };
}

export function WriteWithAiButton({
  writing,
  disabled,
  onClick,
}: {
  writing: number | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || writing !== null}
      onClick={onClick}
      className="gap-1.5 text-muted-foreground"
    >
      <SparklesIcon className="size-3.5" />
      Write with AI
    </Button>
  );
}

/** Shown in place of the editor's empty space while the reply is written. */
export function WriteWithAiProgress({ startedAt }: { startedAt: number }) {
  const seconds = useElapsedSeconds(startedAt);
  return (
    <div className="animate-fade-slide-in py-2" aria-live="polite">
      <div className="flex h-[22px] items-center gap-2 text-[12.5px]">
        <span className="assistant-live-mark grid size-[11px] shrink-0 place-items-center rounded-full border-[1.5px] border-blue-500">
          <span className="size-[5px] rounded-full bg-blue-500" />
        </span>
        <span className="assistant-sheen">
          Writing the reply in your voice…
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {seconds} s
        </span>
      </div>
      <div className="ml-[19px] py-1">
        <div className="skeleton-line my-2" style={{ width: 40 }} />
        <div className="skeleton-line my-2" />
        <div className="skeleton-line my-2" style={{ width: 190 }} />
      </div>
    </div>
  );
}

function useElapsedSeconds(startedAt: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
