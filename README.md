# Nanasa (නැනස)

Nanasa is a multi agent orchestrator capable of orchestrating multiple coding agents like GitHub Copilot, Claude Code, Codex and Pi to achieve long horizon tasks.

> The name *nanasa* (නැනස) means "wisdom" or "intellect" in Sinhala.

## Why Nanasa?

Individual coding agents are good at short, well scoped tasks. They tend to lose track on long horizon work that spans many files, many steps and many hours. Nanasa sits above the agents and provides the missing layer:

- **Orchestration** – break a large goal into tasks and hand each one to the agent best suited for it.
- **Multi agent** – use GitHub Copilot, Claude Code, Codex and Pi side by side instead of committing to a single vendor.
- **Long horizon** – keep shared context, progress and state across the whole run, not just a single prompt.
- **Observability** – see what each agent was asked to do, what it produced and why.

## Status

Nanasa is in early development. The interfaces, configuration format and CLI described here are still taking shape and may change without notice. Contributions and ideas are very welcome.

## Concepts

| Concept | Description |
| --- | --- |
| **Task** | A unit of work with a goal, inputs and a definition of done. |
| **Agent** | An adapter around a coding agent such as GitHub Copilot, Claude Code, Codex or Pi. |
| **Orchestrator** | Plans tasks, selects agents, dispatches work and evaluates results. |
| **Run** | A single end to end execution of a goal, made up of many tasks across many agents. |

## Getting started

Nanasa is not yet published as a package. To follow along with development:

```bash
git clone https://github.com/dasiths/nanasa.git
cd nanasa
```

Setup, build and usage instructions will be added here as the implementation lands.

## Roadmap

- [ ] Core orchestrator and task graph
- [ ] Agent adapters for GitHub Copilot, Claude Code, Codex and Pi
- [ ] Shared context and memory across tasks
- [ ] Run history and observability
- [ ] CLI

## Contributing

Issues and pull requests are welcome. Since the project is still early, please open an issue to discuss larger changes before starting work on them.

## License

See [LICENSE](LICENSE) if present in this repository. A license will be added before the first release.
