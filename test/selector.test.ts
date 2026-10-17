import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { HistoryItem } from "../src/history.ts";
import { PromptHistorySelectorComponent } from "../src/selector.ts";

function createFakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function createFakeTui() {
  return {
    requestRender: vi.fn(),
  } as any;
}

const SAMPLE_ITEMS: HistoryItem[] = [
  {
    text: "git status && git diff",
    timestamp: 3_000,
    cwd: "/Users/me/code/app",
    sessionId: "s1",
    isCurrentSession: true,
    isCurrentProject: true,
  },
  {
    text: "deploy service to staging\nwith canary enabled",
    timestamp: 2_000,
    cwd: "/Users/me/code/app",
    sessionId: "s0",
    isCurrentSession: false,
    isCurrentProject: true,
  },
  {
    text: "terraform plan -out=tfplan",
    timestamp: 1_000,
    cwd: "/Users/me/code/infra",
    sessionId: "s-other",
    isCurrentSession: false,
    isCurrentProject: false,
  },
];

describe("PromptHistorySelectorComponent", () => {
  it("defaults to project scope when project items exist, or all scope when project is empty", () => {
    const tui = createFakeTui();
    const theme = createFakeTheme();
    const compWithProject = new PromptHistorySelectorComponent(tui, theme, SAMPLE_ITEMS, {
      onSelect: () => {},
      onCancel: () => {},
    });
    expect(compWithProject.getScope()).toBe("project");
    expect(compWithProject.getSelectedItem()?.text).toBe("git status && git diff");

    const compWithoutProject = new PromptHistorySelectorComponent(
      tui,
      theme,
      SAMPLE_ITEMS.filter((i) => !i.isCurrentProject),
      {
        onSelect: () => {},
        onCancel: () => {},
      },
    );
    expect(compWithoutProject.getScope()).toBe("all");
    expect(compWithoutProject.getSelectedItem()?.text).toBe("terraform plan -out=tfplan");

    // When initialQuery matches only an item outside project scope, fall back to "all" scope
    // and place cursor at the end of initialQuery so typing appends to it.
    const compWithInitialQuery = new PromptHistorySelectorComponent(tui, theme, SAMPLE_ITEMS, {
      initialQuery: "terra",
      onSelect: () => {},
      onCancel: () => {},
    });
    expect(compWithInitialQuery.getScope()).toBe("all");
    compWithInitialQuery.handleInput("f");
    expect(compWithInitialQuery.getQuery()).toBe("terraf");
  });

  it("cycles matches with Ctrl+R / Down and Ctrl+S / Up, and selects with Enter", () => {
    const tui = createFakeTui();
    const theme = createFakeTheme();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const comp = new PromptHistorySelectorComponent(tui, theme, SAMPLE_ITEMS, {
      initialScope: "all",
      onSelect,
      onCancel,
    });

    expect(comp.getSelectedIndex()).toBe(0);

    // Ctrl+R () moves to next (older) match
    comp.handleInput("\x12");
    expect(comp.getSelectedIndex()).toBe(1);
    expect(comp.getSelectedItem()?.text).toContain("deploy service to staging");

    // Ctrl+R again moves to index 2
    comp.handleInput("\x12");
    expect(comp.getSelectedIndex()).toBe(2);

    // Ctrl+R wraps to index 0
    comp.handleInput("\x12");
    expect(comp.getSelectedIndex()).toBe(0);

    // Ctrl+S () moves back to previous (wrapping to 2)
    comp.handleInput("\x13");
    expect(comp.getSelectedIndex()).toBe(2);

    // Enter (CR) selects current item
    comp.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("terraform plan -out=tfplan");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("filters live as the user types, toggles scope with Tab, and cancels on Escape", () => {
    const tui = createFakeTui();
    const theme = createFakeTheme();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const comp = new PromptHistorySelectorComponent(tui, theme, SAMPLE_ITEMS, {
      initialScope: "project",
      onSelect,
      onCancel,
    });

    // Tab (	) switches project -> all -> session -> project
    comp.handleInput("\t");
    expect(comp.getScope()).toBe("all");

    for (const ch of "terraform") {
      comp.handleInput(ch);
    }
    expect(comp.getQuery()).toBe("terraform");
    expect(comp.getSelectedItem()?.text).toBe("terraform plan -out=tfplan");

    // Escape () cancels
    comp.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders lines within terminal width budget and includes multi-line preview", () => {
    const tui = createFakeTui();
    const theme = createFakeTheme();
    const comp = new PromptHistorySelectorComponent(tui, theme, SAMPLE_ITEMS, {
      initialScope: "all",
      onSelect: () => {},
      onCancel: () => {},
    });
    comp.focused = true;
    // Select multi-line item
    comp.handleInput("\x12");

    const width = 60;
    const lines = comp.render(width);
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines.join("\n")).toContain("with canary enabled");
  });
});
