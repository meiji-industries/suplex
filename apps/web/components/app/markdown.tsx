import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MarkdownImageSource = Record<string, string>;

const remarkPlugins = [remarkGfm, remarkBreaks];
const MarkdownLink: Components["a"] = ({ children, href, node: _node, ...props }) => (
  <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
);

export const Markdown = memo(function Markdown({ source, imageSources }: { source: string; imageSources?: MarkdownImageSource }) {
  const components = useMemo<Components>(() => ({
    a: MarkdownLink,
    img({ src, node: _node, ...props }) {
      return <img {...props} src={src ? imageSources?.[src] ?? src : undefined} />;
    },
  }), [imageSources]);
  return (
    <div className="prose-suplex">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
