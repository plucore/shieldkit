import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useCallback, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import { useWebComponentClick } from "../../hooks/useWebComponentClick";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  // <s-button> intercepts native click events; type="submit" alone is not
  // reliable inside a Polaris web component. Trigger form.requestSubmit()
  // explicitly via useWebComponentClick (CLAUDE.md §11).
  const formRef = useRef<HTMLFormElement>(null);
  const submitForm = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);
  const loginRef = useWebComponentClick<HTMLElement>(submitForm);

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post" ref={formRef}>
        <s-section heading="Log in">
          <s-text-field
            name="shop"
            label="Shop domain"
            details="example.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            autocomplete="on"
            error={errors.shop}
          ></s-text-field>
          <s-button ref={loginRef}>Log in</s-button>
        </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
