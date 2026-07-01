// Core utilities

export function pipe<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return (arg: T) => fns.reduce((acc, fn) => fn(acc), arg);
}

export function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const cache = new Map<string, unknown>();
  return ((...args: unknown[]) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as T;
}

export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T;
  if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags) as unknown as T;
  if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as unknown as T;
  if (obj instanceof Map) {
    const clone = new Map();
    obj.forEach((v, k) => clone.set(deepClone(k), deepClone(v)));
    return clone as unknown as T;
  }
  if (obj instanceof Set) {
    const clone = new Set();
    obj.forEach(v => clone.add(deepClone(v)));
    return clone as unknown as T;
  }
  const clone = {} as Record<string, unknown>;
  for (const key of Object.keys(obj as object)) {
    clone[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return clone as unknown as T;
}
