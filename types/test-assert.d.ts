declare module 'node:assert/strict' {
  export function throws(
    block: () => unknown,
    error?: RegExp | ((error: any) => boolean) | object | Error,
    message?: string | Error,
  ): void;

  export function rejects(
    block: Promise<unknown> | (() => Promise<unknown>),
    error?: RegExp | ((error: any) => boolean) | object | Error,
    message?: string | Error,
  ): Promise<void>;
}
