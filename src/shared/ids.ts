declare const gitShaBrand: unique symbol;
declare const gitTreeBrand: unique symbol;
declare const turnIdBrand: unique symbol;
declare const executionIdBrand: unique symbol;

export type GitSha = string & { readonly [gitShaBrand]: "GitSha" };
export type GitTree = string & { readonly [gitTreeBrand]: "GitTree" };
export type TurnId = string & { readonly [turnIdBrand]: "TurnId" };
export type ExecutionId = string & { readonly [executionIdBrand]: "ExecutionId" };

function id(value: string, name: string): string {
  if (!value) throw new Error(`${name} must not be empty`);
  return value;
}

export function gitSha(value: string): GitSha { return id(value, "GitSha") as GitSha; }
export function gitTree(value: string): GitTree { return id(value, "GitTree") as GitTree; }
export function turnId(value: string): TurnId { return id(value, "TurnId") as TurnId; }
export function executionId(value: string): ExecutionId { return id(value, "ExecutionId") as ExecutionId; }
