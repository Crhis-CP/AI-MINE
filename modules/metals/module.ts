import { defineModule } from "@amp/contracts/modules";
export default defineModule({
  name: "metals",
  pages: [{ path: "metals", file: "web/prices.tsx", id: "routes/metals" }],
  apiPaths: [/^\/api\/site\/metal-prices$/],
});
