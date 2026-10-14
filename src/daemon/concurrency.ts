export async function mapConcurrent<T, R>(
  values: readonly T[],
  width: number,
  body: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, values.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= values.length) return;
        results[i] = await body(values[i]!);
      }
    }),
  );
  return results;
}
