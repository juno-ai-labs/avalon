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
  return client;
};
