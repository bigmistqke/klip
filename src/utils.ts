// Utility to strip readonly for SolidJS store compatibility
export type Mutable<T> = T extends object
    ? T extends readonly (infer U)[]
    ? Mutable<U>[]
    : { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;