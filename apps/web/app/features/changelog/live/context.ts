import { createContext, useContext } from "react";
import { type LiveData, NO_LIVE_DATA } from "./types";

/** The real figures the changelog loader read for its showcases; the page provides them, a showcase reads them. */
export const LiveDataContext = createContext<LiveData>(NO_LIVE_DATA);
export const useLiveData = () => useContext(LiveDataContext);
