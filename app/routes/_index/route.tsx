import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>ShieldKit</h1>
        <p className={styles.text}>
          The ultimate Google Merchant Center compliance scanner for Shopify stores.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}

        {/* ── Pricing ── */}
        <div className={styles.pricing}>
          <div className={styles.pricingCard}>
            <h2 className={styles.pricingTitle}>Free</h2>
            <div className={styles.pricingPrice}>$0</div>
            <ul className={styles.pricingFeatures}>
              <li>1 compliance scan per month</li>
              <li>Fix instructions for top 3 findings</li>
              <li>JSON-LD theme extension</li>
            </ul>
          </div>
          <div className={styles.pricingCard}>
            <h2 className={styles.pricingTitle}>Shield Pro</h2>
            <div className={styles.pricingPrice}>
              $14<span className={styles.pricingInterval}> /month</span>
            </div>
            <ul className={styles.pricingFeatures}>
              <li>Everything in Free, plus:</li>
              <li>Unlimited compliance scans</li>
              <li>Continuous weekly monitoring</li>
              <li>Weekly health digest email</li>
              <li>AI-powered policy generator</li>
              <li>GMC re-review appeal letter</li>
            </ul>
          </div>
          <div className={`${styles.pricingCard} ${styles.pricingCardPro}`}>
            <h2 className={styles.pricingTitle}>Shield Max</h2>
            <div className={styles.pricingPrice}>
              $39<span className={styles.pricingInterval}> /month</span>
            </div>
            <ul className={styles.pricingFeatures}>
              <li>Everything in Shield Pro, plus:</li>
              <li>Merchant Listings JSON-LD enricher</li>
              <li>GTIN / MPN / brand auto-filler</li>
              <li>Organization &amp; WebSite schema</li>
              <li>llms.txt at root domain</li>
              <li>AI bot allow/block toggle</li>
            </ul>
          </div>
        </div>

        <ul className={styles.list}>
          <li>
            <strong>12-Point GMC Audit</strong>: Instantly scan your store for
            the exact reasons Google suspends accounts.
          </li>
          <li>
            <strong>Actionable Fixes</strong>: Get plain-English resolution
            guides for every failed check.
          </li>
          <li>
            <strong>Stay Compliant</strong>: Protect your Google Merchant Center
            account from suspension.
          </li>
        </ul>

        <footer
          style={{
            marginTop: "48px",
            paddingTop: "24px",
            borderTop: "1px solid #e1e3e5",
            fontSize: "13px",
            color: "#6d7175",
            display: "flex",
            gap: "16px",
            justifyContent: "center",
          }}
        >
          <a href="/privacy" style={{ color: "#6d7175", textDecoration: "underline" }}>
            Privacy
          </a>
          <a href="/terms" style={{ color: "#6d7175", textDecoration: "underline" }}>
            Terms
          </a>
          <span>© ShieldKit</span>
        </footer>
      </div>
    </div>
  );
}
