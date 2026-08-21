import type { SourcePoint, SourceSpan } from './types.js'

export class SourceCoordinateMap {
  readonly #text: string
  readonly #byteOffsets: Uint32Array
  readonly #lineStarts: number[] = [0]

  constructor(text: string) {
    this.#text = text
    this.#byteOffsets = new Uint32Array(text.length + 1)
    let byteOffset = 0
    for (let index = 0; index < text.length; ) {
      this.#byteOffsets[index] = byteOffset
      const codePoint = text.codePointAt(index)
      if (codePoint === undefined) break
      const width = codePoint > 0xffff ? 2 : 1
      if (width === 2) this.#byteOffsets[index + 1] = byteOffset
      byteOffset += Buffer.byteLength(String.fromCodePoint(codePoint))
      index += width
      this.#byteOffsets[index] = byteOffset
      if (codePoint === 0x0a) this.#lineStarts.push(index)
    }
  }

  span(startCodeUnit: number, endCodeUnit: number): SourceSpan {
    if (!Number.isInteger(startCodeUnit) || !Number.isInteger(endCodeUnit) || startCodeUnit < 0 || endCodeUnit < startCodeUnit || endCodeUnit > this.#text.length) {
      throw new RangeError('Invalid source span')
    }
    return {
      startByte: this.#byteOffsets[startCodeUnit] ?? 0,
      endByte: this.#byteOffsets[endCodeUnit] ?? 0,
      start: this.#point(startCodeUnit),
      end: this.#point(endCodeUnit),
    }
  }

  #point(codeUnit: number): SourcePoint {
    let low = 0
    let high = this.#lineStarts.length
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if ((this.#lineStarts[middle] ?? 0) <= codeUnit) low = middle
      else high = middle
    }
    const lineStart = this.#lineStarts[low] ?? 0
    const column = [...this.#text.slice(lineStart, codeUnit)].length + 1
    return { line: low + 1, column }
  }
}
