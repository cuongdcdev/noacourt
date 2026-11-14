// Browser stand-in for Node's `process`, injected by esbuild (see build:page).
// Wallet SDKs (HOT, near-api-js) read process.env / process.nextTick at load time.
export const process = {
  env: {} as Record<string, string | undefined>,
  browser: true,
  versions: {} as Record<string, string>,
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => fn(...args)),
  emit: () => false,
};
