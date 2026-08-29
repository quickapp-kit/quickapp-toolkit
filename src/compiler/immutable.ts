export function deepFreeze<T>(value: T): T {
  return freezeValue(value, new WeakSet<object>())
}

function freezeValue<T>(value: T, seen: WeakSet<object>): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value
  const object = value as object
  if (seen.has(object)) return value
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError('Mutable Map and Set values require an immutable compiler-owned representation')
  }
  if (Array.isArray(value)) {
    if (value.every(item => item === null || (typeof item !== 'object' && typeof item !== 'function'))) {
      return Object.freeze(value)
    }
  }
  seen.add(object)
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor !== undefined && 'value' in descriptor) freezeValue(descriptor.value, seen)
  }
  return Object.freeze(value)
}

export class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries)
    Object.freeze(this)
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: K): V | undefined {
    return this.#entries.get(key)
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries()
  }

  keys(): MapIterator<K> {
    return this.#entries.keys()
  }

  values(): MapIterator<V> {
    return this.#entries.values()
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#entries) callbackfn.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableMap'
  }
}
