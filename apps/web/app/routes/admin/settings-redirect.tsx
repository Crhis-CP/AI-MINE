import { redirect } from "react-router";
export function loader() {
  return redirect("/admin/settings", 302);
}
