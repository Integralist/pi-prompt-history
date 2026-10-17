import { dirname, join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { installPromptHistoryEditor } from "../src/editor.ts";
import {
  collectHistory,
  type HistoryItem,
  type HistoryScope,
  type RuntimePromptEntry,
} from "../src/history.ts";
import { PromptHistorySelectorComponent } from "../src/selector.ts";

export { installPromptHistoryEditor } from "../src/editor.ts";
export {
  type CollectHistoryOptions,
  collectHistory,
  deduplicateHistory,
  extractPromptFromEntry,
  filterHistory,
  formatRelativeAge,
  type HistoryItem,
  type HistoryScope,
  type RuntimePromptEntry,
  shortenCwdPath,
} from "../src/history.ts";
export {
  PromptHistorySelectorComponent,
  type PromptHistorySelectorOptions,
} from "../src/selector.ts";

export interface PromptHistoryExtensionOptions {
  sessionsRootDir?: string;
  maxSessionFiles?: number;
  defaultScope?: HistoryScope;
}

const MAX_RUNTIME_ENTRIES = 500;

function resolveSessionsRootDir(
  ctx: ExtensionContext,
  explicitRootDir?: string,
): string {
  if (explicitRootDir) {
    return explicitRootDir;
  }
  try {
    const sessionDir = ctx.sessionManager.getSessionDir?.();
    if (sessionDir) {
      return dirname(sessionDir);
    }
  } catch {
    // Fall back to default agent sessions directory
  }
  return join(getAgentDir(), "sessions");
}

export default function promptHistoryExtension(
  pi: ExtensionAPI,
  _configuration?: unknown,
  options: PromptHistoryExtensionOptions = {},
): void {
  const runtimeEntries: RuntimePromptEntry[] = [];
  let isSearchOpen = false;

  const recordRuntimePrompt = (text: string, ctx: ExtensionContext): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    runtimeEntries.push({
      text: trimmed,
      timestamp: Date.now(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (runtimeEntries.length > MAX_RUNTIME_ENTRIES) {
      runtimeEntries.shift();
    }
  };

  const openPromptHistorySearch = async (
    ctx: ExtensionContext,
    initialQueryOverride?: string,
  ): Promise<void> => {
    if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
      return;
    }
    if (isSearchOpen) {
      return;
    }
    isSearchOpen = true;

    try {
      const initialQuery =
        initialQueryOverride !== undefined
          ? initialQueryOverride
          : (ctx.ui.getEditorText?.() ?? "");

      const items: HistoryItem[] = collectHistory({
        currentEntries: ctx.sessionManager.getEntries(),
        currentSessionId: ctx.sessionManager.getSessionId(),
        currentCwd: ctx.cwd,
        currentSessionFile: ctx.sessionManager.getSessionFile(),
        sessionsRootDir: resolveSessionsRootDir(ctx, options.sessionsRootDir),
        runtimeEntries,
        maxSessionFiles: options.maxSessionFiles,
      });

      let activeTui: TUI | undefined;
      const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        activeTui = tui;
        return new PromptHistorySelectorComponent(tui, theme, items, {
          initialQuery,
          initialScope: options.defaultScope,
          onSelect: (text) => done(text),
          onCancel: () => done(null),
        });
      });

      if (typeof selected === "string") {
        ctx.ui.setEditorText(selected);
        activeTui?.requestRender();
      }
    } finally {
      isSearchOpen = false;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return;
    }
    installPromptHistoryEditor(ctx, () => {
      void openPromptHistorySearch(ctx);
    });
  });

  pi.on("input", (event, ctx) => {
    if (typeof event.text === "string") {
      recordRuntimePrompt(event.text, ctx);
    }
  });

  pi.on("user_bash", (event, ctx) => {
    if (typeof event.command === "string" && event.command.trim()) {
      const prefix = event.excludeFromContext ? "!!" : "!";
      recordRuntimePrompt(`${prefix}${event.command.trim()}`, ctx);
    }
  });

  pi.registerCommand("history", {
    description: "Search prompt history interactively (same as Ctrl+R)",
    handler: async (args, ctx) => {
      const query = args.trim() ? args.trim() : undefined;
      await openPromptHistorySearch(ctx, query);
    },
  });
}
