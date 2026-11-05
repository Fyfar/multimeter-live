'use client';

import { DigitalDisplay } from '@/components/DigitalDisplay';
import { RealtimeChart, type ChartType } from '@/components/RealtimeChart';
import { Controls, PanelStrip, RecordButton } from '@/components/Controls';
import { StatisticsPanel } from '@/components/StatisticsPanel';
import { displayUnit, type Reading } from '@/lib/parser';
import type { SampleStore } from '@/lib/samples';
import type { EngineView } from '@/lib/capture';
import { toFinite, type Settings } from '@/lib/settings';
import type { useTriggerEntry } from '@/lib/useTriggerEntry';
import type { Theme } from '@/lib/useTheme';

// An inverted manual range (minimum at or above maximum) describes no window at all. Applying it
// would hand Chart.js `min > max`, which silently renders an empty or upside-down axis — so it is
// ignored and auto-scaling continues, and Controls says so instead of leaving the operator to
// wonder why their numbers did nothing.
function resolveRange(autoScale: boolean, min: string, max: string) {
  const lo = toFinite(min);
  const hi = toFinite(max);
  const rangeInvalid = !autoScale && lo !== null && hi !== null && lo >= hi;
  const manual = !autoScale && !rangeInvalid;
  return { rangeInvalid, yMin: manual ? (lo ?? undefined) : undefined, yMax: manual ? (hi ?? undefined) : undefined };
}

export function Dashboard({
  engineView: ev, store, counts, reading, connected, settings, onSettingsChange, trigger,
  chartType, onChartTypeChange, theme, binWidth, centerValue, onToggleRecord, onStableOnlyChange,
  onClear, onExportCsv, panelOpen, onOpenPanel, onClosePanel,
}: {
  engineView: EngineView;
  store: SampleStore;
  counts: Map<number, number>;
  reading: Reading | null;
  connected: boolean;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  trigger: ReturnType<typeof useTriggerEntry>;
  chartType: ChartType;
  onChartTypeChange: (t: ChartType) => void;
  theme: Theme;
  binWidth: number | undefined;
  centerValue: number | undefined;
  onToggleRecord: () => void;
  onStableOnlyChange: (v: boolean) => void;
  onClear: () => void;
  onExportCsv: () => void;
  panelOpen: boolean;
  onOpenPanel: () => void;
  onClosePanel: () => void;
}) {
  const { rangeMin, rangeMax, autoScale, timeRange, stableOnly } = settings;
  const { rangeInvalid, yMin, yMax } = resolveRange(autoScale, rangeMin, rangeMax);
  // Stays on the statistics, NOT on store.count: statistics are session-scoped and
  // legitimately exceed the retained window past seven days, and this is deliberately 0
  // after a preserve-log reset. Reading the store here would put two differently-valued
  // tiles labelled "Samples" on one screen.
  const recordedCount = ev.stats?.count ?? 0;
  const hasSamples = store.count > 0;

  return (
    <>
      {/* Main content */}
      <main tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-5 focus:outline-none">
        <div className="flex flex-col gap-4">
          <DigitalDisplay
            reading={reading}
            recording={ev.recording}
            sampleCount={recordedCount}
          />
          <PanelStrip label="Controls" expanded={panelOpen} onOpen={onOpenPanel}>
            <RecordButton recording={ev.recording} canRecord={connected} onToggle={onToggleRecord} />
          </PanelStrip>
          <RealtimeChart
            store={store}
            sampleVersion={ev.version}
            chartFromSeq={ev.chartFromSeq}
            chartEpoch={ev.chartEpoch}
            counts={counts}
            stableOnly={stableOnly}
            sessionStart={ev.sessionStart}
            unit={ev.unit}
            yMin={yMin}
            yMax={yMax}
            timeRange={timeRange}
            onTimeRangeChange={(v) => onSettingsChange({ timeRange: v })}
            chartType={chartType}
            onChartTypeChange={onChartTypeChange}
            binWidth={binWidth}
            centerValue={centerValue}
            theme={theme}
          />
          <StatisticsPanel stats={ev.stats} baseUnit={ev.unit} resolution={binWidth} />
        </div>
      </main>

      {/* Right panel */}
      <Controls
        rangeMin={rangeMin}
        rangeMax={rangeMax}
        rangeInvalid={rangeInvalid}
        onRangeMinChange={(v) => onSettingsChange({ rangeMin: v })}
        onRangeMaxChange={(v) => onSettingsChange({ rangeMax: v })}
        autoScale={autoScale}
        onAutoScaleChange={(v) => onSettingsChange({ autoScale: v })}
        triggerThreshold={trigger.threshold}
        onTriggerThresholdChange={trigger.setThreshold}
        triggerArmed={trigger.armed}
        onTriggerArmedChange={trigger.setArmed}
        canArm={(toFinite(trigger.threshold) ?? 0) > 0 && connected}
        triggerUnit={displayUnit(ev.unit)}
        recording={ev.recording}
        onToggleRecord={onToggleRecord}
        canRecord={connected}
        stableOnly={stableOnly}
        onStableOnlyChange={onStableOnlyChange}
        onClear={onClear}
        canClear={hasSamples}
        onExportCsv={onExportCsv}
        canExport={hasSamples}
        open={panelOpen}
        onClose={onClosePanel}
      />
    </>
  );
}
