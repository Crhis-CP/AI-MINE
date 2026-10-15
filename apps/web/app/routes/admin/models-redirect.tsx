import { redirect } from "react-router";
export function loader({ request }: { request: Request }) {
  const days = new URL(request.url).searchParams.get("days");
  return redirect(`/admin/models${days ? `?days=${encodeURIComponent(days)}` : ""}`, 302);
}
