import type { TaskSetup } from "../../contracts/generated/TaskSetup.js";

export function setupStatus(setup: TaskSetup): string {
  switch (setup.state) {
    case "running": return "Setup runs.";
    case "succeeded": return "Setup succeeded.";
    case "failed": return setup.exitStatus === "not recorded" ? "Setup stopped. Exit status is not available." : `Setup failed with exit status ${setup.exitStatus}.`;
    case "none": return "";
  }
}
