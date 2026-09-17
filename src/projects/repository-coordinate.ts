export function repositoryCoordinate(value: string): { host: "github" | "bitbucket"; repository: string; cloneUrl: string; name: string } | null {
  const raw = value.trim();
  if (/(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])/i.test(raw)) return null;
  const ssh = /^git@(github\.com|bitbucket\.org):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  let domain: string, owner: string, name: string;
  if (ssh?.[1] && ssh[2] && ssh[3]) { domain = ssh[1]; owner = ssh[2]; name = ssh[3]; }
  else {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" || !["github.com", "bitbucket.org"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match?.[1] || !match[2]) return null;
    domain = url.hostname; owner = match[1]; name = match[2];
  }
  if ([owner, name].some(part => part === "." || part === ".." || part.startsWith("-"))) return null;
  const repository = `${owner}/${name}`.toLowerCase();
  return { host: domain === "github.com" ? "github" : "bitbucket", repository, name, cloneUrl: ssh ? `git@${domain}:${repository}.git` : `https://${domain}/${repository}.git` };
}
