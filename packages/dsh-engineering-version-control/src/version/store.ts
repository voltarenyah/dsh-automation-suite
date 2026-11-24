/**
 * Opening and writing the version store (`.dsh/versions.db`).
 *
 * The store is a **local index**: it can be deleted at any time and rebuilt from
 * git history + `_evidence.json` (see `reindex`). It never holds file contents —
 * a `Version` + `Object` pair points at `git cat-file -p <sha>:<path>`.
 *
 * Every write goes through {@link VersionStore.transaction}, so the three layers
 * (events, graph, projection) move together or not at all.
 *
 * @module dsh-engineering-context/version/store
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { PluginConfig } from '../config.js'
import { VERSION_FTS_STATEMENT, VERSION_SCHEMA_STATEMENTS, VERSION_SCHEMA_VERSION } from './schema.js'

/** A value SQLite can bind. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** Absolute path of the version database of one workspace. */
export function versionStorePath(config: PluginConfig, root: string): string {
  return join(root, config.stateDirName, 'versions.db')
}

/** Absolute path of the directory holding external design documents (P3). */
export function versionDocsDirectory(config: PluginConfig, root: string): string {
  return join(root, config.stateDirName, 'docs')
}

/** One open store, with cached prepared statements. */
export class VersionStore {
  /** The open database handle. */
  readonly db: DatabaseSync
  /** The database file. */
  readonly path: string
  /** True when FTS5 is available (the document index can be searched). */
  readonly fts: boolean

  private readonly statements = new Map<string, StatementSync>()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    for (const sql of VERSION_SCHEMA_STATEMENTS) this.db.exec(sql)

    let fts = false
    try {
      this.db.exec(VERSION_FTS_STATEMENT)
      fts = true
    } catch {
      // FTS5 is optional; the document index falls back to LIKE search.
      fts = false
    }
    this.fts = fts
    this.run(
      `INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(VERSION_SCHEMA_VERSION),
    )
  }

  /** A cached prepared statement. */
  stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  /** Run one statement, discarding its rows. */
  run(sql: string, ...params: SqlValue[]): void {
    this.stmt(sql).run(...params)
  }

  /** First row of one statement, or undefined. */
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  /** Every row of one statement. */
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  /** Run `fn` inside one immediate transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A rollback after a failed commit is best-effort; the original error wins.
      }
      throw error
    }
  }

  /** Close the handle. */
  close(): void {
    this.statements.clear()
    this.db.close()
  }
}

/**
 * Open (and migrate) the store of one workspace.
 *
 * @param config - the resolved plugin configuration.
 * @param root - the workspace root.
 * @returns the open store; the caller must `close()` it.
 */
export function openVersionStore(config: PluginConfig, root: string): VersionStore {
  return new VersionStore(versionStorePath(config, root))
}

/** True when the store file exists. */
export function versionStoreExists(config: PluginConfig, root: string): boolean {
  try {
    const store = new VersionStore(versionStorePath(config, root))
    store.close()
    return true
  } catch {
    return false
  }
}
