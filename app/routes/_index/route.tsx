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
          The ultimate Google Merchant Center compliance scanner.
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
        <ul className={styles.list}>
          <li>
            <strong>10-Point GMC Audit</strong>: Instantly scan your store for
            the exact reasons Google suspends accounts.
          </li>
          <li>
            <strong>Actionable Fixes</strong>: Get plain-English resolution
            guides for every failed check.
          </li>
          <li>
            <strong>Free Policy Guide</strong>: Receive our GMC Survival Guide
            with copy-paste policy templates.
          </li>
        </ul>
      </div>
    </div>
  );
}
