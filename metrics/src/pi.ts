import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasUsage, normalizeModel, normalizeProvider } from "./metrics.ts";
import type { PiFileCursor, PiSessionHeader, UsageEvent } from "./types.ts";

const MAX_HEADER_BYTES = 64 * 1024;
// Bounds memory per poll; larger files continue on the next cycle.
const MAX_BYTES_PER_FILE_PER_SCAN = 64 * 1024 * 1024;
const TAIL_SIGNATURE_BYTES = 256;

interface RecordValue {
  readonly [key: string]: unknown;
}

interface FileDescriptor {
  readonly fileKey: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly header: PiSessionHeader;
  readonly headerJson: string;
  readonly cursor: PiFileCursor | undefined;
}

export interface PiFileBatch {
  readonly path: string;
  readonly events: readonly UsageEvent[];
  readonly cursor: PiFileCursor;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([key]) => key !== "parentId")
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseHeader(value: unknown): PiSessionHeader | null {
  if (!isRecord(value) || value.type !== "session") return null;
  const sessionId = stringValue(value.id);
  const timestamp = timestampValue(value.timestamp);
  if (!sessionId || timestamp === null) return null;
  return {
    sessionId,
    timestamp,
    parentSession: stringValue(value.parentSession),
  };
}

function listSessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.warn(`[pi] Unable to enumerate session directory ${directory}:`, error);
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function readFirstLine(path: string, size: number): string | null {
  const fd = openSync(path, "r");
  try {
    const amount = Math.min(size, MAX_HEADER_BYTES);
    if (amount <= 0) return null;
    const bytes = Buffer.alloc(amount);
    const read = readSync(fd, bytes, 0, amount, 0);
    const newline = bytes.subarray(0, read).indexOf(0x0a);
    const line = bytes.subarray(0, newline >= 0 ? newline : read).toString("utf8").replace(/\r$/, "");
    return line.length > 0 ? line : null;
  } finally {
    closeSync(fd);
  }
}

function fileKey(path: string, device: number, inode: number): string {
  return inode > 0 ? `${device}:${inode}` : `path:${resolve(path)}`;
}

function parentIdFromPath(parentPath: string): string {
  const normalized = parentPath.replaceAll("\\", "/");
  const stem = basename(normalized).replace(/\.jsonl$/i, "");
  const separator = stem.indexOf("_");
  return separator >= 0 ? stem.slice(separator + 1) : stem;
}

function isWithinRoot(root: string, path: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(path);
  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function readDescriptors(root: string, cursors: ReadonlyMap<string, PiFileCursor>): FileDescriptor[] {
  const files = listSessionFiles(root);
  const descriptors: FileDescriptor[] = [];
  for (const path of files) {
    try {
      const fd = openSync(path, "r");
      let stat;
      try {
        stat = fstatSync(fd);
      } finally {
        closeSync(fd);
      }
      const key = fileKey(path, stat.dev, stat.ino);
      const cursor = cursors.get(key);
      const line = readFirstLine(path, stat.size);
      if (!line) {
        console.warn(`[pi] Skipping empty or incomplete session header: ${path}`);
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        console.warn(`[pi] Skipping invalid session header: ${path}`);
        continue;
      }
      const header = parseHeader(decoded);
      if (!header) {
        console.warn(`[pi] Skipping unsupported session header: ${path}`);
        continue;
      }
      descriptors.push({
        fileKey: key,
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        header,
        headerJson: line,
        cursor,
      });
    } catch (error) {
      console.warn(`[pi] Could not inspect session ${path}:`, error);
    }
  }
  return descriptors;
}

function findParent(
  current: FileDescriptor,
  root: string,
  byPath: ReadonlyMap<string, FileDescriptor>,
  byId: ReadonlyMap<string, FileDescriptor>
): { readonly id: string; readonly timestamp: number | null; readonly path: string | null } | null {
  const parentPath = current.header.parentSession;
  if (!parentPath) return null;
  const normalizedPath = resolve(parentPath);
  if (isWithinRoot(root, normalizedPath)) {
    const parent = byPath.get(normalizedPath);
    if (parent) return { id: parent.header.sessionId, timestamp: parent.header.timestamp, path: parent.path };
  }
  const parentId = parentIdFromPath(parentPath);
  const parentById = byId.get(parentId);
  if (parentById) return { id: parentById.header.sessionId, timestamp: parentById.header.timestamp, path: parentById.path };
  return { id: parentId, timestamp: null, path: null };
}

function ownerSessionId(
  descriptor: FileDescriptor,
  eventTimestamp: number,
  root: string,
  byPath: ReadonlyMap<string, FileDescriptor>,
  byId: ReadonlyMap<string, FileDescriptor>
): string {
  const currentId = descriptor.header.sessionId;
  if (eventTimestamp >= descriptor.header.timestamp) return currentId;

  let parent = findParent(descriptor, root, byPath, byId);
  if (!parent) return currentId;
  let fallbackId = parent.id;
  const visited = new Set([currentId]);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    fallbackId = parent.id;
    if (parent.timestamp !== null && eventTimestamp >= parent.timestamp) return parent.id;
    if (!parent.path) break;
    const parentDescriptor = byPath.get(resolve(parent.path));
    if (!parentDescriptor) break;
    parent = findParent(parentDescriptor, root, byPath, byId);
  }
  return fallbackId;
}

function parseUsage(value: unknown): {
  readonly tokens: UsageEvent["tokens"];
  readonly costUsd: number;
} | null {
  if (!isRecord(value)) return null;
  const cost = isRecord(value.cost) ? finiteNonNegative(value.cost.total) : 0;
  return {
    tokens: {
      input: finiteNonNegative(value.input),
      output: finiteNonNegative(value.output),
      cache_read: finiteNonNegative(value.cacheRead),
      cache_write: finiteNonNegative(value.cacheWrite),
    },
    costUsd: cost,
  };
}

function eventFromEntry(
  value: unknown,
  descriptor: FileDescriptor,
  ownerId: string
): UsageEvent | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return null;
  const entryType = value.type;
  let usageValue: unknown;
  let providerRaw: string | null = null;
  let modelRaw: string | null = null;
  let eventTimestamp: number | null = timestampValue(value.timestamp);
  let identityProjection: RecordValue;

  if (entryType === "message") {
    if (!isRecord(value.message)) return null;
    const message = value.message;
    if (message.role !== "assistant" && message.role !== "toolResult") return null;
    if (message.role === "assistant" && message.stopReason === "pending") return null;
    usageValue = message.usage;
    providerRaw = stringValue(message.provider);
    modelRaw = stringValue(message.model);
    eventTimestamp = timestampValue(message.timestamp) ?? eventTimestamp;
    identityProjection = {
      type: entryType, id: value.id, timestamp: value.timestamp,
      role: message.role, messageTimestamp: message.timestamp,
      provider: message.provider, model: message.model, usage: message.usage,
      stopReason: message.stopReason, toolCallId: message.toolCallId,
      toolName: message.toolName, isError: message.isError,
    };
  } else if (entryType === "usage") {
    usageValue = value.usage;
    providerRaw = stringValue(value.provider);
    modelRaw = stringValue(value.model);
    identityProjection = {
      type: entryType, id: value.id, timestamp: value.timestamp,
      kind: value.kind, provider: value.provider, model: value.model,
      usage: value.usage,
    };
  } else if (entryType === "compaction" || entryType === "branch_summary") {
    usageValue = value.usage;
    identityProjection = {
      type: entryType, id: value.id, timestamp: value.timestamp,
      usage: value.usage,
    };
  } else {
    return null;
  }

  const usage = parseUsage(usageValue);
  if (!usage || eventTimestamp === null || eventTimestamp <= 0) return null;
  const event: UsageEvent = {
    eventId: `pi:${hash(`${ownerId}\0${value.id}`)}`,
    payloadHash: hash(stableStringify(identityProjection)),
    harness: "pi",
    provider: normalizeProvider(providerRaw),
    model: normalizeModel(modelRaw),
    timestamp: eventTimestamp,
    sessionKey: `pi:${ownerId}`,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
  };
  return hasUsage(event) ? event : null;
}

function tailHash(path: string, end: number): string {
  if (end <= 0) return "";
  const length = Math.min(TAIL_SIGNATURE_BYTES, end);
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, end - length);
    return hash(bytes.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

function readDelta(descriptor: FileDescriptor): { readonly lines: readonly string[]; readonly cursor: PiFileCursor } {
  const previous = descriptor.cursor;
  let offset = previous?.offset ?? 0;
  let pending = previous ? Buffer.from(previous.pendingBase64, "base64") : Buffer.alloc(0);
  let reset = !previous || offset > descriptor.size;

  if (previous && !reset) {
    if (descriptor.headerJson !== previous.headerJson) reset = true;
    if (descriptor.size === previous.size && descriptor.mtimeMs !== previous.mtimeMs) reset = true;
    if (!reset && previous.tailHash && tailHash(descriptor.path, offset) !== previous.tailHash) reset = true;
  }
  if (reset) {
    if (previous) console.warn(`[pi] Session file changed; rescanning from the beginning: ${descriptor.path}`);
    offset = 0;
    pending = Buffer.alloc(0);
  }

  const bytesToRead = Math.min(Math.max(0, descriptor.size - offset), MAX_BYTES_PER_FILE_PER_SCAN);
  let chunk = Buffer.alloc(0);
  if (bytesToRead > 0) {
    const fd = openSync(descriptor.path, "r");
    try {
      chunk = Buffer.alloc(bytesToRead);
      const read = readSync(fd, chunk, 0, bytesToRead, offset);
      chunk = chunk.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
  const nextOffset = offset + chunk.length;
  const combined = Buffer.concat([pending, chunk]);
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < combined.length; index++) {
    if (combined[index] !== 0x0a) continue;
    const line = combined.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
    lines.push(line);
    lineStart = index + 1;
  }
  const remainder = combined.subarray(lineStart);
  const cursor: PiFileCursor = {
    fileKey: descriptor.fileKey,
    path: descriptor.path,
    offset: nextOffset,
    pendingBase64: remainder.toString("base64"),
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    tailHash: tailHash(descriptor.path, nextOffset),
    headerJson: descriptor.headerJson,
  };
  return { lines, cursor };
}

export function scanPiSessions(
  root: string,
  cursors: ReadonlyMap<string, PiFileCursor>
): PiFileBatch[] {
  const rootPath = resolve(root);
  const descriptors = readDescriptors(rootPath, cursors);
  const byPath = new Map(descriptors.map((descriptor) => [resolve(descriptor.path), descriptor]));
  const byId = new Map(descriptors.map((descriptor) => [descriptor.header.sessionId, descriptor]));
  const batches: PiFileBatch[] = [];

  for (const descriptor of descriptors) {
    try {
      const { lines, cursor } = readDelta(descriptor);
      const events: UsageEvent[] = [];
      for (const [index, line] of lines.entries()) {
        if (line.length === 0) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          // A complete malformed line is permanently skipped, but does not stop
          // the rest of this session or other session files from being imported.
          console.warn(`[pi] Skipping malformed JSON at ${descriptor.path}:${index + 1}`);
          continue;
        }
        if (isRecord(entry) && entry.type === "session") continue;
        if (!isRecord(entry)) continue;
        const eventTime = timestampValue(entry.timestamp) ?? descriptor.header.timestamp;
        const owner = ownerSessionId(descriptor, eventTime, rootPath, byPath, byId);
        const event = eventFromEntry(entry, descriptor, owner);
        if (event) events.push(event);
      }
      batches.push({ path: descriptor.path, events, cursor });
    } catch (error) {
      console.warn(`[pi] Could not read session ${descriptor.path}; will retry:`, error);
    }
  }
  return batches;
}
