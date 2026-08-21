import { useSyncExternalStore } from "react";
import { getAgentSnapshot, subscribeAgent } from "./store";

export function useAgent() {
  return useSyncExternalStore(subscribeAgent, getAgentSnapshot, getAgentSnapshot);
}
