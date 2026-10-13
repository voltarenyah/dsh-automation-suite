/**
 * Ambient declarations for the DeepSeek Harness runtime modules this plugin uses.
 *
 * DSH publishes `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` as ESM with
 * their own `.d.ts`; those are resolved at run time from the profile's runtime
 * resolution (`$DSH_HOME/profiles/node_modules`). Reproducing the small surface
 * used here keeps `npm run build` self-contained: it needs no network access and
 * no copy of the harness inside this repository.
 *
 * The declarations mirror the published shapes:
 *   - `@deepseek-ai/cordis`          Context.effect / Context.tools / Context.inject
 *   - `@deepseek-ai/dsh-tools`       the unified schema DSL and `defineTool`
 *   - `@deepseek-ai/schemastery`     the Config schema builder
 *   - `@deepseek-ai/dsh-skill`       the `skills` service (reached through
 *                                    `ctx.inject(['skills'], …)`, never imported,
 *                                    so the plugin also loads without it)
 *
 * This file must stay a script (no top-level import/export) so that
 * `declare module` augments the global module map instead of a module body.
 */

/** The service names this plugin injects. Only `skills` is optional. */
type DshServiceName = 'skills'

/** Invocation policy of one skill, as the registry resolves it. */
interface DshSkillInvocation {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Directory (or URL / opaque) resource base rendered to the model on load. */
type DshSkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** One discoverable skill summary; `locator` is provider-private. */
interface DshSkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: DshSkillInvocation
  readonly provider: string
  readonly source: string
  readonly rank: number
  readonly resourceBase?: DshSkillResourceBase
  readonly path?: string
  readonly locator: unknown
}

/** One loaded skill, as returned by `provider.get()`. */
interface DshSkillDefinition {
  readonly name: string
  readonly description: string
  readonly invocation: DshSkillInvocation
  readonly provider: string
  readonly source: string
  readonly resourceBase?: DshSkillResourceBase
  readonly path?: string
  readonly content: string
}

/** Lifecycle controls handed to a provider factory. */
interface DshSkillProviderControl {
  readonly signal: AbortSignal
  invalidate(): void
}

/** A same-process skill source. */
interface DshSkillProvider {
  readonly name: string
  list(options?: unknown): Promise<readonly DshSkillCandidate[]>
  get(candidate: DshSkillCandidate, options?: { readonly signal?: AbortSignal }): Promise<DshSkillDefinition | undefined>
}

/** The `skills` service, provided by `@deepseek-ai/dsh-skill`. */
interface DshSkillRegistry {
  /** Registers a provider for the lifetime of the calling context. */
  registerProvider(create: (control: DshSkillProviderControl) => DshSkillProvider): unknown
}

declare module '@deepseek-ai/cordis' {
  /** A disposer returned by an effect; unloading awaits it when it is async. */
  export type Disposable<T = unknown> = () => T

  /** Accepted effect body: one disposer, or an iterable of them. */
  export type SyncEffect = Disposable | Iterable<Disposable>

  /** Named logger handed out by `ctx.logger(name)`. */
  export interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  /** The logging service; call it as a function to get a named logger. */
  export interface LoggerService {
    (name: string): Logger
  }

  export interface Context {
    /** The tool registry, provided by `@deepseek-ai/dsh-tools`. */
    readonly tools: import('@deepseek-ai/dsh-tools').ToolRuntime
    /** The logging service. */
    readonly logger: LoggerService
    /**
     * The skill registry, provided by `@deepseek-ai/dsh-skill`. Read it inside
     * `inject`, never directly: a composition without the registry has no
     * `skills` service, and the plugin must keep working without it.
     */
    readonly skills: DshSkillRegistry
    /**
     * Runs `execute` and registers everything it returns as owned resources.
     * The disposers run in reverse order when the plugin unloads.
     */
    effect(execute: () => SyncEffect, label?: string): Disposable
    /**
     * Starts a child plugin that waits until every named service exists; the
     * callback receives a context that carries them. Injecting `skills` this way
     * keeps the service optional for the rest of `apply`.
     */
    inject(services: readonly DshServiceName[], callback: (ctx: Context) => void): Disposable
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
    enum?: readonly number[]
    const?: number
  }

  export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'integer'
    enum?: readonly number[]
    const?: number
  }

  export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean'
    enum?: readonly boolean[]
    const?: boolean
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

  type Simplify<T> = { [K in keyof T]: T[K] } & {}
  type StringKeyOf<S> = Extract<keyof S, string>
  type RequiredKeys<S> = {
    [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
  }[StringKeyOf<S>]

  type InferProperties<S> = Simplify<
    { [K in RequiredKeys<S>]: InferValue<S[K]> } & {
      [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferValue<S[K]>
    }
  >

  /** Infers the value of one schema node. */
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
                : S extends { oneOf: readonly unknown[] }
                  ? InferValue<S['oneOf'][number]>
                  : JsonValue

  /** Infers the typed argument object of an implicit parameter schema. */
  export type InferArgs<S> = InferProperties<S>

  /** Model-facing content produced by a tool's render function. */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /** Execution identity handed to a tool body. */
  export interface ToolRunContext {
    readonly signal?: AbortSignal
  }

  /** A registry-ready tool definition. */
  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    readonly parameters: ParameterSchemaSpec
    readonly output: {
      readonly schema: ValueSchemaSpec
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
      render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    }
    readonly timeoutMs?: number
    readonly isConcurrencySafe?: (args: InferArgs<S>) => boolean
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  }

  /**
   * Builds a typed tool definition with inferred arguments and outputs.
   */
  export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
    options: DefineToolOptions<S, O>,
  ): ToolDefinition

  /** The tool registry exposed as `ctx.tools`. */
  export interface ToolRuntime {
    /** Registers one definition; returns the disposer that unregisters it. */
    register(definition: ToolDefinition): () => void
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T> {
    required(): Schema<T>
    default(value: T): Schema<T>
    description(text: string): Schema<T>
  }

  export interface SchemaStatic {
    string(): Schema<string>
    number(): Schema<number>
    natural(): Schema<number>
    boolean(): Schema<boolean>
    array<T>(inner: Schema<T>): Schema<T[]>
    object<T extends Record<string, Schema<unknown>>>(
      shape: T,
    ): Schema<{ [K in keyof T]: T[K] extends Schema<infer V> ? V : never }>
  }

  const Schema: SchemaStatic
  export default Schema
}
