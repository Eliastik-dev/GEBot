import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { isSafeHref } from "../utils/safeUrl.js";

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: ["h3", "p", "ul", "ol", "li", "strong", "em", "a"],
  attributes: {
    ...defaultSchema.attributes,
    a: ["href"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["https", "http", "tel"],
  },
};

type Props = {
  content: string;
};

export function SafeMarkdown({ content }: Props) {
  return (
    <ReactMarkdown
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      disallowedElements={["script", "style", "iframe", "object", "embed", "form", "input", "img"]}
      unwrapDisallowed
      components={{
        h3: ({ children }) => (
          <h3 className="mt-1.5 mb-0.5 text-xs font-semibold text-[#1A2B4B] first:mt-0 sm:mt-2 sm:mb-1 sm:text-sm">
            {children}
          </h3>
        ),
        ul: ({ children }) => <ul className="my-0.5 list-disc pl-3.5 sm:my-1 sm:pl-4">{children}</ul>,
        li: ({ children }) => <li className="mb-0.5 sm:mb-1">{children}</li>,
        a: ({ href, children }) => {
          const safeHref = isSafeHref(href) ? href : undefined;
          if (!safeHref) return <span>{children}</span>;
          return (
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex rounded-md bg-[#1466AC]/12 px-1.5 py-0.5 text-[11px] text-[#1466AC] hover:bg-[#1466AC]/20 sm:px-2 sm:py-1 sm:text-xs"
            >
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
