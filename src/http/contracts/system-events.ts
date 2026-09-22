import { z } from "zod";

export const ClientLifecycleSchema = z.object({
  state: z.enum(["startup", "resumed", "api_activity", "pageshow", "pagehide", "visible", "hidden", "online", "offline"]),
  tabId: z.string().uuid(),
  documentId: z.string().uuid(),
  clientTime: z.iso.datetime(),
  visible: z.boolean(),
  online: z.boolean(),
}).strict();
