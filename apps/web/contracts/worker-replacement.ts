import { z } from "zod";

export const WorkerReplacementSchema = z.object({ sessionId: z.string(), reason: z.string(), handoff: z.string() });
