import { useEffect, useState } from "react";
import { Activity, BarChart3, Database, PieChart, TrendingUp } from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  PieChart as RePieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { getUsageAnalytics, type UsageAnalyticsResponse } from "../../lib/api";

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  puter: "Puter",
  ollama: "Ollama",
  nvidia: "NVIDIA",
  groq: "Groq",
  minimax: "Minimax"
};

const PROVIDER_COLORS: Record<string, string> = {
  gemini: "#4DA6FF",
  puter: "#7ED7A2",
  ollama: "#A78BFA",
  nvidia: "#94e3b8",
  groq: "#F97316",
  minimax: "#E11D48"
};

const CHART_COLORS = ["#4DA6FF", "#7ED7A2", "#E8C06A", "#F18B8B", "#C084FC", "#60A5FA", "#94e3b8", "#FBBF24"];

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

function truncateModelName(value: string, maxLength = 26) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

const chartConfig = {
  margin: { top: 8, right: 8, bottom: 4, left: 0 },
  axisStyle: { fontSize: 11, fill: "var(--text-muted-foreground)" },
  gridStyle: { stroke: "var(--border-card)", strokeDasharray: "3 3" },
};

type ModelBarDatum = {
  name: string;
  fullName: string;
  provider: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  color: string;
  share: number;
  rank: number;
};

type ModelTooltipProps = {
  active?: boolean;
  payload?: Array<{
    payload: ModelBarDatum;
  }>;
};

function ModelUsageTooltip({ active, payload }: ModelTooltipProps) {
  if (!active || !payload?.length) return null;

  const item = payload[0]?.payload;
  if (!item) return null;

  return (
    <div
      className="min-w-[220px] rounded-lg border px-3 py-3 font-mono-tech"
      style={{
        background: "color-mix(in srgb, var(--card-3) 85%, transparent)",
        backdropFilter: "blur(16px)",
        borderColor: "color-mix(in srgb, var(--border-card) 60%, transparent)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-foreground">{item.fullName}</div>
          <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{item.provider}</div>
        </div>
        <div className="panel-badge">#{item.rank}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="panel-card rounded px-2.5 py-2">
          <div className="text-muted-foreground">Total</div>
          <div className="mt-1 font-semibold text-foreground">{formatCompactNumber(item.totalTokens)}</div>
        </div>
        <div className="panel-card rounded px-2.5 py-2">
          <div className="text-muted-foreground">Share</div>
          <div className="mt-1 font-semibold text-foreground">{formatPercent(item.share)}</div>
        </div>
        <div className="panel-card rounded px-2.5 py-2">
          <div className="text-muted-foreground">Prompt</div>
          <div className="mt-1 font-semibold text-foreground">{formatCompactNumber(item.promptTokens)}</div>
        </div>
        <div className="panel-card rounded px-2.5 py-2">
          <div className="text-muted-foreground">Completion</div>
          <div className="mt-1 font-semibold text-foreground">{formatCompactNumber(item.completionTokens)}</div>
        </div>
      </div>
    </div>
  );
}

export function UsageAnalyticsPage() {
  const [analytics, setAnalytics] = useState<UsageAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setLoading(true);
      setMessage("");

      try {
        const usage = await getUsageAnalytics();
        if (!mounted) return;
        setAnalytics(usage);
      } catch (error) {
        if (!mounted) return;
        setMessage(error instanceof Error ? error.message : "Failed to load usage analytics");
        setAnalytics(null);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4 animate-pulse" />
          <span className="text-[12px]">Loading analytics...</span>
        </div>
      </div>
    );
  }

  if (message || !analytics) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app">
        <div className="text-center">
          <div className="rounded-full border border-border bg-card p-4 inline-flex mb-3">
            <BarChart3 className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-[12px] text-muted-foreground">{message || "No analytics data available yet."}</p>
        </div>
      </div>
    );
  }

  const providers = analytics.providers ?? [];
  const models = analytics.models ?? [];

  const providerPieData = providers.map((item, index) => ({
    name: PROVIDER_LABEL[item.provider] || item.provider,
    value: item.totalTokens,
    color: PROVIDER_COLORS[item.provider] ?? CHART_COLORS[index % CHART_COLORS.length],
    requests: item.requests,
    chatRequests: item.chatRequests,
    agentRequests: item.agentRequests,
    share: analytics.totalTokens > 0 ? item.totalTokens / analytics.totalTokens : 0,
  }));

  const modelBarData = models.map((item, index) => ({
    fullName: item.model || "Unknown",
    name: truncateModelName(item.model || "Unknown"),
    provider: PROVIDER_LABEL[item.provider] || item.provider,
    totalTokens: item.totalTokens,
    promptTokens: item.promptTokens,
    completionTokens: item.completionTokens,
    color: CHART_COLORS[index % CHART_COLORS.length],
    share: analytics.totalTokens > 0 ? item.totalTokens / analytics.totalTokens : 0,
    rank: 0,
  })).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const providerStackData = providers.map((item) => ({
    name: PROVIDER_LABEL[item.provider] || item.provider,
    prompt: item.promptTokens,
    completion: item.completionTokens,
    chat: item.chatRequests,
    agent: item.agentRequests,
  }));

  const chatAgentPieData = providers.flatMap((item) => [
    { name: `${PROVIDER_LABEL[item.provider] || item.provider} Chat`, value: item.chatRequests, color: PROVIDER_COLORS[item.provider] ?? CHART_COLORS[0], opacity: 1 },
    { name: `${PROVIDER_LABEL[item.provider] || item.provider} Agent`, value: item.agentRequests, color: PROVIDER_COLORS[item.provider] ?? CHART_COLORS[0], opacity: 0.55 },
  ]).filter((d) => d.value > 0);

  const hasData = providers.length > 0;

  const topModel = modelBarData[0] ?? null;
  const topThreeShare = modelBarData.slice(0, 3).reduce((sum, item) => sum + item.share, 0);
  const leaderboardCount = modelBarData.length;
  const topProvider = [...providerPieData].sort((a, b) => b.value - a.value)[0] ?? null;
  const totalChatRequests = providers.reduce((sum, item) => sum + item.chatRequests, 0);
  const totalAgentRequests = providers.reduce((sum, item) => sum + item.agentRequests, 0);
  const dominantRequestMode = totalAgentRequests > totalChatRequests ? "Agent-heavy" : totalChatRequests > totalAgentRequests ? "Chat-heavy" : "Balanced";
  const promptShare = analytics.totalTokens > 0 ? analytics.promptTokens / analytics.totalTokens : 0;
  const completionShare = analytics.totalTokens > 0 ? analytics.completionTokens / analytics.totalTokens : 0;
  const sortedProviders = [...providers].sort((a, b) => b.totalTokens - a.totalTokens);
  const sortedModels = [...models].sort((a, b) => b.totalTokens - a.totalTokens);

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary">
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Page Header */}
        <header className="space-y-2">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
            <BarChart3 size={16} />
          </div>
          <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Usage Analytics</h1>
          <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
            Token volume, request mix, and model leaderboards across all providers.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            { label: "Responses", value: analytics.totalRequests, icon: Activity },
            { label: "Total tokens", value: analytics.totalTokens, icon: TrendingUp },
            { label: "Prompt tokens", value: analytics.promptTokens, icon: BarChart3 },
            { label: "Completion tokens", value: analytics.completionTokens, icon: PieChart },
          ].map((stat) => (
            <div key={stat.label} className="analytics-panel rounded-lg px-3 py-3 space-y-2">
              <div className="flex items-center gap-2 panel-label text-muted-foreground">
                <div className="flex h-4 w-4 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
                  <stat.icon className="h-2 w-2" />
                </div>
                {stat.label}
              </div>
              <div className="panel-value text-[14px] font-semibold text-foreground">{formatCompactNumber(stat.value)}</div>
            </div>
          ))}
        </div>

        {/* Usage Heatmap */}
        {hasData && analytics.dailyUsage?.length > 0 && (() => {
          const daily = analytics.dailyUsage ?? [];
          if (daily.length === 0) return null;

          const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
          // "Today" is simply the last entry in the daily array — the
          // backend builds it that way (the loop runs `for (let i = 167;
          // i >= 0; i--)` so the last element is always `today`). This
          // sidesteps all timezone issues (server vs client, UTC vs
          // local) because we're matching against the actual last
          // data point, not computing a date string. The last entry's
          // date is what we use for the tooltip "Today ·" prefix.
          const lastEntry = daily[daily.length - 1];
          const todayKey = lastEntry?.date ?? "";
          const maxTokens = Math.max(1, ...daily.map((d) => d.tokens));
          // Stats shown in the panel header (matches the design: Total tokens,
          // Peak tokens, Active days). These are summed/maxed across the
          // displayed window (24 weeks), not the entire account lifetime.
          const totalTokens = daily.reduce((sum, d) => sum + d.tokens, 0);
          const peakTokens = daily.reduce((max, d) => (d.tokens > max ? d.tokens : max), 0);
          const totalActiveDays = daily.filter((d) => d.tokens > 0).length;

          // Organize into weeks (columns) × days (rows).
          // daily is sorted oldest→newest, 168 entries (24 weeks × 7 days).
          // Each day entry is placed in the correct week column based on
          // its day-of-week. The first/last week may be partial if the
          // 168-day window doesn't start on a Monday or end on a Sunday.
          const weeks: Array<Array<{ date: string; tokens: number; requests: number } | null>> = [];
          for (const entry of daily) {
            const d = new Date(entry.date + "T00:00:00");
            const dayOfWeek = (d.getDay() + 6) % 7; // Mon=0, Sun=6
            // New week starts on Monday, or on the very first entry.
            const isFirstEntry = weeks.length === 0;
            const isNewWeekStart = dayOfWeek === 0 && !isFirstEntry;
            const weekIndex = isFirstEntry
              ? 0
              : isNewWeekStart
                ? weeks.length
                : weeks.length - 1;
            while (weeks.length <= weekIndex) weeks.push(new Array(7).fill(null));
            weeks[weekIndex][dayOfWeek] = entry;
          }

          // Month labels (show first occurrence of each month)
          const monthLabels: Array<{ weekIndex: number; label: string }> = [];
          let lastMonth = -1;
          for (let w = 0; w < weeks.length; w++) {
            for (let d = 0; d < 7; d++) {
              const entry = weeks[w]?.[d];
              if (entry) {
                const month = new Date(entry.date + "T00:00:00").getMonth();
                if (month !== lastMonth) {
                  monthLabels.push({ weekIndex: w, label: new Date(entry.date + "T00:00:00").toLocaleDateString(undefined, { month: "short" }) });
                  lastMonth = month;
                }
                break;
              }
            }
          }

          function getIntensity(tokens: number): string {
            if (tokens === 0) return "var(--card-3)";
            const ratio = tokens / maxTokens;
            if (ratio < 0.2) return "color-mix(in srgb, var(--accent-red) 20%, var(--card-3))";
            if (ratio < 0.4) return "color-mix(in srgb, var(--accent-red) 40%, var(--card-3))";
            if (ratio < 0.6) return "color-mix(in srgb, var(--accent-red) 60%, var(--card-3))";
            if (ratio < 0.8) return "color-mix(in srgb, var(--accent-red) 80%, var(--card-3))";
            return "var(--accent-red)";
          }

          return (
            <div className="analytics-panel rounded-lg p-5 space-y-4">
              <div className="relative border-b border-border/40 pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-cyan/15 border border-accent-cyan/20 text-accent-cyan">
                        <Activity size={12} />
                      </div>
                      <div>
                        <div className="panel-label text-muted-foreground">Activity</div>
                        <h3 className="mt-0.5 panel-title text-foreground">Usage Heatmap</h3>
                      </div>
                    </div>
                    <p className="mt-2 max-w-[58ch] panel-desc leading-4">
                      Daily token volume over the last 24 weeks. Hover for details.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[280px]">
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Total tokens</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{formatCompactNumber(totalTokens)}</div>
                    </div>
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Peak tokens</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{formatCompactNumber(peakTokens)}</div>
                    </div>
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Active days</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{totalActiveDays}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3">
                {/* CSS grid so the month labels row and the week columns
                    share the exact same column boundaries — the month
                    labels can then be positioned with `left: %` against
                    the same grid the cells live in. This replaces the
                    previous approach that hardcoded a 14px-per-week
                    margin and broke whenever the weeks were distributed
                    differently (e.g. with `flex-1 justify-between`). */}
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `30px minmax(0, 1fr)`,
                    columnGap: "6px"
                  }}
                >
                  {/* Spacer above the day labels */}
                  <div />

                  {/* Month labels row — positioned absolutely inside a
                      relative container that spans the same column as
                      the week grid. Each label sits at the left edge of
                      the week where the month starts.
                      The `calc()` accounts for the cumulative gap
                      offset: with N weeks each of width W/N plus a
                      3px gap between them, the i-th week starts at
                      i * (W/N + 3/N) = (i/N) * (W + 3) pixels from
                      the left, which as a calc of the parent width is
                      `(100% + 3px) * (i / N)`. */}
                  <div className="relative h-[12px] mb-1.5">
                    {monthLabels.map((m) => {
                      const fraction = weeks.length > 0
                        ? m.weekIndex / weeks.length
                        : 0;
                      return (
                        <span
                          key={m.weekIndex}
                          className="absolute font-mono-tech text-[9px] text-muted-foreground/60 leading-none"
                          style={{ left: `calc((100% + 3px) * ${fraction})` }}
                        >
                          {m.label}
                        </span>
                      );
                    })}
                  </div>

                  {/* Day labels — sit in the first grid column, aligned
                      with each row of cells. `flex-1` makes each label
                      share the row height equally, so the label row
                      matches the cell row height exactly (cell row is
                      7 × cell_width + 6 × 3px gap, label column is
                      7 × label_height + 6 × 3px gap, and `flex-1`
                      distributes so label_height = cell_width). */}
                  <div className="flex flex-col gap-[3px]">
                    {days.map((label, i) => (
                      <div key={i} className="flex-1 flex items-center justify-end pr-0.5">
                        <span className="font-mono-tech text-[9px] text-muted-foreground/50 leading-none">{label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Week columns — same 3px gap as the row gap (between
                      day cells in a week), so the heatmap is a uniform
                      grid of cells with consistent spacing on both
                      axes. Each week takes an equal share of the
                      available width via `flex-1`, and each cell is
                      `aspect-square` so it is always a perfect square
                      regardless of panel width. */}
                  <div className="flex gap-[3px]">
                    {weeks.map((week, wi) => (
                      <div key={wi} className="flex flex-col gap-[3px] flex-1 min-w-0">
                        {week.map((entry, di) => {
                          // "Today" is always the last data cell in the
                          // array — identified by matching its date
                          // against the last entry's date, which the
                          // backend always sets to today. No ring/box
                          // around the cell (that was the "extra box"
                          // the user flagged); the position itself
                          // (rightmost data cell) is the indicator.
                          // The tooltip is prefixed with "Today ·" so
                          // a hover still confirms it.
                          const isToday = !!entry && entry.date === todayKey;
                          return (
                            <div
                              key={di}
                              className="aspect-square w-full rounded-[2px] transition-colors"
                              style={{ backgroundColor: entry ? getIntensity(entry.tokens) : "var(--card-3)" }}
                              title={entry
                                ? `${isToday ? "Today · " : ""}${entry.date}: ${formatCompactNumber(entry.tokens)} tokens, ${entry.requests} requests`
                                : ""}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Legend */}
                <div className="mt-2 flex items-center justify-end gap-1.5 font-mono-tech text-[9px] text-muted-foreground/60">
                  <span>Less</span>
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "var(--card-3)" }} />
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 20%, var(--card-3))" }} />
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 40%, var(--card-3))" }} />
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 60%, var(--card-3))" }} />
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 80%, var(--card-3))" }} />
                  <div className="h-[11px] w-[11px] rounded-[2px]" style={{ backgroundColor: "var(--accent-red)" }} />
                  <span>More</span>
                </div>
              </div>
            </div>
          );
        })()}

        {!hasData ? (
          <div className="analytics-panel rounded-lg border-dashed px-4 py-8 text-center font-mono-tech text-[10px] uppercase tracking-[0.12em] text-muted-foreground">No usage recorded yet. Send some messages to see analytics.</div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="analytics-panel rounded-lg p-5 space-y-4">
                <div className="relative border-b border-border/40 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-blue/15 border border-accent-blue/20 text-accent-blue">
                          <PieChart size={12} />
                        </div>
                        <div>
                          <div className="panel-label text-muted-foreground">Provider split</div>
                          <h3 className="mt-0.5 panel-title text-foreground">Token Distribution</h3>
                        </div>
                      </div>
                      <p className="mt-2 max-w-[48ch] panel-desc leading-4">
                        See where token volume concentrates across providers.
                      </p>
                    </div>
                    <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                      {topProvider ? `Top: ${topProvider.name}` : "No provider data"}
                    </div>
                  </div>
                </div>

                {providerPieData.length === 0 ? (
                  <div className="relative px-3 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">No data</div>
                ) : (
                  <div className="space-y-3">
                    <div className="w-full h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <RePieChart>
                          <Pie
                            data={providerPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius="50%"
                            outerRadius="75%"
                            paddingAngle={3}
                            dataKey="value"
                            stroke="none"
                            cornerRadius={6}
                          >
                            {providerPieData.map((entry, index) => (
                              <Cell key={index} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "color-mix(in srgb, var(--card) 85%, transparent)",
                              backdropFilter: "blur(16px)",
                              border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                              borderRadius: 8,
                              fontSize: 11,
                              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                              color: "var(--text-primary)",
                            }}
                            labelStyle={{ color: "var(--text-primary)" }}
                            itemStyle={{ color: "var(--text-primary)" }}
                            formatter={(value: number) => [formatCompactNumber(value), "Tokens"]}
                          />
                        </RePieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="space-y-1.5">
                      {providerPieData.map((item) => (
                        <div key={item.name} className="panel-card rounded px-3 py-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                                <div className="truncate font-mono-tech text-[11px] font-medium text-foreground">{item.name}</div>
                              </div>
                              <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">{item.requests} responses</div>
                            </div>
                            <div className="text-right">
                              <div className="panel-value text-[11px] font-medium text-foreground">{formatCompactNumber(item.value)}</div>
                              <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">{formatPercent(item.share)}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="analytics-panel rounded-lg p-5 space-y-4">
                <div className="relative border-b border-border/40 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-green/15 border border-accent-green/20 text-accent-green">
                          <TrendingUp size={12} />
                        </div>
                        <div>
                          <div className="panel-label text-muted-foreground">Usage mode</div>
                          <h3 className="mt-0.5 panel-title text-foreground">Chat vs Agent</h3>
                        </div>
                      </div>
                      <p className="mt-2 max-w-[48ch] panel-desc leading-4">
                        Compare how request activity splits between chat sessions and agent-driven workflows.
                      </p>
                    </div>
                    <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                      {dominantRequestMode}
                    </div>
                  </div>
                </div>

                {chatAgentPieData.length === 0 ? (
                  <div className="relative px-3 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">No data</div>
                ) : (
                  <div className="space-y-3">
                    <div className="w-full h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <RePieChart>
                          <Pie
                            data={chatAgentPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius="50%"
                            outerRadius="75%"
                            paddingAngle={2}
                            dataKey="value"
                            stroke="none"
                            cornerRadius={6}
                          >
                            {chatAgentPieData.map((entry, index) => (
                              <Cell
                                key={index}
                                fill={entry.color}
                                fillOpacity={entry.opacity}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "color-mix(in srgb, var(--card) 85%, transparent)",
                              backdropFilter: "blur(16px)",
                              border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                              borderRadius: 8,
                              fontSize: 11,
                              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                              color: "var(--text-primary)",
                            }}
                            labelStyle={{ color: "var(--text-primary)" }}
                            itemStyle={{ color: "var(--text-primary)" }}
                            formatter={(value: number) => [value, "Requests"]}
                          />
                        </RePieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="space-y-1.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="panel-card rounded px-3 py-2">
                          <div className="panel-label text-muted-foreground">Chat</div>
                          <div className="mt-1.5 panel-value text-[16px] font-semibold text-foreground">{formatCompactNumber(totalChatRequests)}</div>
                        </div>
                        <div className="panel-card rounded px-3 py-2">
                          <div className="panel-label text-muted-foreground">Agent</div>
                          <div className="mt-1.5 panel-value text-[16px] font-semibold text-foreground">{formatCompactNumber(totalAgentRequests)}</div>
                        </div>
                      </div>

                      {chatAgentPieData.map((item) => (
                        <div key={item.name} className="panel-card rounded px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-1.5 w-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: item.color, opacity: item.opacity }}
                            />
                            <div className="min-w-0 flex-1 truncate font-mono-tech text-[11px] font-medium text-foreground">{item.name}</div>
                            <div className="font-mono-tech text-[10px] text-muted-foreground">{item.value}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="analytics-panel rounded-lg p-5 space-y-4">
              <div className="relative border-b border-border/40 pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-purple/15 border border-accent-purple/20 text-accent-purple">
                        <BarChart3 size={12} />
                      </div>
                      <div>
                        <div className="panel-label text-muted-foreground">Token mix</div>
                        <h3 className="mt-0.5 panel-title text-foreground">Token Composition</h3>
                      </div>
                    </div>
                    <p className="mt-2 max-w-[58ch] panel-desc leading-4">
                      Compare prompt and completion token contribution by provider.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[260px]">
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Prompt share</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{formatPercent(promptShare)}</div>
                    </div>
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Completion share</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{formatPercent(completionShare)}</div>
                    </div>
                  </div>
                </div>
              </div>

              {providerStackData.length === 0 ? (
                <div className="relative px-3 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">No data</div>
              ) : (
                <div className="relative px-3 py-2">
                  <div className="mb-3 flex flex-wrap items-center gap-3 font-mono-tech text-[10px] text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent-blue" />
                      Prompt tokens
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent-green-alt" />
                      Completion tokens
                    </div>
                  </div>

                  <div className="panel-card rounded p-2 h-[180px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={providerStackData} margin={chartConfig.margin}>
                        <defs>
                          <linearGradient id="promptGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#4DA6FF" stopOpacity={0.32} />
                            <stop offset="95%" stopColor="#4DA6FF" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="completionGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#7ED7A2" stopOpacity={0.32} />
                            <stop offset="95%" stopColor="#7ED7A2" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 6" stroke="var(--border-card)" />
                        <XAxis dataKey="name" tick={chartConfig.axisStyle} axisLine={false} tickLine={false} />
                        <YAxis tick={chartConfig.axisStyle} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatCompactNumber(v)} />
                        <Tooltip
                          contentStyle={{ background: "color-mix(in srgb, var(--card) 85%, transparent)", backdropFilter: "blur(16px)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", borderRadius: 8, fontSize: 11, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "var(--text-primary)" }}
                          formatter={(value: number) => [formatCompactNumber(value), ""]}
                        />
                        <Area type="natural" dataKey="prompt" stroke="#4DA6FF" fill="url(#promptGradient)" strokeWidth={2} name="Prompt tokens" />
                        <Area type="natural" dataKey="completion" stroke="#7ED7A2" fill="url(#completionGradient)" strokeWidth={2} name="Completion tokens" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            <div className="analytics-panel rounded-lg p-5 space-y-4">
              <div className="relative border-b border-border/40 pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-yellow/15 border border-accent-yellow/20 text-accent-yellow">
                        <Activity size={12} />
                      </div>
                      <div>
                        <div className="panel-label text-muted-foreground">Model leaderboard</div>
                        <h3 className="mt-0.5 panel-title text-foreground">Top Models</h3>
                      </div>
                    </div>
                    <p className="mt-2 max-w-[62ch] panel-desc leading-4">
                      Compare which models carry the most token volume across recent usage.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[340px]">
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Leader</div>
                      <div className="mt-0.5 truncate panel-value font-medium text-foreground">{topModel?.fullName ?? "Unknown"}</div>
                      <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">
                        {topModel ? `${formatCompactNumber(topModel.totalTokens)} tokens` : "No data"}
                      </div>
                    </div>
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Top 3 share</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{formatPercent(topThreeShare)}</div>
                      <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">of total token volume</div>
                    </div>
                    <div className="border-l border-border/40 pl-3">
                      <div className="panel-label text-muted-foreground">Tracked models</div>
                      <div className="mt-0.5 panel-value font-medium text-foreground">{leaderboardCount}</div>
                      <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">top active entries shown</div>
                    </div>
                  </div>
                </div>
              </div>

              {modelBarData.length === 0 ? (
                <div className="relative px-3 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">No data</div>
              ) : (
                <div className="relative grid gap-4 px-3 py-2 xl:grid-cols-[minmax(0,1.45fr)_280px]">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="panel-label text-muted-foreground">Token volume</div>
                      <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                        Ranked by total tokens
                      </div>
                    </div>

                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={modelBarData} layout="vertical" margin={{ top: 6, right: 18, bottom: 0, left: 6 }}>
                          <CartesianGrid strokeDasharray="2 6" stroke="var(--border-card)" horizontal={false} />
                          <XAxis
                            type="number"
                            tick={chartConfig.axisStyle}
                            axisLine={false}
                            tickLine={false}
                            tickMargin={10}
                            tickFormatter={(v: number) => formatCompactNumber(v)}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={{ fontSize: 11, fill: "var(--text-muted-foreground)", fontFamily: "'JetBrains Mono', monospace" }}
                            axisLine={false}
                            tickLine={false}
                            tickMargin={10}
                            width={184}
                          />
                          <Tooltip cursor={{ fill: "color-mix(in srgb, var(--foreground) 4%, transparent)" }} content={<ModelUsageTooltip />} />
                          <Bar dataKey="totalTokens" radius={[0, 4, 4, 0]} barSize={16} background={{ fill: "var(--card-3)", radius: 4 }}>
                            {modelBarData.map((entry, index) => (
                              <Cell key={index} fill={entry.color} fillOpacity={index === 0 ? 1 : 0.9} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono-tech text-[10px] text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent-blue" />
                        Primary volume indicator
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-card" />
                        Baseline track for comparison
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-border/40 pt-4 xl:border-t-0 xl:border-l xl:border-border/40 xl:pl-4 xl:pt-0">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="panel-label text-muted-foreground">Quick read</div>
                        <div className="mt-0.5 panel-title text-foreground">Leaders at a glance</div>
                      </div>
                      <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                        Top {Math.min(modelBarData.length, 5)}
                      </div>
                    </div>

                    <div className="mt-3 space-y-1.5">
                      {modelBarData.slice(0, 5).map((item) => (
                        <div key={`${item.provider}-${item.fullName}`} className="flex items-center gap-2 panel-card rounded px-3 py-2">
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/40 bg-card/50 font-mono-tech text-[10px] font-medium text-foreground">
                            {item.rank}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono-tech text-[11px] font-medium text-foreground">{item.fullName}</div>
                            <div className="mt-0.5 flex items-center gap-2 font-mono-tech text-[10px] text-muted-foreground">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: item.color }} />
                              {item.provider}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="panel-value text-[11px] font-medium text-foreground">{formatCompactNumber(item.totalTokens)}</div>
                            <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">{formatPercent(item.share)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="analytics-panel rounded-lg p-5 space-y-4">
                <div className="relative border-b border-border/40 pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-blue/15 border border-accent-blue/20 text-accent-blue">
                        <Activity size={12} />
                      </div>
                      <div>
                        <div className="panel-label text-muted-foreground">Provider table</div>
                        <h3 className="mt-0.5 panel-title text-foreground">Providers</h3>
                      </div>
                    </div>
                    <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                      {sortedProviders.length} tracked
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {sortedProviders.map((item) => (
                    <div key={item.provider} className="panel-card rounded px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-mono-tech text-[11px] font-medium text-foreground">{PROVIDER_LABEL[item.provider] || item.provider}</div>
                          <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">last active {formatDate(item.lastUsedAt)}</div>
                        </div>
                        <div className="text-right">
                          <div className="panel-value text-[11px] font-semibold text-foreground">{formatCompactNumber(item.totalTokens)}</div>
                          <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">{formatCompactNumber(item.requests)} responses</div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 font-mono-tech text-[10px] text-muted-foreground">
                        <span className="panel-badge rounded px-1.5 py-0.5">{item.chatRequests} chat</span>
                        <span className="panel-badge rounded px-1.5 py-0.5">{item.agentRequests} agent</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="analytics-panel rounded-lg p-5 space-y-4">
                <div className="relative border-b border-border/40 pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-purple/15 border border-accent-purple/20 text-accent-purple">
                        <BarChart3 size={12} />
                      </div>
                      <div>
                        <div className="panel-label text-muted-foreground">Model table</div>
                        <h3 className="mt-0.5 panel-title text-foreground">Models</h3>
                      </div>
                    </div>
                    <div className="panel-badge rounded px-2 py-0.5 text-muted-foreground">
                      Sorted by tokens
                    </div>
                  </div>
                </div>

                <div className="sidebar-scroll max-h-[400px] space-y-1.5 overflow-y-auto pr-2">
                  {sortedModels.map((item) => (
                    <div key={`${item.provider}-${item.model}`} className="panel-card rounded px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <code className="block truncate font-mono-tech text-[11px] text-foreground">{item.model}</code>
                          <div className="mt-0.5 font-mono-tech text-[10px] text-muted-foreground">{PROVIDER_LABEL[item.provider] || item.provider}</div>
                        </div>
                        <span className="shrink-0 panel-badge rounded px-2 py-0.5 text-foreground">
                          {formatCompactNumber(item.totalTokens)} tokens
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 font-mono-tech text-[10px] text-muted-foreground">
                        <span className="panel-badge rounded px-1.5 py-0.5">{formatCompactNumber(item.promptTokens)} prompt</span>
                        <span className="panel-badge rounded px-1.5 py-0.5">{formatCompactNumber(item.completionTokens)} completion</span>
                        <span className="panel-badge rounded px-1.5 py-0.5">{item.chatRequests} chat · {item.agentRequests} agent</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        <div className="analytics-panel rounded-lg p-5">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
              <Database size={12} />
            </div>
            <span className="panel-title text-foreground">Token accuracy</span>
          </div>
          <p className="panel-desc font-mono-tech max-w-[65ch] leading-5">
            Real usage appears when the provider returns a <code>usage</code> object. For streaming requests, the app requests <code>stream_options.include_usage</code>; providers that do not return usage will show 0 tokens for those responses.
          </p>
        </div>
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
}
