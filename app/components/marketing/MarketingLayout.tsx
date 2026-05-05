import { Link } from "react-router";
import type { ReactNode } from "react";
import { SITE } from "../../lib/brand";

interface MarketingLayoutProps {
  children: ReactNode;
  /** Optional aria label for the main content region */
  mainLabel?: string;
}

/**
 * Wraps all public marketing pages with shared chrome:
 *  - light blue gradient background
 *  - Inter font
 *  - sticky top nav
 *  - footer
 *
 * The `.shieldkit-marketing` class scopes Tailwind + brand resets so the
 * embedded admin app under /app/* is untouched.
 */
export function MarketingLayout({ children, mainLabel }: MarketingLayoutProps) {
  return (
    <div className="shieldkit-marketing">
      <MarketingNav />
      <main aria-label={mainLabel ?? "Main content"}>{children}</main>
      <MarketingFooter />
    </div>
  );
}

function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-brand-card-border/60 backdrop-blur bg-[rgba(220,234,245,0.75)]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-extrabold text-brand-navy text-lg">
          <ShieldMark />
          <span>ShieldKit</span>
        </Link>
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-brand-navy">
          <Link to="/" className="hover:opacity-70">Home</Link>
          <Link to="/scan" className="hover:opacity-70">Scan</Link>
          <Link to="/blog" className="hover:opacity-70">Blog</Link>
          <Link to="/explainer" className="hover:opacity-70">Explainer</Link>
          <a
            href={SITE.installUrl}
            className="rounded-full bg-brand-navy !text-white px-5 py-2 hover:opacity-90 transition"
          >
            Install
          </a>
        </nav>
        {/* Mobile: just the install CTA */}
        <a
          href={SITE.installUrl}
          className="md:hidden rounded-full bg-brand-navy !text-white px-4 py-2 text-sm"
        >
          Install
        </a>
      </div>
    </header>
  );
}

function MarketingFooter() {
  return (
    <footer className="mt-24 border-t border-brand-card-border/60 bg-white/40">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-sm text-brand-navy">
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 font-extrabold text-base">
            <ShieldMark />
            <span>ShieldKit</span>
          </div>
          <p className="mt-3 text-brand-gray-text">
            GMC compliance + AI search visibility for Shopify.
          </p>
        </div>
        <FooterCol title="Product">
          <Link to="/" className="hover:underline">Home</Link>
          <Link to="/scan" className="hover:underline">Free scan</Link>
          <a href="#pricing" className="hover:underline">Pricing</a>
        </FooterCol>
        <FooterCol title="Resources">
          <Link to="/blog" className="hover:underline">Blog</Link>
          <Link to="/explainer" className="hover:underline">GMC explainer</Link>
        </FooterCol>
        <FooterCol title="Legal">
          <a href="#" className="hover:underline">Privacy policy</a>
          <a href="#" className="hover:underline">Terms of service</a>
        </FooterCol>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 pb-8 text-xs text-brand-gray-text">
        © {new Date().getFullYear()} ShieldKit. All rights reserved.
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-brand-gray-text mb-3 font-semibold">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function ShieldMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"
        fill="#0f1f3d"
      />
      <path
        d="M9 12l2 2 4-4"
        stroke="#dceaf5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
