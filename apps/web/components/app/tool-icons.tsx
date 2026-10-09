export const toolIcons = {
  git: { label: "Git", src: new URL("./tool-icons/git.svg", import.meta.url).href, render: "mask", color: "#F05032" },
  "gh-auth": { label: "GitHub", src: new URL("./tool-icons/github.svg", import.meta.url).href, render: "mask", color: undefined },
  "gh-cli": { label: "GitHub CLI", src: new URL("./tool-icons/github.svg", import.meta.url).href, render: "mask", color: undefined },
  bitbucket: { label: "Bitbucket", src: new URL("./tool-icons/bitbucket.svg", import.meta.url).href, render: "mask", color: undefined },
  jira: { label: "Jira", src: new URL("./tool-icons/jira.svg", import.meta.url).href, render: "mask", color: undefined },
  linear: { label: "Linear", src: new URL("./tool-icons/linear.svg", import.meta.url).href, render: "mask", color: undefined },
  "herdr-readiness": { label: "Herdr", src: new URL("./tool-icons/herdr.svg", import.meta.url).href, render: "image", color: undefined },
} satisfies Record<string, { label: string; src: string; render: "mask" | "image"; color: string | undefined }>;

export type ToolIconId = keyof typeof toolIcons;

export function ToolIcon({ tool }: { tool: ToolIconId }) {
  const icon = toolIcons[tool];
  if (icon.render === "image") return <img aria-hidden="true" alt="" src={icon.src} className="size-4 shrink-0 rounded-sm" />;
  const mask = `url("${icon.src}") center / contain no-repeat`;
  return <span aria-hidden="true" className="inline-block size-4 shrink-0 bg-current" style={{ mask, WebkitMask: mask, color: icon.color }} />;
}
