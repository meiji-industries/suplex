/** Local-day date ranges. A range starts at local midnight and ends at the exclusive midnight after its last day. */
export type DateRange = { start: number; end: number };
export type DateRangePreset = "today" | "7-days" | "30-days" | "custom";
/** The selected preset and the custom days, as `YYYY-MM-DD` date input values. */
export type DateRangeSelection = { preset: DateRangePreset; customStart: string; customEnd: string };

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function presetRange(preset: Exclude<DateRangePreset, "custom">, now: Date): DateRange {
  const end = addDays(startOfDay(now), 1);
  const days = preset === "today" ? 1 : preset === "7-days" ? 7 : 30;
  return { start: addDays(end, -days).getTime(), end: end.getTime() };
}

export function customRange(start: string, end: string): DateRange {
  const rangeStart = startOfDay(dateFromInput(start));
  return {
    start: rangeStart.getTime(),
    end: addDays(startOfDay(dateFromInput(end)), 1).getTime(),
  };
}

/** A selection on `preset` whose custom days match that preset's range. */
export function initialDateRange(preset: Exclude<DateRangePreset, "custom">, now = new Date()): DateRangeSelection {
  const range = presetRange(preset, now);
  return { preset, customStart: dateInputValue(new Date(range.start)), customEnd: dateInputValue(new Date(range.end - 1)) };
}

/** The range a selection covers. `today` is the current local day as a date input value. */
export function resolveDateRange(selection: DateRangeSelection, today: string): DateRange {
  return selection.preset === "custom"
    ? customRange(selection.customStart, selection.customEnd)
    : presetRange(selection.preset, dateFromInput(today));
}

/** The first and last day that the date inputs show for a selection. */
export function displayedDates(selection: DateRangeSelection, range: DateRange): { start: string; end: string } {
  return selection.preset === "custom"
    ? { start: selection.customStart, end: selection.customEnd }
    : { start: dateInputValue(new Date(range.start)), end: dateInputValue(new Date(range.end - 1)) };
}

/** Select a custom start day. A start after the shown end also moves the end. */
export function changeDateRangeStart(displayed: { start: string; end: string }, value: string): DateRangeSelection {
  return { preset: "custom", customStart: value, customEnd: value > displayed.end ? value : displayed.end };
}

/** Select a custom end day. An end before the shown start also moves the start. */
export function changeDateRangeEnd(displayed: { start: string; end: string }, value: string): DateRangeSelection {
  return { preset: "custom", customStart: value < displayed.start ? value : displayed.start, customEnd: value };
}

export function dateRangeIncludes(range: DateRange, time: number): boolean {
  return time >= range.start && time < range.end;
}
