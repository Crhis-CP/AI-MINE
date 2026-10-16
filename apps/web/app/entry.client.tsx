// Keep the hydration bootstrap outside shared dependency chunks loaded by page extensions.
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { createRenderErrorHandler } from "./lib/render-recovery";

const documentRelease = document.querySelector('meta[name="amp-release"]')?.getAttribute("content") ?? null;
const onCaughtError = createRenderErrorHandler(documentRelease);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    { onCaughtError },
  );
});
