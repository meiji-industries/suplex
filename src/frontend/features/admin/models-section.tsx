import { Button } from "../../components/ui/button.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, matchesSearch, type SettingsTableColumn } from "../../components/app/settings-table.js";
import type { ApiModel } from "../../shell/view-shared.js";
import { useState, type ReactElement } from "react";

const MODEL_COLUMNS: SettingsTableColumn[] = [{ key: "model", label: "Model", width: 240 }, { key: "provider", label: "Provider", width: 180 }, { key: "displayName", label: "Display name", width: 220 }];

const ALL_PROVIDERS = "All providers";

export function ModelsSection({ models, onReload }: { models: ApiModel[]; onReload: () => void }): ReactElement {
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const providers = [ALL_PROVIDERS, ...new Set(models.map((model) => model.providerLabel))];
  const visible = models.filter((model) => (provider === ALL_PROVIDERS || model.providerLabel === provider) && matchesSearch(search, model.id, model.displayName, model.providerLabel));
  return <section><SettingsToolbar searchLabel="Search models" searchPlaceholder="Search models" searchValue={search} onSearchChange={setSearch} filters={{ options: providers, value: provider, onChange: setProvider }} actions={<Button size="sm" variant="outline" onClick={onReload}>Refresh</Button>} /><SettingsDataTable label="Models" columns={MODEL_COLUMNS}><SettingsTableGroup columnCount={MODEL_COLUMNS.length} count={visible.length} label="Available models">{visible.map((model) => <SettingsTableRow key={model.provider + "/" + model.id}><SettingsTableCell>{model.id}</SettingsTableCell><SettingsTableCell>{model.providerStatus === "missing" ? `${model.providerLabel} (Missing)` : model.providerLabel}</SettingsTableCell><SettingsTableCell>{model.displayName}</SettingsTableCell></SettingsTableRow>)}</SettingsTableGroup>{models.length === 0 ? <SettingsTableEmpty columnCount={MODEL_COLUMNS.length}>Models are not available. Check provider configuration.</SettingsTableEmpty> : visible.length === 0 ? <SettingsTableEmpty columnCount={MODEL_COLUMNS.length}>No models match the search.</SettingsTableEmpty> : null}</SettingsDataTable></section>;
}
