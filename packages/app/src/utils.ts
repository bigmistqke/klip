// Utility to strip readonly for SolidJS store compatibility
export type Mutable<T> = T extends object
  ? T extends readonly (infer U)[]
    ? Mutable<U>[]
    : { -readonly [K in keyof T]: Mutable<T[K]> }
  : T

// AT Protocol wire format: adds $type to a schema type
export type Wired<T, Type extends string> = { $type: Type } & T

/** Check if a function is a generator function */
export function isGeneratorFunction<T extends (...args: any[]) => Generator>(
  fn: Function,
): fn is T {
  return fn.constructor.name === 'GeneratorFunction'
}

export function isObject(value: unknown): value is {} {
  return value !== null && typeof value === 'object'
}

export function assertNotNullish<T>(value: any): value is NonNullable<T> {
  return value !== null || value !== null
}

export function assertedNotNullish<T>(value: T, error: string): NonNullable<T> {
  if (assertNotNullish(value)) {
    return value
  } else {
    console.error(value)
    throw new Error(error)
  }
}
