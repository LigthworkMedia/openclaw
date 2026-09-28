import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionEntry } from "./types.js";

export const SESSION_ENTRY_SNAPSHOT_FIELDS = [
  "sessionDiffBaseline",
  "skillsSnapshot",
  "systemPromptReport",
] as const;

export type SessionEntrySnapshot = {
  field: (typeof SESSION_ENTRY_SNAPSHOT_FIELDS)[number];
  valueJson: string;
};

export type SessionEntrySnapshotRow = {
  session_diff_baseline_json?: string | null;
  skills_snapshot_json?: string | null;
  system_prompt_report_json?: string | null;
};

const snapshotColumns = [
  ["sessionDiffBaseline", "session_diff_baseline_json"],
  ["skillsSnapshot", "skills_snapshot_json"],
  ["systemPromptReport", "system_prompt_report_json"],
] as const;

/** One statement owns hot and cold facts; JSON remains opaque to SQLite's depth limit. */
export function sessionEntrySnapshotColumnsForKeys(keys?: readonly string[]) {
  const selectedKeys = keys === undefined ? undefined : sqliteStringSet(keys);
  return snapshotColumns.map(([field, alias]) => {
    /* kysely-allow-raw: select the exact cold field within the entry statement snapshot. */
    const snapshot = sql<string | null>`(
      SELECT value_json FROM session_entry_snapshots
      WHERE session_key = session_nodes.session_key AND field = ${field}
    )`;
    return (
      selectedKeys === undefined
        ? snapshot
        : /* kysely-allow-raw: hydrate only explicitly selected full entries in the same statement. */
          sql<
            string | null
          >`CASE WHEN session_nodes.session_key IN ${selectedKeys} THEN ${snapshot} END`
    ).as(alias);
  });
}

export const sessionEntrySnapshotColumns = sessionEntrySnapshotColumnsForKeys();

export function splitSessionEntrySnapshots(entry: SessionEntry | Record<string, unknown>): {
  entryJson: string;
  snapshots: SessionEntrySnapshot[];
} {
  const { sessionDiffBaseline, skillsSnapshot, systemPromptReport, ...hot } = entry;
  const values = { sessionDiffBaseline, skillsSnapshot, systemPromptReport };
  const snapshots: SessionEntrySnapshot[] = [];
  for (const field of SESSION_ENTRY_SNAPSHOT_FIELDS) {
    const valueJson = JSON.stringify(values[field]);
    if (valueJson !== undefined) {
      snapshots.push({ field, valueJson });
    }
  }
  return { entryJson: JSON.stringify(hot), snapshots };
}

export function attachSessionEntrySnapshots<T extends object>(
  entry: T,
  row: SessionEntrySnapshotRow,
): T {
  for (const [field, alias] of snapshotColumns) {
    const valueJson = row[alias];
    if (valueJson != null) {
      const value: unknown = JSON.parse(valueJson);
      Object.assign(entry, { [field]: value });
    }
  }
  return entry;
}

/** The entry writer owns this synchronous transaction and publishes its committed facts. */
export function writeSessionEntrySnapshots(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  snapshots: readonly SessionEntrySnapshot[],
): void {
  if (!database.db.isTransaction) {
    throw new Error("Session snapshot writes require an entry transaction");
  }
  const db = getNodeSqliteKysely<DB>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_entry_snapshots")
      .where("session_key", "=", sessionKey)
      .$if(snapshots.length > 0, (query) =>
        query.where(
          "field",
          "not in",
          snapshots.map((snapshot) => snapshot.field),
        ),
      ),
  );
  for (const snapshot of snapshots) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_entry_snapshots")
        .values({ session_key: sessionKey, field: snapshot.field, value_json: snapshot.valueJson })
        .onConflict((conflict) =>
          conflict
            .columns(["session_key", "field"])
            .doUpdateSet({ value_json: snapshot.valueJson })
            .where("value_json", "!=", snapshot.valueJson),
        ),
    );
  }
}
