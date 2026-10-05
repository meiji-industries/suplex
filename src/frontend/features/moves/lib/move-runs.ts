import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import type { MoveResponse } from "../../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../../contracts/generated/MoveRunResponse.js";
import type { MoveRunner } from "../../../contracts/generated/MoveRunner.js";
import { useOptionalCompanyContext } from "../../../shell/company-context.js";
import { archiveMoveRun, endMoveRun, listMoves } from "./move-api.js";

/** Prompts and scripts run in a terminal. Pull request and task moves start tasks instead. */
export const runsInTerminal = (runner: MoveRunner): boolean => runner === "prompt" || runner === "script";

/** Each move's latest terminal run. Other runners show through the tasks they start. */
export function useShellRuns(companyId: string | undefined): Array<{ move: MoveResponse; run: MoveRunResponse }> {
  const user = useOptionalCompanyContext()?.user;
  const moves = useQuery({
    queryKey: ["moves", user?.id, companyId],
    queryFn: companyId ? ({ signal }) => listMoves(companyId, signal) : skipToken,
    refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 3000,
  });
  return (moves.data ?? []).flatMap(move => move.lastRun && runsInTerminal(move.lastRun.runner) ? [{ move, run: move.lastRun }] : []);
}

/** Stop ends a live run's terminal. Archive hides the run and ends a live terminal too. Both refresh every list of moves. */
export function useRunActions(): { stop: (runId: string) => Promise<void>; archive: (runId: string) => Promise<void> } {
  const queries = useQueryClient();
  const then = (operation: (runId: string) => Promise<void>) => async (runId: string): Promise<void> => {
    await operation(runId);
    await queries.invalidateQueries({ queryKey: ["moves"] });
  };
  return { stop: then(endMoveRun), archive: then(archiveMoveRun) };
}
