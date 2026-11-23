import { readFileSync } from 'node:fs'
import { checkServerIdentity } from 'node:tls'
import { PostgresDriver } from '@minatojs/driver-postgres'

export type DatabaseStage = 'test' | 'prod'

export function databaseStage(value = process.env.FAMILA_DB_ENV ?? 'test'): DatabaseStage {
  if (value !== 'test' && value !== 'prod') throw new Error('FAMILA_DB_ENV must be test or prod.')
  return value
}

export function postgresConfig(stage: DatabaseStage) {
  const prefix = 'FAMILA_' + databaseStage(stage).toUpperCase() + '_PG_'
  function required(key: string) {
    const value = process.env[key]
    if (!value) throw new Error('Missing ' + key)
    return value
  }
  const host = required(prefix + 'HOST')
  const database = required(prefix + 'DATABASE')
  const user = required(prefix + 'USER')
  const port = Number(required(prefix + 'PORT'))
  if (database !== 'famila_' + stage || user !== database + '_app') throw new Error('Database or role does not match ' + stage)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PostgreSQL port.')
  return { host, port, user, database, password: required(prefix + 'PASSWORD'),
    ssl: { ca: readFileSync(required('FAMILA_PG_CA_FILE'), 'utf8'), rejectUnauthorized: true,
      checkServerIdentity: (_name: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, certificate) },
    connection: { search_path: 'famila' }, connect_timeout: 8 }
}

// Minato 2.7 inspects public even when PostgreSQL creates the tables in search_path.
// Only rewrite its catalog lookups, before the driver batches them with ordinary SQL.
export class FamilaPostgresDriver extends PostgresDriver {
  override get(selection: Parameters<PostgresDriver['get']>[0]) {
    // The PostgreSQL builder extracts JSON leaves as text. HDSI stores a numeric
    // script entry id and uses it in the delivery receipt lookup.
    const id = selection.query['metadata.scriptEntryId']
    if (selection.table === 'interlude_script_entry' && typeof id === 'number') {
      const lookup = Object.create(selection)
      lookup.query = { ...selection.query, 'metadata.scriptEntryId': String(id) }
      return super.get(lookup)
    }
    return super.get(selection)
  }

  override queue<T extends any[] = any[]>(sql: string, values?: any): Promise<T> {
    const lookup = /^(SELECT \* FROM (?:information_schema\.(?:columns|tables|table_constraints) WHERE table_schema|pg_indexes WHERE schemaname) = )'public'/
    return super.queue<T>(sql.replace(lookup, '$1current_schema()'), values)
  }
}
