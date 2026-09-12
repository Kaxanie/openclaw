import { expectDefined } from "@openclaw/normalization-core";
import {
  iterateRedactMatches,
  type RedactMatch,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";

export type RedactionEdit = { start: number; end: number; replacement: string };
export type RedactionTarget = { start: number; end: number; value: string };

export function applyRedactionEdits(value: string, edits: RedactionEdit[]): string {
  edits.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionEdit[] = [];
  for (const edit of edits) {
    const previous = merged.at(-1);
    if (!previous || edit.start >= previous.end) {
      merged.push({ ...edit });
    } else if (
      edit.start !== previous.start ||
      edit.end !== previous.end ||
      edit.replacement !== previous.replacement
    ) {
      previous.end = Math.max(previous.end, edit.end);
      // Conflicting captures cannot retain a hint exposing another captured value.
      previous.replacement = "***";
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of merged) {
    parts.push(value.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  return parts.join("") + value.slice(cursor);
}

type ScalarToken = {
  start: number;
  end: number;
  key: string;
  isKey: boolean;
  string: boolean;
};

function readScalarTokens(text: string): ScalarToken[] {
  const tokens: ScalarToken[] = [];
  const containers: { key: string; field?: string }[] = [];
  const syntax = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g;
  for (const match of text.matchAll(syntax)) {
    const raw = match[0];
    const parent = containers.at(-1);
    const key = parent?.field ?? parent?.key ?? "";
    if (raw === "{" || raw === "[") {
      containers.push({ key });
    } else if (raw === "}" || raw === "]") {
      containers.pop();
    } else if (raw !== ":" && raw !== ",") {
      const start = match.index;
      const end = start + raw.length;
      const string = raw.startsWith('"');
      const isKey = string && /^\s*:/.test(text.slice(end));
      if (isKey && parent) {
        parent.field = JSON.parse(raw);
      }
      tokens.push({ start, end, key: isKey ? "" : key, isKey, string });
    }
  }
  return tokens;
}

function stringBoundaries(text: string, token: ScalarToken): Map<number, number> {
  const boundaries = new Map<number, number>();
  let decoded = 0;
  for (let offset = token.start + 1; offset < token.end - 1; decoded += 1) {
    boundaries.set(offset, decoded);
    offset += text[offset] === "\\" ? (text[offset + 1] === "u" ? 6 : 2) : 1;
  }
  boundaries.set(token.end - 1, decoded);
  return boundaries;
}

function firstIntersectingToken(tokens: ScalarToken[], start: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(tokens[middle], "bounded JSON token search").end <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function redactJsonRecord(
  input: string,
  patterns: ResolvedRedactPattern[],
  getEdit: (
    match: RedactMatch,
    pattern: ResolvedRedactPattern,
    project: (start: number, end: number) => RedactionTarget | undefined,
  ) => RedactionEdit | undefined,
  preserveValue: (key: string, value: string) => boolean,
  finishChangedValue: (value: string) => string,
): string {
  let text = input;
  for (const pattern of patterns) {
    const tokens = readScalarTokens(text);
    const tokenEdits = new Map<ScalarToken, RedactionEdit[]>();
    const fullMasks = new Set<ScalarToken>();
    const stringTokens = new Map<ScalarToken, { value: string; boundaries: Map<number, number> }>();
    const readStringToken = (token: ScalarToken) => {
      let decoded = stringTokens.get(token);
      if (!decoded) {
        decoded = {
          value: JSON.parse(text.slice(token.start, token.end)),
          boundaries: stringBoundaries(text, token),
        };
        stringTokens.set(token, decoded);
      }
      return decoded;
    };
    for (const token of tokens) {
      if (token.isKey) {
        continue;
      }
      const value = token.string
        ? readStringToken(token).value
        : text.slice(token.start, token.end);
      if (preserveValue(token.key, value)) {
        continue;
      }
      for (const match of iterateRedactMatches(value, pattern)) {
        const edit = getEdit(match, pattern, (start, end) => ({
          start,
          end,
          value: value.slice(start, end),
        }));
        if (!edit || edit.end <= edit.start) {
          continue;
        }
        if (!token.string) {
          fullMasks.add(token);
        } else {
          const edits = tokenEdits.get(token) ?? [];
          edits.push(edit);
          tokenEdits.set(token, edits);
        }
      }
    }
    for (const match of iterateRedactMatches(text, pattern)) {
      let capture: { start: number; end: number } | undefined;
      getEdit(match, pattern, (start, end) => {
        capture = { start, end };
        return undefined;
      });
      if (!capture || capture.end <= capture.start) {
        continue;
      }
      for (
        let index = firstIntersectingToken(tokens, capture.start);
        index < tokens.length;
        index += 1
      ) {
        const token = expectDefined(tokens[index], "bounded JSON token capture");
        if (token.start >= capture.end) {
          break;
        }
        if (!token.string) {
          fullMasks.add(token);
          continue;
        }
        const { value, boundaries } = readStringToken(token);
        if (!token.isKey && preserveValue(token.key, value)) {
          continue;
        }
        const start = boundaries.get(Math.max(capture.start, token.start + 1));
        const end = boundaries.get(Math.min(capture.end, token.end - 1));
        // Cutting an escape cannot leave the rest of a quoted credential visible.
        if (start === undefined || end === undefined || end <= start) {
          fullMasks.add(token);
          continue;
        }
        const edit = getEdit(match, pattern, () => ({
          start,
          end,
          value: value.slice(start, end),
        }));
        if (edit) {
          const edits = tokenEdits.get(token) ?? [];
          edits.push(edit);
          tokenEdits.set(token, edits);
        }
      }
    }
    const edits: RedactionEdit[] = [];
    for (const token of tokens) {
      const selected = tokenEdits.get(token);
      if (fullMasks.has(token)) {
        edits.push({ start: token.start, end: token.end, replacement: '"***"' });
      } else if (selected) {
        const { value } = readStringToken(token);
        edits.push({
          start: token.start,
          end: token.end,
          replacement: JSON.stringify(finishChangedValue(applyRedactionEdits(value, selected))),
        });
      }
    }
    text = applyRedactionEdits(text, edits);
  }
  return text;
}
