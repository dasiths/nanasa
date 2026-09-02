import type { Terminal } from "@xterm/xterm";

export type ClipboardOutcome = { ok: true } | { ok: false; message: string };

export function selectionModifier(platform = navigator.platform): "Option" | "Shift" {
  return /Mac|iPhone|iPad/.test(platform) ? "Option" : "Shift";
}

export async function writeClipboardText(value: string): Promise<ClipboardOutcome> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    }
  } catch {
    // Fall back to a temporary selection within the same trusted user action.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    return document.execCommand?.("copy") === true
      ? { ok: true }
      : { ok: false, message: "Use your browser or operating system Copy command." };
  } catch {
    return { ok: false, message: "Use your browser or operating system Copy command." };
  } finally {
    textarea.remove();
  }
}

export async function copyTerminalSelection(terminal: Terminal): Promise<ClipboardOutcome> {
  const text = terminal.getSelection();
  if (text.length === 0) return { ok: false, message: "Select terminal text before copying." };
  return writeClipboardText(text);
}

export async function readClipboardText(): Promise<string | { ok: false; message: string }> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return { ok: false, message: "Use your browser or operating system Paste command." };
  }
}

export function installCopyOnSelect(
  element: HTMLElement,
  terminal: Terminal,
  copy: () => void,
): () => void {
  let selecting = false;
  const onMouseDown = (event: MouseEvent) => {
    selecting = event.button === 0;
  };
  const onMouseUp = () => {
    if (!selecting) return;
    selecting = false;
    if (terminal.hasSelection()) copy();
  };
  element.addEventListener("mousedown", onMouseDown);
  element.ownerDocument.addEventListener("mouseup", onMouseUp);
  return () => {
    element.removeEventListener("mousedown", onMouseDown);
    element.ownerDocument.removeEventListener("mouseup", onMouseUp);
  };
}

export function installTrustedClipboardEvents(
  element: HTMLElement,
  terminal: Terminal,
  paste: (text: string) => void,
): () => void {
  const copy = (event: ClipboardEvent) => {
    if (!event.isTrusted || !terminal.hasSelection() || event.clipboardData === null) return;
    event.clipboardData.setData("text/plain", terminal.getSelection());
    event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!event.isTrusted || text === undefined || text.length === 0) return;
    event.preventDefault();
    paste(text);
  };
  element.addEventListener("copy", copy);
  element.addEventListener("paste", onPaste);
  return () => {
    element.removeEventListener("copy", copy);
    element.removeEventListener("paste", onPaste);
  };
}
