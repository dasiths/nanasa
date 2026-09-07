# Reference files

Integration authors and advanced users can use these generated and
human-readable references after completing the task guides.

## Human-readable reference

* [CLI commands and output](cli.md)
* [Configuration fields and limits](configuration.md)
* [HTTP, events, terminal, and MCP protocols](protocols.md)

## Generated JSON

These files are generated from product declarations and stay in this directory:

* [CLI command registry](cli.json) for command IDs, families, arguments, and modes
* [OpenAPI registry](openapi.json) for HTTP routes and schemas
* [Event protocol](events.json) for durable event frames
* [Terminal protocol](terminal.json) for terminal frames and limits
* [MCP tools](mcp-tools.json) for agent coordination tools
* [Capabilities](capabilities.json) for product capabilities
* [Errors and limits](errors-limits.json) for machine-readable failures and bounds
* [Portal help](portal-help.json) for in-product help content
* [Reference package metadata](package.json) for generated set identity
* [Configuration schema](config.schema.json) for authored YAML fields and limits

The configuration schema checks the authored data shape. Run
`npx nanasa setup` or `npx nanasa doctor` for checks that need repository files,
directory ownership, or resolved cross-references.
