// public/game/InterviewPanel.ts
// DOM overlay for interviewing agents. No Phaser dependency.
// Listens for 'teamville:openInterview' custom event dispatched by VillageScene._openInterview().

import { buildMemoryCard, animateBars, type MemoryEntry } from './MemoryCard.js';

/** Raw cosine threshold (mirrors src/memory/retrieve.ts RELEVANCE_THRESHOLD) */
const RELEVANCE_THRESHOLD = 0.25;

/** Typewriter character delay in ms */
const TYPEWRITER_DELAY = 18;

/** People metadata for header display. Mirrors frozen contract person IDs. */
const PEOPLE_META: Record<string, { name: string; role: string; sprite: number }> = {
  priya: { name: 'Priya', role: 'PM — Atlas launch owner',  sprite: 0 },
  dana:  { name: 'Dana',  role: 'Senior Backend Engineer',   sprite: 1 },
  tom:   { name: 'Tom',   role: 'Junior Frontend Engineer',  sprite: 2 },
  marco: { name: 'Marco', role: 'Designer',                  sprite: 3 },
  sara:  { name: 'Sara',  role: 'Data Engineer',             sprite: 4 },
  ben:   { name: 'Ben',   role: 'Engineering Manager',       sprite: 5 },
};

/* ── API response shape ── */

interface Citation {
  n: number;
  memoryId: number;
  text: string;
  simTime: number;
  sourceRef: string | null;
}

interface Verdict {
  pass: boolean;
  reason: string;
}

interface InterviewResponse {
  status: 'answered' | 'declined' | 'blocked';
  answer: string | null;
  citations: Citation[];
  memoryTrace: MemoryEntry[];
  verdict: Verdict | null;
}

interface MemoryTabEntry {
  id: number;
  kind: string;
  text: string;
  simTime: number;
  sourceRef: string | null;
  evidenceIds: number[] | null;
  importance: number;
}

/**
 * Mount the interview panel onto the existing #interview-overlay DOM.
 * Must be called once after the DOM is ready (e.g. end of main.ts).
 * Registers a 'teamville:openInterview' window event listener.
 */
export function mount(): void {
  const overlay       = document.getElementById('interview-overlay')!;
  const closeBtn      = document.getElementById('iv-close')!;
  const askBtn        = document.getElementById('iv-ask') as HTMLButtonElement;
  const questionEl    = document.getElementById('iv-question') as HTMLTextAreaElement;
  const tabs          = document.querySelectorAll<HTMLButtonElement>('.iv-tab');
  const stepperEl     = document.getElementById('iv-stepper')!;
  const answerBox     = document.getElementById('iv-answer-box')!;
  const verdictEl     = document.getElementById('iv-verdict')!;
  const memCards      = document.getElementById('iv-memory-cards')!;
  const threshBar     = document.getElementById('iv-threshold-bar')!;
  const statusEl      = document.getElementById('iv-status')!;
  const memoriesListEl = document.getElementById('iv-memories-list')!;
  const traceSection  = document.getElementById('iv-trace-section') as HTMLDetailsElement | null;
  const traceSummary  = document.getElementById('iv-trace-summary')!;

  /** Currently open person ID */
  let currentPersonId: string | null = null;

  /** In-flight interview fetch abort controller */
  let abortCtrl: AbortController | null = null;

  /** Active citations from the latest answered response */
  let activeCitations: Citation[] = [];

  /* ── Listen for open event dispatched by VillageScene ── */
  window.addEventListener('teamville:openInterview', (e: Event) => {
    const detail = (e as CustomEvent<{ personId: string }>).detail;
    openPanel(detail.personId);
  });

  /* ── Tabs ── */
  const tabsArray = Array.from(tabs);

  function activateTab(tab: HTMLButtonElement): void {
    tabsArray.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      t.setAttribute('tabindex', '-1');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');

    document.querySelectorAll<HTMLElement>('.iv-pane').forEach(p => p.classList.remove('active'));
    const pane = document.getElementById(`pane-${tab.dataset['tab']}`);
    if (pane) pane.classList.add('active');

    if (tab.dataset['tab'] === 'memories' && currentPersonId) {
      void loadMemoriesTab(currentPersonId);
    }
  }

  tabsArray.forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab));

    // Arrow key navigation between tabs (ARIA tabs pattern)
    tab.addEventListener('keydown', (e: KeyboardEvent) => {
      const idx = tabsArray.indexOf(tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = tabsArray[(idx + 1) % tabsArray.length];
        if (next) { activateTab(next); next.focus(); }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = tabsArray[(idx - 1 + tabsArray.length) % tabsArray.length];
        if (prev) { activateTab(prev); prev.focus(); }
      } else if (e.key === 'Home') {
        e.preventDefault();
        const first = tabsArray[0];
        if (first) { activateTab(first); first.focus(); }
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = tabsArray[tabsArray.length - 1];
        if (last) { activateTab(last); last.focus(); }
      }
    });
  });

  /* ── Close button + Escape key ── */
  closeBtn.addEventListener('click', () => closePanel());
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePanel();
  });

  /* ── Question submit ── */
  askBtn.addEventListener('click', () => void submitQuestion());
  questionEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitQuestion();
    }
  });

  /* ─────────────────────────────────── OPEN / CLOSE ─── */

  function openPanel(personId: string): void {
    currentPersonId = personId;
    const meta = PEOPLE_META[personId] ?? { name: personId, role: '', sprite: 0 };

    const nameEl = document.getElementById('iv-name');
    const roleEl = document.getElementById('iv-role');
    if (nameEl) nameEl.textContent = meta.name;
    if (roleEl) roleEl.textContent = meta.role;

    // Update dialog aria-label to name the specific agent being interviewed
    overlay.setAttribute('aria-label', `Interview with ${meta.name}`);

    _drawAvatar(personId, meta.sprite);

    clearResults();
    questionEl.value = '';

    // Switch to Interview tab; use roving tabindex so only the active tab is in tab order
    tabs.forEach(t => {
      const active = t.dataset['tab'] === 'interview';
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    document.querySelectorAll<HTMLElement>('.iv-pane').forEach(p => {
      p.classList.toggle('active', p.id === 'pane-interview');
    });

    // Reset memories tab so stale content is not shown
    memoriesListEl.innerHTML = '';

    overlay.classList.add('open');
    questionEl.focus();
  }

  function closePanel(): void {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    overlay.classList.remove('open');
    overlay.setAttribute('aria-label', 'Agent interview panel');
    currentPersonId = null;
    // Return focus to the game container / body so keyboard users aren't stranded
    const gameContainer = document.getElementById('game-container');
    if (gameContainer) {
      gameContainer.focus();
    }
  }

  /* ─────────────────────────────────── SUBMIT ─── */

  async function submitQuestion(): Promise<void> {
    const question = questionEl.value.trim();
    if (!question || !currentPersonId) return;
    if (abortCtrl) abortCtrl.abort();

    abortCtrl = new AbortController();

    clearResults();
    askBtn.disabled = true;
    statusEl.textContent = 'Thinking…';

    // Show pipeline stepper; light up first step
    stepperEl.classList.add('visible');
    _setStep('embed', 'active');

    let result: InterviewResponse;
    try {
      const res = await fetch('/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: currentPersonId, question }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result = (await res.json()) as InterviewResponse;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `Error: ${msg}`;
      askBtn.disabled = false;
      stepperEl.classList.remove('visible');
      return;
    }

    abortCtrl = null;
    askBtn.disabled = false;

    // Mark all stepper steps done
    _setStep('embed',  'done');
    _setStep('score',  'done');
    _setStep('gate',   'done');
    _setStep('draft',  'done');
    _setStep('judge',  'done');

    statusEl.textContent = '';
    renderResult(result);
  }

  /* ─────────────────────────────────── RENDER RESULT ─── */

  function renderResult(result: InterviewResponse): void {
    activeCitations = result.citations ?? [];

    const trace = result.memoryTrace ?? [];

    // For 'answered' responses, the cited memory IDs get gold highlighting
    const citedMemIds = new Set<number | string>(
      result.status === 'answered'
        ? (result.citations ?? []).map(c => c.memoryId)
        : [],
    );

    // ── Answer / status message FIRST (top of results) ──
    if (result.status === 'answered' && result.answer) {
      // S4: typewriter the answer with inline citation chips
      answerBox.classList.add('visible');
      const html = _buildAnswerHtml(result.answer, result.citations ?? []);
      _typewriterHtml(answerBox, html, TYPEWRITER_DELAY);
    } else if (result.status === 'blocked') {
      // S11: show block message; do NOT render the answer (it is null anyway)
      answerBox.classList.add('visible');
      answerBox.style.color = 'var(--red)';
      answerBox.textContent = 'Answer not shown — failed grounding check.';
      if (result.verdict?.reason) {
        const reason = document.createElement('div');
        reason.style.cssText = 'font-size:11px;margin-top:6px;color:var(--text-dim);';
        reason.textContent = result.verdict.reason;
        answerBox.appendChild(reason);
      }
    } else if (result.status === 'declined') {
      // S5: honest decline message in gold
      answerBox.classList.add('visible');
      answerBox.style.color = 'var(--gold)';
      answerBox.textContent = "I don't have reliable information about that.";
    }

    // ── Verdict badge — directly below answer ──
    verdictEl.classList.remove('pass', 'block', 'declined');
    if (result.verdict) {
      if (result.verdict.pass) {
        // aria-label spells out the glyph meaning for screen readers
        verdictEl.setAttribute('aria-label', 'Verdict: Grounded and safe');
        verdictEl.textContent = '✓ Grounded · Safe';
        verdictEl.classList.add('pass');
      } else {
        verdictEl.setAttribute('aria-label', 'Verdict: Failed grounding check');
        verdictEl.textContent = `✗ Failed grounding check`;
        verdictEl.classList.add('block');
      }
    } else if (result.status === 'declined') {
      verdictEl.setAttribute('aria-label', `Verdict: Below relevance threshold ${RELEVANCE_THRESHOLD}`);
      verdictEl.textContent = `↓ Below relevance threshold (${RELEVANCE_THRESHOLD})`;
      verdictEl.classList.add('declined');
    }

    // ── Memory trace section (secondary, collapsed by default) ──
    if (trace.length > 0) {
      // Update the summary label with the count
      if (traceSummary) {
        traceSummary.textContent = `How it retrieved this (${trace.length} memor${trace.length === 1 ? 'y' : 'ies'})`;
      }

      // S5 — DECLINED: show threshold bar inside the details section
      if (result.status === 'declined') {
        threshBar.classList.add('visible');
      }

      // Render memory trace cards with staggered animate-in
      trace.forEach((mem, i) => {
        const isTop = citedMemIds.has(mem.memoryId);
        const card = buildMemoryCard(mem, isTop, (eid) => _scrollToMemory(eid));
        card.style.transitionDelay = `${i * 60}ms`;
        memCards.appendChild(card);

        // Trigger fade-in + bar animation after brief delay
        setTimeout(() => {
          card.classList.add('visible');
          animateBars(card);
        }, 20 + i * 60);
      });

      // Show the trace section; leave collapsed (user can expand)
      if (traceSection) traceSection.style.display = '';
    } else {
      // No trace — hide the section entirely
      if (traceSection) traceSection.style.display = 'none';
    }
  }

  /* ─────────────────────────────────── MEMORIES TAB (S7) ─── */

  async function loadMemoriesTab(personId: string): Promise<void> {
    memoriesListEl.innerHTML =
      '<div style="color:var(--text-dim);font-size:12px;">Loading…</div>';

    let memories: MemoryTabEntry[];
    try {
      const res = await fetch(`/memories/${personId}`);
      // Graceful degradation: 404 or any non-OK means the route isn't implemented yet
      if (res.status === 404) {
        memoriesListEl.innerHTML =
          '<div style="color:var(--text-dim);font-size:12px;">Memories unavailable.</div>';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      memories = (await res.json()) as MemoryTabEntry[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      memoriesListEl.innerHTML =
        `<div style="color:var(--text-dim);font-size:12px;">Memories unavailable (${msg}).</div>`;
      return;
    }

    memoriesListEl.innerHTML = '';

    // Sort: thought-kind reflections first (S7 hero), then by simTime descending
    const sorted = [...memories].sort((a, b) => {
      if (a.kind === 'thought' && b.kind !== 'thought') return -1;
      if (b.kind === 'thought' && a.kind !== 'thought') return 1;
      return b.simTime - a.simTime;
    });

    for (const mem of sorted) {
      memoriesListEl.appendChild(_buildThoughtCard(mem));
    }

    if (sorted.length === 0) {
      memoriesListEl.innerHTML =
        '<div style="color:var(--text-dim);font-size:12px;">No memories found.</div>';
    }
  }

  /**
   * Build a memory card for the Memories tab (full display; evidence tree for thoughts).
   */
  function _buildThoughtCard(mem: MemoryTabEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'thought-card';
    card.id = `mem-${mem.id}`;

    const kindEl = document.createElement('div');
    kindEl.className = 'thought-kind';
    kindEl.textContent = mem.kind.toUpperCase();

    const textEl = document.createElement('div');
    textEl.className = 'thought-text';
    textEl.textContent = mem.text;

    const meta = document.createElement('div');
    meta.style.cssText =
      'font-size:10px;color:var(--text-dim);margin-top:4px;font-family:var(--mono);';
    meta.textContent = `${_fmtTs(mem.simTime)} · importance ${mem.importance}`;

    card.append(kindEl, textEl, meta);

    // Evidence pointers for reflections (S7)
    if (mem.kind === 'thought' && Array.isArray(mem.evidenceIds) && mem.evidenceIds.length > 0) {
      const evDiv = document.createElement('div');
      evDiv.className = 'thought-evidence';
      evDiv.textContent = 'based on memories: ';
      for (const eid of mem.evidenceIds) {
        const lnk = document.createElement('span');
        lnk.className = 'ev-link';
        lnk.textContent = `#${eid}`;
        lnk.setAttribute('role', 'button');
        lnk.setAttribute('tabindex', '0');
        lnk.setAttribute('aria-label', `Scroll to memory ${eid}`);
        lnk.addEventListener('click', () => _highlightMemoryById(eid));
        lnk.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            _highlightMemoryById(eid);
          }
        });
        evDiv.appendChild(lnk);
        evDiv.appendChild(document.createTextNode(' '));
      }
      card.appendChild(evDiv);
    }

    return card;
  }

  /* ─────────────────────────────────── CITATION CHIPS ─── */

  /**
   * Replace [n] markers in raw answer text with interactive citation chip spans.
   * Returns safe HTML string (plain text is escaped before chip injection).
   */
  function _buildAnswerHtml(answer: string, citations: Citation[]): string {
    const citMap = new Map(citations.map(c => [c.n, c]));
    const escaped = _escapeHtml(answer);
    return escaped.replace(/\[(\d+)\]/g, (_match, num: string) => {
      const n = parseInt(num, 10);
      const cit = citMap.get(n);
      if (!cit) return `[${num}]`;
      // Build a descriptive label: include the source ref if available
      const refPart = cit.sourceRef ? `, source: ${cit.sourceRef}` : '';
      const ariaLabel = `Citation ${n}${refPart}`;
      return `<span class="citation-chip" data-n="${n}" role="button" tabindex="0" aria-label="${_escapeHtml(ariaLabel)}">[${n}]</span>`;
    });
  }

  /* ─────────────────────────────────── TYPEWRITER ─── */

  /**
   * Typewriter-render HTML into el, character by character.
   * Respects prefers-reduced-motion (instant render if motion reduced).
   */
  function _typewriterHtml(el: HTMLElement, html: string, delay: number): void {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      el.innerHTML = html;
      _attachCitationHandlers(el);
      return;
    }

    // Parse into segments: text nodes and chip elements
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const nodes = Array.from(tmp.childNodes);

    el.innerHTML = '';
    let nodeIdx = 0;

    function renderNextNode(): void {
      if (nodeIdx >= nodes.length) {
        _attachCitationHandlers(el);
        return;
      }
      const node = nodes[nodeIdx++];
      if (node.nodeType === Node.TEXT_NODE) {
        _typeText(el, node.textContent ?? '', delay, renderNextNode);
      } else {
        // Citation chip element — append immediately
        el.appendChild((node as HTMLElement).cloneNode(true));
        setTimeout(renderNextNode, delay * 2);
      }
    }
    renderNextNode();
  }

  function _typeText(el: HTMLElement, text: string, delay: number, onDone: () => void): void {
    let i = 0;
    function next(): void {
      if (i >= text.length) { onDone(); return; }
      el.appendChild(document.createTextNode(text[i++]!));
      setTimeout(next, delay);
    }
    next();
  }

  function _attachCitationHandlers(el: HTMLElement): void {
    el.querySelectorAll<HTMLElement>('.citation-chip').forEach(chip => {
      chip.addEventListener('click', () => _expandCitation(chip));
      chip.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') _expandCitation(chip);
      });
    });
  }

  function _expandCitation(chip: HTMLElement): void {
    const n = parseInt(chip.dataset['n'] ?? '0', 10);
    const cit = activeCitations.find(c => c.n === n);
    if (!cit) return;

    // Toggle existing expansion
    const existing = chip.nextElementSibling as HTMLElement | null;
    if (existing?.classList.contains('citation-expand')) {
      existing.classList.toggle('open');
      return;
    }

    const box = document.createElement('div');
    box.className = 'citation-expand open';

    const tsEl = document.createElement('div');
    tsEl.className = 'cit-ts';
    tsEl.textContent = _fmtTs(cit.simTime);

    const txtEl = document.createElement('div');
    txtEl.textContent = cit.text;

    const refEl = document.createElement('div');
    refEl.className = 'cit-ref';
    refEl.textContent = cit.sourceRef ?? '';

    box.append(tsEl, txtEl, refEl);
    chip.insertAdjacentElement('afterend', box);
  }

  /* ─────────────────────────────────── HELPERS ─── */

  function clearResults(): void {
    memCards.innerHTML = '';
    answerBox.classList.remove('visible');
    answerBox.innerHTML = '';
    answerBox.style.color = '';
    verdictEl.className = 'iv-verdict';
    verdictEl.textContent = '';
    threshBar.classList.remove('visible');
    stepperEl.classList.remove('visible');
    statusEl.textContent = '';
    activeCitations = [];
    // Reset trace section: hide it and close (un-open) the details
    if (traceSection) {
      traceSection.style.display = 'none';
      traceSection.open = false;
    }
    if (traceSummary) {
      traceSummary.textContent = 'How it retrieved this';
    }
  }

  function _drawAvatar(personId: string, spriteIndex: number): void {
    const canvas = document.getElementById('iv-avatar') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const COLORS = ['#4f8ef7', '#e05252', '#52c27a', '#c87ef5', '#f5c518', '#f5a623'];
    const initials = (PEOPLE_META[personId]?.name ?? personId).slice(0, 1).toUpperCase();
    ctx.clearRect(0, 0, 40, 40);
    ctx.fillStyle = COLORS[spriteIndex % COLORS.length]!;
    ctx.fillRect(0, 0, 40, 40);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 20, 21);
  }

  function _setStep(stepName: string, state: 'active' | 'done'): void {
    const el = stepperEl.querySelector<HTMLElement>(`[data-step="${stepName}"]`);
    if (!el) return;
    el.classList.remove('active', 'done');
    el.classList.add(state);
  }

  function _scrollToMemory(memId: number | string): void {
    const card = document.querySelector<HTMLElement>(`[data-memory-id="${memId}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function _highlightMemoryById(memId: number): void {
    const card = document.getElementById(`mem-${memId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = card.style.borderColor;
      card.style.borderColor = 'var(--gold)';
      setTimeout(() => { card.style.borderColor = prev; }, 2000);
    }
  }

  function _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _fmtTs(epochMs: number): string {
    if (!epochMs) return '';
    const d = new Date(epochMs);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  }
}
