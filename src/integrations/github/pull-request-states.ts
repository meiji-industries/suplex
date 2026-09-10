import { z } from "zod";
import type { PullRequestReference } from "../../tasks/control.js";

export type PullRequestIdentity = { repository: string; number: number };
const Identity = z.object({ repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i), number: z.number().int().positive() });
const Pull = z.object({ number: z.number().int().positive(), url: z.string().url(), headRefOid: z.string().min(1), state: z.enum(["OPEN", "CLOSED", "MERGED"]), mergedAt: z.string().datetime().nullable() });
const Response = z.object({ data: z.record(z.string(), z.object({ pullRequest: Pull.nullable() }).nullable()) });

export async function readPullRequestStates(inputs: PullRequestIdentity[], query: (query: string) => Promise<unknown>): Promise<PullRequestReference[]> {
  const unique = new Map<string, PullRequestIdentity>();
  for (const input of inputs) {
    const identity = Identity.parse(input);
    identity.repository = identity.repository.toLowerCase();
    unique.set(`${identity.repository}#${identity.number}`, identity);
  }
  const identities = [...unique.values()];
  const result: PullRequestReference[] = [];
  for (let offset = 0; offset < identities.length; offset += 50) {
    const batch = identities.slice(offset, offset + 50);
    const fields = batch.map(({ repository, number }, index) => {
      const [owner, name] = repository.split("/");
      return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { number url headRefOid state mergedAt } }`;
    });
    const response = Response.parse(await query(`query { ${fields.join(" ")} }`));
    batch.forEach((identity, index) => {
      const pull = response.data[`p${index}`]?.pullRequest;
      if (!pull) return;
      if (pull.number !== identity.number) throw new Error("GitHub returned a different pull request number");
      result.push({ repository: identity.repository, number: pull.number, url: pull.url, headSha: pull.headRefOid, state: pull.state.toLowerCase(), mergedAt: pull.mergedAt });
    });
  }
  return result;
}
