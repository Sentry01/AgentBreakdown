# Contributing to AgentBreakdown

Thanks for your interest in improving AgentBreakdown! Contributions, bug reports, and ideas are all welcome.

## Reporting bugs & requesting features

- **🐞 Bug?** [Open a bug report](https://github.com/Sentry01/AgentBreakdown/issues/new?template=bug_report.yml)
- **💡 Idea / feature?** [Open a feature request](https://github.com/Sentry01/AgentBreakdown/issues/new?template=feature_request.yml)
- **❓ Question / discussion?** Use [Discussions](https://github.com/Sentry01/AgentBreakdown/discussions)

Browse existing issues first: <https://github.com/Sentry01/AgentBreakdown/issues>

When filing a bug, please include your Copilot CLI version, Node.js version, OS, and any relevant lines from
`~/.copilot/logs/extensions/user-subagent-token-usage-*.log`.

## Development setup

```bash
git clone https://github.com/Sentry01/AgentBreakdown.git
cd AgentBreakdown
npm install
```

Symlink (or copy) the folder into your extensions directory so Copilot CLI picks it up:

```bash
ln -s "$PWD" ~/.copilot/extensions/AgentBreakdown
```

In a Copilot CLI session, reload after edits:

```
/extensions reload
```

### Project layout

| Path | Purpose |
| --- | --- |
| `extension.mjs` | Bootstrapper (installs deps, loads `main.mjs`) |
| `main.mjs` | Event tracking, tools, CLI summary panel, webview wiring |
| `content/index.html` | Live dashboard (polls `usage.json`) |
| `content/style.css` | Dashboard styling |
| `lib/` | `copilot-webview` helper (native window + bridge) |

### Sanity checks before a PR

```bash
node --check extension.mjs
node --check main.mjs
```

## Pull requests

`main` is protected: changes land via pull request (linear history, no force-pushes, conversations resolved).

1. Create a branch: `git checkout -b feature/short-description`
2. Make your change and run the sanity checks above.
3. Open a PR against `main` with a clear description and, where relevant, a screenshot of the window.

## Code of conduct

Be respectful and constructive. By participating you agree to keep interactions welcoming and harassment-free.

## License

By contributing you agree your contributions are licensed under the project's [MIT License](./LICENSE).
