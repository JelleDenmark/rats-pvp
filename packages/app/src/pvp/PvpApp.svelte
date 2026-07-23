<script lang="ts">
  import { onMount } from 'svelte';
  import {
    simulateDuel,
    UNIT_DEFS,
    type Lineup,
    PVP_BUDGET,
    PVP_BOARD_CAP,
    PVP_ROSTER,
    pvpUnitCost,
  } from '@wrad/core';
  import { deviceId, SUPABASE_URL, SUPABASE_ANON_KEY } from '../telemetry';
  import { CHANNEL } from '../env';
  import { ReplayPlayer } from '../replay/ReplayPlayer';

  // ---- roster + budget (shared with the server runner via @wrad/core) ------
  const BUDGET = PVP_BUDGET;
  const ROSTER = PVP_ROSTER;
  const BOARD_CAP = PVP_BOARD_CAP;
  const cost = (defId: string) => pvpUnitCost(defId);

  // ---- round identity --------------------------------------------------
  // An explicit `?round=` always wins (testing / old links). Otherwise the
  // active round is resolved from the server (`pvp_rounds`, status=open) so
  // rounds can open/close on a cron with nobody sharing a new URL — see
  // `resolveRound()` below. `roundReady` gates the rest of the UI until that
  // resolves (or falls back), so localStorage is never read/written under
  // the wrong round's namespace.
  const HEADERS = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  let roundReady = $state(false);
  let rawRound = $state('');
  let roundId = $state('');
  let roundClosesAt = $state<string | null>(null);

  // ---- persisted local state ----------------------------------------------
  const NS = $derived(`ratspvp:${roundId}`);
  function loadJSON<T,>(k: string, fb: T): T {
    try {
      const v = localStorage.getItem(`${NS}:${k}`);
      return v ? (JSON.parse(v) as T) : fb;
    } catch {
      return fb;
    }
  }
  function save(k: string, v: unknown) {
    localStorage.setItem(`${NS}:${k}`, JSON.stringify(v));
  }

  let view = $state<'build' | 'results'>('build');
  let name = $state<string>('');
  let board = $state<string[]>([]); // ordered defIds, index 0 = front
  let submitState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let submitError = $state('');
  let inspect = $state<{ area: 'roster' | 'board'; index: number } | null>(null);

  const spent = $derived(board.reduce((s, d) => s + cost(d), 0));
  const left = $derived(BUDGET - spent);

  // Guarded by roundReady so the default '' values never clobber a namespace
  // before loadPersisted() has actually loaded it (see resolveRound).
  $effect(() => { if (roundReady) save('name', name); });
  $effect(() => { if (roundReady) save('board', board); });

  function loadPersisted() {
    name = loadJSON('name', '');
    board = loadJSON('board', []);
    if (!name) name = `Rat-${deviceId().slice(0, 4)}`;
  }

  interface RoundMeta {
    round_id: string;
    opens_at: string;
    closes_at: string;
    status: 'open' | 'scoring' | 'closed';
  }

  async function fetchOpenRound(): Promise<RoundMeta | null> {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pvp_rounds?status=eq.open&order=opens_at.desc&limit=1` +
        `&select=round_id,opens_at,closes_at,status`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as RoundMeta[];
    return rows[0] ?? null;
  }

  async function fetchRoundMeta(id: string): Promise<RoundMeta | null> {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pvp_rounds?round_id=eq.${encodeURIComponent(id)}` +
        `&select=round_id,opens_at,closes_at,status`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as RoundMeta[];
    return rows[0] ?? null;
  }

  /**
   * Resolves which round is active. An explicit `?round=` overrides and just
   * fetches that round's metadata (for the countdown). Otherwise asks the
   * server which round is currently open. Any failure (network down, or the
   * `pvp_rounds` table/migration not applied yet) falls back to the old
   * default of `r1` with no countdown — the builder must still work offline.
   */
  async function resolveRound() {
    const override = new URLSearchParams(location.search).get('round');
    try {
      if (override) {
        rawRound = override;
        roundId = (CHANNEL === 'dev' ? 'dev-' : '') + override;
        roundClosesAt = (await fetchRoundMeta(roundId))?.closes_at ?? null;
      } else {
        const open = await fetchOpenRound();
        if (open) {
          roundId = open.round_id;
          rawRound = roundId.replace(/^dev-/, '');
          roundClosesAt = open.closes_at;
        } else {
          rawRound = 'r1';
          roundId = (CHANNEL === 'dev' ? 'dev-' : '') + rawRound;
          roundClosesAt = null;
        }
      }
    } catch {
      rawRound = override ?? 'r1';
      roundId = (CHANNEL === 'dev' ? 'dev-' : '') + rawRound;
      roundClosesAt = null;
    }
    roundReady = true;
    loadPersisted();
  }

  // ---- round countdown ------------------------------------------------------
  let now = $state(Date.now());
  const roundTimeLabel = $derived.by(() => {
    if (!roundClosesAt) return null;
    const diff = new Date(roundClosesAt).getTime() - now;
    if (diff <= 0) return 'Round closed — check Standings for results.';
    const mins = Math.floor(diff / 60_000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `Round closes in ${h > 0 ? `${h}h ` : ''}${m}m`;
  });

  function add(defId: string) {
    if (board.length >= BOARD_CAP) return;
    if (cost(defId) > left) return;
    board = [...board, defId];
  }
  function removeAt(i: number) {
    board = board.filter((_, k) => k !== i);
  }
  function moveBoard(i: number, delta: number) {
    const to = i + delta;
    if (to < 0 || to >= board.length) return;
    const b = [...board];
    [b[i], b[to]] = [b[to], b[i]];
    board = b;
    inspect = { area: 'board', index: to };
  }

  function displayName(): string {
    return name.trim() || `Rat-${deviceId().slice(0, 4)}`;
  }

  async function submit() {
    if (board.length === 0) return;
    submitState = 'saving';
    submitError = '';
    const lineup: Lineup = { units: board.map((defId) => ({ defId, tier: 1, relicIds: [] })) };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_pvp_board`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          p_round: roundId,
          p_device: deviceId(),
          p_name: displayName(),
          p_lineup: lineup,
        }),
      });
      if (res.ok) {
        submitState = 'saved';
      } else {
        submitState = 'error';
        const body = await res.json().catch(() => null);
        submitError = /not open/i.test(body?.message ?? '')
          ? 'This round has closed — check Standings.'
          : 'Submit failed — is the round backend live?';
      }
    } catch {
      submitState = 'error';
      submitError = 'Submit failed — is the round backend live?';
    }
  }

  // ---- results / replays ---------------------------------------------------
  interface ResultRow {
    device_id: string;
    name: string;
    score: number; // match points (win 3 / draw 1 / loss 0)
    margin: number; // survivor differential (tiebreak)
    wins: number;
    losses: number;
    draws: number;
    rank: number;
  }
  interface BoardRow {
    device_id: string;
    name: string;
    lineup: Lineup;
  }
  interface Matchup {
    opp: string;
    outcome: 'win' | 'loss' | 'draw';
    events: import('@wrad/core').BattleEvent[];
  }

  let standings = $state<ResultRow[]>([]);
  let matchups = $state<Matchup[]>([]);
  let submittedCount = $state(0);
  let loadingResults = $state(false);
  const me = deviceId();

  async function loadResults() {
    loadingResults = true;
    try {
      const sres = await fetch(
        `${SUPABASE_URL}/rest/v1/pvp_results?round_id=eq.${encodeURIComponent(roundId)}` +
          `&order=rank.asc&select=device_id,name,score,margin,wins,losses,draws,rank`,
        { headers: HEADERS }
      );
      standings = sres.ok ? await sres.json() : [];

      // Only reveal matchups once the round has actually been closed by
      // `npm run run-round` — otherwise submitting a board would leak the
      // outcome against everyone submitted so far, before the round is final.
      if (standings.length === 0) {
        matchups = [];
        const cres = await fetch(
          `${SUPABASE_URL}/rest/v1/pvp_boards?round_id=eq.${encodeURIComponent(roundId)}` +
            `&select=device_id&limit=1000`,
          { headers: HEADERS }
        );
        submittedCount = cres.ok ? ((await cres.json()) as unknown[]).length : 0;
        return;
      }

      const bres = await fetch(
        `${SUPABASE_URL}/rest/v1/pvp_boards?round_id=eq.${encodeURIComponent(roundId)}` +
          `&select=device_id,name,lineup`,
        { headers: HEADERS }
      );
      const boards: BoardRow[] = bres.ok ? await bres.json() : [];
      const mine = boards.find((b) => b.device_id === me);
      matchups = mine
        ? boards
            .filter((b) => b.device_id !== me)
            .map((b) => {
              const r = simulateDuel(mine.lineup, b.lineup);
              const outcome = r.result.winner === 'a' ? 'win' : r.result.winner === 'b' ? 'loss' : 'draw';
              return { opp: b.name, outcome, events: r.events } as Matchup;
            })
        : [];
    } finally {
      loadingResults = false;
    }
  }

  // ---- pixi replay ---------------------------------------------------------
  let stageEl: HTMLDivElement | undefined = $state();
  let player: ReplayPlayer | undefined;
  let playing = $state(false);

  async function watch(m: Matchup) {
    if (!stageEl || playing) return;
    if (!player) {
      player = new ReplayPlayer();
      await player.init(stageEl);
    }
    playing = true;
    stageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    try {
      await player.play(m.events);
    } finally {
      playing = false;
    }
  }

  onMount(() => {
    resolveRound();
    const t = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(t);
  });

  async function goResults() {
    view = 'results';
    await loadResults();
  }
</script>

<main>
  <h1>RATS PVP</h1>
  {#if !roundReady}
    <p class="sub">loading round…</p>
  {:else}
  <p class="sub">round {rawRound} · counters WALL ▸ THORN ▸ BRUISER ▸ WALL</p>
  {#if roundTimeLabel}<p class="hint round-timer">{roundTimeLabel}</p>{/if}

  <div class="compendium-nav">
    <button class:active={view === 'build'} onclick={() => (view = 'build')}>Build</button>
    <button class:active={view === 'results'} onclick={goResults}>Standings</button>
  </div>

  {#if view === 'build'}
    <section class="build">
      <p class="hint">Spend {BUDGET} scrap on a board of rats. It auto-fights every other player's board this round.</p>

      <div class="status-row">
        <span class="scrap">⚙ {left} / {BUDGET} scrap left</span>
        <label class="name">
          <input bind:value={name} maxlength="24" placeholder="Rat-boss" />
        </label>
      </div>

      <div class="horde-panel">
        <div class="panel-label row-label">
          <span>roster</span>
          <span>tap to add</span>
        </div>
        <div class="board roster-board">
          {#each ROSTER as r, i}
            <button
              class="tile unit-tile"
              class:selected={inspect?.area === 'roster' && inspect.index === i}
              onclick={() => (inspect = { area: 'roster', index: i })}
            >
              <span class="tile-sub role">{r.role}</span>
              <span class="tile-name">{UNIT_DEFS[r.defId].name}</span>
              <span class="tile-stats">{UNIT_DEFS[r.defId].attack}⚔/{UNIT_DEFS[r.defId].health}❤</span>
              <span class="tile-sub">{r.blurb}</span>
              <span class="tile-cost">⚙ {cost(r.defId)}</span>
            </button>
          {/each}
        </div>
      </div>

      <div class="phase-divider"><span>your board</span></div>

      <div class="horde-panel">
        <div class="panel-label row-label">
          <span>{board.length}/{BOARD_CAP} rats</span>
          <span>front → back, left clashes first</span>
        </div>
        {#if board.length === 0}
          <p class="lb-empty">No rats yet — tap a roster rat above to add one.</p>
        {:else}
          <div class="board horde-board">
            {#each board as d, i}
              <button
                class="tile unit-tile"
                class:selected={inspect?.area === 'board' && inspect.index === i}
                onclick={() => (inspect = { area: 'board', index: i })}
              >
                <span class="tile-sub">pos {i + 1}</span>
                <span class="tile-name">{UNIT_DEFS[d].name}</span>
                <span class="tile-stats">{UNIT_DEFS[d].attack}⚔/{UNIT_DEFS[d].health}❤</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <button class="ride submit" onclick={submit} disabled={board.length === 0 || left < 0 || submitState === 'saving'}>
        {submitState === 'saving' ? 'Submitting…' : 'Submit board'}
      </button>
      {#if submitState === 'saved'}<p class="ok">Submitted for round {rawRound}. Check Standings after it runs.</p>{/if}
      {#if submitState === 'error'}<p class="err">{submitError}</p>{/if}
    </section>
  {:else}
    <section class="results">
      <div class="leaderboard">
        <div class="lb-head">
          <span class="panel-label">Standings · round {rawRound}</span>
          <button class="lb-refresh" onclick={() => void loadResults()} disabled={loadingResults}>
            {loadingResults ? '…' : '↻'}
          </button>
        </div>
        {#if loadingResults}
          <p class="lb-empty">Loading…</p>
        {:else if standings.length === 0}
          <p class="lb-empty">
            {submittedCount} {submittedCount === 1 ? 'player has' : 'players have'} submitted a board so far.
            Results stay hidden until the round is closed.
          </p>
        {:else}
          <ol class="lb-rows">
            {#each standings as row}
              <li class="lb-row" class:me={row.device_id === me}>
                <span class="lb-rank">{row.rank}</span>
                <span class="lb-name">{row.name}{row.device_id === me ? ' · you' : ''}</span>
                <span class="lb-boss">{row.wins}-{row.losses}-{row.draws} · {row.margin >= 0 ? '+' : ''}{row.margin}</span>
                <span class="lb-depth">{row.score} pts</span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      {#if matchups.length > 0}
        <div class="horde-panel matchups-panel">
          <div class="panel-label row-label"><span>your matchups</span></div>
          <div class="stage" bind:this={stageEl}></div>
          <ul class="matchups">
            {#each matchups as m}
              <li class={m.outcome}>
                <span class="tag">{m.outcome}</span>
                <span class="opp">vs {m.opp}</span>
                <button class="watch" onclick={() => watch(m)} disabled={playing}>▶ watch</button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  {/if}
  {/if}

  {#if inspect}
    {@const ins = inspect}
    <div class="sheet-backdrop" role="presentation" onclick={() => (inspect = null)}>
      <div class="sheet" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        {#if ins.area === 'roster'}
          {@const r = ROSTER[ins.index]}
          {@const def = UNIT_DEFS[r.defId]}
          {@const afford = cost(r.defId) <= left}
          {@const full = board.length >= BOARD_CAP}
          <div class="card-head">
            <div class="card-icon">{r.role[0]}</div>
            <div>
              <div class="card-name">{def.name}</div>
              <div class="card-stats">{def.attack}/{def.health} <span class="card-tier">atk/hp</span></div>
              <div class="card-sub role">{r.role}</div>
            </div>
          </div>
          <p class="card-ability">{r.blurb}.</p>
          <p class="card-hint">costs ⚙ {cost(r.defId)} scrap</p>
          <div class="card-actions">
            <button class="primary" disabled={!afford || full} onclick={() => { add(r.defId); inspect = null; }}>
              + add to board
            </button>
            <button onclick={() => (inspect = null)}>close</button>
          </div>
          {#if full}<div class="card-warn">the board is full</div>
          {:else if !afford}<div class="card-warn">not enough scrap</div>{/if}
        {:else}
          {@const d = board[ins.index]}
          {@const def = UNIT_DEFS[d]}
          <div class="card-head">
            <div class="card-icon">{ins.index + 1}</div>
            <div>
              <div class="card-name">{def.name}</div>
              <div class="card-stats">{def.attack}/{def.health} <span class="card-tier">atk/hp</span></div>
              <div class="card-sub">position {ins.index + 1} of {board.length}</div>
            </div>
          </div>
          <p class="card-hint">front → back, left clashes first</p>
          <div class="card-actions">
            <button disabled={ins.index === 0} onclick={() => moveBoard(ins.index, -1)}>◀ move up</button>
            <button disabled={ins.index === board.length - 1} onclick={() => moveBoard(ins.index, 1)}>move down ▶</button>
          </div>
          <div class="card-actions">
            <button onclick={() => { removeAt(ins.index); inspect = null; }}>remove</button>
            <button onclick={() => (inspect = null)}>close</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 940px;
    margin: 0 auto;
    padding: 24px 16px 48px;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: 28px;
    letter-spacing: 6px;
    color: var(--ink);
  }

  .sub {
    margin: 4px 0 16px;
    color: var(--ink-dim);
    font-size: 13px;
  }

  .compendium-nav {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 0 0 16px;
  }

  .compendium-nav button {
    padding: 6px 14px;
    font-family: inherit;
    font-size: 12px;
    color: var(--ink);
    background: #241a14;
    border: 1px solid #4a3520;
    border-radius: 6px;
    cursor: pointer;
  }

  .compendium-nav button.active {
    color: #f0e6d2;
    border-color: var(--accent);
  }

  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .build { max-width: 620px; margin: 0 auto 16px; text-align: left; }

  .hint { color: var(--ink-dim); line-height: 1.4; font-size: 13px; margin: 0 0 12px; }

  .round-timer { text-align: center; margin: -8px 0 16px; font-size: 12px; color: #d9a441; }

  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .scrap { font-size: 16px; color: #d4af37; }

  .name input {
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid #4a3520;
    background: #241a14;
    color: var(--ink);
    font-family: inherit;
    font-size: 13px;
  }

  .panel-label { font-size: 12px; color: var(--ink-dim); }

  .row-label {
    display: flex;
    justify-content: space-between;
    margin: 0 2px 8px;
  }

  .horde-panel {
    padding: 10px 12px 12px;
    border: 1.5px solid #6b4a2a;
    border-radius: 10px;
    background: #1c150f;
    margin-bottom: 12px;
  }

  .board {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .roster-board { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }

  .tile {
    position: relative;
    min-width: 0;
    min-height: 86px;
    padding: 7px 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    background: #241a14;
    border: 1px solid #4a3520;
    border-radius: 8px;
    color: var(--ink);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tile-name {
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.15;
    overflow-wrap: break-word;
  }

  .tile-stats {
    font-size: 14px;
    font-weight: bold;
    color: #f0e6d2;
  }

  .tile-sub {
    font-size: 10px;
    color: var(--ink-dim);
    line-height: 1.2;
    overflow-wrap: break-word;
  }

  .tile-sub.role {
    color: #d9a441;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 10px;
  }

  .tile-cost { font-size: 11px; color: #d4af37; }

  .unit-tile.selected {
    border-color: var(--accent);
    background: #2c1e15;
  }

  .phase-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 18px auto 14px;
    color: var(--accent);
    font-size: 12px;
    letter-spacing: 3px;
    text-transform: uppercase;
  }

  .phase-divider::before,
  .phase-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #4a3520;
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 50;
  }

  .sheet {
    width: 100%;
    max-width: 480px;
    background: #1a140f;
    border: 1px solid #4a3520;
    border-bottom: none;
    border-radius: 14px 14px 0 0;
    padding: 18px 18px 26px;
    text-align: left;
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .card-icon {
    width: 56px;
    height: 56px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    font-weight: 700;
    color: #d9a441;
    background: #241a14;
    border: 1px solid #4a3520;
    border-radius: 10px;
  }

  .card-name { font-size: 19px; color: var(--ink); }

  .card-stats {
    margin-top: 3px;
    font-size: 17px;
    font-weight: bold;
    color: #f0e6d2;
  }

  .card-tier {
    font-size: 11px;
    font-weight: normal;
    color: var(--ink-dim);
    margin-left: 6px;
  }

  .card-sub {
    margin-top: 3px;
    font-size: 12px;
    color: var(--ink-dim);
  }

  .card-sub.role { color: #d9a441; font-weight: 700; letter-spacing: 1px; }

  .card-ability {
    margin: 14px 0 4px;
    font-size: 14px;
    line-height: 1.45;
    color: #c9b891;
  }

  .card-hint {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--ink-dim);
  }

  .card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  .card-actions button {
    padding: 9px 16px;
    font-family: inherit;
    font-size: 14px;
    color: var(--ink);
    background: #241a14;
    border: 1px solid #4a3520;
    border-radius: 6px;
    cursor: pointer;
  }

  .card-actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #f7ede0;
  }

  .card-actions button:disabled { opacity: 0.4; cursor: default; }

  .card-warn {
    margin-top: 8px;
    font-size: 12px;
    color: #d8452e;
  }

  .lb-empty {
    margin: 4px 0;
    font-size: 13px;
    color: var(--ink-dim);
  }

  .ride {
    margin-top: 4px;
    padding: 10px 28px;
    font-family: inherit;
    font-size: 16px;
    letter-spacing: 2px;
    color: var(--ink);
    background: var(--accent);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    width: 100%;
  }

  .ride:disabled { opacity: 0.5; cursor: wait; }

  .ok { margin-top: 8px; font-size: 13px; color: #7fbf6a; }
  .err { margin-top: 8px; font-size: 13px; color: #d8452e; }

  .results { max-width: 620px; margin: 0 auto; text-align: left; }

  .leaderboard {
    max-width: 620px;
    margin: 0 auto;
    padding: 12px 14px 14px;
    border: 1px solid #322820;
    border-radius: 10px;
    background: #14100c;
    text-align: left;
  }

  .lb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .lb-refresh {
    min-width: 40px;
    min-height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 10px;
    font-family: inherit;
    font-size: 13px;
    color: var(--ink);
    background: #241a14;
    border: 1px solid #4a3520;
    border-radius: 6px;
    cursor: pointer;
  }

  .lb-refresh:disabled { opacity: 0.5; cursor: default; }

  .lb-rows { list-style: none; margin: 10px 0 0; padding: 0; }

  .lb-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 14px;
  }

  .lb-row:nth-child(odd) { background: #1a140f; }
  .lb-row.me { background: #2c2415; color: #f0e6d2; }

  .lb-rank {
    min-width: 24px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }

  .lb-row.me .lb-rank { color: #d4af37; }

  .lb-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lb-boss {
    flex: 0 0 auto;
    white-space: nowrap;
    font-size: 12px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }

  .lb-depth {
    flex: 0 0 auto;
    white-space: nowrap;
    color: #d4af37;
    font-variant-numeric: tabular-nums;
  }

  .matchups-panel { margin-top: 14px; }

  .stage { margin: 6px 0; min-height: 60px; }
  .stage :global(canvas) { max-width: 100%; height: auto; border-radius: 8px; }

  .matchups { list-style: none; padding: 0; margin: 0; }
  .matchups li { display: flex; align-items: center; gap: 10px; padding: 5px 8px; font-size: 14px; }
  .matchups .opp { flex: 1; }
  .matchups .tag {
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
  }
  .matchups li.win .tag { background: #2f5a2f; color: #d8f0cf; }
  .matchups li.loss .tag { background: #5a2f2f; color: #f0d4cf; }
  .matchups li.draw .tag { background: #4a3520; color: #e8dcc9; }

  .watch {
    padding: 6px 14px;
    font-family: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
</style>
