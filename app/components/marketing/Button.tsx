import type { ReactNode } from "react";
import { Link } from "react-router";

type Variant = "primary" | "secondary";
type Size = "md" | "lg";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
}
interface AnchorProps extends BaseProps {
  href: string;
  to?: never;
  external?: boolean;
}
interface LinkProps extends BaseProps {
  to: string;
  href?: never;
  external?: never;
}

type Props = AnchorProps | LinkProps;

const baseClasses =
  "inline-flex items-center justify-center rounded-full font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-navy whitespace-nowrap";

const variantClasses: Record<Variant, string> = {
  primary: "bg-brand-navy text-white hover:opacity-90 shadow-card",
  secondary:
    "bg-white text-brand-navy border border-brand-card-border hover:bg-white/80",
};

const sizeClasses: Record<Size, string> = {
  md: "px-5 py-2.5 text-sm",
  lg: "px-7 py-3.5 text-base",
};

export function MarketingButton(props: Props) {
  const { variant = "primary", size = "md", className = "", children } = props;
  const cls = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

  if ("to" in props && props.to) {
    return (
      <Link to={props.to} className={cls}>
        {children}
      </Link>
    );
  }
  if ("href" in props && props.href) {
    const isExternal =
      props.external ?? /^https?:\/\//.test(props.href);
    return (
      <a
        href={props.href}
        className={cls}
        {...(isExternal
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {children}
      </a>
    );
  }
  return null;
}
