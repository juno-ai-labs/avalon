import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const createQueryClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (attempt, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && attempt < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  // Socket-owned viewer state has no fetcher and must outlive individual screens.
  // Set these before either an observer or the first directory write creates a query.
  client.setQueryDefaults(["workstream-children"], { gcTime: Number.POSITIVE_INFINITY });
  client.setQueryDefaults(["workstream-background-agents"], { gcTime: Number.POSITIVE_INFINITY });
  return client;
};
