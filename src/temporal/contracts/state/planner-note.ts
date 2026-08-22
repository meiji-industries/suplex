import { z } from "zod";

export const plannerNoteStateFields = {
  pendingPlannerNotes: z.array(z.string().trim().min(1).max(8_000)).max(32).optional(),
};
