// Shared unit art: defId -> bundled SVG url, resolved at build time by Vite.
// Used by both the replay renderer (as PixiJS textures) and the shop/board
// tiles (as <img> portraits).
export const ART_URL: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('./replay/art/*.svg', { eager: true, query: '?url', import: 'default' })
  ).map(([path, url]) => [path.split('/').pop()!.replace('.svg', ''), url as string])
);

// Rats PvP placeholder art (issue #2): the pvpOnly roster has no dedicated art
// yet, so each PvP defId aliases an existing WRAD portrait rather than falling
// back to a plain rectangle in the replay. Two units imported wholesale from
// WRAD (Dire-Rat, Press-Kin) reuse their OWN art; the rest borrow a
// role-appropriate WRAD asset. Aliasing (not copying the .svg) keeps a single
// source of truth, so if the source art changes the placeholder tracks it.
// Replace with dedicated PvP art when it's commissioned.
const PVP_ART_ALIASES: Record<string, string> = {
  'plate-rat': 'culvert-knight', // WALL: full plate armor, visored helm
  'bramble-rat': 'grate-golem', // THORN: sharp iron grate — hurts to touch
  'gorge-rat': 'corpse-glutton', // BRUISER: bloated glutton — gorging
  'dire-rat-pvp': 'dire-rat', // imported unit -> its own WRAD art
  'steel-whisker-pvp': 'sluice-bulwark', // THORN: riveted steel armor
  'grave-leech-pvp': 'dray-ogre', // BRUISER: hulking brute
  'press-kin-pvp': 'press-kin', // imported unit -> its own WRAD art
};
for (const [defId, source] of Object.entries(PVP_ART_ALIASES)) {
  const url = ART_URL[source];
  if (url) ART_URL[defId] = url;
}
