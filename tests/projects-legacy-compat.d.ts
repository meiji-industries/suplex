import "../src/projects.js";

// Historical fixtures still construct revision-era workflow inputs. Production
// project responses deliberately do not carry these fields.
declare module "../src/projects.js" {
  interface Project {
    status?: string;
    activeRevisionId?: string;
    configurationRevision?: number;
    configurationIdentity?: string;
    baseSha?: string;
    targetSha?: string;
  }
}

export {};
