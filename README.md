# Puzzle Forge

**Multi-model AI harness for creating robust D&D puzzles.** Watch AI agents design, critique, playtest, and iterate in real-time.

Live at: [puzzle-forge.vercel.app](https://puzzle-forge.vercel.app)

---

## The Problem

D&D puzzle creation is an unsolved benchmark for AI. Models tend to:
- Design *scenarios* that aren't actually *puzzles*
- Commit to a path and back-justify choices
- Make puzzles that are either trivially obvious or logically broken

Puzzle Forge attacks this with a multi-model critique pipeline and forced iteration.

## How It Works

```
Round N:
  ⚒ Architect      → Designs / iterates the puzzle
  ⚖ Critics        → Hunt for logic gaps and ambiguities (parallel)
  🎲 Playtesters   → Solve it as real players would (parallel)
  🐍 Devil's Adv.  → Find bypasses, trivial solutions, collapses (parallel)
  ✦ Synthesizer    → Integrates all critique, outputs refined puzzle
```

Repeat for 1–3 rounds. Each round, the puzzle gets harder to break.

## Features

- **Any model for any role** — use OpenRouter's full catalog
- **Dynamic model list** — fetches live from OpenRouter API
- **Live streaming** — watch every agent think in real-time
- **Parallel critique** — critics, playtesters, and devil's advocate run simultaneously
- **Abort anytime** — quench the forge mid-run
- **Keyboard shortcut** — `Cmd/Ctrl+Enter` to start, `Escape` to abort
- **Your key, your data** — API key stays in your browser, never hits our servers

## Usage

1. Get an [OpenRouter API key](https://openrouter.ai)
2. Visit [puzzle-forge.vercel.app](https://puzzle-forge.vercel.app)
3. Enter your key and click **Fetch Models** to load the live model list
4. Configure models for each role (or keep the defaults)
5. Set an optional puzzle theme/seed
6. Click **Ignite the Forge**

### Default Configuration

| Role | Default Model |
|------|--------------|
| Architect | `anthropic/claude-sonnet-4-6` |
| Synthesizer | `anthropic/claude-sonnet-4-6` |
| Critic | `anthropic/claude-sonnet-4-6` |
| Playtester | `meta-llama/llama-3.3-70b-instruct` |
| Devil's Advocate | First critic's model |

### Playtester Personas

- **Thorough** — methodical, forms theory before acting
- **Aggressive** — impatient, tries shortcuts and magic
- **Lateral** — unconventional, finds unintended solutions
- **Literal** — takes everything at face value, misses subtext

## Self-Hosting

For local use (API key stays server-side in env):

```bash
git clone https://github.com/adamholtergmailcom/puzzle-forge
cd puzzle-forge
npm install
OPENROUTER_API_KEY=sk-or-... node server.cjs
```

Open [http://localhost:7634](http://localhost:7634)

## Security

- API key is stored only in `localStorage` and sent directly to OpenRouter
- All LLM output is sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) before rendering
- CSP restricts all network connections to `openrouter.ai` only
- Model IDs are validated against an allowlist pattern before use
- No analytics, no tracking, no server-side storage

## License

MIT — see [LICENSE](LICENSE)
