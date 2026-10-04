import { redirect } from "react-router";

export function loader() {
  return redirect("/admin/usage-models/settings", 302);
}
