import type { DatabaseSync } from "node:sqlite";
import type { InferResult, RawBuilder } from "kysely";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_cold_archives"
  | "transcript_rewrite_watermarks"
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

export type CurrentTranscriptProjection = {
  database: OpenClawAgentDatabase;
  generation: string | undefined;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

export type SessionTranscriptMessageEvent = {
  event: TranscriptEvent;
  eventSeq: number;
  seq: number;
  displayPosition?: TranscriptDisplayPosition;
};

const EMPTY_PROJECTION_STATE: SessionTranscriptProjectionState = {
  activeEventCount: 0,
  activeMessageCount: 0,
  indexedSeq: -1,
  leafEventId: null,
  needsRebuild: false,
};

export function getActiveTranscriptKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
}

export function parseActiveTranscriptMessageRow(row: {
  event_seq: number;
  event_json: string;
  message_position: number | null;
}): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    // SAFETY: The active projection indexes serialized TranscriptEvent rows.
    event: JSON.parse(row.event_json) as TranscriptEvent,
    eventSeq: row.event_seq,
    // Gateway cursors use the visible-message ordinal, matching the JSONL index.
    // Raw event seq includes headers/control rows and would make pages overlap.
    seq: row.message_position + 1,
  };
}

function buildProjectionSnapshotQuery(
  database: OpenClawAgentDatabase,
  sessionId: RawBuilder<string>,
) {
  const db = getActiveTranscriptKysely(database);
  // The target survives empty and archived transcripts, which have no hot event rows.
  const target = db.selectNoFrom(sessionId.as("session_id")).as("target");
  return db
    .selectFrom(target)
    .leftJoin("session_transcript_index_state as state", "state.session_id", "target.session_id")
    .leftJoin(
      "transcript_rewrite_watermarks as watermark",
      "watermark.session_id",
      "target.session_id",
    )
    .select([
      "watermark.generation",
      "state.active_event_count",
      "state.active_message_count",
      "state.indexed_seq",
      "state.leaf_event_id",
      "state.needs_rebuild",
    ])
    .select((eb) => [
      eb
        .selectFrom("transcript_events")
        .select(({ fn }) => fn.max<number | null>("seq").as("latest_seq"))
        .whereRef("transcript_events.session_id", "=", "target.session_id")
        .as("latest_seq"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .whereRef("session_transcript_cold_archives.session_id", "=", "target.session_id"),
        )
        .as("is_cold"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_active_events")
            .select("session_id")
            .whereRef("session_transcript_active_events.session_id", "=", "target.session_id")
            .where("context_eligible", "is", null),
        )
        .as("has_unclassified"),
    ]);
}

// Cache compilation only; bindings and rows belong to each read snapshot.
const projectionSnapshotReaders = new WeakMap<
  DatabaseSync,
  ReturnType<
    typeof prepareSqliteQuerySync<
      string,
      InferResult<ReturnType<typeof buildProjectionSnapshotQuery>>[number]
    >
  >
>();

function readProjectionSnapshot(database: OpenClawAgentDatabase, sessionId: string) {
  let read = projectionSnapshotReaders.get(database.db);
  if (!read) {
    read = prepareSqliteQuerySync<
      string,
      InferResult<ReturnType<typeof buildProjectionSnapshotQuery>>[number]
    >(database.db, (parameter) =>
      buildProjectionSnapshotQuery(
        database,
        parameter((id) => id),
      ),
    );
    projectionSnapshotReaders.set(database.db, read);
  }
  const row = read(sessionId).rows[0]!;
  return {
    cold: Boolean(row.is_cold),
    generation: row.generation ?? undefined,
    hasUnclassified: Boolean(row.has_unclassified),
    latestSeq: row.latest_seq,
    ...(typeof row.indexed_seq === "number"
      ? {
          state: {
            activeEventCount: row.active_event_count ?? 0,
            activeMessageCount: row.active_message_count ?? 0,
            indexedSeq: row.indexed_seq,
            leafEventId: row.leaf_event_id,
            needsRebuild: row.needs_rebuild !== 0,
          },
        }
      : {}),
  };
}

export function withCurrentProjectionSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (projection: CurrentTranscriptProjection) => T,
): T {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const database = openOpenClawAgentDatabase(databaseOptions);
  const result = runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const snapshot = readProjectionSnapshot(database, resolved.sessionId);
      if (snapshot.cold) {
        throw new SessionTranscriptColdError(resolved.sessionId);
      }
      if (snapshot.latestSeq === null) {
        return {
          kind: "value" as const,
          value: read({
            database,
            generation: snapshot.generation,
            resolved,
            state: EMPTY_PROJECTION_STATE,
          }),
        };
      }
      if (
        snapshot.state &&
        !snapshot.state.needsRebuild &&
        snapshot.state.indexedSeq === snapshot.latestSeq &&
        !snapshot.hasUnclassified
      ) {
        return {
          kind: "value" as const,
          value: read({
            database,
            generation: snapshot.generation,
            resolved,
            state: snapshot.state,
          }),
        };
      }
      return { kind: "unavailable" as const };
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.history.read",
    },
  );
  if (result.kind === "value") {
    return result.value;
  }
  // Request latency never scales with transcript size. The maintenance owner
  // rebuilds after this stack unwinds; callers return a retryable response.
  startSessionTranscriptIndexReconcile({
    ...databaseOptions,
    preferredSessionId: resolved.sessionId,
  });
  throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
}
