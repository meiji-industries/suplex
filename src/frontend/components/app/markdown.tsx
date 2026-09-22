import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MarkdownImageSource = Record<string, string>;

export function Markdown({ source, imageSources }: { source: string; imageSources?: MarkdownImageSource }) {
  return (
    <div className="prose-suplex">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a({ children, href, node: _node, ...props }) {
            return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          img({ src, node: _node, ...props }) {
            return <img {...props} src={src ? imageSources?.[src] ?? src : undefined} />;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
