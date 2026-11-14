import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { coreEntities } from './coreEntities'
export let AppDataSource: DataSource
export async function initDatabase(options: { databasePath: string; dataSource?: DataSource }): Promise<void> {
  if (AppDataSource?.isInitialized) throw new Error('Famila core is already initialized in this process.')
  if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true })
  AppDataSource = options.dataSource ?? new DataSource({ type: 'better-sqlite3', database: options.databasePath, entities: coreEntities, synchronize: false, logging: false })
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  // Initialize new core stores only. Never migrate a host application database implicitly.
  if (!options.dataSource) {
    const tables = await AppDataSource.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    if (tables.length === 0) {
      await AppDataSource.synchronize()
      await AppDataSource.query('CREATE TABLE famila_core_schema (version INTEGER NOT NULL)')
      await AppDataSource.query('INSERT INTO famila_core_schema (version) VALUES (1)')
    } else {
      const marker = tables.some((table: { name: string }) => table.name === 'famila_core_schema')
      const version = marker ? await AppDataSource.query('SELECT version FROM famila_core_schema') : []
      if (version.length !== 1 || version[0].version !== 1) {
        throw new Error('Unsupported core database. Use a new path, or provide a host DataSource with its own migrations.')
      }
    }
  }
  await AppDataSource.query('PRAGMA foreign_keys = ON')
  await AppDataSource.query('PRAGMA busy_timeout = 5000')
}
