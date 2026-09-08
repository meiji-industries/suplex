export interface ProjectFinding {
  code: string;
  field: string;
  message: string;
}

export class ProjectFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly findings: ProjectFinding[];

  constructor(publicMessage: string, findings: ProjectFinding[] = [], statusCode = 400) {
    super(publicMessage);
    this.name = "ProjectFailure";
    this.publicMessage = publicMessage;
    this.findings = findings;
    this.statusCode = statusCode;
  }
}
