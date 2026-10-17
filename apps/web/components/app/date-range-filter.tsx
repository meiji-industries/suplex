import type { ReactElement } from "react";

import { Input } from "../ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.js";
import {
  changeDateRangeEnd,
  changeDateRangeStart,
  displayedDates,
  resolveDateRange,
  type DateRangePreset,
  type DateRangeSelection,
} from "./date-range.js";

/**
 * Preset pills and start and end date inputs for a local-day range.
 * `today` is the latest day to select, as a date input value. `label` names the inputs, such as "Timeline start date".
 */
export function DateRangeFilter({ value, onChange, today, label }: {
  value: DateRangeSelection;
  onChange: (value: DateRangeSelection) => void;
  today: string;
  label: string;
}): ReactElement {
  const displayed = displayedDates(value, resolveDateRange(value, today));
  return <>
    <Tabs value={value.preset} onValueChange={preset => onChange({ ...value, preset: preset as DateRangePreset })}>
      <TabsList variant="pill">
        <TabsTrigger className="font-normal" value="today">Today</TabsTrigger>
        <TabsTrigger className="font-normal" value="7-days">7 days</TabsTrigger>
        <TabsTrigger className="font-normal" value="30-days">30 days</TabsTrigger>
        <TabsTrigger className="font-normal" value="custom">Custom</TabsTrigger>
      </TabsList>
    </Tabs>
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <label className="w-36">
        <span className="sr-only">{label} start date</span>
        <Input
          aria-label={`${label} start date`}
          type="date"
          max={displayed.end}
          value={displayed.start}
          onChange={event => { if (event.target.value) onChange(changeDateRangeStart(displayed, event.target.value)); }}
        />
      </label>
      <span>to</span>
      <label className="w-36">
        <span className="sr-only">{label} end date</span>
        <Input
          aria-label={`${label} end date`}
          type="date"
          min={displayed.start}
          max={today}
          value={displayed.end}
          onChange={event => { if (event.target.value) onChange(changeDateRangeEnd(displayed, event.target.value)); }}
        />
      </label>
    </div>
  </>;
}
