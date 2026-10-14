/**
 * Where the engineering-graph engine lives.
 *
 * The engine is the vendored C# half of this plugin (`engine/`, renamed and
 * flattened to `EngineeringGraph.Engine` by docs/decisions.md D17). This module
 * is the single place that knows its packaged location, so both `apply` and the
 * tests resolve it the same way — exactly how family 1 resolves its controller
 * (`dsh-tia-openness-v17-min/src/controller.ts`).
 *
 * @module dsh-engineering-graph/engine-path
 */

import { isAbsolute, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of this module: `<package>/lib` once built, `<package>/src` in source. */
const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** Package root, used to locate the bundled engine. */
export const packageRoot = dirname(moduleDirectory)

/** The executable name the C# project produces (docs/decisions.md D17). */
export const ENGINE_EXECUTABLE_NAME = 'EngineeringGraph.Engine.exe'

/** The packaged engine, relative to the package root, with forward slashes. */
export const ENGINE_RELATIVE_PATH = `engine/bin/${ENGINE_EXECUTABLE_NAME}`

/** The engine executable shipped inside this package. */
export function bundledEnginePath(): string {
  return join(packageRoot, 'engine', 'bin', ENGINE_EXECUTABLE_NAME)
}

/**
 * Where a resolved path came from: the profile config, or the package itself.
 *
 * Both are reported to the user in the missing-engine warning, so the message
 * can say *why* the path is what it is.
 */
export type EnginePathSource = 'config' | 'package'

/**
 * Resolves the engine to run: an explicit configuration wins, otherwise the
 * executable shipped with this package.
 *
 * There is deliberately no environment override (family 1 has one for its
 * controller): a profile can already point `enginePath` anywhere, and a second,
 * invisible source of truth would only make the reported `source` less useful.
 *
 * @param configured - the configured `enginePath`; empty means "packaged".
 * @returns the resolved path and where it came from.
 */
export function resolveEnginePath(configured: string): { path: string; source: EnginePathSource } {
  if (configured.trim().length > 0) {
    return { path: isAbsolute(configured) ? configured : resolve(configured), source: 'config' }
  }
  return { path: bundledEnginePath(), source: 'package' }
}
