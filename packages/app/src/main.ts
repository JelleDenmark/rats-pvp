import { mount } from 'svelte';
import './app.css';

const target = document.getElementById('app')!;

// Rats PvP prototype lives behind ?mode=pvp so the WRAD gauntlet app (App.svelte)
// is completely untouched. Dynamic import keeps each entry's code separate.
// Wrapped in an async IIFE — top-level await isn't in the build target.
void (async () => {
  if (new URLSearchParams(location.search).get('mode') === 'pvp') {
    const { default: PvpApp } = await import('./pvp/PvpApp.svelte');
    mount(PvpApp, { target });
  } else {
    const { default: App } = await import('./App.svelte');
    mount(App, { target });
  }
})();
