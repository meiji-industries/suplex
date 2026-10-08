import type { ReactElement, ReactNode } from "react";

type CompactCardProps = {
  children: ReactNode;
  highlighted?: boolean;
} & ({ href: string; htmlFor?: never } | { htmlFor: string; href?: never });

/** Shared compact surface for project links and selectable move recommendations. */
export function CompactCard({ children, href, htmlFor, highlighted = false }: CompactCardProps): ReactElement {
  const className = `flex h-full min-w-0 cursor-pointer gap-3 rounded-md border p-3 text-sm hover:bg-muted/50 has-[[data-checked]]:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring${highlighted ? " border-primary/50" : ""}`;
  return href !== undefined
    ? <a href={href} className={className}>{children}</a>
    : <label htmlFor={htmlFor} className={className}>{children}</label>;
}
