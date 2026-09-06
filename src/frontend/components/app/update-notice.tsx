import { X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { UpdateResponseSchema, type UpdateResponse } from "../../../http/contracts/update.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../ui/button.js";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "../ui/card.js";

const UPDATE_POLL_INTERVAL_MS = 60_000;

export function UpdateNotice(): ReactElement | null {
  const [update, setUpdate] = useState<UpdateResponse | undefined>();
  const [closedRevision, setClosedRevision] = useState<string | undefined>();

  useEffect(() => {
    let closed = false;
    const readUpdate = async (): Promise<void> => {
      try {
        const next = UpdateResponseSchema.parse(await readJson<UpdateResponse>("/api/update"));
        if (!closed) setUpdate(next);
      } catch {
        if (!closed) setUpdate({ available: false });
      }
    };
    void readUpdate();
    const timer = setInterval(() => void readUpdate(), UPDATE_POLL_INTERVAL_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  if (!update?.available) return null;
  const revision = update.revision ?? "available";
  if (closedRevision === revision) return null;

  return (
    <div data-update-notice data-update-revision={update.revision} role="status" aria-live="polite" className="border-b px-4 py-2 lg:px-6">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Update available</CardTitle>
          <CardDescription>Update and restart Forge.</CardDescription>
          <CardAction>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Close update notice" title="Close update notice" onClick={() => setClosedRevision(revision)}>
              <X aria-hidden="true" />
            </Button>
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  );
}
