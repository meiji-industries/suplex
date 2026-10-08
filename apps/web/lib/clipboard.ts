import { toast } from "sonner";

export async function copyToClipboard(text: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error("Suplex could not copy to clipboard. Select the text and copy it.");
    return false;
  }
  toast.success(message);
  return true;
}
