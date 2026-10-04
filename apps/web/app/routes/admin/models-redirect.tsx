import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  const days = new URL(request.url).searchParams.get("days");
  const query = days === null ? "" : `?${new URLSearchParams({ days })}`;
  return redirect(`/admin/usage-models${query}`, 302);
}
