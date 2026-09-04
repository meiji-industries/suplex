import type { OwnerAnswer } from "../../workflow/owner-answer.js";

export interface HerdrTurnReadActivities {
  readHerdrTurn(input: {
    taskId: string;
    companyId: string;
    workflowId: string;
    role: "planner" | "reviewer" | "builder" | "integrator";
    promptKind: string;
    subject: { commit?: string | null; tree?: string | null; planRevision?: number | null };
  }): Promise<OwnerAnswer>;
}
