import type { DatabaseSync } from "node:sqlite";
import { parseSqliteSessionEntryRecord } from "../config/sessions/session-entry-json.js";
import { splitSessionEntrySnapshots } from "../config/sessions/session-entry-snapshots.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { sessionEntrySnapshotsSchemaSql } from "./openclaw-agent-session-snapshots-schema.js";

/** The existing schema owner holds maintenance authority and the outer write transaction. */
export function migrateSessionEntrySnapshotsInTransaction(database: DatabaseSync): void {
  database.exec(
    "ALTER TABLE session_nodes ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0",
  );
  database.exec(sessionEntrySnapshotsSchemaSql(OPENCLAW_AGENT_SCHEMA_SQL));
  const select = database.prepare(`
    SELECT session_key, current_session_id, updated_at, entry_json
    FROM session_nodes WHERE (? IS NULL OR session_key > ?) ORDER BY session_key LIMIT 64
  `);
  const insert = database.prepare(`
    INSERT INTO session_entry_snapshots(session_key, field, value_json) VALUES (?, ?, ?)
  `);
  const update = database.prepare(`
    UPDATE session_nodes SET entry_json = ? WHERE session_key = ?
  `);
  const markValid = database.prepare(
    "UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?",
  );
  for (const statement of [insert, update, markValid]) {
    statement.setReadBigInts(true);
  }
  let after: string | null = null;
  while (true) {
    const rows: ReturnType<typeof select.all> = select.all(after, after);
    if (rows.length === 0) {
      return;
    }
    renewAgentDatabaseMaintenanceAuthorityIfPresent();
    for (const row of rows) {
      if (
        typeof row.session_key !== "string" ||
        typeof row.current_session_id !== "string" ||
        typeof row.updated_at !== "number" ||
        typeof row.entry_json !== "string"
      ) {
        throw new Error("Unreadable session row during snapshot migration");
      }
      after = row.session_key;
      const entry = parseSqliteSessionEntryRecord({
        current_session_id: row.current_session_id,
        updated_at: row.updated_at,
        entry_json: row.entry_json,
      });
      // Preserve corrupt, identity-mismatched and retained-window rows byte-for-byte for Doctor.
      if (!entry) {
        continue;
      }
      const { entryJson, snapshots } = splitSessionEntrySnapshots(entry);
      if (snapshots.length === 0) {
        continue;
      }
      for (const snapshot of snapshots) {
        insert.run(row.session_key, snapshot.field, snapshot.valueJson);
      }
      update.run(entryJson, row.session_key);
      markValid.run(row.session_key);
    }
  }
}
