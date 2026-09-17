# ChatGPT Universal Exporter

A Tampermonkey userscript workspace for exporting ChatGPT conversations to ZIP with JSON and Markdown.

Current imported version: **1.0.9-selective-retry-failed**

## Features

- Personal/team conversation export.
- Selective export: load the conversation list first, then fetch only selected conversation details.
- JSON + Markdown output.
- Retry/backoff handling and failure manifests.
- Workspace ID detection for supported team-space flows.

## Install

Install a userscript manager such as Tampermonkey, then import:

`ChatGPT_Universal_Exporter.user.js`

## Upstream attribution

This repository preserves the userscript's original metadata:

- Author: **huhu**
- License declaration: **MIT**
- Upstream metadata points to the original GreasyFork / `huhusmang/ChatGPT-Exporter` source.

This repository is a maintained copy/adaptation workspace; upstream attribution should remain intact.

## Support

If this tool saves you time and you would like to support ongoing maintenance, you can buy me a coffee ☕.

**Sponsor link: coming soon.**

See [SPONSORING.md](SPONSORING.md).

## Notes

The imported userscript currently retains its upstream `@downloadURL` and `@updateURL` metadata.
If this repository later becomes the canonical distribution point, those metadata fields should be
reviewed before publishing a GitHub-hosted install link.
