/** Typed construction for the partial R2 buckets used by retention tests. */
type R2BucketDouble = {
  [Key in keyof R2Bucket]?: R2Bucket[Key] extends (...args: any[]) => any
    ? (...args: any[]) => unknown
    : R2Bucket[Key];
};

export function createTestR2Bucket<T extends R2BucketDouble>(value: T): R2Bucket {
  return value as unknown as R2Bucket;
}
