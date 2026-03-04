'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const PORT = 7634;

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

const runs = new Map();       // runId → { id, events[], status, theme }
const sseClients = new Map(); // runId → Set<Response>

// ─────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────

function emit(runId, run, event) {
  run.events.push(event);
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients.get(runId) ?? []) {
    try { res.write(data); } catch {}
  }
}

app.get('/api/stream/:runId', (req, res) => {
  const { runId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);

  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  sseClients.get(runId).add(res);

  // Replay past events for reconnecting clients
  for (const evt of runs.get(runId)?.events ?? []) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  req.on('close', () => {
    clearInterval(ka);
    sseClients.get(runId)?.delete(res);
  });
});

// ─────────────────────────────────────────────────────────────
// OpenRouter streaming
// ─────────────────────────────────────────────────────────────

async function streamChat(apiKey, model, messages, onToken) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': `http://localhost:${PORT}`,
      'X-Title': 'Puzzle Forge',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return full;
      try {
        const tok = JSON.parse(raw)?.choices?.[0]?.delta?.content ?? '';
        if (tok) { full += tok; onToken(tok); }
      } catch {}
    }
  }
  return full;
}

// ─────────────────────────────────────────────────────────────
// Agent runner
// ─────────────────────────────────────────────────────────────

async function runAgent(runId, run, apiKey, id, name, role, model, messages, phase, round) {
  emit(runId, run, { type: 'agent_start', agentId: id, agentName: name, agentRole: role, model, phase, round });
  let content;
  try {
    content = await streamChat(apiKey, model, messages, tok => {
      emit(runId, run, { type: 'token', agentId: id, text: tok, round });
    });
  } catch (err) {
    emit(runId, run, { type: 'agent_error', agentId: id, error: err.message, round });
    throw err;
  }
  emit(runId, run, { type: 'agent_end', agentId: id, content, round });
  return content;
}

// ─────────────────────────────────────────────────────────────
// System prompts
// ─────────────────────────────────────────────────────────────

const ARCHITECT_SYSTEM = `You are a master D&D puzzle architect with two decades of tabletop RPG design experience. You design puzzles that are:
• Logically rigorous: the solution follows directly and unambiguously from the clues alone
• Player-solvable: a table of 4 players can solve it in 15–30 minutes without special knowledge
• Dramatically satisfying: there is a clear "aha moment" when the answer clicks
• Fair but challenging: no arbitrary gotchas, but not trivially guessable

Format your puzzle EXACTLY as follows (use these exact headers):

## THE SCENE
[2–3 vivid paragraphs describing the physical environment, what players see, smell, hear]

## OBSERVABLE CLUES
[Numbered list of 4–6 specific things players can observe, touch, or examine. Be precise.]

## THE MECHANISM
[DM-ONLY: The precise logical chain connecting clues to solution, step by step]

## THE SOLUTION
[One clear, unambiguous answer or action]

## RED HERRINGS
[2–3 things that seem meaningful but aren't—explain why each misleads and why it's fair]

## DM NOTES
[How to run this at the table: pacing, what to reveal on request, atmosphere tips]`;

const CRITIC_SYSTEM = `You are a ruthless logic critic for tabletop RPG puzzles. Your sole job is finding flaws. Do NOT praise anything. Be specific and cite exact clue numbers.

Evaluate:
1. LOGIC GAPS — Does the solution actually follow from the listed clues, step by step? Trace it.
2. AMBIGUITY — Can clues be interpreted to reach wrong-but-plausible answers?
3. MISSING INFORMATION — What do players need to know that isn't explicitly given?
4. FAIRNESS — Are red herrings distinguishable from real clues? Is this fun or frustrating?
5. VERDICT — Rate: SOLID / FLAWED / BROKEN, with one-line justification`;

const DEVIL_SYSTEM = `You are an adversarial puzzle breaker. Find every way this D&D puzzle can FAIL or be circumvented. Think like someone trying to min-max around it.

Report:
1. TRIVIAL SOLUTIONS — Can this be solved by random guessing, pattern-matching, or lucky rolls?
2. BYPASS METHODS — List specific D&D spells/abilities/skills that short-circuit this puzzle (Detect Magic, Knock, Guidance, Comprehend Languages, etc.)
3. ACCIDENTAL WINS — Ways players could trigger the solution without understanding it
4. BRUTE FORCE — If players try every permutation, does the puzzle collapse?
5. LOGIC COLLAPSE — Trace through 3 unexpected player actions: "What if they do X?" — does the puzzle break?`;

function playtesterSystem(persona) {
  const personas = {
    thorough: "You are a careful, methodical player. You read every clue twice, form a theory before acting, and won't guess until you have solid reasoning.",
    aggressive: "You are an impatient player who immediately looks for shortcuts. You want to roll Perception, cast Detect Magic, or physically break things. You're bored by careful puzzle-solving.",
    lateral: "You think unconventionally. You look for solutions the designer didn't intend. You ask unusual questions and try unexpected approaches.",
    literal: "You interpret everything with extreme literalness. Figurative language confuses you. You take descriptions at face value and miss subtext.",
  };
  return `You are a D&D player at the table. ${personas[persona] ?? personas.thorough}

Think out loud as you work through the puzzle. Record:
- What you notice first and why
- The theory you form and how you test it
- Exactly what you try, in order
- Whether you solve it and how satisfying that felt
- Where you got confused, frustrated, or wanted to give up`;
}

const SYNTH_SYSTEM = `You are the final synthesis stage in a puzzle refinement pipeline. You have a draft puzzle and critique from multiple sources. Your job: produce the BEST POSSIBLE version by surgically fixing critical issues while preserving what works. Do NOT rewrite from scratch unless the puzzle is fundamentally broken.

Output format:

## SYNTHESIS NOTES
[4–6 bullet points: what you changed, what you kept, and why]

[Then the COMPLETE revised puzzle using the standard Architect format with all sections]`;

// ─────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────

function makeArchitectMsg(theme) {
  const user = theme
    ? `Create a D&D puzzle for this setting/theme: "${theme}"\n\nBe inventive. Avoid pressure plates, combination locks, and riddle doors unless you make them genuinely novel.`
    : `Create an original, inventive D&D puzzle. Avoid overused tropes (pressure plates, riddle doors, obvious number combinations). Consider puzzles involving: astronomy, linguistics, music, alchemy, historical events in your world, natural phenomena, social/interpersonal mechanics, or ecological observations.`;
  return [{ role: 'system', content: ARCHITECT_SYSTEM }, { role: 'user', content: user }];
}

function makeArchitectReviseMsg(puzzle, critiques, theme) {
  const block = critiques.map(c => `### ${c.name} (${c.role})\n${c.content}`).join('\n\n---\n\n');
  return [
    { role: 'system', content: ARCHITECT_SYSTEM + '\n\nYou are revising an existing puzzle based on critique. Fix what is broken. Keep what works. Do not restart from scratch.' },
    { role: 'user', content: `CURRENT PUZZLE:\n\n${puzzle}\n\n---\n\nCRITIQUE RECEIVED:\n\n${block}\n\n---\n\nProduce an improved version addressing the most critical issues. Briefly note your changes at the top.` },
  ];
}

function makeCriticMsg(puzzle) {
  return [{ role: 'system', content: CRITIC_SYSTEM }, { role: 'user', content: `Analyze this D&D puzzle:\n\n${puzzle}` }];
}

function makeDevilMsg(puzzle) {
  return [{ role: 'system', content: DEVIL_SYSTEM }, { role: 'user', content: `Break this puzzle:\n\n${puzzle}` }];
}

function makePlaytesterMsg(puzzle, persona) {
  return [{ role: 'system', content: playtesterSystem(persona) }, { role: 'user', content: `The DM presents this puzzle to your party:\n\n${puzzle}` }];
}

function makeSynthMsg(puzzle, critiques) {
  const block = critiques.map(c => `### ${c.name} (${c.role})\n${c.content}`).join('\n\n---\n\n');
  return [
    { role: 'system', content: SYNTH_SYSTEM },
    { role: 'user', content: `CURRENT PUZZLE:\n\n${puzzle}\n\n---\n\nALL CRITIQUE:\n\n${block}` },
  ];
}

// ─────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────

async function forge(runId, apiKey, config, theme) {
  const run = runs.get(runId);
  const { architectModel, critics = [], playtesters = [], synthModel, rounds = 2 } = config;
  const devilModel = critics[0]?.model ?? architectModel;

  emit(runId, run, { type: 'forge_start', rounds, theme });

  let puzzle = null;
  let allCritiques = [];

  for (let r = 1; r <= rounds; r++) {
    // ── DESIGN ──────────────────────────────────────────────
    emit(runId, run, { type: 'phase_start', phase: 'design', round: r });
    const archMsgs = r === 1
      ? makeArchitectMsg(theme)
      : makeArchitectReviseMsg(puzzle, allCritiques, theme);

    puzzle = await runAgent(runId, run, apiKey,
      'architect', 'The Architect', 'Puzzle Designer',
      architectModel, archMsgs, 'design', r);

    // ── CRITIQUE ─────────────────────────────────────────────
    emit(runId, run, { type: 'phase_start', phase: 'critique', round: r });
    allCritiques = [];
    const jobs = [];

    critics.forEach((c, i) => {
      jobs.push(
        runAgent(runId, run, apiKey,
          `critic_${i}`, c.name || `Logician ${i + 1}`, 'Logic Critic',
          c.model, makeCriticMsg(puzzle), 'critique', r)
          .then(content => allCritiques.push({ role: 'logician', name: c.name || `Logician ${i + 1}`, content }))
          .catch(err => allCritiques.push({ role: 'logician', name: c.name || `Logician ${i + 1}`, content: `[Error: ${err.message}]` }))
      );
    });

    playtesters.forEach((pt, i) => {
      jobs.push(
        runAgent(runId, run, apiKey,
          `playtester_${i}`, pt.name || `Player ${i + 1}`, 'Playtester',
          pt.model, makePlaytesterMsg(puzzle, pt.persona || 'thorough'), 'critique', r)
          .then(content => allCritiques.push({ role: 'playtester', name: pt.name || `Player ${i + 1}`, content }))
          .catch(err => allCritiques.push({ role: 'playtester', name: pt.name || `Player ${i + 1}`, content: `[Error: ${err.message}]` }))
      );
    });

    jobs.push(
      runAgent(runId, run, apiKey,
        'devil', "Devil's Advocate", 'Puzzle Breaker',
        devilModel, makeDevilMsg(puzzle), 'critique', r)
        .then(content => allCritiques.push({ role: 'devil', name: "Devil's Advocate", content }))
        .catch(err => allCritiques.push({ role: 'devil', name: "Devil's Advocate", content: `[Error: ${err.message}]` }))
    );

    await Promise.all(jobs);

    // ── SYNTHESIS ────────────────────────────────────────────
    emit(runId, run, { type: 'phase_start', phase: 'synthesis', round: r });
    puzzle = await runAgent(runId, run, apiKey,
      `synth_${r}`, 'The Synthesizer', 'Puzzle Refiner',
      synthModel, makeSynthMsg(puzzle, allCritiques), 'synthesis', r);
  }

  emit(runId, run, { type: 'forge_complete', finalPuzzle: puzzle });
  run.status = 'complete';
}

// ─────────────────────────────────────────────────────────────
// API routes
// ─────────────────────────────────────────────────────────────

app.post('/api/forge', (req, res) => {
  const { apiKey, config, theme } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  const runId = crypto.randomUUID();
  runs.set(runId, { id: runId, events: [], status: 'running', config, theme });
  res.json({ runId });

  forge(runId, apiKey, config, theme).catch(err => {
    const run = runs.get(runId);
    if (run) {
      emit(runId, run, { type: 'error', message: err.message });
      run.status = 'error';
    }
    console.error('Forge pipeline error:', err);
  });
});

app.get('/api/runs', (req, res) => {
  const list = [...runs.values()].map(r => ({
    id: r.id, status: r.status, theme: r.theme,
    eventCount: r.events.length,
  }));
  res.json(list.reverse());
});

app.listen(PORT, () => {
  console.log(`🔥 Puzzle Forge → http://localhost:${PORT}`);
});
