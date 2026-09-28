import type { ReactElement, ReactNode } from "react";
import { Filters, FilterValuePopover, createFilterQuery, createFilterRule, type FilterField, type FilterOperator } from "../../components/reui/filters/filters.js";
import { Button } from "../../components/ui/button.js";
import { ButtonGroupText } from "../../components/ui/button-group.js";

export function TaskOptionFilter<V extends string | string[]>({ prefix, label, value, valueLabel, valueIcon, options, disabled, onValueChange }: {
  prefix: string | ReactElement;
  label: string;
  value: V;
  valueLabel?: string;
  valueIcon?: ReactNode;
  options: { value: string; label: string; icon?: ReactNode; disabled?: boolean }[];
  disabled: boolean;
  onValueChange: (value: V) => void;
}) {
  const operator: FilterOperator = { value: "is", label: "is", arity: Array.isArray(value) ? "many" : "one" };
  const field: FilterField<V> = { id: label, label, type: Array.isArray(value) ? "multiselect" : "select", options, operators: [operator], searchable: false };
  const rule = createFilterRule({ id: label, path: [label], operator: "is", value });
  return <Filters fields={[field]} query={createFilterQuery([rule])} disabled={disabled} onQueryChange={query => {
    const next = query.rules[0];
    if (next?.type === "rule" && next.value !== undefined) onValueChange(next.value);
  }}>
      {typeof prefix === "string" ? <ButtonGroupText><span className="text-muted-foreground">{prefix}</span></ButtonGroupText> : prefix}
      <FilterValuePopover rule={rule} field={field} operator={operator} trigger={<Button type="button" variant="outline" size="sm" aria-label={label}>{valueIcon ?? options.find(option => option.value === value)?.icon}{valueLabel ?? options.find(option => option.value === value)?.label ?? value}</Button>} />
  </Filters>;
}
