import { Button } from "../../components/ui/button.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, type SettingsTableColumn } from "../../components/app/settings-table.js";
import type { ApiModel } from "../../shell/view-shared.js";
import type { ReactElement } from "react";

const MODEL_COLUMNS: SettingsTableColumn[] = [{ key: "model", label: "Model", width: 240 }, { key: "provider", label: "Provider", width: 180 }, { key: "displayName", label: "Display name", width: 220 }];

export function ModelsSection({ models, onReload }: { models: ApiModel[]; onReload: () => void }): ReactElement {
  return <section><SettingsToolbar searchLabel="Search models" searchPlaceholder="Search models" filterLabel="OpenCode" actions={<Button size="sm" variant="outline" onClick={onReload}>Check configuration</Button>} /><p className="my-3 text-xs text-muted-foreground">OpenCode, Claude Code, and Devin CLI supply these models. Configure providers on the Forge host.</p><SettingsDataTable label="Models" columns={MODEL_COLUMNS}><SettingsTableGroup columnCount={MODEL_COLUMNS.length} count={models.length} label="Available models">{models.map((model) => <SettingsTableRow key={model.provider + "/" + model.id}><SettingsTableCell>{model.id}</SettingsTableCell><SettingsTableCell>{model.providerStatus === "missing" ? `${model.providerLabel} (Missing)` : model.providerLabel}</SettingsTableCell><SettingsTableCell>{model.displayName}</SettingsTableCell></SettingsTableRow>)}</SettingsTableGroup>{models.length === 0 ? <SettingsTableEmpty columnCount={MODEL_COLUMNS.length}>Models are not available. Check provider configuration.</SettingsTableEmpty> : null}</SettingsDataTable></section>;
}
