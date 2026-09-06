import { z } from "zod";

export const UpdateResponseSchema = z.object({
  available: z.boolean(),
  revision: z.string().min(1).optional(),
});

export type UpdateResponse = z.infer<typeof UpdateResponseSchema>;
