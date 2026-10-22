/**
 * Ambient declarations for the DeepSeek Harness runtime modules this plugin uses.
 *
 * Why this file exists: DSH ships `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`
 * and friends with `"types": "./lib/types/index.d.ts"`, but the copy this
 * repository develops against is extracted from the *installed app's*
 * `resources/app.asar`, and that production build carries **no** `.d.ts` files at
 * all. `tsc` therefore reports `TS7016` for every runtime import. The sibling
 * package `dsh-tia-openness-v17-min` solves this the same way, with a
 * hand-written ambient file; see this package's `AGENTS.md`.
 *
 * The declarations mirror the runtime the local harness actually ships
 * (0.2.0-rc.2 when they were written; re-verified unchanged against 0.2.1-rc.2 on
 * 2026-10-19). They were written against the real implementation rather than
 * guessed: the shapes of `ToolExecutionResult`, the `tools/pre-execute` gate's
 * `exec`, and the return of `next()` were read off the live runtime, and
 * `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` ship their original
 * TypeScript sources, from which their signatures here are taken. The plugin's
 * own test suite executes against that runtime, so a declaration that lied about
 * a member would surface there.
 *
 * This file must stay a **script** (no top-level `import`/`export`), so that each
 * `declare module` augments the global module map instead of defining a module
 * body.
 */

declare module '@deepseek-ai/cordis' {
  /** A disposer. Unloading awaits it when it is async. */
  export type Disposable<T = unknown> = () => T

  /** A cordis plugin: an object carrying an `apply`, or a plugin function. */
  export type Plugin = object

  /**
   * The event map.
   *
   * The live runtime augments this with a long list of names; only the one this
   * plugin subscribes to is declared here. Add the names you actually use, and
   * nothing else — an empty catch-all entry would erase the listener parameter
   * typing that `ctx.on` derives from this map.
   */
  export interface Events {
    'tools/pre-execute': import('@deepseek-ai/dsh-tools').PreExecuteListener
  }

  /**
   * Public shape of a cordis context. The runtime proxies its `Context` class, so
   * the members a plugin may read are described by this interface; the class
   * declaration below supplies the constructor.
   */
  export interface Context {
    /** The tool registry, provided by `@deepseek-ai/dsh-tools`. */
    readonly tools: import('@deepseek-ai/dsh-tools').ToolRuntime
    /**
     * Subscribe to an event.
     * @returns the disposer that unsubscribes the listener.
     */
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean): () => boolean
    /**
     * Load a plugin, and everything it depends on, into this context.
     */
    plugin(plugin: Plugin, config?: unknown): Promise<Context>
    /**
     * Register a service implementation owned by the current fiber. The
     * service is visible to dependents and is removed when the fiber unloads.
     * @returns the disposer that unregisters the service.
     */
    provide(name: 'gitContext', value: import('./service.ts').GitContextService): () => void
    provide(name: string, value?: unknown): () => void
    /**
     * Read a service without declaring an inject dependency.
     * @param strict - when `true` (default), only an active provider's value is
     * returned; a service whose provider is still loading reads as `undefined`.
     * @returns the service value, or `undefined` when not provided.
     */
    get(name: 'gitContext'): import('./service.ts').GitContextService | undefined
    get(name: string, strict?: boolean): unknown
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
  // The author-facing parameter/output schema specification: a compact object
  // form (`{ type: 'string', description, required }`) that `defineTool`
  // compiles into raw JSON Schema before the registry ever sees it.

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

  // ------------------------------------------------------------- type inference

  type StringKeyOf<S> = Extract<keyof S, string>
  type RequiredKeys<S> = {
    [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
  }[StringKeyOf<S>]

  // Deliberately a single mapped type with key remapping rather than the usual
  // `Simplify<Required… & Optional…>` shape. Both alternatives were measurably
  // worse here: flattening with `& {}` and splitting into two mapped types
  // intersected together each made `tsc` exceed its instantiation depth (TS2589)
  // on this plugin's output schemas, e.g. `git_branch`.
  type InferProperties<S> = {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? K : never]: InferValue<S[K]>
  } & {
    [K in StringKeyOf<S> as S[K] extends { required: true } ? never : K]?: InferValue<S[K]>
  }

  /**
   * Infers the value of one schema node.
   *
   * `oneOf` deliberately infers as `JsonValue` instead of recursing into its
   * members. Recursing is not merely expensive here, it does not terminate:
   * `InferValue` is instantiated with the *constraint* `ValueSchemaSpec` before
   * the caller's output schema has been resolved, that union includes
   * `OneOfValueSchemaSpec`, and its `oneOf` members are `ValueSchemaSpec` again —
   * so `InferValue<ValueSchemaSpec>` expands into itself and `tsc` reports TS2589
   * on every tool with a nested output schema.
   *
   * The cost is bounded and known: `oneOf` appears only in *output* schemas in
   * this plugin (`git_status.branch`, `git_fetch.remote`), never in a tool's
   * parameters, and every tool body here annotates its output type explicitly —
   * so nothing loses a useful inference. `InferArgs` is unaffected. Restore the
   * recursion only together with a guard that keeps it out of the constraint.
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

  /** Infers the typed argument object of an implicit parameter schema. */
  export type InferArgs<S> = InferProperties<S>

  // ------------------------------------------------------------------- results

  /** Model-facing content produced by a tool's render function. */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /**
   * The part of the calling agent a tool body may read.
   *
   * Only the session cwd is used: tools resolve their repository root from
   * `agent.session.header.cwd` rather than from `process.cwd()` or a
   * model-supplied path. The live session object carries far more; this
   * declares the one field the tools depend on.
   */
  export interface ToolAgent {
    readonly session: {
      readonly header: {
        /** The session's working directory, fixed when the session was created. */
        readonly cwd?: string
      }
    }
  }

  /**
   * Execution identity handed to a tool body.
   *
   * `signal` is required, not optional: the live pipeline always supplies it, and
   * tools forward it straight into APIs that demand one. `agent` is absent for
   * calls that do not originate from an agent session (e.g. a direct registry
   * call), which the tools treat as an error rather than a cwd fallback.
   */
  export interface ToolRunContext {
    readonly signal: AbortSignal
    /** The calling agent, when the call came from an agent session. */
    readonly agent?: ToolAgent
  }

  /**
   * One in-flight tool call, as seen by a `tools/pre-execute` listener.
   *
   * The live object carries more members (`token`, `rootCallId`, `signal`,
   * `deferContext`, `concludeTurn`); only the two a gate inspects are declared.
   */
  export interface ToolExecution {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
  }

  /**
   * What a `tools/pre-execute` listener decides.
   *
   * `{ kind: 'allow' }` is what `next()` resolves to when no listener objects.
   * The live union also carries `'cancel'` and the pipeline's own disposition
   * kinds, which a gate never returns.
   */
  export type PreToolDecision =
    | { kind: 'allow' }
    | { kind: 'ask'; reason: string }
    | { kind: 'deny'; reason: string }

  /**
   * A `tools/pre-execute` listener: inspect one call, then either decide or defer
   * to the rest of the chain through `next()`.
   */
  export type PreExecuteListener = (
    exec: ToolExecution,
    next: () => PreToolDecision | Promise<PreToolDecision>,
  ) => PreToolDecision | Promise<PreToolDecision>

  /** One entry of a tool call's presentation: which card renders it, and how. */
  export interface ToolCallPresentation {
    readonly card: 'generic'
    readonly title: string
    readonly kind: 'read' | 'other'
    readonly rawInput: unknown
  }

  // ---------------------------------------------------------------- definitions

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
   * `S` is inferred with the `const` modifier so that literal parameter enums and
   * `required` flags survive, which is what makes `args` precise inside a tool
   * body. `O` deliberately is **not**: under `const` the whole nested output
   * schema is inferred as one huge deeply-readonly literal — every `description`
   * becoming a string literal type — and running `InferValue` over that makes
   * `tsc` give up with TS2589 on the deeper schemas (e.g. `git_branch`). Plain
   * inference still keeps the discriminants (`type: 'string'`, `required: true`)
   * literal, because the `ValueSchemaSpec` constraint supplies them, so output
   * values stay precise without the blow-up.
   */
  export function defineTool<const S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
    options: DefineToolOptions<S, O>,
  ): ToolDefinition

  /** The request accepted by {@link ToolRuntime.execute}. */
  export interface ToolExecuteRequest {
    readonly signal: AbortSignal
    readonly callId: string
    readonly name: string
    readonly arguments: Record<string, unknown>
    /**
     * The calling agent scope. The test fixture supplies a minimal stand-in
     * carrying `session.header.cwd`; the live pipeline supplies the real
     * agent, which also selects the tool-visibility layer.
     */
    readonly agent?: ToolAgent
  }

  /**
   * The materialized outcome of one tool call.
   *
   * Success carries `value`; failure carries `error`. `content` is the rendered
   * model-facing form and is present in both cases. Both `value` and `error` are
   * optional here rather than split into a discriminated union because the
   * pipeline only guarantees `isError` and `content`.
   */
  export interface ToolExecutionResult {
    readonly isError: boolean
    readonly content: ContentBlock[]
    readonly value?: unknown
    readonly error?: { readonly message: string }
  }

  /** The tool registry exposed as `ctx.tools`. */
  export interface ToolRuntime {
    /** Registers one definition; returns the disposer that unregisters it. */
    register(definition: ToolDefinition): () => void
    /** Runs one tool call through the full pipeline. */
    execute(request: ToolExecuteRequest): Promise<ToolExecutionResult>
  }

  /** The tool runtime plugin, loaded by the test fixture onto a bare context. */
  const ToolRuntime: import('@deepseek-ai/cordis').Plugin
  export default ToolRuntime
}

declare module '@deepseek-ai/dsh-system-prompt' {
  /**
   * The system-prompt service plugin.
   *
   * Only ever handed to `ctx.plugin()` by the test fixture, never introspected,
   * so it is declared as an opaque plugin handle rather than modelled.
   */
  const SystemPrompt: import('@deepseek-ai/cordis').Plugin
  export default SystemPrompt
}

declare module '@deepseek-ai/schemastery' {
  /**
   * A schema node.
   *
   * Declared as a **class** on purpose: the plugin's `src/index.ts` writes both
   * `z.object({…})` (a value) and `Config: z<Config>` (a type), so the default
   * export has to carry both meanings. `export default <a const>` does not — the
   * type side is dropped and `tsc` reports TS2749 — whereas a class declaration
   * has both by construction. Instance signatures mirror the shipped
   * `src/index.ts`, reduced to the builder methods this plugin's config uses.
   */
  export default class Schema<S = unknown, T = S> {
    required(): Schema<S, T>
    default(value: T | Partial<S>): Schema<S, T>
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
    static union<const X extends readonly Schema[]>(list: X): Schema<InferSchema<X[number]>>
  }

  /** Infers the validated output type of a schema node. */
  export type InferSchema<X> = X extends Schema<unknown, infer T> ? T : never
}
