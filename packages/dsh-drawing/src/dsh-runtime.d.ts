/**
 * Ambients for the DeepSeek Harness runtime modules this plugin uses.
 *
 * DSH ships `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` with type
 * declarations, but the copy this repository develops against is extracted from
 * the installed app's `resources/app.asar`, and that production build carries no
 * `.d.ts` at all — so `tsc` reports `TS7016` for every runtime import. The
 * sibling packages solve it the same way (see `dsh-engineering-context`).
 *
 * This file must stay a **script** (no top-level `import`/`export`) so each
 * `declare module` augments the global module map. Declare only what this plugin
 * touches, and write it as the implementation behaves — the test suite runs
 * against the real runtime, so a declaration that lies would surface there.
 */

declare module '@deepseek-ai/cordis' {
  /** A cordis plugin: an object carrying an `apply`, or a plugin function. */
  export type Plugin = object

  /** The harness logger, callable for a scoped child and usable directly. */
  export interface Logger {
    (name?: string): Logger
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

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
    /** Look up a service by name; optional services must be treated as absent. */
    get(name: string): unknown
    /** Register a disposer (optionally labelled) that runs when the plugin unloads. */
    effect(setup: () => void | (() => void), label?: string): () => void
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

  export type ValueSchemaSpec =
    | StringValueSchemaSpec
    | NumberValueSchemaSpec
    | IntegerValueSchemaSpec
    | BooleanValueSchemaSpec
    | ArrayValueSchemaSpec
    | ObjectValueSchemaSpec
    | JsonValueSchemaSpec

  /** One parameter property, optionally required. */
  export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

  /** The implicit parameter object root of one tool. */
  export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }

  type StringKeyOf<S> = Extract<keyof S, string>

  /** Infers the typed argument object of an implicit parameter schema. */
  export type InferArgs<S> = {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? K : never]: InferValue<S[K]>
  } & {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? never : K]?: InferValue<S[K]>
  }

  /** Infers the value of one schema node. */
  export type InferValue<S> = S extends { type: 'string' }
    ? S extends { enum: readonly (infer E)[] }
      ? E
      : string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
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

  /** Model-facing content produced by a tool's render function. */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /** Execution identity handed to a tool body. */
  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly callId?: string
    readonly agent?: {
      readonly session: {
        readonly header: {
          readonly cwd?: string
        }
      }
    }
  }

  /** A registry-ready tool definition. */
  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly output: {
      readonly schema: Record<string, unknown>
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
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>>
  }

  /** Builds a typed tool definition with inferred arguments and outputs. */
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
  /** A schema node; used both as a value (`Schema.object`) and as a type. */
  export default class Schema<S = unknown, T = S> {
    default(value: T): Schema<S, T>
    description(text: string): Schema<S, T>

    static string(): Schema<string>
    static number(): Schema<number>
    static natural(): Schema<number>
    static boolean(): Schema<boolean>
    static object<X extends Record<string, Schema>>(
      dict: X,
    ): Schema<{ [K in keyof X]: InferSchema<X[K]> }>
  }

  /** Infers the validated output type of a schema node. */
  export type InferSchema<X> = X extends Schema<unknown, infer T> ? T : never
}
