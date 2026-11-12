"use client";

import type { AiStageResult } from "../../../lib/api";

/**
 * The AI pipeline's stage set, in execution order (ADR-006 §5).
 * `media.ai.stages` only contains stages that have already settled (READY or
 * FAILED), so the bar advances as the runner persists each stage.
 */
const AI_STAGES = ["TRANSCRIPTION", "SUMMARY", "KEYWORDS", "CLASSIFICATION", "OCR"] as const;

function label(stage: string): string {
  return stage.charAt(0) + stage.slice(1).toLowerCase();
}

/**
 * Data-driven staged progress bar for AI enrichment (ADR-006 §17).
 *
 * Rendered only while work is in flight (PENDING/PROCESSING); the stage table
 * remains the source of truth for finished results. The fill reflects settled
 * stages / total stages — never a fabricated percentage. PENDING has no settled
 * stage yet, so it shows an indeterminate sweep; PROCESSING animates the
 * in-flight segment so the card is visibly working.
 */
export function AiProgress({ status, stages }: { status: string; stages: AiStageResult[] }) {
  const pending = status === "PENDING";
  const processing = status === "PROCESSING";
  if (!pending && !processing) return null;

  const settled = new Map(stages.map((stage) => [stage.stage, stage.status]));
  const settledCount = AI_STAGES.filter((stage) => settled.has(stage)).length;
  const percent = Math.round((settledCount / AI_STAGES.length) * 100);
  const nextStage = AI_STAGES.find((stage) => !settled.has(stage));

  const fillClass = pending ? "ai-progress-fill indeterminate" : "ai-progress-fill active";

  return (
    <div className="ai-progress">
      <div className="ai-progress-head">
        <span>
          {pending && "Queued for processing…"}
          {processing && nextStage && `Processing ${label(nextStage)}…`}
          {processing && !nextStage && "Finalizing…"}
        </span>
        <span>{pending ? "—" : `${percent}%`}</span>
      </div>
      <div
        className="ai-progress-track"
        role="progressbar"
        aria-label="AI enrichment progress"
        {...(pending
          ? {}
          : { "aria-valuemin": 0, "aria-valuemax": AI_STAGES.length, "aria-valuenow": settledCount })}
      >
        <div
          className={fillClass}
          style={pending ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="ai-progress-steps">
        {AI_STAGES.map((stage) => {
          const stageStatus = settled.get(stage);
          const className = stageStatus === "READY"
            ? "ai-step done"
            : stageStatus === "FAILED"
              ? "ai-step failed"
              : processing && stage === nextStage
                ? "ai-step active"
                : "ai-step";
          return <span key={stage} className={className}>{label(stage)}</span>;
        })}
      </div>
    </div>
  );
}
