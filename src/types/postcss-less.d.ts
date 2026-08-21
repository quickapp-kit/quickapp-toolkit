declare module 'postcss-less' {
  import type { ParserOptions, Root } from 'postcss'

  interface LessSyntax {
    parse(source: string, options?: ParserOptions): Root
    stringify(node: unknown, builder: unknown): void
    nodeToString(node: unknown): string
  }

  const syntax: LessSyntax
  export default syntax
}
