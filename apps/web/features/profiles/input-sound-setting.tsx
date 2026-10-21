import { useState, type ReactElement } from "react";

import { Switch } from "../../components/ui/switch.js";
import { SettingRow } from "../settings/settings-layout.js";
import { readInputSound, saveInputSound } from "../tasks/lib/input-sound.js";

const LABEL = "Sound when a task needs your input";

export function InputSoundSetting(): ReactElement {
  const [enabled, setEnabled] = useState(readInputSound);
  return <SettingRow label={LABEL} description="Suplex plays a sound on this device when a task needs your input.">
    <Switch aria-label={LABEL} checked={enabled} onCheckedChange={checked => setEnabled(saveInputSound(checked))} />
  </SettingRow>;
}
