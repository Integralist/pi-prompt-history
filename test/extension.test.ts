import { describe, expect, it, vi } from "vitest";
import promptHistoryExtension from "../extensions/prompt-history.ts";
import type { PromptHistorySelectorComponent } from "../src/selector.ts";

function createHarness() {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const commands = new Map<string, any>();

  let editorText = "";
  let editorFactory: any;
  let lastCustomFactory: any;

  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  } as any;

  const ui = {
    getEditorText: () => editorText,
    setEditorText: vi.fn((text: string) => {
      editorText = text;
    }),
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: any) => {
      editorFactory = factory;
    },
    notify: vi.fn(),
    custom: vi.fn(async (factory: any) => {
      lastCustomFactory = factory;
      return await new Promise<string | null>((resolve) => {
        const comp = factory(
          { requestRender: vi.fn() },
          {
            fg: (_c: string, t: string) => t,
            bg: (_c: string, t: string) => t,
            bold: (t: string) => t,
          },
          {},
          resolve,
        ) as PromptHistorySelectorComponent;
        lastCustomComponent = comp;
      });
    }),
  };

  let lastCustomComponent: PromptHistorySelectorComponent | undefined;

  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/Users/me/code/app",
    ui,
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionDir: () => "/tmp/nonexistent/sessions/--Users-me-code-app--",
      getSessionFile: () => undefined,
      getEntries: () => [
        {
          type: "message",
          timestamp: "2026-10-17T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "initial session prompt" }] },
        },
      ],
    },
  } as any;

  return {
    pi,
    ctx,
    ui,
    handlers,
    commands,
    setEditorTextState: (t: string) => {
      editorText = t;
    },
    getEditorFactory: () => editorFactory,
    getLastCustomComponent: () => lastCustomComponent,
    getLastCustomFactory: () => lastCustomFactory,
    async emit(event: string, payload: any = {}) {
      for (const h of handlers.get(event) ?? []) {
        await h(payload, ctx);
      }
    },
  };
}

describe("promptHistoryExtension", () => {
  it("registers /history command, tracks runtime inputs, and populates editor on Ctrl+R selection", async () => {
    const h = createHarness();
    promptHistoryExtension(h.pi, undefined, { sessionsRootDir: "/tmp/nonexistent-root" });

    expect(h.commands.has("history")).toBe(true);

    await h.emit("session_start", { type: "session_start" });
    const factory = h.getEditorFactory();
    expect(factory).toBeTypeOf("function");

    // Simulate runtime input and user_bash events
    await h.emit("input", { type: "input", text: "second prompt from input event" });
    await h.emit("user_bash", {
      type: "user_bash",
      command: "git status -sb",
      excludeFromContext: false,
      cwd: "/Users/me/code/app",
    });

    // Pre-fill editor with query "second" and press Ctrl+R
    h.setEditorTextState("second");
    const editor = factory({}, {}, {});
    editor.handleInput("\x12");

    // Wait a tick for async openPromptHistorySearch to invoke ctx.ui.custom
    await Promise.resolve();
    const selector = h.getLastCustomComponent();
    expect(selector).toBeDefined();
    expect(selector?.getQuery()).toBe("second");
    expect(selector?.getSelectedItem()?.text).toBe("second prompt from input event");

    // Press Enter (CR) inside selector to accept
    selector?.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ui.setEditorText).toHaveBeenCalledWith("second prompt from input event");
  });

  it("supports /history slash command with optional query argument and leaves editor unchanged on Escape", async () => {
    const h = createHarness();
    promptHistoryExtension(h.pi, undefined, { sessionsRootDir: "/tmp/nonexistent-root" });

    h.setEditorTextState("draft to keep");
    const cmd = h.commands.get("history");
    const runPromise = cmd.handler("initial", h.ctx);

    await Promise.resolve();
    const selector = h.getLastCustomComponent();
    expect(selector?.getQuery()).toBe("initial");
    expect(selector?.getSelectedItem()?.text).toBe("initial session prompt");

    // Press Escape () to cancel
    selector?.handleInput("\x1b");
    await runPromise;

    expect(h.ui.setEditorText).not.toHaveBeenCalled();
  });
});
