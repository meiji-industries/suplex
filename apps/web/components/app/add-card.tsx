import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../ui/button.js";

export function AddCard({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-primary/50 p-4"><Button type="button" onClick={onClick}><Plus />{label}</Button></div>;
}
