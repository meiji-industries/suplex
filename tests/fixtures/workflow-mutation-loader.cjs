module.exports = function workflowMutationLoader(source) {
  const mode = this.getOptions ? this.getOptions().mode : "incompatible";
  if (mode !== "compatible" && mode !== "incompatible") throw new Error(`Unknown Workflow mutation mode: ${mode}`);
  const needle = "if (distinctPlanningStates || !patched(planningProjectionIntegrityPatch)) await projectIssueState(next);";
  if (source.split(needle).length !== 2) throw new Error("Workflow mutation target must occur exactly once");
  if (mode === "compatible") {
    return source.replace(needle, `if (patched("suplex-replay-compatible-mutation-v1")) await sleep("1 millisecond");\n    ${needle}`);
  }
  return source.replace(needle, `await sleep("1 millisecond");\n    ${needle}`);
};
