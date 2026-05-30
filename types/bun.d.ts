declare module "bun" {
  export class Glob {
    constructor(pattern: string)
    scan(options?: { cwd?: string; absolute?: boolean }): AsyncIterable<string>
  }
}
