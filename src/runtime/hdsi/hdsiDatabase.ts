import { postgresConfig, type DatabaseStage } from './postgres'

type Result = { rows: any[]; changes: number }
export type Query = (sql: string, ...values: any[]) => Promise<Result>

/** All work on a connection, including a whole transaction, runs in submission order. */
export class HdsiDatabase {
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly query: Query, private readonly disconnect: () => Promise<void>) {}

  static sqlite(file: string) {
    const db = new (require('better-sqlite3'))(file)
    db.pragma('journal_mode = WAL')
    return new HdsiDatabase(async (sql, ...values) => {
      const statement = db.prepare(sql)
      return statement.reader ? { rows: statement.all(...values), changes: 0 } : { rows: [], changes: statement.run(...values).changes }
    }, async () => db.close())
  }

  static async postgres(stage: DatabaseStage, onError: (e: Error) => void) {
    const { connection, connect_timeout, ...config } = postgresConfig(stage)
    const client = new (require('pg').Client)({ ...config, options: '-c search_path=' + connection.search_path, connectionTimeoutMillis: connect_timeout * 1000 })
    client.on('error', onError)
    await client.connect()
    return new HdsiDatabase(async (sql, ...values) => {
      let n = 0
      const result = await client.query(sql.replace(/\?/g, () => '$' + ++n), values)
      return { rows: result.rows, changes: result.rowCount }
    }, () => client.end())
  }

  private serial<T>(action: () => Promise<T>) {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }
  run(sql: string, ...values: any[]) { return this.serial(() => this.query(sql, ...values)) }
  async all(sql: string, ...values: any[]) { return (await this.run(sql, ...values)).rows }
  transaction<T>(action: (query: Query) => Promise<T>) {
    return this.serial(async () => {
      await this.query('BEGIN')
      try {
        const result = await action(this.query)
        await this.query('COMMIT')
        return result
      } catch (error) { await this.query('ROLLBACK'); throw error }
    })
  }
  close() { return this.serial(this.disconnect) }
}
