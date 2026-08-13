import {
  createTestEnv,
} from "./cloudflare-test";

export function assertCloudflareTestBuilderTypes(): void {
  // @ts-expect-error Environment binding names are exact.
  createTestEnv({ DATABSE: {} });
  // @ts-expect-error A D1 binding cannot be replaced by a callable value.
  createTestEnv({ DB: () => 1 });
  // @ts-expect-error Supplied method parameters must overlap the workerd contract.
  createTestEnv({ DB: { prepare: (query: number) => (void query, {}) } });
  // @ts-expect-error Object-returning workerd methods cannot return a primitive.
  createTestEnv({ DB: { prepare: (query: string) => (void query, 1) } });
}
