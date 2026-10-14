import type { Readable, Writable } from 'node:stream';
export const MAX_FRAME = 2 << 20;
export async function* frames(input: Readable, max = MAX_FRAME): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (!size || size > max) throw new Error('frame bounds');
      if (buffer.length < size + 4) break;
      yield JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
      buffer = buffer.subarray(size + 4);
    }
    if (buffer.length > max + 4) throw new Error('frame bounds');
  }
  if (buffer.length) throw new Error('truncated frame');
}
export function frame(value: unknown, max = MAX_FRAME): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > max) throw new Error('frame bounds');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(data.length);
  return Buffer.concat([h, data]);
}
export async function sendFrame(output: Writable, value: unknown): Promise<void> {
  const data = frame(value);
  await new Promise<void>((resolve, reject) =>
    output.write(data, (error) => (error ? reject(error) : resolve())),
  );
}
