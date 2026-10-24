import { defineWebModule } from "@amp/web/modules";
import { IconTrendUp } from "@amp/web/extension";
import { createElement } from "react";
const entry = { to: "/metals", label: "金属价格", icon: IconTrendUp };
export default defineWebModule({ name: "metals", navigation: [entry], tabs: [entry], tools: [{ ...entry, icon: createElement(IconTrendUp, { size: 18 }) }] });
