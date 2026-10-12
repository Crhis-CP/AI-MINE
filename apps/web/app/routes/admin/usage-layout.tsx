import { Outlet } from "react-router";

// Models, reconciliation and settings are sibling pages in the admin sidebar, the same way
// 上游基础方案 keeps each of those screens as its own navigation item.
export default function UsageLayout() {
  return <Outlet />;
}
