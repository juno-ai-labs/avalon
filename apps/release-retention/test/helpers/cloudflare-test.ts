/** Typed construction for the partial R2 buckets used by retention tests. */
type BivariantR2Method<Arguments extends unknown[], Result> = {
  bivarianceHack(...args: Arguments): Result;
}["bivarianceHack"];

type R2BucketDouble = {
  [Key in keyof R2Bucket]?: R2Bucket[Key] extends (...args: infer Arguments) => infer Result
    ? R2Bucket[Key] | BivariantR2Method<Arguments, Result>
    : R2Bucket[Key];
};

export function createTestR2Bucket<T extends R2BucketDouble>(value: T): R2Bucket {
  return value as unknown as R2Bucket;
}
