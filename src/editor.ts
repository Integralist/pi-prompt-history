import {
  CustomEditor,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey } from "@earendil-works/pi-tui";

export type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;

const WRAPPED_EDITOR_FACTORY = Symbol.for("pi-prompt-history.wrappedEditorFactory");
const WRAPPED_EDITOR_INSTANCE = Symbol.for("pi-prompt-history.wrappedEditorInstance");

type MarkedFactory = EditorFactory & {
  [WRAPPED_EDITOR_FACTORY]?: boolean;
};

interface MarkedEditor extends EditorComponent {
  [WRAPPED_EDITOR_INSTANCE]?: boolean;
  isShowingAutocomplete?: () => boolean;
}

function attachCtrlRHandler(editor: MarkedEditor, onTrigger: () => void): MarkedEditor {
  if (editor[WRAPPED_EDITOR_INSTANCE]) {
    return editor;
  }
  const origHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, "ctrl+r") && !editor.isShowingAutocomplete?.()) {
      onTrigger();
      return;
    }
    origHandleInput(data);
  };
  editor[WRAPPED_EDITOR_INSTANCE] = true;
  return editor;
}

function createWrappedEditorFactory(
  baseFactory: EditorFactory | undefined,
  onTrigger: () => void,
): MarkedFactory {
  const factory: MarkedFactory = (tui, theme, keybindings) => {
    const baseEditor = baseFactory
      ? baseFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings);
    return attachCtrlRHandler(baseEditor as MarkedEditor, onTrigger);
  };
  factory[WRAPPED_EDITOR_FACTORY] = true;
  return factory;
}

export function installPromptHistoryEditor(
  ctx: ExtensionContext,
  onTrigger: () => void,
): void {
  if (!ctx.hasUI || typeof ctx.ui?.setEditorComponent !== "function") {
    return;
  }

  const wrapCurrentIfNeeded = (): void => {
    const currentFactory =
      typeof ctx.ui.getEditorComponent === "function"
        ? (ctx.ui.getEditorComponent() as MarkedFactory | undefined)
        : undefined;
    if (currentFactory?.[WRAPPED_EDITOR_FACTORY]) {
      return;
    }
    const wrapped = createWrappedEditorFactory(currentFactory, onTrigger);
    ctx.ui.setEditorComponent(wrapped);
  };

  wrapCurrentIfNeeded();

  // If another extension registered after us replaces setEditorComponent synchronously
  // during session_start without chaining getEditorComponent(), re-wrap it on microtask.
  queueMicrotask(() => {
    wrapCurrentIfNeeded();
  });
}
