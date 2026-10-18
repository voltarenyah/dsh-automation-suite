/**
 * Ambient declarations for the DeepSeek Harness runtime modules this plugin uses.
 *
 * Why this file exists: DSH ships `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`
 * and `@deepseek-ai/schemastery` with `"types"` pointing at `.d.ts` files, but the
 * copy this repository develops against is extracted from the *installed app's*
 * `resources/app.asar`, and that production build carries **no** `.d.ts` files at
 * all, so `tsc` reports `TS7016` for every runtime import. The sibling packages
 * (`dsh-tia-openness-v17-min`, `dsh-engineering-context`, `dsh-tool-git`) solve
 * this the same way, each with its own hand-written declaration.
 *
 * The declarations mirror the runtime the local harness actually ships
 * (`@deepseek-ai/cordis` 4.0.4, harness 0.2.0-rc.2) and were read off the real
 * implementation rather than guessed:
 *
 * - `Context.effect` comes from the fiber mixin (`cordis/src/fiber.ts:415-418`,
 *   `declare module './context.ts'`) and takes an effect body returning a
 *   disposer — the body runs when the effect is registered, and the returned
 *   disposer runs on unload. The TIA Openness plugin uses it exactly that way to own a
 *   subprocess, and this plugin now attaches the engine client's `stop()` to it.
 * - `ctx.logger` is both callable (`ctx.logger(name)`) and a logger
 *   (`ctx.logger.warn(...)`), `cordis/src/context.ts:28` + `logger.ts`.
 * - `ctx.get(name)` is the optional-service lookup
 *   (`cordis/src/reflect.ts:233`), which returns `undefined` for a service the
 *   composition does not have.
 * - `ctx.tools` is the tool registry `@deepseek-ai/dsh-tools` provides; its
 *   `register(definition)` really returns the disposer that unregisters the tool
 *   (`dsh-tools/lib/index.js:2876-2878`).
 * - `defineTool` compiles the author-facing schema immediately, so the registered
 *   definition's `parameters` and `output.schema` are already **raw JSON Schema**
 *   (`dsh-tools/lib/index.js:826-905`): the implicit parameter object gains a
 *   top-level `required` array and every per-property `required: true` is gone.
 *   The `render` and `execute` pair keeps the inferred types instead.
 * - A tool may declare `presentCall` (a `{card, title, kind, rawInput}` render
 *   intent) and `defineTool` wraps it so invalid replay arguments fall back to no
 *   presentation (`dsh-tools/lib/index.js:874-877`). The built-in `run_code` uses
 *   `kind: 'execute'` (`dsh-tools/lib/index.js:1445-1449`); the sibling
 *   `dsh-tool-git` verified `'read' | 'other'` against the same runtime, so all
 *   three are declared.
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
    /** The tool registry, provided by `@deepseek-ai/dsh-tools`. */
    readonly tools: import('@deepseek-ai/dsh-tools').ToolRuntime
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

  /**
   * Base class of a service other plugins consume.
   *
   * Constructing one registers it on the given context under `name`, and the
   * registration is owned by that context's fiber: it is unregistered when the
   * owning plugin unloads. The runtime implements that in this very constructor
   * through `ctx.reflect.provide(name, this, check)`, so a plugin only has to
   * instantiate the subclass inside its `apply`.
   */
  export class Service {
    /** The context the service was registered in. */
    readonly ctx: Context
    /** The name the service is registered under. */
    readonly name: string
    /**
     * @param ctx - the context to register in.
     * @param name - the service name; the caller must pass it, because the static
     *   `provide` fallback is an upstream feature this plugin does not use.
     */
    constructor(ctx: Context, name?: string)
  }

  /** The root context constructor. */
  export const Context: {
    new (): Context
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** Lossless JSON value. */
  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue }

  // ---------------------------------------------------------------- schema DSL
  // The author-facing schema specification: a compact object form that
  // `defineTool` compiles into raw JSON Schema before the registry sees it.

  /** Annotation keywords shared by every schema node. */
  export interface ValueSchemaAnnotations {
    description?: string
    title?: string
    default?: JsonValue
    examples?: JsonValue
  }

  export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string'
    enum?: readonly string[]
    const?: string
  }

  export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number'
  }

  export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'integer'
  }

  export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean'
  }

  export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'null'
  }

  export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array'
    items?: ValueSchemaSpec
  }

  export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object'
    properties?: ParameterSchemaSpec
    additionalProperties: boolean
  }

  export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'json'
  }

  export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
  }

  export type ValueSchemaSpec =
    | StringValueSchemaSpec
    | NumberValueSchemaSpec
    | IntegerValueSchemaSpec
    | BooleanValueSchemaSpec
    | NullValueSchemaSpec
    | ArrayValueSchemaSpec
    | ObjectValueSchemaSpec
    | JsonValueSchemaSpec
    | OneOfValueSchemaSpec

  /** One parameter property, optionally required. */
  export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

  /** The implicit parameter object root of one tool. */
  export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }

  // ------------------------------------------------------------- type inference

  type StringKeyOf<S> = Extract<keyof S, string>

  /**
   * Infers the typed argument object of an implicit parameter schema.
   *
   * Written as a single mapped type with key remapping, like the sibling
   * packages: splitting it into two intersected mapped types is what makes `tsc`
   * exceed its instantiation depth (TS2589) on deeper schemas.
   */
  export type InferArgs<S> = {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? K : never]: InferValue<S[K]>
  } & {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? never : K]?: InferValue<S[K]>
  }

  /**
   * Infers the value of one schema node. `oneOf` deliberately infers as
   * `JsonValue` instead of recursing: under the `ValueSchemaSpec` constraint the
   * recursion does not terminate (the union includes `OneOfValueSchemaSpec` whose
   * members are `ValueSchemaSpec` again). This plugin uses no `oneOf`.
   */
  export type InferValue<S> = S extends { type: 'string' }
    ? S extends { enum: readonly (infer E)[] }
      ? E
      : string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
        : S extends { type: 'null' }
          ? null
          : S extends { type: 'array' }
            ? S extends { items: infer I }
              ? InferValue<I>[]
              : JsonValue[]
            : S extends { type: 'object'; additionalProperties: boolean }
              ? S extends { properties: infer P }
                ? InferProperties<P>
                : Record<string, JsonValue>
              : S extends { type: 'json' }
                ? JsonValue
                : JsonValue

  /** Infers the object value of a nested `properties` block. */
  export type InferProperties<P> = {
    [K in StringKeyOf<P> as P[K] extends { required: true } ? K : never]: InferValue<P[K]>
  } & {
    [K in StringKeyOf<P> as P[K] extends { required: true } ? never : K]?: InferValue<P[K]>
  }

  // ------------------------------------------------------------------- results

  /** Model-facing content produced by a tool's render function. */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /**
   * Execution identity handed to a tool body.
   *
   * `signal` is required: the live pipeline always supplies it, and the tools
   * forward it so a cancelled call terminates the engine instead of waiting for
   * the request timeout.
   */
  export interface ToolRunContext {
    readonly signal: AbortSignal
  }

  /**
   * Raw JSON Schema, as a **registered definition** carries it.
   *
   * `defineTool` compiles the author-facing spec immediately, so
   * `ToolDefinition.parameters` and `ToolDefinition.output.schema` are already raw
   * JSON Schema (the per-property `required: true` becomes the object-level
   * `required` array). A consumer that wants to validate a value uses these.
   */
  export interface RawJsonSchema {
    readonly type?: string
    readonly description?: string
    readonly properties?: { readonly [key: string]: RawJsonSchema }
    readonly required?: readonly string[]
    readonly items?: RawJsonSchema
    readonly additionalProperties?: boolean
    readonly enum?: readonly JsonValue[]
    readonly [key: string]: unknown
  }

  /** One entry of a tool call's presentation: which card renders it, and how. */
  export interface ToolCallPresentation {
    readonly card: 'generic'
    readonly title: string
    readonly kind: 'read' | 'other' | 'execute'
    readonly rawInput: unknown
  }

  /** A registry-ready tool definition. */
  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    /** The compiled raw JSON Schema of the implicit parameter object. */
    readonly parameters: RawJsonSchema
    readonly output: {
      /** The compiled raw JSON Schema of the result. */
      readonly schema: RawJsonSchema
      readonly render: (args: never, value: never) => ContentBlock[]
    }
    readonly timeoutMs?: number
    readonly isConcurrencySafe?: (args: never) => boolean
    readonly execute: (args: never, exec: ToolRunContext) => Promise<unknown>
  }

  /** Options accepted by `defineTool`. */
  export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string
    readonly description: string
    readonly parameters: S
    readonly output: {
      readonly schema: O
      render(args: InferArgs<S>, value: InferValue<O>): ContentBlock[]
    }
    readonly timeoutMs?: number
    readonly isConcurrencySafe?: (args: InferArgs<S>) => boolean
    readonly presentCall?: (args: InferArgs<S>) => ToolCallPresentation
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>>
  }

  /**
   * Builds a typed tool definition with inferred arguments and outputs.
   *
   * `S` is inferred with the `const` modifier so literal parameter enums and
   * `required` flags survive, which is what makes `args` precise inside a tool
   * body. `O` deliberately is not, for the same reason the sibling packages give:
   * under `const` the nested output schema becomes one deeply-readonly literal and
   * running `InferValue` over it exhausts `tsc`.
   */
  export function defineTool<const S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
    options: DefineToolOptions<S, O>,
  ): ToolDefinition

  /** The tool registry exposed as `ctx.tools`. */
  export interface ToolRuntime {
    /** Registers one definition; returns the disposer that unregisters it. */
    register(definition: ToolDefinition): () => void
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
