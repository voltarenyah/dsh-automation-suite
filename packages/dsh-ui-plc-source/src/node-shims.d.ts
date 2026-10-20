/**
 * Ambient declarations for the two Node built-ins the host half uses.
 *
 * This package compiles with `"types": []` on purpose (there is no `@types/node`
 * in the checkout, and the extracted DSH runtime ships no `.d.ts`), so the
 * hand-written surface stays as small as the code that touches it. Extend a
 * declaration here rather than widening it to `any`.
 *
 * @module dsh-ui-plc-source/node-shims
 */

declare module 'node:fs/promises' {
  /** The subset of `Dirent` that `{ withFileTypes: true }` guarantees. */
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
  }

  export function readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>
  export function readFile(path: string, options: { readonly encoding: 'utf8' }): Promise<string>
}

declare module 'node:path' {
  export function join(...segments: string[]): string
}
