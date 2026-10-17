import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectHistory,
  deduplicateHistory,
  extractPromptFromEntry,
  filterHistory,
  formatRelativeAge,
  type HistoryItem,
  shortenCwdPath,
} from "../src/history.ts";

describe("extractPromptFromEntry", () => {
  it("extracts plain string user messages and ISO timestamps", () => {
    const entry = {
      type: "message",
      timestamp: "2026-10-17T10:00:00.000Z",
      message: {
        role: "user",
        content: "  explain how CustomEditor works  ",
      },
    };
    expect(extractPromptFromEntry(entry)).toEqual({
      text: "explain how CustomEditor works",
      timestamp: Date.parse("2026-10-17T10:00:00.000Z"),
    });
  });

  it("extracts multi-part text content from user messages", () => {
    const entry = {
      type: "message",
      timestamp: "2026-10-17T10:01:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "first line\nsecond line" },
          { type: "image", data: "abc" },
        ],
        timestamp: 1792231260000,
      },
    };
    expect(extractPromptFromEntry(entry)).toEqual({
      text: "first line\nsecond line",
      timestamp: 1792231260000,
    });
  });

  it("reconstructs /skill:<name> invocations instead of expanded XML skill blocks", () => {
    const skillText = [
      '<skill name="commit" location="/Users/me/.agents/skills/commit/SKILL.md">',
      "References are relative to /Users/me/.agents/skills/commit.",
      "",
      "Commit instructions body...",
      "</skill>",
      "",
      "group by package",
    ].join("\n");
    const entry = {
      type: "message",
      timestamp: "2026-10-17T10:02:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: skillText }],
      },
    };
    expect(extractPromptFromEntry(entry)).toEqual({
      text: "/skill:commit group by package",
      timestamp: Date.parse("2026-10-17T10:02:00.000Z"),
    });
  });

  it("extracts ! and !! bashExecution entries", () => {
    const bangEntry = {
      type: "message",
      timestamp: "2026-10-17T10:03:00.000Z",
      message: {
        role: "bashExecution",
        command: "git status",
        excludeFromContext: false,
        timestamp: 1000,
      },
    };
    const doubleBangEntry = {
      type: "message",
      timestamp: "2026-10-17T10:04:00.000Z",
      message: {
        role: "bashExecution",
        command: "ls -la",
        excludeFromContext: true,
        timestamp: 2000,
      },
    };
    expect(extractPromptFromEntry(bangEntry)).toEqual({
      text: "!git status",
      timestamp: 1000,
    });
    expect(extractPromptFromEntry(doubleBangEntry)).toEqual({
      text: "!!ls -la",
      timestamp: 2000,
    });
  });

  it("returns null for non-user entries, empty prompts, or malformed data", () => {
    expect(extractPromptFromEntry(null)).toBeNull();
    expect(extractPromptFromEntry({ type: "model_change" })).toBeNull();
    expect(
      extractPromptFromEntry({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ).toBeNull();
    expect(
      extractPromptFromEntry({
        type: "message",
        message: { role: "user", content: "   \n  " },
      }),
    ).toBeNull();
  });
});

describe("deduplicateHistory", () => {
  it("orders newest first, deduplicates by prompt text, and merges session/project flags", () => {
    const items: HistoryItem[] = [
      {
        text: "run make test",
        timestamp: 100,
        cwd: "/Users/me/code/proj-a",
        sessionId: "s1",
        isCurrentSession: true,
        isCurrentProject: true,
      },
      {
        text: "check git diff",
        timestamp: 300,
        cwd: "/Users/me/code/proj-a",
        sessionId: "s1",
        isCurrentSession: true,
        isCurrentProject: true,
      },
      {
        text: "run make test",
        timestamp: 200,
        cwd: "/Users/me/code/proj-b",
        sessionId: "s2",
        isCurrentSession: false,
        isCurrentProject: false,
      },
    ];

    const deduped = deduplicateHistory(items);
    expect(deduped).toEqual([
      {
        text: "check git diff",
        timestamp: 300,
        cwd: "/Users/me/code/proj-a",
        sessionId: "s1",
        isCurrentSession: true,
        isCurrentProject: true,
      },
      {
        text: "run make test",
        timestamp: 200,
        cwd: "/Users/me/code/proj-b",
        sessionId: "s2",
        isCurrentSession: true,
        isCurrentProject: true,
      },
    ]);
  });
});

describe("filterHistory", () => {
  const sampleItems: HistoryItem[] = [
    {
      text: "deploy to staging cluster",
      timestamp: 300,
      cwd: "/Users/me/code/app",
      sessionId: "s-current",
      isCurrentSession: true,
      isCurrentProject: true,
    },
    {
      text: "fix flaky unit test in router",
      timestamp: 200,
      cwd: "/Users/me/code/app",
      sessionId: "s-older",
      isCurrentSession: false,
      isCurrentProject: true,
    },
    {
      text: "update terraform provider version",
      timestamp: 100,
      cwd: "/Users/me/code/infra",
      sessionId: "s-other",
      isCurrentSession: false,
      isCurrentProject: false,
    },
  ];

  it("filters by scope (session, project, all)", () => {
    expect(filterHistory(sampleItems, "", "session").map((i) => i.text)).toEqual([
      "deploy to staging cluster",
    ]);
    expect(filterHistory(sampleItems, "", "project").map((i) => i.text)).toEqual([
      "deploy to staging cluster",
      "fix flaky unit test in router",
    ]);
    expect(filterHistory(sampleItems, "", "all").map((i) => i.text)).toEqual([
      "deploy to staging cluster",
      "fix flaky unit test in router",
      "update terraform provider version",
    ]);
  });

  it("prioritizes exact substring matches followed by fuzzy matches", () => {
    const matches = filterHistory(sampleItems, "router", "all");
    expect(matches.map((i) => i.text)).toEqual(["fix flaky unit test in router"]);

    const fuzzy = filterHistory(sampleItems, "tf provider", "all");
    expect(fuzzy.map((i) => i.text)).toEqual(["update terraform provider version"]);
  });
});

describe("collectHistory", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("combines current session entries, runtime inputs, and JSONL files across projects", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-prompt-history-test-"));
    tempDirs.push(root);

    const projADir = join(root, "--Users-me-code-proj-a--");
    const projBDir = join(root, "--Users-me-code-proj-b--");
    mkdirSync(projADir, { recursive: true });
    mkdirSync(projBDir, { recursive: true });

    const fileA = join(projADir, "session-a.jsonl");
    writeFileSync(
      fileA,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-a",
          timestamp: "2026-10-17T08:00:00.000Z",
          cwd: "/Users/me/code/proj-a",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-10-17T08:01:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "prompt from disk proj-a" }] },
        }),
      ].join("\n") + "\n",
    );

    const fileB = join(projBDir, "session-b.jsonl");
    writeFileSync(
      fileB,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-b",
          timestamp: "2026-10-17T09:00:00.000Z",
          cwd: "/Users/me/code/proj-b",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-10-17T09:01:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "prompt from disk proj-b" }] },
        }),
      ].join("\n") + "\n",
    );

    utimesSync(fileA, new Date("2026-10-17T08:01:00.000Z"), new Date("2026-10-17T08:01:00.000Z"));
    utimesSync(fileB, new Date("2026-10-17T09:01:00.000Z"), new Date("2026-10-17T09:01:00.000Z"));

    const history = collectHistory({
      currentEntries: [
        {
          type: "message",
          timestamp: "2026-10-17T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "prompt in active session" }] },
        },
      ],
      currentSessionId: "sess-active",
      currentCwd: "/Users/me/code/proj-a",
      sessionsRootDir: root,
      runtimeEntries: [
        {
          text: "latest runtime prompt",
          timestamp: Date.parse("2026-10-17T10:05:00.000Z"),
          cwd: "/Users/me/code/proj-a",
          sessionId: "sess-active",
        },
      ],
    });

    expect(history.map((h) => h.text)).toEqual([
      "latest runtime prompt",
      "prompt in active session",
      "prompt from disk proj-b",
      "prompt from disk proj-a",
    ]);
    expect(history[0]?.isCurrentSession).toBe(true);
    expect(history[0]?.isCurrentProject).toBe(true);
    expect(history[2]?.isCurrentSession).toBe(false);
    expect(history[2]?.isCurrentProject).toBe(false);
    expect(history[3]?.isCurrentSession).toBe(false);
    expect(history[3]?.isCurrentProject).toBe(true);
  });
});

describe("formatting helpers", () => {
  it("formats relative ages concisely", () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeAge(now - 10_000, now)).toBe("now");
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatRelativeAge(now - 4 * 86_400_000, now)).toBe("4d");
  });

  it("shortens home directory prefixes", () => {
    expect(shortenCwdPath("/Users/me/code/pi-prompt-history", "/Users/me")).toBe(
      "~/code/pi-prompt-history",
    );
    expect(shortenCwdPath("/opt/work", "/Users/me")).toBe("/opt/work");
  });
});
