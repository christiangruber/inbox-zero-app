"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { CheckIcon } from "lucide-react";
import type { GetAssistantActivityResponse } from "@/app/api/user/assistant-activity/route";
import { runRulesAction } from "@/utils/actions/ai-rule";
import { getAccountScopedKey } from "@/utils/swr";
import { toastError } from "@/components/Toast";
import { cn } from "@/utils";

type Activity = NonNullable<GetAssistantActivityResponse["activity"]>;
type Step = Activity["steps"][number];

const LIVE_POLL_MS = 700;

/**
 * One compact line per assistant step under the open conversation: what it is
 * doing while a step runs, the step's name once it is done.
 */
export function AssistantActivity({
  emailAccountId,
  messageId,
  threadId,
  onDraftReady,
}: {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  onDraftReady: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [watchedLive, setWatchedLive] = useState(false);
  const [open, setOpen] = useState(false);

  const path = `/api/user/assistant-activity?messageId=${encodeURIComponent(messageId)}`;
  const { data, mutate } = useSWR<GetAssistantActivityResponse>(
    getAccountScopedKey(path, emailAccountId),
    {
      refreshInterval: (latest) =>
        starting || (latest?.activity && !latest.activity.finishedAt)
          ? LIVE_POLL_MS
          : 0,
    },
  );

  const activity = data?.activity ?? null;
  const running = starting || (activity !== null && !activity.finishedAt);

  useEffect(() => {
    if (running) setWatchedLive(true);
  }, [running]);

  const notifiedDraft = useRef(false);
  useEffect(() => {
    if (
      watchedLive &&
      activity?.outcome === "draft" &&
      !notifiedDraft.current
    ) {
      notifiedDraft.current = true;
      onDraftReady();
    }
  }, [watchedLive, activity?.outcome, onDraftReady]);

  const start = async (rerun: boolean) => {
    notifiedDraft.current = false;
    setStarting(true);
    setWatchedLive(true);
    mutate();
    const result = await runRulesAction(emailAccountId, {
      messageId,
      threadId,
      isTest: false,
      rerun,
    });
    setStarting(false);
    await mutate();
    if (result?.serverError) {
      toastError({
        title: "The assistant could not process this email",
        description: result.serverError,
      });
    }
  };

  if (!data) return null;

  const showSteps = running || watchedLive || open;
  const steps = activity?.steps ?? [];

  return (
    <div className="mt-3 border-t pt-2 text-[12.5px]">
      {running || watchedLive ? null : (
        <SummaryLine
          data={data}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          onRun={() => start(Boolean(data.executedRules.length || activity))}
        />
      )}
      {showSteps && steps.length > 0 && (
        <div className="feel-disclose" data-open="true">
          <ul className="feel-disclose-inner">
            {steps.map((step, index) => (
              <StepRow
                key={`${step.key}-${step.startedAt}`}
                step={step}
                delay={watchedLive ? 0 : Math.min(index, 4) * 50}
              />
            ))}
          </ul>
        </div>
      )}
      {running && steps.length === 0 && (
        <Row mark="live">
          <span className="assistant-sheen truncate">
            Starting the assistant…
          </span>
        </Row>
      )}
      {running && activity?.steps.at(-1)?.key === "draft" && (
        <div className="mb-1 ml-[19px] border-l-2 py-1 pl-3">
          <div className="skeleton-line my-2" style={{ width: 40 }} />
          <div className="skeleton-line my-2" />
          <div className="skeleton-line my-2" style={{ width: 190 }} />
        </div>
      )}
      {watchedLive && !running && activity && (
        <Row mark="done" className="animate-fade-slide-in">
          <span className="text-foreground">
            {outcomeLabel(activity.outcome)}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {activity.outcome === "draft" ? "shown below · nothing sent" : ""}
          </span>
        </Row>
      )}
    </div>
  );
}

function SummaryLine({
  data,
  open,
  onToggle,
  onRun,
}: {
  data: GetAssistantActivityResponse;
  open: boolean;
  onToggle: () => void;
  onRun: () => void;
}) {
  const { activity, executedRules } = data;

  if (!activity && executedRules.length === 0) {
    return (
      <Row mark="idle">
        <span className="text-muted-foreground">
          The assistant hasn’t looked at this email yet
        </span>
        <span className="flex-1" />
        <LinkButton onClick={onRun}>Run assistant</LinkButton>
      </Row>
    );
  }

  const hasDraft =
    activity?.outcome === "draft" ||
    executedRules.some((rule) => rule.hasDraft);
  const decision = activity?.steps.find((step) => step.key === "decision");
  const tags = decision?.tags?.length
    ? decision.tags
    : executedRules.flatMap((rule) => (rule.ruleName ? [rule.ruleName] : []));
  const note =
    decision?.note ??
    executedRules.find((rule) => rule.reason)?.reason ??
    undefined;

  return (
    <Row mark={hasDraft ? "done" : "muted"}>
      <span className="text-foreground">
        {hasDraft ? "Draft ready" : outcomeLabel(activity?.outcome ?? "sorted")}
      </span>
      {tags.slice(0, 3).map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={note}
      >
        {hasDraft ? "nothing sent" : note}
      </span>
      {activity && (
        <LinkButton onClick={onToggle}>{open ? "Hide" : "Steps"}</LinkButton>
      )}
      <LinkButton onClick={onRun}>Run again</LinkButton>
    </Row>
  );
}

function StepRow({ step, delay }: { step: Step; delay: number }) {
  if (step.state === "running") {
    return (
      <Row mark="live" as="li">
        <span className="assistant-sheen truncate">{step.doing}</span>
      </Row>
    );
  }

  const seconds =
    step.endedAt !== undefined
      ? `${((step.endedAt - step.startedAt) / 1000).toFixed(1)} s`
      : "";

  return (
    <Row
      mark={step.state === "failed" ? "failed" : "done"}
      as="li"
      className="animate-fade-slide-in"
      style={{ "--row-delay": `${delay}ms` } as CSSProperties}
    >
      <span className="text-foreground">{step.title}</span>
      {step.tags?.slice(0, 3).map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={step.note}
      >
        {step.note}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {seconds}
      </span>
    </Row>
  );
}

function Row({
  mark,
  as: Element = "div",
  className,
  style,
  children,
}: {
  mark: "live" | "done" | "failed" | "idle" | "muted";
  as?: "div" | "li";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Element
      className={cn(
        "flex h-[22px] min-w-0 items-center gap-2 whitespace-nowrap",
        className,
      )}
      style={style}
    >
      <Mark state={mark} />
      {children}
    </Element>
  );
}

function Mark({
  state,
}: {
  state: "live" | "done" | "failed" | "idle" | "muted";
}) {
  if (state === "done" || state === "muted") {
    return (
      <CheckIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 stroke-[3]",
          state === "done" ? "text-green-500" : "text-muted-foreground",
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[11px] shrink-0 place-items-center rounded-full border-[1.5px]",
        state === "live" && "assistant-live-mark border-blue-500",
        state === "failed" && "border-red-500",
        state === "idle" && "border-muted-foreground opacity-60",
      )}
    >
      {state === "live" && (
        <span className="size-[5px] rounded-full bg-blue-500" />
      )}
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-secondary px-1.5 text-[11px] text-foreground">
      {children}
    </span>
  );
}

function LinkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs text-blue-500 transition-colors duration-150 hover:text-blue-400"
    >
      {children}
    </button>
  );
}

function outcomeLabel(outcome: Activity["outcome"]) {
  switch (outcome) {
    case "draft":
      return "Draft ready";
    case "no-reply":
      return "No reply needed";
    case "failed":
      return "Something went wrong";
    default:
      return "Sorted";
  }
}
