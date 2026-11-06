// The router's Link, Form and navigate in the interface language (DEC-78): under /en an internal address
// gets the /en prefix, so a reader of the English interface is never dropped onto a Chinese page; external,
// relative and shared addresses (API, feeds, images) pass through unchanged, and Chinese pages are untouched.
// Reader pages import these instead of react-router's own. The language switch is the one link that must
// leave the language, so it keeps react-router's plain Link.
import { useCallback, type Ref } from "react";
import {
  Form as RouterForm,
  Link as RouterLink,
  useNavigate as useRouterNavigate,
  type FormProps,
  type LinkProps,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from "react-router";
import { useLocalize } from "./index.ts";

/** react-router's Link, its address kept in the page's language. */
export function Link({ to, ...rest }: LinkProps & { ref?: Ref<HTMLAnchorElement> }) {
  const localize = useLocalize();
  return <RouterLink {...rest} to={localize(to)} />;
}

/** react-router's Form, its action kept in the page's language (no action: the page itself). */
export function Form({ action, ...rest }: FormProps & { ref?: Ref<HTMLFormElement> }) {
  const localize = useLocalize();
  return <RouterForm {...rest} action={action === undefined ? undefined : localize(action)} />;
}

/** react-router's navigate, an address kept in the page's language (a history step is passed on as it is). */
export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate();
  const localize = useLocalize();
  return useCallback(
    ((to: To | number, options?: NavigateOptions) => (typeof to === "number" ? navigate(to) : navigate(localize(to), options))) as NavigateFunction,
    [navigate, localize],
  );
}
