import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

class SqliteD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly statement: StatementSync,
  ) {}

  bind(...bindings: unknown[]) {
    this.bindings = bindings;
    return this;
  }

  async first<T>() {
    return (this.statement.get(...this.bindings) ?? null) as T | null;
  }

  async run() {
    const result = this.statement.run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.bindings) as T[],
    };
  }
}

export class SqliteD1Fixture {
  readonly database = new DatabaseSync(":memory:");
  readonly db: D1Database;

  constructor(migrationPaths: string[]) {
    for (const path of migrationPaths) {
      this.database.exec(readFileSync(path, "utf8"));
    }

    this.db = {
      prepare: (sql: string) =>
        new SqliteD1Statement(this.database.prepare(sql)) as unknown as D1PreparedStatement,
      batch: async (statements: D1PreparedStatement[]) => {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    } as unknown as D1Database;
  }

  close() {
    this.database.close();
  }
}
