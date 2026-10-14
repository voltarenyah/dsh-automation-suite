/**
 * Ambient declarations for the DeepSeek Harness runtime modules this plugin uses.
 *
 * Why this file exists: DSH ships `@deepseek-ai/cordis` and
 * `@deepseek-ai/schemastery` with `"types"` pointing at `.d.ts` files, but the
 * copy this repository develops against is extracted from the *installed app's*
 * `resources/app.asar`, and that production build carries **no** `.d.ts` files at
 * all, so `tsc` reports `TS7016` for every runtime import. The sibling packages
 * solve this the same way, each with its own hand-written declaration; see
 * `packages/dsh-tool-git/AGENTS.md` §3 for the maintenance rules.
 *
 * The declarations mirror the runtime the local harness actually ships
 * (`@deepseek-ai/cordis` 4.0.4) and were read off the real implementation rather
 * than guessed:
 *
 * - `Context.effect` comes from the fiber mixin (`cordis/src/fiber.ts:415-418`,
 *   `declare module './context.ts'`) and takes an effect body returning a
 *   disposer — the body runs when the effect is registered, and the returned
 *   disposer runs on unload. Family 1 uses it exactly that way to own a
 *   subprocess; this plugin registers the same seam without a subprocess yet.
 * - `ctx.logger` is both callable (`ctx.logger(name)`) and a logger
 *   (`ctx.logger.warn(...)`), `cordis/src/context.ts:28` + `logger.ts`.
 * - `ctx.get(name)` is the optional-service lookup
 *   (`cordis/src/reflect.ts:233`), which returns `undefined` for a service the
 *   composition does not have.
 * - `Schema` instance/static signatures mirror `schemastery/src/index.ts:42-100`
 *   and were checked against the shipped build: `Schema.object({...})({})`
 *   really applies the per-field defaults, and `natural()` really rejects a
 *   negative value.
 *
 * This file must stay a **script** (no top-level `import`/`export`), so that each
 * `declare module` augments the global module map instead of defining a module
 * body. Declare only what this plugin actually uses, and write it as the
 * implementation behaves — the test suite runs against that real runtime, so a
 * declaration that lied about a member would surface there.
 */

declare module '@deepseek-ai/cordis' {
  /** The harness logger, callable for a scoped child and usable directly. */
  export interface Logger {
    /** Returns the logger scoped to `name` (or to this logger when omitted). */
    (name?: string): Logger
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

  /** Function returned by an effect to release resources during disposal. */
  export type Disposable<T = unknown> = () => T

  /**
   * Effect body result accepted by `ctx.effect()`: a disposer, a promise of one,
   * or a (possibly async) iterable yielding several. This plugin returns a single
   * async disposer, which is the `Promise<Disposable>` arm.
   */
  export type Effect<T = unknown> =
    | Disposable<T>
    | Promise<Disposable<T>>
    | Iterable<Disposable<T>>
    | AsyncIterable<Disposable<T>>

  /**
   * Public shape of a cordis context, reduced to the members this plugin reads.
   * The runtime proxies its `Context` class, so this interface describes what a
   * plugin may touch.
   */
  export interface Context {
    /** The harness logger; `ctx.logger(name)` scopes it to this plugin. */
    readonly logger: Logger
    /**
     * Look up a service by name. Optional dependencies are discovered this way
     * and must be treated as absent when this returns `undefined`.
     */
    get(name: string): unknown
    /**
     * Registers a cleanup-aware effect on this plugin's fiber and returns the
     * disposer that tears it down. The returned value is awaitable.
     */
    effect(execute: () => Effect, label?: string): Disposable<Promise<void>>
  }

  /** The root context constructor. */
  export const Context: {
    new (): Context
  }
}

declare module '@deepseek-ai/schemastery' {
  /**
   * A schema node.
   *
   * Declared as a **class** on purpose: this plugin's `config.ts` writes both
   * `Schema.object({…})` (a value) and profile-facing type annotations (a type),
   * so the default export must carry both meanings. Instance signatures mirror
   * the shipped `src/index.ts`, reduced to the builder methods this plugin's
   * config uses.
   */
  export default class Schema<S = unknown, T = S> {
    default(value: T): Schema<S, T>
    description(text: string): Schema<S, T>

    static const<const V>(value: V): Schema<V>
    static string(): Schema<string>
    static number(): Schema<number>
    static natural(): Schema<number>
    static boolean(): Schema<boolean>
    static array<X>(inner: Schema<X>): Schema<X[]>
    static object<X extends Record<string, Schema>>(
      dict: X,
    ): Schema<{ [K in keyof X]: InferSchema<X[K]> }>
  }

  /** Infers the validated output type of a schema node. */
  export type InferSchema<X> = X extends Schema<unknown, infer T> ? T : never
}
