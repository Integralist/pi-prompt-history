import { describe, expect, it, vi } from "vitest";
import { installPromptHistoryEditor } from "../src/editor.ts";

describe("installPromptHistoryEditor", () => {
  it("intercepts Ctrl+R and preserves existing custom editor behavior", () => {
    let installedFactory: any;
    const baseHandleInput = vi.fn();
    const baseRender = vi.fn(() => ["top", "content", "bottom"]);

    const existingFactory = vi.fn(() => ({
      handleInput: baseHandleInput,
      render: baseRender,
      isShowingAutocomplete: () => false,
    }));

    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        getEditorComponent: () => installedFactory,
        setEditorComponent: (factory: any) => {
          installedFactory = factory;
        },
      },
    } as any;

    // Simulate another extension (like pi-skill-argument-hints) setting an editor first
    ctx.ui.setEditorComponent(existingFactory);

    const onTrigger = vi.fn();
    installPromptHistoryEditor(ctx, onTrigger);

    expect(installedFactory).toBeTypeOf("function");
    const editor = installedFactory({}, {}, {});

    // Normal input forwards to base editor
    editor.handleInput("a");
    expect(baseHandleInput).toHaveBeenCalledWith("a");
    expect(onTrigger).not.toHaveBeenCalled();

    // Ctrl+R () triggers history search and does not forward to base editor
    editor.handleInput("\x12");
    expect(onTrigger).toHaveBeenCalledOnce();
    expect(baseHandleInput).toHaveBeenCalledTimes(1);

    // Custom render is preserved
    expect(editor.render(80)).toEqual(["top", "content", "bottom"]);
  });

  it("re-wraps if another extension replaces setEditorComponent later in the same tick", async () => {
    let installedFactory: any;
    const lateHandleInput = vi.fn();

    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        getEditorComponent: () => installedFactory,
        setEditorComponent: (factory: any) => {
          installedFactory = factory;
        },
      },
    } as any;

    const onTrigger = vi.fn();
    installPromptHistoryEditor(ctx, onTrigger);

    // Another extension overwrites setEditorComponent synchronously after us
    ctx.ui.setEditorComponent(() => ({
      handleInput: lateHandleInput,
      render: () => ["late"],
      isShowingAutocomplete: () => false,
    }));

    // Wait for microtask re-wrap
    await Promise.resolve();

    const editor = installedFactory({}, {}, {});
    editor.handleInput("\x12");
    expect(onTrigger).toHaveBeenCalledOnce();
    expect(lateHandleInput).not.toHaveBeenCalled();
  });
});
