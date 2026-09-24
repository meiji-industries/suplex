import type { ReactElement } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "../ui/empty.js";
import { Spinner } from "../ui/spinner.js";

/** Page or panel loading state. Tables use SettingsTableLoading instead. */
export function LoadingState({ label = "Please wait." }: { label?: string }): ReactElement {
  return (
    <Empty aria-busy="true">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
        <EmptyDescription>{label}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
