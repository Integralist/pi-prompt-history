import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  filterHistory,
  formatRelativeAge,
  type HistoryItem,
  type HistoryScope,
  shortenCwdPath,
} from "./history.ts";

export interface PromptHistorySelectorOptions {
  initialQuery?: string;
  initialScope?: HistoryScope;
  maxVisible?: number;
  nowMs?: () => number;
  onSelect: (text: string) => void;
  onCancel: () => void;
}

const SCOPE_ORDER: readonly HistoryScope[] = ["project", "all", "session"];
const DEFAULT_MAX_VISIBLE = 8;
const MAX_PREVIEW_LINES = 4;

export class PromptHistorySelectorComponent extends Container {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly allItems: readonly HistoryItem[];
  private readonly searchInput: Input;
  private readonly maxVisible: number;
  private readonly nowMs: () => number;
  private readonly onSelectCallback: (text: string) => void;
  private readonly onCancelCallback: () => void;

  private _focused = false;
  private scope: HistoryScope;
  private filteredItems: HistoryItem[] = [];
  private selectedIndex = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    items: readonly HistoryItem[],
    options: PromptHistorySelectorOptions,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.allItems = items;
    this.maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;

    const initialQuery = options.initialQuery ?? "";
    const hasProjectMatches = filterHistory(items, initialQuery, "project").length > 0;
    this.scope = options.initialScope ?? (hasProjectMatches ? "project" : "all");

    this.searchInput = new Input();
    if (initialQuery) {
      this.searchInput.setValue(initialQuery);
      this.searchInput.handleInput("\x05"); // Move cursor to end of initialQuery
    }

    this.recomputeFilter(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  getScope(): HistoryScope {
    return this.scope;
  }

  getQuery(): string {
    return this.searchInput.getValue();
  }

  getSelectedIndex(): number {
    return this.filteredItems.length === 0 ? -1 : this.selectedIndex;
  }

  getSelectedItem(): HistoryItem | undefined {
    return this.filteredItems[this.selectedIndex];
  }

  private recomputeFilter(resetSelection: boolean): void {
    this.filteredItems = filterHistory(this.allItems, this.searchInput.getValue(), this.scope);
    if (this.filteredItems.length === 0) {
      this.selectedIndex = 0;
    } else if (resetSelection) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, this.filteredItems.length - 1);
    }
  }

  private cycleScope(): void {
    const currentIdx = SCOPE_ORDER.indexOf(this.scope);
    const nextIdx = (currentIdx + 1) % SCOPE_ORDER.length;
    this.scope = SCOPE_ORDER[nextIdx] ?? "all";
    this.recomputeFilter(true);
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const total = this.filteredItems.length;
    if (total === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.input.tab") || matchesKey(data, "tab")) {
      this.cycleScope();
      return;
    }

    if (
      matchesKey(data, "ctrl+r") ||
      matchesKey(data, "ctrl+n") ||
      kb.matches(data, "tui.select.down")
    ) {
      this.moveSelection(1);
      return;
    }

    if (
      matchesKey(data, "ctrl+s") ||
      matchesKey(data, "ctrl+p") ||
      kb.matches(data, "tui.select.up")
    ) {
      this.moveSelection(-1);
      return;
    }

    if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, "pageDown")) {
      this.moveSelection(this.maxVisible);
      return;
    }

    if (kb.matches(data, "tui.select.pageUp") || matchesKey(data, "pageUp")) {
      this.moveSelection(-this.maxVisible);
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
      const selected = this.getSelectedItem();
      if (selected) {
        this.onSelectCallback(selected.text);
      } else {
        this.onCancelCallback();
      }
      return;
    }

    if (
      kb.matches(data, "tui.select.cancel") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "ctrl+g")
    ) {
      this.onCancelCallback();
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      this.recomputeFilter(true);
    }
    this.tui.requestRender();
  }

  private renderBorder(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(1, width)));
  }

  private renderScopeText(): string {
    const labels: { scope: HistoryScope; label: string }[] = [
      { scope: "project", label: "Project" },
      { scope: "all", label: "All" },
      { scope: "session", label: "Session" },
    ];
    return labels
      .map(({ scope, label }) =>
        this.scope === scope
          ? this.theme.fg("accent", `◉ ${label}`)
          : this.theme.fg("muted", `○ ${label}`),
      )
      .join(this.theme.fg("muted", " | "));
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(10, width);
    const lines: string[] = [];

    // Top border
    lines.push(this.renderBorder(safeWidth));

    // Header row: title + scope + count
    const countText =
      this.filteredItems.length > 0
        ? `(${this.selectedIndex + 1}/${this.filteredItems.length})`
        : "(0/0)";
    const title = this.theme.bold(this.theme.fg("accent", "Prompt History"));
    const rightHeader = `${this.renderScopeText()}  ${this.theme.fg("muted", countText)}`;
    const rightWidth = visibleWidth(rightHeader);
    const leftAvailable = Math.max(0, safeWidth - rightWidth - 1);
    const leftTruncated = truncateToWidth(title, leftAvailable, "");
    const headerGap = Math.max(0, safeWidth - visibleWidth(leftTruncated) - rightWidth);
    lines.push(truncateToWidth(`${leftTruncated}${" ".repeat(headerGap)}${rightHeader}`, safeWidth, ""));

    // Search input row
    for (const inputLine of this.searchInput.render(safeWidth)) {
      lines.push(truncateToWidth(inputLine, safeWidth, ""));
    }

    // Matching items
    if (this.filteredItems.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("muted", "  No matching prompts"), safeWidth, ""));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.maxVisible / 2),
          this.filteredItems.length - this.maxVisible,
        ),
      );
      const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
      const now = this.nowMs();

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredItems[i];
        if (!item) continue;
        const isSelected = i === this.selectedIndex;
        const singleLine = item.text.replace(/\s*\n\s*/g, " ↵ ").trim();
        const age = formatRelativeAge(item.timestamp, now);
        const folderBadge =
          this.scope === "all" && item.cwd ? ` [${shortenCwdPath(item.cwd)}]` : "";
        const metaRaw = `${folderBadge}${age ? ` ${age}` : ""}`;
        const metaWidth = visibleWidth(metaRaw);

        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const maxPromptWidth = Math.max(4, safeWidth - 2 - metaWidth);
        const truncatedPrompt = truncateToWidth(singleLine, maxPromptWidth, "…");
        const styledPrompt = isSelected
          ? this.theme.bold(this.theme.fg("accent", truncatedPrompt))
          : truncatedPrompt;
        const gap = Math.max(0, safeWidth - 2 - visibleWidth(truncatedPrompt) - metaWidth);
        const styledMeta = metaRaw ? this.theme.fg("muted", metaRaw) : "";

        lines.push(
          truncateToWidth(`${prefix}${styledPrompt}${" ".repeat(gap)}${styledMeta}`, safeWidth, ""),
        );
      }

      // Multi-line preview when selected item has multiple lines or is long
      const selected = this.getSelectedItem();
      if (selected && (selected.text.includes("\n") || selected.text.length > safeWidth - 6)) {
        lines.push(this.theme.fg("dim", "  " + "┄".repeat(Math.max(1, safeWidth - 4))));
        const rawPreviewLines = selected.text.split("\n");
        const previewSlice = rawPreviewLines.slice(0, MAX_PREVIEW_LINES);
        for (const pLine of previewSlice) {
          lines.push(
            truncateToWidth(`  ${this.theme.fg("muted", pLine)}`, safeWidth, "…"),
          );
        }
        if (rawPreviewLines.length > MAX_PREVIEW_LINES) {
          const remaining = rawPreviewLines.length - MAX_PREVIEW_LINES;
          lines.push(
            truncateToWidth(
              this.theme.fg("dim", `  … +${remaining} more line${remaining === 1 ? "" : "s"}`),
              safeWidth,
              "",
            ),
          );
        }
      }
    }

    // Hint bar
    const hint = this.theme.fg(
      "dim",
      "  Enter insert · Ctrl+R/↓ older · Ctrl+S/↑ newer · Tab scope · Esc cancel",
    );
    lines.push(truncateToWidth(hint, safeWidth, "…"));

    // Bottom border
    lines.push(this.renderBorder(safeWidth));

    return lines;
  }
}
