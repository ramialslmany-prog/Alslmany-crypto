/**
 * "How the bot reached this decision" — the eight stages as a timeline.
 *
 * The rule this component exists to hold: UNAVAILABLE STAGES ARE DISPLAYED,
 * not omitted, with the confidence penalty they caused. A pipeline that
 * quietly drops what it could not read presents a partial analysis as a
 * complete one.
 */
import { num } from "@/web/format";

export interface TimelineStage {
  id: string;
  number: number;
  name: string;
  status: "pass" | "fail" | "unavailable";
  score: number;
  arabic: string;
  failReason?: string | null;
  unavailableReason?: string | null;
  confidencePenalty?: number;
  factors?: { id: string; label: string; display: string; contribution: number; note: string }[];
}

const STATUS_AR = {
  pass: "اجتازت",
  fail: "سقطت",
  unavailable: "غير متاحة",
} as const;

export function StageTimeline({ stages, showFactors = true }: { stages: TimelineStage[]; showFactors?: boolean }) {
  return (
    <div className="timeline">
      {stages.map((stage) => (
        <article key={stage.id} className={`stage-row ${stage.status}`}>
          <div className="stage-rail">
            <span className="n">{stage.number}</span>
            <span className="dot" aria-hidden="true" />
          </div>

          <div className="stage-body">
            <div className="stage-title">
              <span className="name">{stage.name}</span>
              <span className={`chip ${stage.status === "fail" ? "chip-short" : stage.status === "pass" ? "chip-info" : ""}`}>
                {STATUS_AR[stage.status]}
              </span>
              {stage.status === "pass" && stage.score !== 0 && (
                <span className="score">{stage.score > 0 ? "+" : "−"}{num(Math.abs(stage.score), 0)}</span>
              )}
              {stage.status === "unavailable" && stage.confidencePenalty ? (
                <span className="score">خفضت الثقة {num(stage.confidencePenalty * 100, 0)}%</span>
              ) : null}
            </div>

            <p className="stage-narrative">
              {stage.status === "fail" && stage.failReason ? stage.failReason : stage.arabic}
            </p>

            {showFactors && stage.factors && stage.factors.length > 0 && (
              <div className="factors">
                {stage.factors.map((f) => (
                  <div key={f.id} className="factor">
                    <span className="fl">{f.label}</span>
                    <span className="fv">
                      {f.display}
                      {f.contribution !== 0 && (
                        <span className="contrib" style={{ marginInlineStart: 8, color: f.contribution > 0 ? "var(--profit)" : "var(--loss)" }}>
                          {f.contribution > 0 ? "+" : "−"}{num(Math.abs(f.contribution), 1)}
                        </span>
                      )}
                    </span>
                    <span className="fn">{f.note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
