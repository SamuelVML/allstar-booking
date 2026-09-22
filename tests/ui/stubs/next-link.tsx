import React from "react";

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  /** Next.js-only; meaningless outside the framework and not a valid DOM attribute. */
  prefetch?: boolean;
};

/** Stands in for `next/link` so Backstage components mount outside Next.js. */
export default function Link({ children, href, prefetch, ...rest }: LinkProps) {
  void prefetch;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
