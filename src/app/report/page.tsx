import { getDb } from "@/db";
import { buildWeeklyReport, type WeeklyReport } from "@/server/report";
import { MISS_CLASS_LABELS, TAXONOMY_LABELS } from "@/lib/labels";
import { timeAgo } from "@/lib/time";

// Same reasoning as the other top-level surfaces: this page reflects
// activity that changes on every capture/write/talk/dictation attempt, so it
// must never be frozen into the build-time static shell.
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sá"]; // Date#getUTCDay(): 0 = Sunday

type EvalMetric = {
  key: "false_flag_rate" | "catch_rate" | "adjudicated_agreement";
  label: string;
  bar: string;
  passes: (v: number) => boolean;
};

const EVAL_METRICS: EvalMetric[] = [
  { key: "false_flag_rate", label: "Falsos positivos", bar: "≤ 10%", passes: (v) => v <= 0.1 },
  { key: "catch_rate", label: "Tasa de detección", bar: "≥ 85%", passes: (v) => v >= 0.85 },
  { key: "adjudicated_agreement", label: "Acuerdo con tus veredictos", bar: "≥ 75%", passes: (v) => v >= 0.75 },
];

/** The trailing 7 UTC calendar days (oldest first), each labeled with its weekday and whether `report` saw activity on it. */
function lastSevenDays(now: Date): { key: string; label: string }[] {
  const days: { key: string; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    days.push({ key: d.toISOString().slice(0, 10), label: WEEKDAY_LABELS[d.getUTCDay()] });
  }
  return days;
}

export default function ReportPage() {
  const db = getDb();
  const report = buildWeeklyReport(db);
  const days = lastSevenDays(new Date());

  return (
    <div className="min-h-dvh">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-2xl font-bold tracking-tight">Reporte</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Tu progreso de la semana</p>
      </header>

      <main className="flex flex-col gap-4 px-4 pb-28 pt-4">
        <Section title="Esta semana" testId="report-week">
          <div className="flex items-center justify-between">
            {days.map((day) => {
              const active = report.activeDays.includes(day.key);
              return (
                <div key={day.key} className="flex flex-col items-center gap-1.5">
                  <span
                    data-testid="active-day-dot"
                    data-active={active}
                    className={`h-3 w-3 rounded-full ${active ? "bg-accent" : "bg-line"}`}
                  />
                  <span className="text-[11px] text-ink-muted">{day.label}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-ink-muted">
            <span className="font-semibold text-ink">{report.daysUsedLast7}</span> de 7 días activos ·{" "}
            <span className="font-semibold text-ink">{report.itemsCapturedLast7}</span>{" "}
            {report.itemsCapturedLast7 === 1 ? "ítem capturado" : "ítems capturados"}
          </p>
        </Section>

        <Section title="Transferencia" testId="report-transfer">
          <p className="text-2xl font-bold text-ink">{report.transfer.count}</p>
          <p className="text-xs text-ink-muted">
            chunks capturados que aparecieron en tu producción (Escribir/Hablar) al menos un día después de
            capturarlos
          </p>
          {report.transfer.chunks.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {report.transfer.chunks.map((chunk) => (
                <span
                  key={chunk}
                  data-testid="transfer-chunk"
                  className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong"
                >
                  {chunk}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title="Categorías recurrentes" testId="report-recurrence">
          {report.recurrence.length === 0 ? (
            <p className="text-sm text-ink-muted">Sin errores registrados todavía.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {report.recurrence.slice(0, 5).map((row) => (
                <li
                  key={row.tag}
                  data-testid="recurrence-row"
                  data-tag={row.tag}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-ink">{TAXONOMY_LABELS[row.tag]}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{row.count}</span>
                    <TrendBadge count={row.count} prevCount={row.prevCount} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Dictado" testId="report-dictation">
          {report.dictation.length === 0 ? (
            <p className="text-sm text-ink-muted">Sin intentos de dictado en los últimos 30 días.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {report.dictation.map((row) => (
                <li key={row.missClass} data-testid="dictation-row" className="flex items-center justify-between text-sm">
                  <span className="text-ink">{MISS_CLASS_LABELS[row.missClass]}</span>
                  <span className="font-semibold text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Evaluador" testId="report-eval">
          {report.latestEval ? (
            <EvalSummary evalRun={report.latestEval} />
          ) : (
            <p className="text-sm text-ink-muted">
              Sin evaluaciones todavía — corre <code className="rounded bg-paper px-1 py-0.5 text-xs">npm run eval</code>
            </p>
          )}
        </Section>
      </main>
    </div>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section
      data-testid={testId}
      className="rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-ink-muted">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function TrendBadge({ count, prevCount }: { count: number; prevCount: number }) {
  const symbol = count > prevCount ? "↑" : count < prevCount ? "↓" : "=";
  const cls = count > prevCount ? "text-danger-fg" : count < prevCount ? "text-kept-fg" : "text-ink-muted";
  return (
    <span data-testid="trend-badge" className={`text-xs font-semibold ${cls}`}>
      {symbol}
    </span>
  );
}

function EvalSummary({ evalRun }: { evalRun: NonNullable<WeeklyReport["latestEval"]> }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">
        {evalRun.model} · {timeAgo(evalRun.createdAt)}
      </p>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {EVAL_METRICS.map(({ key, label, bar, passes }) => {
          const value = evalRun.agreement[key];
          return (
            <li
              key={key}
              data-testid="eval-metric-row"
              data-metric={key}
              className="flex items-center justify-between text-sm"
            >
              <span className="text-ink">{label}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-ink-muted">{bar}</span>
                {value === undefined ? (
                  <span className="text-xs text-ink-muted">—</span>
                ) : (
                  <span
                    data-testid="eval-metric-value"
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      passes(value) ? "bg-kept-bg text-kept-fg" : "bg-danger-bg text-danger-fg"
                    }`}
                  >
                    {(value * 100).toFixed(0)}%
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
