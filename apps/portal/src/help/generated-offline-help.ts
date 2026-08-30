import type { PortalCommand } from "../shell/command-palette.js";

export interface OfflineHelpSection {
  title: string;
  items: Array<{ term: string; description: string }>;
}

export function generatedOfflineHelp(commands: PortalCommand[]): OfflineHelpSection[] {
  return [
    {
      title: "Keyboard",
      items: [
        {
          term: "Ctrl+K / Cmd+K",
          description: "Open the command palette outside forms and terminals.",
        },
        ...commands
          .filter((command) => command.shortcut !== undefined)
          .map((command) => ({ term: command.shortcut!, description: command.label })),
      ],
    },
    {
      title: "Terminal access",
      items: [
        {
          term: "Selection",
          description: "Hold Shift and drag on Linux or Windows; hold Option and drag on macOS.",
        },
        {
          term: "Controller",
          description:
            "One controller sends input. Observers can select and copy without changing the PTY.",
        },
        {
          term: "Transcript",
          description:
            "Use the terminal toolbar for bounded accessible history and retained checkpoints.",
        },
      ],
    },
    {
      title: "Workflow semantics",
      items: [
        {
          term: "Delivery",
          description: "A message reaching a terminal is transport progress, not work completion.",
        },
        {
          term: "Unread",
          description:
            "Unread state belongs to this browser and is not proof that an agent read a message.",
        },
        {
          term: "Action",
          description:
            "Prompt actions track submission, acceptance, work, waits, and correlated completion.",
        },
        {
          term: "Completion",
          description:
            "Completed work remains attention-worthy until an operator acknowledges its revision.",
        },
      ],
    },
  ];
}
