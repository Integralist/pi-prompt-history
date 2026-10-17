import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export type HistoryScope = "all" | "project" | "session";

export interface HistoryItem {
  text: string;
  timestamp: number;
  cwd: string;
  sessionId: string;
  isCurrentSession: boolean;
  isCurrentProject: boolean;
}

export interface RuntimePromptEntry {
  text: string;
  timestamp: number;
  cwd: string;
  sessionId: string;
}

export interface CollectHistoryOptions {
  currentEntries: readonly unknown[];
  currentSessionId: string;
  currentCwd: string;
  currentSessionFile?: string;
  sessionsRootDir?: string;
  runtimeEntries?: readonly RuntimePromptEntry[];
  maxSessionFiles?: number;
}

const DEFAULT_MAX_SESSION_FILES = 200;

function parseTimestamp(entryTs: unknown, messageTs: unknown): number {
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
    return messageTs;
  }
  if (typeof entryTs === "string") {
    const parsed = Date.parse(entryTs);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof entryTs === "number" && Number.isFinite(entryTs)) {
    return entryTs;
  }
  return 0;
}

function normalizePromptText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "";
  }
  const skillBlock = parseSkillBlock(trimmed);
  if (skillBlock) {
    const args = skillBlock.userMessage?.trim();
    return args ? `/skill:${skillBlock.name} ${args}` : `/skill:${skillBlock.name}`;
  }
  return trimmed;
}

export function extractPromptFromEntry(
  entry: unknown,
): { text: string; timestamp: number } | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (record.type !== "message") {
    return null;
  }
  const msg = record.message;
  if (typeof msg !== "object" || msg === null) {
    return null;
  }
  const message = msg as Record<string, unknown>;
  const timestamp = parseTimestamp(record.timestamp, message.timestamp);

  if (message.role === "bashExecution") {
    const cmd = typeof message.command === "string" ? message.command.trim() : "";
    if (!cmd) {
      return null;
    }
    const prefix = message.excludeFromContext === true ? "!!" : "!";
    return { text: `${prefix}${cmd}`, timestamp };
  }

  if (message.role !== "user") {
    return null;
  }

  let rawText = "";
  if (typeof message.content === "string") {
    rawText = message.content;
  } else if (Array.isArray(message.content)) {
    const textParts: string[] = [];
    for (const part of message.content) {
      if (typeof part === "object" && part !== null) {
        const partRecord = part as Record<string, unknown>;
        if (partRecord.type === "text" && typeof partRecord.text === "string") {
          textParts.push(partRecord.text);
        }
      }
    }
    rawText = textParts.join("\n");
  }

  const normalized = normalizePromptText(rawText);
  if (!normalized) {
    return null;
  }

  return { text: normalized, timestamp };
}

export function deduplicateHistory(items: readonly HistoryItem[]): HistoryItem[] {
  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const byText = new Map<string, HistoryItem>();

  for (const item of sorted) {
    const key = item.text.trim();
    if (!key) continue;
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, {
        ...item,
        text: key,
      });
    } else {
      existing.isCurrentSession = existing.isCurrentSession || item.isCurrentSession;
      existing.isCurrentProject = existing.isCurrentProject || item.isCurrentProject;
    }
  }

  return [...byText.values()];
}

export function filterHistory(
  items: readonly HistoryItem[],
  query: string,
  scope: HistoryScope,
): HistoryItem[] {
  const scoped = items.filter((item) => {
    if (scope === "session") return item.isCurrentSession;
    if (scope === "project") return item.isCurrentProject;
    return true;
  });

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return scoped;
  }

  const lowerQuery = trimmedQuery.toLowerCase();
  const substringMatches: HistoryItem[] = [];
  const substringSet = new Set<HistoryItem>();

  for (const item of scoped) {
    if (item.text.toLowerCase().includes(lowerQuery)) {
      substringMatches.push(item);
      substringSet.add(item);
    }
  }

  const remaining = scoped.filter((item) => !substringSet.has(item));
  const fuzzyMatches = fuzzyFilter(remaining, trimmedQuery, (item) => item.text);

  return [...substringMatches, ...fuzzyMatches];
}

function listSessionFiles(rootDir: string, maxFiles: number): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const filesWithMtime: { path: string; mtimeMs: number }[] = [];

  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        try {
          const subEntries = readdirSync(fullPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && sub.name.endsWith(".jsonl")) {
              const filePath = join(fullPath, sub.name);
              try {
                const st = statSync(filePath);
                filesWithMtime.push({ path: filePath, mtimeMs: st.mtimeMs });
              } catch {
                // Ignore unreadable file
              }
            }
          }
        } catch {
          // Ignore unreadable subdirectory
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const st = statSync(fullPath);
          filesWithMtime.push({ path: fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // Ignore unreadable file
        }
      }
    }
  } catch {
    return [];
  }

  filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return filesWithMtime.slice(0, maxFiles).map((f) => f.path);
}

function readPromptsFromSessionFile(
  filePath: string,
  currentSessionId: string,
  currentCwd: string,
): HistoryItem[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  let sessionId = "";
  let sessionCwd = "";
  const items: HistoryItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") {
      if (typeof record.id === "string") sessionId = record.id;
      if (typeof record.cwd === "string") sessionCwd = record.cwd;
      continue;
    }

    const extracted = extractPromptFromEntry(parsed);
    if (!extracted) continue;

    const isCurrentSession = Boolean(sessionId && sessionId === currentSessionId);
    const isCurrentProject = Boolean(sessionCwd && sessionCwd === currentCwd);

    items.push({
      text: extracted.text,
      timestamp: extracted.timestamp,
      cwd: sessionCwd,
      sessionId,
      isCurrentSession,
      isCurrentProject,
    });
  }

  return items;
}

export function collectHistory(options: CollectHistoryOptions): HistoryItem[] {
  const items: HistoryItem[] = [];

  if (options.runtimeEntries) {
    for (const rt of options.runtimeEntries) {
      const normalized = normalizePromptText(rt.text);
      if (!normalized) continue;
      items.push({
        text: normalized,
        timestamp: rt.timestamp,
        cwd: rt.cwd,
        sessionId: rt.sessionId,
        isCurrentSession: rt.sessionId === options.currentSessionId,
        isCurrentProject: rt.cwd === options.currentCwd,
      });
    }
  }

  for (const entry of options.currentEntries) {
    const extracted = extractPromptFromEntry(entry);
    if (!extracted) continue;
    items.push({
      text: extracted.text,
      timestamp: extracted.timestamp,
      cwd: options.currentCwd,
      sessionId: options.currentSessionId,
      isCurrentSession: true,
      isCurrentProject: true,
    });
  }

  if (options.sessionsRootDir) {
    const maxFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
    const sessionFiles = listSessionFiles(options.sessionsRootDir, maxFiles);
    for (const filePath of sessionFiles) {
      if (options.currentSessionFile && filePath === options.currentSessionFile) {
        continue;
      }
      items.push(
        ...readPromptsFromSessionFile(filePath, options.currentSessionId, options.currentCwd),
      );
    }
  }

  return deduplicateHistory(items);
}

export function formatRelativeAge(timestampMs: number, nowMs = Date.now()): string {
  if (!timestampMs || timestampMs <= 0) {
    return "";
  }
  const diffMs = Math.max(0, nowMs - timestampMs);
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function shortenCwdPath(cwd: string, homeDir = homedir()): string {
  if (!cwd) return "";
  if (homeDir && cwd.startsWith(homeDir)) {
    const rest = cwd.slice(homeDir.length);
    return rest ? `~${rest}` : "~";
  }
  return cwd;
}
