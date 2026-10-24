# Mock Regional Helper

A Tampermonkey userscript for running a VGC "mock regional" on the Pokemon Showdown Bo3 ladder. It records each set: opponent, game results, replay links, ELO, and the opponent's team. It works out your stage (Day 1 / Day 2 / Top Cut / Eliminated / Champion) and builds a Discord post for you to paste.

It only watches traffic, saves replays, and formats the post. It never picks moves or queues for you.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Edge, Firefox, Safari).
   - **Chrome/Edge:** also turn on **Allow User Scripts** for Tampermonkey (right-click the Tampermonkey icon → **Manage extension** → **Allow User Scripts**), or Developer mode on older versions. Without it, scripts won't run.
2. Click **[Install Mock Regional Helper](https://raw.githubusercontent.com/definitelybenny/mock-regional-helper/main/mock-regional-helper.user.js)**. Tampermonkey opens an install page; click **Install**.
3. Open (or reload) https://play.pokemonshowdown.com/. Tampermonkey asks once for permission to contact `pokemonshowdown.com` (ELO and replays) and `pokepast.es` (team upload). Click **Always allow** for both.
4. You should see a small **Mock Regional** badge in the bottom-right corner. Click it to open the tab.

**Updates** are automatic: Tampermonkey checks this repo daily. To update right away, open the Tampermonkey dashboard → **Utilities** → **Check for userscript updates**.

## Use

1. Click the small **Mock Regional** badge to open the **Mock Regional** tab. It opens on the right side of Showdown, next to your other tabs (works in both the new and the old Showdown client). You can drag the badge anywhere; it always shows your record and stage. Enter the event name and click **Start run**.
2. Ladder as usual in `[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)`. Your team is recorded when you search. If you started the run after searching, it is taken from your open team sheet in the next battle, without EVs/IVs.
   - If you search with a **different team** during a run (or one shows up in a battle's team sheet), a small alert asks whether to record that set. **Don't record** leaves it out of the run; ignoring the alert records it.
3. Each game also records your 4 brought Pokémon, your leads, and the opponent's leads and revealed Pokémon ("Led A+B (brought A, B, C, D) vs X+Y"). After each game the script saves the replay. Each game shows *saving…*, then **replay ✓**, or *failed ✗* with **Retry**. Retry only works while that battle's tab is still open. Showdown also shows its own "replay uploaded" popup. When a set ends, a note prompt appears with an optional 1-5 rating. You can skip it, and **edit** any set later.
4. **Started late?** Open **Import past sets**. Search your public replays, or paste replay links (private ones work too). Then tick the sets to add. They are inserted in date order and can replace "vs ?" placeholder sets.
5. **Adjust** has **Mark W** / **Mark L**, **Undo last set** and **End run** for anything the automation misses.
6. The run ends by itself when you are eliminated or win top cut. The tab then shows a summary with **Copy for Discord** and **New run**. Long posts are split into parts so each fits Discord's 2000-character limit, with one copy button per part. **Report card** (also on the run page and in History) draws a PNG summary: record, stage, ELO, your team, and one row per set with the opponent's six and your leads. Use **Copy image** to paste it into Discord, or **Download PNG** (copying falls back to a download if the browser blocks it). The **Show notes** toggle includes or hides your notes. **New run** moves the finished run to **History**; nothing is discarded. **Resume run** undoes a manual End run. While a run is ended, new sets are not tracked (you get a reminder if one starts).

The tab header has **History** (past runs: view read-only, copy for Discord, delete), **Stats** (record per team, win rate vs opponent Pokémon and per lead pair, ELO across runs) and **Backup** (export the current run or everything as a .json file, and import one; runs you already have are skipped).

Settings (in the tab): format ID, number of Day 1 and Day 2 rounds, max Swiss losses (default 2), top cut rounds (default 3 = Top 8), include spreads, upload to pokepast.es, and leads/bring per game in the Discord post (on by default).

Rules: you are eliminated as soon as your Swiss losses go over the max (so X-2 is still alive), or on any top cut loss. Ties count in the record but not as losses.

The run is saved in Tampermonkey storage, so reloading the page doesn't lose it.

If something looks wrong (for example sets not being picked up, or a sidebar instead of the tab), open the browser console (F12) and send the lines starting with `[MockRegional]`. They say which mode was chosen and why.

## Battle data export (schema v1)

**Backup → Export battle data** (or **Export battle data** on an archived run) writes one `.json` file. It contains the raw evidence only. Spreads are not inferred: opponent team sheets have no EVs, and damage, speed and roll inference is left to the importer.

```
{
  schema: "mock-regional-helper/battle-data", schemaVersion: 1,
  format: "gen9championsvgc2026regmcbo3", exportedAt: ISO date, player: "name",
  runs: [{
    id, event, player, startedAt: ISO date,
    myTeamPaste: Showdown export text (Level: 50; "EVs:" holds Champions stat points when known),
    myTeamHasSpreads: true if captured from your search (false = from a team sheet, no spreads),
    sets: [{
      round: "R1".."R12" | "Top 8" | "Top 4" | "Finals", opponent, result: "W"|"L"|"T"|null,
      oppTeamSheet: [{ species, item, ability, moves[], nature, gender, level, teraType? }] | null,
      oppTeamPacked: the raw packed |showteam| string, oppTeamPaste: export text (Level: 50, no EVs line),
      oppSpecies: [6 species],
      games: [{
        n, roomid, result, replayUrl,
        myLeads[2], myBring[<=4], oppLeads[2], oppRevealed[],   // Mega forms are given as the base species
        logSource: "player" | "spectator" | "replay" | null,   // spectator/replay = taken from a saved replay
        logMissing: true | false,                               // no log could be found or fetched
        log: [every protocol line of the battle room, in order], // |move|, |-damage| (HP %), |-crit|, |turn|, ...
        requests: [your |request| JSON: the team-preview one and the first in-battle one (exact stats)]
      }]
    }]
  }]
}
```

Notes for the importer:
- **Player logs** are from your own point of view. Your HP shows as exact values (`153/175`) and the opponent's as a percentage.
- **Spectator logs** show both sides as percentages and have no `requests`.
- **Missing log:** `log` is empty and `logMissing` is true if the game has no log (a manual set, or a replay that couldn't be fetched).
- **Backfill:** the export first fills missing logs, team sheets and leads from the games' replays (fetched 3 at a time and cached), so runs recorded by older versions export complete. **Backup → Battle logs → Backfill from replays** does the same without exporting.
- **Bring for replay-sourced games:** `myBring` comes from switch-ins. A Pokémon that was brought but never sent in is missing.
