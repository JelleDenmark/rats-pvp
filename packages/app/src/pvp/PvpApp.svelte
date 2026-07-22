<script lang="ts">
  import { onMount } from 'svelte';
  import { simulateDuel, UNIT_DEFS, type Lineup } from '@wrad/core';
  import { deviceId, SUPABASE_URL, SUPABASE_ANON_KEY } from '../telemetry';
  import { CHANNEL } from '../env';
  import { ReplayPlayer } from '../replay/ReplayPlayer';

  // ---- roster + budget -----------------------------------------------------
  const BUDGET = 100;
  const ROSTER = [
    { defId: 'plate-rat', role: 'WALL', blurb: 'armor — beats THORN' },
    { defId: 'bramble-rat', role: 'THORN', blurb: 'reflect — beats BRUISER' },
    { defId: 'gorge-rat', role: 'BRUISER', blurb: 'lifesteal — beats WALL' },
  ];
  const BOARD_CAP = 8;
  const cost = (defId: string) => UNIT_DEFS[defId]?.cost ?? 0;

  // ---- round identity ------------------------------------------------------
  const rawRound = new URLSearchParams(location.search).get('round') ?? 'r1';
  const roundId = (CHANNEL === 'dev' ? 'dev-' : '') + rawRound;
  const HEADERS = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };

  // ---- persisted local state ----------------------------------------------
  const NS = `ratspvp:${roundId}`;
  const loadJSON = <T,>(k: string, fb: T): T => {
    try {
      const v = localStorage.getItem(`${NS}:${k}`);
      return v ? (JSON.parse(v) as T) : fb;
    } catch {
      return fb;
    }
  };
  const save = (k: string, v: unknown) => localStorage.setItem(`${NS}:${k}`, JSON.stringify(v));

  let view = $state<'build' | 'results'>('build');
  let name = $state<string>(loadJSON('name', ''));
  let board = $state<string[]>(loadJSON('board', [])); // ordered defIds, index 0 = front
  let submitState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const spent = $derived(board.reduce((s, d) => s + cost(d), 0));
  const left = $derived(BUDGET - spent);

  $effect(() => save('name', name));
  $effect(() => save('board', board));

  function add(defId: string) {
    if (board.length >= BOARD_CAP) return;
    if (cost(defId) > left) return;
    board = [...board, defId];
  }
  function removeAt(i: number) {
    board = board.filter((_, k) => k !== i);
  }

  function displayName(): string {
    return name.trim() || `Rat-${deviceId().slice(0, 4)}`;
  }

  async function submit() {
    if (board.length === 0) return;
    submitState = 'saving';
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
      submitState = res.ok ? 'saved' : 'error';
    } catch {
      submitState = 'error';
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
    if (!name) name = `Rat-${deviceId().slice(0, 4)}`;
  });

  async function goResults() {
    view = 'results';
    await loadResults();
  }
</script>

<main class="pvp">
  <header>
    <h1>🐀 Rats PvP <span class="round">round {rawRound}</span></h1>
    <nav>
      <button class:active={view === 'build'} onclick={() => (view = 'build')}>Build</button>
      <button class:active={view === 'results'} onclick={goResults}>Standings</button>
    </nav>
  </header>

  {#if view === 'build'}
    <section class="build">
      <p class="hint">
        Spend {BUDGET} scrap on a board of rats. It auto-fights every other player's board
        this round. Counters: <b>WALL</b> ▸ <b>THORN</b> ▸ <b>BRUISER</b> ▸ <b>WALL</b>.
      </p>

      <label class="name">
        Name <input bind:value={name} maxlength="24" placeholder="Rat-boss" />
      </label>

      <div class="scrap">Scrap left: <b class:broke={left < 0}>{left}</b> / {BUDGET}</div>

      <div class="roster">
        {#each ROSTER as r}
          <div class="card">
            <div class="card-head">
              <span class="role">{r.role}</span>
              <span class="c">{cost(r.defId)}⚙</span>
            </div>
            <div class="dname">{UNIT_DEFS[r.defId].name}</div>
            <div class="stats">
              {UNIT_DEFS[r.defId].attack}⚔ / {UNIT_DEFS[r.defId].health}❤
            </div>
            <div class="blurb">{r.blurb}</div>
            <button onclick={() => add(r.defId)} disabled={cost(r.defId) > left || board.length >= BOARD_CAP}>
              + Add
            </button>
          </div>
        {/each}
      </div>

      <h3>Your board <span class="sub">(front → back, left is first to clash)</span></h3>
      {#if board.length === 0}
        <p class="empty">No rats yet — add some above.</p>
      {:else}
        <ol class="board">
          {#each board as d, i}
            <li>
              <span class="pos">{i + 1}</span>
              <span>{UNIT_DEFS[d].name}</span>
              <button class="x" onclick={() => removeAt(i)} aria-label="remove">×</button>
            </li>
          {/each}
        </ol>
      {/if}

      <button class="submit" onclick={submit} disabled={board.length === 0 || left < 0 || submitState === 'saving'}>
        {submitState === 'saving' ? 'Submitting…' : 'Submit board'}
      </button>
      {#if submitState === 'saved'}<p class="ok">Submitted for round {rawRound}. Check Standings after it runs.</p>{/if}
      {#if submitState === 'error'}<p class="err">Submit failed — is the round backend live?</p>{/if}
    </section>
  {:else}
    <section class="results">
      {#if loadingResults}
        <p>Loading…</p>
      {:else if standings.length === 0}
        <p class="empty">No standings yet — this round hasn't been run.</p>
      {:else}
        <ol class="lb">
          {#each standings as row}
            <li class:me={row.device_id === me}>
              <span class="rank">{row.rank}</span>
              <span class="who">{row.name}</span>
              <span class="score">{row.score} pts</span>
              <span class="wld">{row.wins}-{row.losses}-{row.draws} · {row.margin >= 0 ? '+' : ''}{row.margin}</span>
            </li>
          {/each}
        </ol>
      {/if}

      {#if matchups.length > 0}
        <h3>Your matchups</h3>
        <div class="stage" bind:this={stageEl}></div>
        <ul class="matchups">
          {#each matchups as m}
            <li class={m.outcome}>
              <span class="tag">{m.outcome}</span>
              <span>vs {m.opp}</span>
              <button onclick={() => watch(m)} disabled={playing}>▶ Watch</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  .pvp {
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem;
    color: #e8e2d8;
    font-family: system-ui, sans-serif;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h1 { font-size: 1.4rem; margin: 0; }
  .round { font-size: 0.8rem; opacity: 0.6; }
  nav button, .submit, .roster button, .matchups button, .x {
    cursor: pointer;
    background: #2b2620;
    color: #e8e2d8;
    border: 1px solid #4a4136;
    border-radius: 6px;
    padding: 0.4rem 0.7rem;
    font: inherit;
  }
  nav button.active { background: #8a4b2f; border-color: #a8623f; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .hint { opacity: 0.85; line-height: 1.4; }
  .name input { padding: 0.3rem; border-radius: 6px; border: 1px solid #4a4136; background: #1a1712; color: inherit; }
  .scrap { margin: 0.6rem 0; }
  .scrap .broke { color: #e06b5a; }
  .roster { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; }
  .card { background: #1f1b16; border: 1px solid #3a332a; border-radius: 8px; padding: 0.6rem; }
  .card-head { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.8; }
  .role { color: #d9a441; font-weight: 700; }
  .dname { font-weight: 600; margin-top: 0.2rem; }
  .stats { font-size: 0.85rem; opacity: 0.8; }
  .blurb { font-size: 0.75rem; opacity: 0.7; margin: 0.3rem 0; min-height: 2.2em; }
  .card button { width: 100%; }
  .sub { font-size: 0.75rem; opacity: 0.6; font-weight: 400; }
  .board { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .board li { display: flex; align-items: center; gap: 0.4rem; background: #26211b; border: 1px solid #3a332a; border-radius: 6px; padding: 0.3rem 0.5rem; }
  .board .pos { font-size: 0.7rem; opacity: 0.6; }
  .board .x { padding: 0 0.4rem; line-height: 1; }
  .empty { opacity: 0.6; }
  .submit { margin-top: 0.8rem; background: #8a4b2f; border-color: #a8623f; font-weight: 600; }
  .ok { color: #7fbf6a; }
  .err { color: #e06b5a; }
  .lb { list-style: none; padding: 0; }
  .lb li { display: grid; grid-template-columns: 2rem 1fr auto auto; gap: 0.6rem; padding: 0.35rem 0.5rem; border-bottom: 1px solid #2a251f; align-items: center; }
  .lb li.me { background: #2b2620; border-radius: 6px; }
  .lb .rank { opacity: 0.6; }
  .lb .score { font-weight: 700; }
  .lb .wld { font-size: 0.8rem; opacity: 0.7; }
  .stage { margin: 0.6rem 0; min-height: 60px; }
  .stage :global(canvas) { max-width: 100%; height: auto; border-radius: 8px; }
  .matchups { list-style: none; padding: 0; }
  .matchups li { display: flex; align-items: center; gap: 0.6rem; padding: 0.3rem 0; }
  .matchups .tag { text-transform: uppercase; font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; }
  .matchups li.win .tag { background: #2f5a2f; }
  .matchups li.loss .tag { background: #5a2f2f; }
  .matchups li.draw .tag { background: #4a4136; }
</style>
