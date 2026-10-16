import { defineWebModule } from "@amp/web/modules";
import { IconTrendUp } from "@amp/web/extension";
export default defineWebModule({ name: "metals", navigation: [{ to: "/metals", label: "金属价格", icon: IconTrendUp }] });
