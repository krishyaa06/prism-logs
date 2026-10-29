# Contributing to prism-logs

Thanks for taking the time to contribute! prism-logs is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism Logs is a log aggregation and query engine: format auto-detection (JSON, logfmt, nginx/apache combined, syslog), level and timestamp normalisation, ingest-time redaction of emails, cards (Luhn-checked), tokens, JWTs, passwords and IPs, a label-indexed chunk store with per-chunk trigram bloom filters, retention and cardinality guards, and a LogQL-compatible query engine with line filters, json/logfmt/pattern/regexp parsers, label filters, line_format, range functions, vector aggregations, topk and binary operators.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-logs.git
cd prism-logs
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-logs/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
