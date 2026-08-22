import { durableId } from "../primitives.js";

export const identityStateFields = {
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
};
