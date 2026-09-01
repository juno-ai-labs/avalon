import { z } from "zod";

/** Memoize a pure value without evaluating its factory during module startup. */
export function memoizedValue<T>(factory: () => T): () => T {
  let initialized = false;
  let value: T;
  return () => {
    if (!initialized) {
      value = factory();
      initialized = true;
    }
    return value;
  };
}

/**
 * Preserve the ordinary Zod schema surface while deferring its real graph until
 * the first parse, unwrap, or JSON Schema conversion that needs it.
 */
export function deferredZodSchema<T extends z.ZodType>(factory: () => T): z.ZodLazy<T> {
  return z.lazy(memoizedValue(factory));
}
