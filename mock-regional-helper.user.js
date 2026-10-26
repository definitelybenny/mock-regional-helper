// ==UserScript==
// @name         Mock Regional Helper
// @namespace    mock-regional-helper
// @version      1.1.1
// @description  Tracks a VGC mock regional run on the Showdown Bo3 ladder: records sets, saves replays, tracks ELO, and formats a Discord post.
// @homepageURL  https://github.com/definitelybenny/mock-regional-helper
// @updateURL    https://raw.githubusercontent.com/definitelybenny/mock-regional-helper/main/mock-regional-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/definitelybenny/mock-regional-helper/main/mock-regional-helper.user.js
// @match        https://play.pokemonshowdown.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      pokemonshowdown.com
// @connect      replay.pokemonshowdown.com
// @connect      pokepast.es
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_listValues, GM_deleteValue, GM_xmlhttpRequest, GM_setClipboard, unsafeWindow */

(function () {
	'use strict';

	/* =====================================================================
	 * Core: pure protocol parsing, state updates, stage logic, formatting.
	 * No DOM / GM access here so it can be tested under Node.
	 * ===================================================================== */
	const Core = (function () {
		const DEFAULT_SETTINGS = {
			formatId: 'gen9championsvgc2026regmcbo3',
			day1Rounds: 8,
			day2Rounds: 4,
			lossThreshold: 2,
			topCutRounds: 3,
			includeSpreads: false,
			usePokepaste: true,
			/** add "led A+B (+C D) vs X+Y" to each game line in the Discord post */
			discordLineups: true,
			/** keep playing the remaining Swiss rounds after going over the loss threshold */
			playOn: false,
		};
		const DISCORD_LIMIT = 2000;
		const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
		const STAT_NAMES = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

		function toID(text) {
			return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
		}

		function unescapeHtml(text) {
			return String(text)
				.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
				.replace(/&#0?39;|&apos;/g, "'").replace(/&#x2f;/gi, '/').replace(/&amp;/g, '&');
		}

		// ---- Transport framing -------------------------------------------

		/** Decode one incoming socket frame into Showdown message blocks. Handles SockJS framing. */
		function decodeFrame(data) {
			if (typeof data !== 'string' || !data) return [];
			const c = data.charAt(0);
			if (c === 'o' || c === 'h') return data.length === 1 ? [] : [data];
			if (c === 'a' && data.charAt(1) === '[') {
				try { return JSON.parse(data.slice(1)).filter(m => typeof m === 'string'); } catch (e) { return []; }
			}
			if (c === 'm' && data.charAt(1) === '"') {
				try { return [JSON.parse(data.slice(1))]; } catch (e) { return []; }
			}
			if (c === 'c' && data.charAt(1) === '[') return [];
			return [data];
		}

		/** Decode an outgoing frame (raw "roomid|text" or SockJS '["roomid|text"]'). */
		function decodeOutgoing(data) {
			if (typeof data !== 'string' || !data) return [];
			if (data.charAt(0) === '[') {
				try {
					const arr = JSON.parse(data);
					if (Array.isArray(arr)) return arr.filter(m => typeof m === 'string');
				} catch (e) { /* not SockJS framing */ }
			}
			return [data];
		}

		/** Split a server message block into room id + protocol lines. */
		function parseBlock(msg) {
			let roomid = '';
			let body = msg;
			if (msg.charAt(0) === '>') {
				const nl = msg.indexOf('\n');
				roomid = nl < 0 ? msg.slice(1) : msg.slice(1, nl);
				body = nl < 0 ? '' : msg.slice(nl + 1);
			}
			return { roomid: roomid.trim(), lines: body.split('\n') };
		}

		/** Split a protocol line into args, keeping the remainder of the line in the last arg. */
		function splitLine(line, maxArgs) {
			if (line.charAt(0) !== '|') return ['', line];
			const parts = line.slice(1).split('|');
			if (maxArgs && parts.length > maxArgs) {
				parts.splice(maxArgs - 1, parts.length, parts.slice(maxArgs - 1).join('|'));
			}
			return parts;
		}

		/** `|updateuser|` identity: leading rank char, optional `@status` suffix. */
		function parseIdentity(identity) {
			let name = String(identity || '');
			if (name && !/[A-Za-z0-9]/.test(name.charAt(0))) name = name.slice(1);
			const at = name.indexOf('@');
			if (at >= 0) name = name.slice(0, at);
			return name.trim();
		}

		/** `|raw|Name's rating: 1500 &rarr; <strong>1516</strong><br />(+16 for winning)` */
		function parseRatingLine(html) {
			const m = /^(.+?)'s rating: (\d+) &rarr; <strong>(\d+)<\/strong>/.exec(html);
			if (!m) return null;
			return { name: unescapeHtml(m[1]), before: Number(m[2]), after: Number(m[3]) };
		}

		/** Extract replay URL from the `/savereplay` popup. */
		function parseReplayPopup(text) {
			if (!/replay has been uploaded/i.test(text)) return null;
			const m = /href="(https?:\/\/replay\.pokemonshowdown\.com\/[^"\s]+)"/.exec(text);
			return m ? m[1] : null;
		}

		/** Replay id prefix for a battle room: drop `battle-` and any `-<password>pw` suffix. */
		function replayBaseForRoom(roomid) {
			let id = roomid.replace(/^battle-/, '');
			if (/pw$/.test(id)) id = id.replace(/-[a-z0-9]+pw$/, '');
			return id;
		}

		function replayMatchesRoom(url, roomid) {
			const id = url.replace(/^https?:\/\/replay\.pokemonshowdown\.com\//, '').replace(/[?#].*$/, '');
			const base = replayBaseForRoom(roomid);
			return id === base || id.indexOf(base + '-') === 0;
		}

		function isBattleRoom(roomid, formatId) {
			return roomid.indexOf('battle-' + formatId + '-') === 0;
		}
		function isBestOfRoom(roomid, formatId) {
			return /^game-bestof\d+-/.test(roomid) && roomid.indexOf('-' + formatId + '-') > 0;
		}
		function battleNumber(roomid) {
			const m = /-(\d+)(?:-[a-z0-9]+pw)?$/.exec(roomid);
			return m ? Number(m[1]) : 0;
		}

		// ---- Teams ---------------------------------------------------------

		/** Readable guess for a packed name, e.g. "SafetyGoggles" -> "Safety Goggles". */
		function unpackName(name, table) {
			if (!name) return '';
			if (table && typeof table.get === 'function') {
				try {
					const obj = table.get(name);
					if (obj && obj.exists !== false && obj.name) return obj.name;
				} catch (e) { /* fall through */ }
			}
			return name.replace(/([0-9]+)/g, ' $1 ').replace(/([A-Z])/g, ' $1').replace(/ {2}/g, ' ').trim();
		}

		/** Packed team -> array of sets (format documented in sim/teams.ts). `dex` is optional. */
		function unpackTeam(buf, dex) {
			if (!buf) return [];
			const team = [];
			const sets = buf.split(']');
			for (const setBuf of sets) {
				const f = setBuf.split('|');
				if (f.length < 2) continue;
				const set = {};
				set.name = f[0] || '';
				set.species = f[1] ? unpackName(f[1], dex && dex.species) : set.name;
				if (dex && dex.species && f[1] === '') set.species = unpackName(set.name, dex.species) || set.name;
				set.item = unpackName(f[2] || '', dex && dex.items);
				const ability = f[3] || '';
				if (['', '0', '1', 'H', 'S'].includes(ability)) {
					let abil = '';
					try {
						const sp = dex && dex.species && dex.species.get(set.species);
						if (sp && sp.abilities) abil = sp.abilities[ability || '0'] || '';
					} catch (e) { /* no dex */ }
					set.ability = abil;
				} else {
					set.ability = unpackName(ability, dex && dex.abilities);
				}
				set.moves = (f[4] || '').split(',').filter(Boolean).map(m => unpackName(m, dex && dex.moves));
				set.nature = f[5] ? f[5].charAt(0).toUpperCase() + f[5].slice(1) : '';
				if (f[6]) {
					const evs = f[6].split(',');
					set.evs = {};
					STAT_ORDER.forEach((s, i) => { set.evs[s] = Number(evs[i]) || 0; });
				}
				set.gender = f[7] || '';
				if (f[8]) {
					const ivs = f[8].split(',');
					set.ivs = {};
					STAT_ORDER.forEach((s, i) => { set.ivs[s] = ivs[i] === '' || ivs[i] === undefined ? 31 : Number(ivs[i]) || 0; });
				}
				set.shiny = !!f[9];
				set.level = f[10] ? parseInt(f[10], 10) : 100;
				const misc = (f[11] || '').split(',');
				set.teraType = misc[5] || '';
				team.push(set);
			}
			return team;
		}

		/** Sets -> Showdown export text. */
		function exportTeam(sets) {
			return sets.map(set => {
				let out = (set.name && set.name !== set.species) ? `${set.name} (${set.species})` : set.species;
				if (set.gender === 'M' || set.gender === 'F') out += ` (${set.gender})`;
				if (set.item) out += ` @ ${set.item}`;
				out += '\n';
				if (set.ability) out += `Ability: ${set.ability}\n`;
				if (set.level && set.level !== 100) out += `Level: ${set.level}\n`;
				if (set.shiny) out += 'Shiny: Yes\n';
				if (set.teraType) out += `Tera Type: ${set.teraType}\n`;
				if (set.evs) {
					const evs = STAT_ORDER.filter(s => set.evs[s]).map(s => `${set.evs[s]} ${STAT_NAMES[s]}`);
					if (evs.length) out += `EVs: ${evs.join(' / ')}\n`;
				}
				if (set.nature) out += `${set.nature} Nature\n`;
				if (set.ivs) {
					const ivs = STAT_ORDER.filter(s => set.ivs[s] !== 31).map(s => `${set.ivs[s]} ${STAT_NAMES[s]}`);
					if (ivs.length) out += `IVs: ${ivs.join(' / ')}\n`;
				}
				for (const move of set.moves) out += `- ${move}\n`;
				return out;
			}).join('\n');
		}

		/** Species list from a packed team (as sent by `|showteam|`). */
		function packedSpecies(buf) {
			if (!buf) return [];
			return buf.split(']').map(s => {
				const f = s.split('|');
				return f[1] || f[0] || '';
			}).filter(Boolean).map(s => /[ -]/.test(s) || /^[A-Z]/.test(s) ? s : unpackName(s));
		}

		/** Remove EV / IV / nature lines from export text. */
		function stripSpreads(text) {
			return String(text).split('\n')
				.filter(line => !/^\s*(EVs|IVs|SPs):/i.test(line) && !/^\s*[A-Za-z]+ Nature\s*$/.test(line))
				.join('\n');
		}

		// ---- Stage logic ---------------------------------------------------

		function swissRounds(settings) {
			return settings.day1Rounds + settings.day2Rounds;
		}

		/** Label for the set at 0-based index i. */
		function roundLabel(i, settings) {
			const swiss = swissRounds(settings);
			if (i < swiss) return `R${i + 1}`;
			const remaining = settings.topCutRounds - (i - swiss);
			if (remaining <= 1) return 'Finals';
			return `Top ${Math.pow(2, remaining)}`;
		}

		function phaseOfRound(i, settings) {
			if (i < settings.day1Rounds) return 'Day 1';
			if (i < swissRounds(settings)) return 'Day 2';
			return roundLabel(i, settings);
		}

		/**
		 * Compute stage from completed sets.
		 * Elimination: losses exceed the threshold during Swiss, or any loss in top cut.
		 * Ties count toward the record only (not losses).
		 * With playOn, going over the loss threshold in Swiss does not end the run: the stage stays
		 * 'Eliminated' (non-terminal) while the remaining Swiss rounds are played for points; there is no top cut.
		 */
		function computeStage(sets, settings, playOn) {
			const swiss = swissRounds(settings);
			const done = sets.filter(s => s.result);
			let wins = 0, losses = 0, ties = 0;
			let stage = null;
			let eliminatedIn = null;
			for (let i = 0; i < done.length && !stage; i++) {
				const r = done[i].result;
				if (r === 'W') wins++;
				else if (r === 'L') losses++;
				else ties++;
				if (i >= swiss) {
					if (r === 'L') {
						stage = 'Eliminated';
						eliminatedIn = roundLabel(i, settings);
					} else if (r === 'W' && i - swiss + 1 >= settings.topCutRounds) {
						stage = 'Champion';
					}
				} else if (losses > settings.lossThreshold && !playOn) {
					stage = 'Eliminated';
					eliminatedIn = phaseOfRound(i, settings);
				} else {
					if (losses > settings.lossThreshold && !eliminatedIn) eliminatedIn = phaseOfRound(i, settings);
					// Playing on after elimination ends with the phase you were eliminated in (Day 1 or Day 2).
					if (eliminatedIn && i === playUntil(eliminatedIn, settings) - 1) stage = 'Eliminated';
					else if (!eliminatedIn && i === swiss - 1 && settings.topCutRounds <= 0) stage = 'Finished';
				}
			}
			const terminal = !!stage;
			if (!stage) {
				const next = done.length;
				stage = eliminatedIn ? 'Eliminated' : next < settings.day1Rounds ? 'Day 1' : next < swiss ? 'Day 2' : 'Top Cut';
			}
			return { stage, terminal, eliminatedIn, wins, losses, ties, completed: done.length, playingOn: !!playOn && !!eliminatedIn && !terminal, playUntil: eliminatedIn ? playUntil(eliminatedIn, settings) : null };
		}

		/** Rounds played in total when playing on after being eliminated in the given phase. */
		function playUntil(eliminatedIn, settings) {
			return eliminatedIn === 'Day 1' ? settings.day1Rounds : swissRounds(settings);
		}

		/** Does this run keep going past elimination (its own choice, or the default setting)? */
		function playsOn(run, settings) {
			return !!((run && run.playOn) || (settings && settings.playOn));
		}

		function stageOf(run, settings) {
			return computeStage(run.sets || [], settings, playsOn(run, settings));
		}

		/** Elimination in Swiss with rounds left and not yet playing on: the user may choose to continue. */
		function canPlayOn(run, settings) {
			if (!run || playsOn(run, settings)) return false;
			const info = computeStage(run.sets || [], settings, false);
			return info.stage === 'Eliminated' && info.completed < playUntil(info.eliminatedIn, settings) && !/^(Top|Finals)/.test(info.eliminatedIn || '');
		}

		/** Continue playing the remaining Swiss rounds after elimination. */
		function continuePlaying(state) {
			const run = state.run;
			if (!run || !canPlayOn(run, state.settings)) return false;
			run.playOn = true;
			run.ended = false;
			run.endedAt = null;
			run.endReason = null;
			run.endElo = null;
			return true;
		}

		function recordText(info) {
			return `${info.wins}-${info.losses}` + (info.ties ? `-${info.ties}` : '');
		}

		function statusText(info, run) {
			if (info.stage === 'Eliminated') return `Eliminated (${info.eliminatedIn})`;
			if (info.terminal) return info.stage;
			if (run && run.ended) return `${info.stage} (run ended)`;
			return info.stage;
		}

		// ---- State ---------------------------------------------------------

		function newState() {
			return { version: 1, settings: Object.assign({}, DEFAULT_SETTINGS), me: null, run: null, lastUtm: null, nextSetDecision: null };
		}

		function loadState(raw) {
			const state = newState();
			if (!raw) return state;
			let obj = raw;
			if (typeof raw === 'string') {
				try { obj = JSON.parse(raw); } catch (e) { return state; }
			}
			if (!obj || typeof obj !== 'object') return state;
			Object.assign(state.settings, obj.settings || {});
			state.me = obj.me || null;
			state.run = obj.run || null;
			if (state.run && !state.run.id) state.run.id = newRunId(); // runs from before v0.4
			state.lastUtm = obj.lastUtm || null;
			state.nextSetDecision = obj.nextSetDecision || null;
			return state;
		}

		function newRunId() {
			return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
		}

		function newRun(event, player, startElo) {
			return {
				id: newRunId(),
				event: event || 'Mock Regional',
				player: player || '',
				startedAt: Date.now(),
				ended: false,
				endedAt: null,
				startElo: startElo == null ? null : startElo,
				currentElo: startElo == null ? null : startElo,
				endElo: null,
				team: null,
				sets: [],
			};
		}

		function newSet(id, opponent, run) {
			return {
				id,
				opponent: opponent || '',
				games: [],
				result: null,
				manual: false,
				eloBefore: run && run.currentElo != null ? Math.round(run.currentElo) : null,
				eloAfter: null,
				oppTeam: [],
				note: '',
				rating: 0,
				endedAt: null,
			};
		}

		function newTracker() {
			return { rooms: {}, replayRequested: {}, untracked: {} };
		}

		function trackRoom(track, roomid) {
			if (!track.rooms[roomid]) {
				track.rooms[roomid] = {
					players: {}, parent: null, result: null, showteam: {}, showteamPacked: {}, ratings: [], title: '', lineup: newLineup(),
				};
			}
			return track.rooms[roomid];
		}

		// ---- Bring-4 and leads ------------------------------------------------

		/** Per-battle record of who came in: leads (before |turn|1), every switch-in, team preview, own request. */
		function newLineup() {
			return { turn: 0, seen: {}, leads: {}, preview: {}, request: null };
		}

		/** "Charizard-Mega-X, L50, M" -> "Charizard" (Mega forms count as the base Pokemon). */
		function speciesFromDetails(details) {
			return String(details || '').split(',')[0].trim().replace(/-Mega(-[XYZ])?$/, '');
		}

		function pushUnique(list, value) {
			if (value && list.indexOf(value) < 0) list.push(value);
		}

		/** Feed one protocol line (already split) into a lineup. */
		function lineupLine(lu, args) {
			switch (args[0]) {
			case 'poke': {
				const side = args[1];
				pushUnique(lu.preview[side] = lu.preview[side] || [], speciesFromDetails(args[2]));
				break;
			}
			case 'turn':
				lu.turn = Number(args[1]) || lu.turn;
				break;
			case 'switch':
			case 'drag': {
				const side = String(args[1] || '').slice(0, 2);
				if (!/^p[1-4]$/.test(side)) break;
				const species = speciesFromDetails(args[2]);
				pushUnique(lu.seen[side] = lu.seen[side] || [], species);
				if (lu.turn === 0) {
					const leads = lu.leads[side] = lu.leads[side] || [];
					if (leads.length < 2) pushUnique(leads, species);
				}
				break;
			}
			case 'request': {
				// our own request lists exactly the brought Pokemon once team preview is over
				let req = null;
				try { req = JSON.parse(args.slice(1).join('|')); } catch (e) { /* ignore */ }
				if (req && !req.teamPreview && req.side && Array.isArray(req.side.pokemon)) {
					lu.request = { side: req.side.id, species: req.side.pokemon.map(p => speciesFromDetails(p.details)) };
				}
				break;
			}
			}
		}

		/** Lineup fields for a game from our side's view. Bring falls back to switch-ins (replays have no request). */
		function lineupFields(lu, mine, opp) {
			// the request (in its order) plus anything else seen switching in, in case a request was partial
			const bring = lu.request && lu.request.side === mine ? lu.request.species.slice() : [];
			for (const species of lu.seen[mine] || []) pushUnique(bring, species);
			return {
				bring: bring.slice(0, 4),
				leads: (lu.leads[mine] || []).slice(),
				oppLeads: (opp && lu.leads[opp] || []).slice(),
				oppSeen: (opp && lu.seen[opp] || []).slice(),
			};
		}

		/** Copy lineup info onto a game; returns true if anything changed. */
		function applyLineup(game, lu, mine, opp) {
			const next = lineupFields(lu, mine, opp);
			let changed = false;
			for (const key of Object.keys(next)) {
				if (!next[key].length) continue;
				if (JSON.stringify(game[key] || []) !== JSON.stringify(next[key])) {
					game[key] = next[key];
					changed = true;
				}
			}
			return changed;
		}

		/** "A+B (+C D) vs X+Y" (short) or "Led A+B (brought A, B, C, D) vs X+Y · seen X, Y, Z" (long). */
		function lineupText(game, long) {
			const leads = game.leads || [];
			if (!leads.length) return '';
			const bring = game.bring || [];
			const back = bring.filter(x => leads.indexOf(x) < 0);
			const oppLeads = game.oppLeads || [];
			if (!long) {
				return leads.join('+') + (back.length ? ' (+' + back.join(' ') + ')' : '') + (oppLeads.length ? ' vs ' + oppLeads.join('+') : '');
			}
			let text = 'Led ' + leads.join('+') + (bring.length ? ' (brought ' + bring.join(', ') + ')' : '');
			if (oppLeads.length) text += ' vs ' + oppLeads.join('+');
			const oppSeen = game.oppSeen || [];
			if (oppSeen.length) text += ' · seen ' + oppSeen.join(', ');
			return text;
		}

		/** Can we start tracking a new set right now? */
		function canAddSets(state) {
			const run = state.run;
			if (!run || run.ended) return false;
			return !stageOf(run, state.settings).terminal;
		}

		function findSet(run, id) {
			return run ? run.sets.find(s => s.id === id) || null : null;
		}

		function setScore(set) {
			let w = 0, l = 0;
			for (const g of set.games) {
				if (g.result === 'W') w++;
				else if (g.result === 'L') l++;
			}
			return { w, l };
		}

		/**
		 * May a set be auto-created for this room? Not if the room's game/set already finished
		 * (stale tabs or replayed logs from before the run) or the user removed it.
		 */
		function mayCreateSet(state, room, setId) {
			if (room.result || !canAddSets(state)) return false;
			return !(state.run.removed || []).includes(setId);
		}

		/** A live Bo3 of ours started while the run is manually ended: tell the user once (Resume run tracks it). */
		function noteUntracked(state, track, room, setId, effects) {
			const run = state.run;
			if (!run || !run.ended || room.result || track.untracked[setId]) return;
			if (stageOf(run, state.settings).terminal) return;
			track.untracked[setId] = true;
			effects.push({ type: 'untracked', setId });
		}

		/** Mark a set finished; returns effects. Results the user set by hand are not overwritten. */
		function finishSet(state, set, result, effects) {
			if (set.resultLocked) return;
			if (set.result) {
				if (set.result !== result) { set.result = result; effects.push({ type: 'changed' }); }
				return;
			}
			set.result = result;
			set.endedAt = Date.now();
			effects.push({ type: 'setEnded', setId: set.id });
			const info = stageOf(state.run, state.settings);
			if (info.terminal && !state.run.ended) {
				state.run.ended = true;
				state.run.endedAt = Date.now();
				effects.push({ type: 'runEnded', reason: info.stage });
			}
		}

		/** Comparable parts per mon of a packed team: species -> item, ability, moves (no nickname/EVs/order). */
		function teamParts(packed) {
			const mons = {};
			for (const setBuf of String(packed || '').split(']')) {
				const f = setBuf.split('|');
				if (f.length < 5) continue;
				mons[toID(f[1] || f[0])] = {
					item: toID(f[2]),
					ability: toID(f[3]),
					moves: (f[4] || '').split(',').map(toID).filter(Boolean).sort().join(','),
				};
			}
			return mons;
		}

		/**
		 * Do two packed teams differ in species, items, abilities or moves? Nicknames, order and spreads are
		 * ignored, so a /utm team and its own open team sheet compare equal. Ability slot codes ('0', '1',
		 * 'H', 'S') can't be compared with ability names, so those are skipped.
		 */
		function teamsDiffer(a, b) {
			const ma = teamParts(a), mb = teamParts(b);
			const ka = Object.keys(ma).sort(), kb = Object.keys(mb).sort();
			if (ka.join() !== kb.join()) return true;
			const slot = x => ['', '0', '1', 'h', 's'].includes(x);
			return ka.some(k => ma[k].item !== mb[k].item || ma[k].moves !== mb[k].moves ||
				(!slot(ma[k].ability) && !slot(mb[k].ability) && ma[k].ability !== mb[k].ability));
		}

		/** A search-time "different team" answer only applies to a set that starts within this window. */
		const TEAM_DECISION_TTL = 30 * 60 * 1000;

		/**
		 * Create a tracked set, applying the answer to a "different team" alert raised at search time:
		 * 'skip' leaves the set untracked (returns null); 'record' or no answer ('pending') records it.
		 */
		function createSet(state, id, opponent, effects) {
			const run = state.run;
			let decision = state.nextSetDecision;
			state.nextSetDecision = null;
			if (decision && Date.now() - decision.at >= TEAM_DECISION_TTL) decision = null;
			if (decision && decision.status === 'skip') {
				(run.removed = run.removed || []).push(id);
				effects.push({ type: 'teamSkipped', setId: id });
				return null;
			}
			const set = newSet(id, opponent, run);
			if (decision) {
				set.teamDecision = decision.status;
				// the alert is still open: re-point it at this set so "Don't record" can drop it
				if (decision.status === 'pending') effects.push({ type: 'teamMismatch', setId: id });
			}
			run.sets.push(set);
			effects.push({ type: 'changed' });
			return set;
		}

		/**
		 * Answer a "different team" alert. setId null = the next set (alert raised at search time).
		 * Not recording drops the set entirely, and its rooms won't re-create it (so no more auto-saves).
		 */
		function decideTeam(state, setId, record) {
			const run = state.run;
			if (!run) return false;
			if (!setId) {
				if (!state.nextSetDecision) return false;
				state.nextSetDecision.status = record ? 'record' : 'skip';
				return true;
			}
			const set = findSet(run, setId);
			if (!set) return false;
			if (record) {
				set.teamDecision = 'record';
				return true;
			}
			run.sets = run.sets.filter(x => x !== set);
			(run.removed = run.removed || []).push(set.id);
			syncRunEnded(state);
			return true;
		}

		/** Pick our side and the opponent's in a tracked battle room. */
		function sides(room, userid) {
			for (const side of Object.keys(room.players)) {
				if (toID(room.players[side]) === userid) {
					const opp = Object.keys(room.players).find(s => s !== side) || null;
					return { mine: side, opp, oppName: opp ? room.players[opp] : '' };
				}
			}
			return null;
		}

		function reconcileBattle(state, track, roomid, effects) {
			const run = state.run;
			const room = track.rooms[roomid];
			if (!run || !state.me || !room || !room.parent) return;
			const side = sides(room, state.me.userid);
			if (!side) return;

			let set = findSet(run, room.parent);
			if (!set) {
				const parent = track.rooms[room.parent];
				if (!mayCreateSet(state, room, room.parent) || (parent && parent.result)) {
					noteUntracked(state, track, room, room.parent, effects);
					return;
				}
				set = createSet(state, room.parent, side.oppName, effects);
				if (!set) return;
			}
			if (!set.opponent && side.oppName) set.opponent = side.oppName;

			let game = set.games.find(g => g.roomid === roomid);
			if (!game) {
				game = { roomid, result: null, replay: null };
				set.games.push(game);
				set.games.sort((a, b) => battleNumber(a.roomid) - battleNumber(b.roomid));
				effects.push({ type: 'changed' });
			}
			if (!set.oppTeam.length && side.opp && room.showteam[side.opp]) {
				set.oppTeam = room.showteam[side.opp];
				effects.push({ type: 'changed' });
			}
			if (!set.oppTeamPacked && side.opp && room.showteamPacked[side.opp]) {
				set.oppTeamPacked = room.showteamPacked[side.opp];
				effects.push({ type: 'changed' });
			}
			if (applyLineup(game, room.lineup, side.mine, side.opp)) effects.push({ type: 'changed' });
			// Open team sheets show our own team too; use it if the /utm was never seen.
			if (!run.team && room.showteamPacked[side.mine]) {
				effects.push({ type: 'teamCaptured', packed: room.showteamPacked[side.mine], source: 'showteam' });
			}
			// ...and lets us notice a set played with a different team (e.g. an accepted challenge).
			if (run.team && room.showteamPacked[side.mine] && !set.teamDecision) {
				if (teamsDiffer(run.team.packed, room.showteamPacked[side.mine])) {
					set.teamDecision = 'pending';
					effects.push({ type: 'teamMismatch', setId: set.id });
				} else {
					set.teamDecision = 'same';
				}
			}
			if (room.result && !game.result) {
				game.result = room.result.tie ? 'T' : (toID(room.result.winner) === state.me.userid ? 'W' : 'L');
				effects.push({ type: 'changed' });
			}
			if (game.result && !game.replay && !track.replayRequested[roomid]) {
				track.replayRequested[roomid] = true;
				effects.push({ type: 'savereplay', roomid });
			}
			for (const r of room.ratings) {
				if (toID(r.name) !== state.me.userid) continue;
				if (set.eloBefore !== r.before || set.eloAfter !== r.after) {
					set.eloBefore = r.before;
					set.eloAfter = r.after;
					run.currentElo = r.after;
					effects.push({ type: 'changed' });
				}
			}
			// Fallback in case the Bo3 room's result is missed: infer from game wins.
			if (!set.result) {
				const score = setScore(set);
				if (score.w >= 2) finishSet(state, set, 'W', effects);
				else if (score.l >= 2) finishSet(state, set, 'L', effects);
			}
		}

		function reconcileBestOf(state, track, roomid, effects) {
			const run = state.run;
			const room = track.rooms[roomid];
			if (!run || !state.me || !room) return;
			let set = findSet(run, roomid);
			if (!set) {
				const names = room.title ? room.title.split(' vs. ') : [];
				const mineIdx = names.findIndex(n => toID(n) === state.me.userid);
				if (names.length !== 2 || mineIdx < 0) return;
				if (!mayCreateSet(state, room, roomid)) {
					noteUntracked(state, track, room, roomid, effects);
					return;
				}
				set = createSet(state, roomid, names[1 - mineIdx], effects);
				if (!set) return;
			}
			if (room.result) {
				const result = room.result.tie ? 'T' : (toID(room.result.winner) === state.me.userid ? 'W' : 'L');
				finishSet(state, set, result, effects);
			}
		}

		/**
		 * Process one incoming server message block. Mutates state/track, returns effects:
		 * {type:'changed'|'savereplay'|'setEnded'|'runEnded', ...}
		 */
		function handleIncoming(state, track, msg) {
			const effects = [];
			const { roomid, lines } = parseBlock(msg);
			const fmt = state.settings.formatId;

			if (!roomid) {
				for (const line of lines) {
					const args = splitLine(line);
					if (args[0] === 'updateuser') {
						const name = parseIdentity(args[1]);
						if (args[2] === '1' && name) {
							const userid = toID(name);
							if (!state.me || state.me.userid !== userid || state.me.name !== name) {
								state.me = { name, userid };
								effects.push({ type: 'changed' });
							}
						}
					} else if (args[0] === 'popup') {
						const url = parseReplayPopup(line);
						if (url && state.run) {
							state.run.sets.forEach((set, i) => {
								set.games.forEach((g, j) => {
									if (!g.replay && replayMatchesRoom(url, g.roomid)) {
										g.replay = url;
										effects.push({ type: 'replaySaved', roomid: g.roomid, label: `${roundLabel(i, state.settings)} G${j + 1}` });
									}
								});
							});
						} else if (/replay could not be saved/i.test(line)) {
							effects.push({ type: 'replayFailed' });
						}
					}
				}
				return effects;
			}

			const battle = isBattleRoom(roomid, fmt);
			const bestOf = !battle && isBestOfRoom(roomid, fmt);
			if (!battle && !bestOf) return effects;
			const room = trackRoom(track, roomid);

			for (const line of lines) {
				if (line.charAt(0) !== '|') continue;
				const args = splitLine(line, 4);
				if (battle) lineupLine(room.lineup, args);
				switch (args[0]) {
				case 'title':
					room.title = args.slice(1).join('|');
					break;
				case 'player':
					if (args[2]) room.players[args[1]] = args[2];
					break;
				case 'uhtml':
				case 'uhtmlchange': {
					const m = /href="\/(game-bestof\d+-[a-z0-9-]+)"/.exec(line);
					if (battle && args[1] === 'bestof' && m) room.parent = m[1];
					break;
				}
				case 'showteam':
					room.showteamPacked[args[1]] = args.slice(2).join('|');
					room.showteam[args[1]] = packedSpecies(room.showteamPacked[args[1]]);
					break;
				case 'win':
					room.result = { winner: args.slice(1).join('|') };
					break;
				case 'tie':
					room.result = { tie: true };
					break;
				case 'raw': {
					const r = parseRatingLine(args.slice(1).join('|'));
					if (r) room.ratings.push(r);
					break;
				}
				}
			}

			if (battle) reconcileBattle(state, track, roomid, effects);
			else reconcileBestOf(state, track, roomid, effects);
			return effects;
		}

		/** Process one outgoing client message ("roomid|text"). Captures the team for the run. */
		function handleOutgoing(state, msg) {
			const effects = [];
			const bar = msg.indexOf('|');
			if (bar < 0) return effects;
			const text = msg.slice(bar + 1);
			for (const cmd of text.split('\n')) {
				if (cmd.indexOf('/utm ') === 0) {
					state.lastUtm = { packed: cmd.slice(5), format: null };
					effects.push({ type: 'changed' });
				} else {
					// /search <format>  or  /challenge <user>, <format>
					const m = /(?:^|\s)\/(search|challenge)\s+(.*)$/.exec(cmd);
					const format = m && toID(m[1] === 'search' ? m[2] : m[2].split(',').slice(1).join(','));
					if (format && state.lastUtm) {
						state.lastUtm.format = format;
						effects.push({ type: 'changed' });
						const run = state.run;
						if (format === state.settings.formatId && run && !run.ended && state.lastUtm.packed) {
							const packed = state.lastUtm.packed;
							const team = run.team;
							if (!team || (team.source === 'showteam' && !teamsDiffer(team.packed, packed))) {
								// first team, or the full version (with spreads) of the team-sheet team
								effects.push({ type: 'teamCaptured', packed, source: 'utm' });
							} else if (teamsDiffer(team.packed, packed)) {
								state.nextSetDecision = { status: 'pending', at: Date.now() };
								effects.push({ type: 'teamMismatch', setId: null });
							} else if (state.nextSetDecision) {
								state.nextSetDecision = null;
								effects.push({ type: 'teamMatch' });
							}
						}
					}
				}
			}
			return effects;
		}

		// ---- Manual overrides ---------------------------------------------

		function markResult(state, result, opponent) {
			const run = state.run;
			if (!run) return [];
			const effects = [];
			let set = run.sets.find(s => !s.result);
			if (!set) {
				if (run.ended) return effects;
				set = newSet('manual-' + Date.now(), opponent, run);
				set.manual = true;
				run.sets.push(set);
			}
			if (opponent) set.opponent = opponent;
			set.resultLocked = false;
			finishSet(state, set, result, effects);
			set.resultLocked = true;
			effects.push({ type: 'changed' });
			return effects;
		}

		/** Re-derive the auto "ended" flag after manual edits. Manual end is left alone. */
		function syncRunEnded(state) {
			const run = state.run;
			if (!run || run.endReason === 'manual') return;
			if (run.playOn && !computeStage(run.sets || [], state.settings, true).eliminatedIn) run.playOn = false; // undone back below elimination
			const info = stageOf(run, state.settings);
			if (info.terminal && !run.ended) {
				run.ended = true;
				run.endedAt = Date.now();
			} else if (!info.terminal && run.ended) {
				run.ended = false;
				run.endedAt = null;
				run.endElo = null;
			}
		}

		function undoLastSet(state) {
			const run = state.run;
			if (!run || !run.sets.length) return false;
			const set = run.sets.pop();
			// Remember it so later messages from its rooms don't re-create it.
			if (!set.manual) (run.removed = run.removed || []).push(set.id);
			syncRunEnded(state);
			return true;
		}

		function endRun(state) {
			if (!state.run || state.run.ended) return false;
			state.run.ended = true;
			state.run.endedAt = Date.now();
			state.run.endReason = 'manual';
			return true;
		}

		/** Undo a manual "End run" (only if the record isn't already terminal). */
		function resumeRun(state) {
			const run = state.run;
			if (!run || !run.ended || stageOf(run, state.settings).terminal) return false;
			run.ended = false;
			run.endedAt = null;
			run.endReason = null;
			run.endElo = null;
			return true;
		}

		// ---- Import from saved replays ----------------------------------------

		const REPLAY_HOST = 'https://replay.pokemonshowdown.com/';
		/** Games of the same opponent closer than this (seconds) are grouped when the Bo3 link is missing. */
		const IMPORT_GROUP_WINDOW = 45 * 60;

		/** "https://replay.pokemonshowdown.com/<id>[.json][?p2]" or a bare id -> replay id (keeps any -<pw>pw). */
		function replayIdFromUrl(text) {
			let id = String(text || '').trim();
			const host = id.indexOf('replay.pokemonshowdown.com/');
			if (host >= 0) id = id.slice(host + 'replay.pokemonshowdown.com/'.length);
			id = id.replace(/[?#].*$/, '').replace(/\.(json|log)$/, '').replace(/\/$/, '').toLowerCase();
			return /^[a-z0-9]+-\d+(-[a-z0-9]+pw)?$/.test(id) ? id : null;
		}

		/** Key that identifies a game regardless of password suffix: "<format>-<number>". */
		function gameKey(roomidOrReplayId) {
			return replayBaseForRoom(String(roomidOrReplayId).replace(/^battle-/, ''));
		}

		/**
		 * Parse a replay JSON ({id, log, uploadtime, password, ...}) into one game from `userid`'s view.
		 * Returns null if the user didn't play in it.
		 */
		function parseReplayGame(replay, userid, sourceUrl) {
			if (!replay || typeof replay.log !== 'string') return null;
			const room = { players: {}, ratings: [], showteam: {}, showteamPacked: {}, playerElo: {}, lineup: newLineup() };
			let bo3 = null, gameNum = 0, result = null, time = 0;
			for (const line of replay.log.split('\n')) {
				const args = splitLine(line);
				lineupLine(room.lineup, args);
				switch (args[0]) {
				case 'player':
					if (args[2]) {
						room.players[args[1]] = args[2];
						if (args[4]) room.playerElo[args[1]] = Number(args[4]) || null;
					}
					break;
				case 'uhtml': {
					const m = args[1] === 'bestof' && /href="\/(game-bestof\d+-[a-z0-9-]+)"/.exec(line);
					if (m) {
						bo3 = m[1];
						const n = /Game (\d+)/.exec(line);
						if (n) gameNum = Number(n[1]);
					}
					break;
				}
				case 'showteam':
					room.showteamPacked[args[1]] = args.slice(2).join('|');
					room.showteam[args[1]] = packedSpecies(room.showteamPacked[args[1]]);
					break;
				case 'win':
					result = { winner: args.slice(1).join('|') };
					break;
				case 'tie':
					result = { tie: true };
					break;
				case 't:':
					if (!time) time = Number(args[1]) || 0;
					break;
				case 'raw': {
					const r = parseRatingLine(args.slice(1).join('|'));
					if (r) room.ratings.push(r);
					break;
				}
				}
			}
			const side = sides(room, userid);
			if (!side) return null;
			let id = replay.id;
			if (replay.password && !/pw$/.test(id)) id += `-${replay.password}pw`;
			const rating = room.ratings.find(r => toID(r.name) === userid) || null;
			return {
				id,
				roomid: 'battle-' + id,
				url: sourceUrl && replayIdFromUrl(sourceUrl) ? REPLAY_HOST + replayIdFromUrl(sourceUrl) : REPLAY_HOST + id,
				bo3,
				gameNum,
				opponent: side.oppName,
				result: !result ? null : result.tie ? 'T' : (toID(result.winner) === userid ? 'W' : 'L'),
				time: time || replay.uploadtime || 0,
				oppTeam: side.opp ? room.showteam[side.opp] || [] : [],
				oppPacked: side.opp ? room.showteamPacked[side.opp] || null : null,
				myPacked: room.showteamPacked[side.mine] || null,
				logLines: replay.log.split('\n').filter(Boolean),
				rating,
				preElo: room.playerElo[side.mine] || null,
				lineup: lineupFields(room.lineup, side.mine, side.opp),
			};
		}

		/** Game record (as stored in a set) for a parsed replay. */
		function importedGame(g) {
			const game = Object.assign({ roomid: g.roomid, result: g.result, replay: g.url }, g.lineup || {});
			if (g.logLines && g.logLines.length) game.log = { source: 'spectator', lines: g.logLines.length };
			return game;
		}

		/** Group parsed games into Bo3 sets (by Bo3 link, else same opponent within a time window). */
		function groupImportedGames(games) {
			const sorted = games.filter(Boolean).slice().sort((a, b) => a.time - b.time);
			const seen = {};
			const groups = [];
			for (const g of sorted) {
				if (seen[gameKey(g.id)]) continue;
				seen[gameKey(g.id)] = true;
				let group = g.bo3 ? groups.find(s => s.id === g.bo3) : null;
				if (!group && !g.bo3) {
					group = groups.find(s => !s.linked && toID(s.opponent) === toID(g.opponent) &&
						g.time - s.lastTime < IMPORT_GROUP_WINDOW && s.games.length < 3 &&
						Math.max(setScore(s).w, setScore(s).l) < 2);
				}
				if (!group) {
					group = { id: g.bo3 || 'import-' + gameKey(g.id), linked: !!g.bo3, opponent: g.opponent, games: [], parsed: [], lastTime: 0 };
					groups.push(group);
				}
				group.parsed.push(g);
				group.games.push(importedGame(g));
				group.lastTime = Math.max(group.lastTime, g.time);
			}
			return groups.map(group => {
				const parsed = group.parsed.slice().sort((a, b) => (a.gameNum - b.gameNum) || (a.time - b.time));
				group.games = parsed.map(importedGame);
				const score = setScore(group);
				const rated = parsed.find(g => g.rating);
				let result = null;
				if (rated && rated.rating.after !== rated.rating.before) result = rated.rating.after > rated.rating.before ? 'W' : 'L';
				else if (score.w >= 2) result = 'W';
				else if (score.l >= 2) result = 'L';
				else if (parsed.length) result = parsed[parsed.length - 1].result;
				const withTeam = parsed.find(g => g.oppTeam.length);
				const withSheet = parsed.find(g => g.oppPacked);
				const mine = parsed.find(g => g.myPacked);
				// raw logs travel separately (stored under their own keys, never in the run state)
				const logs = {};
				for (const g of parsed) if (g.logLines && g.logLines.length) logs[g.roomid] = g.logLines;
				return {
					id: group.id,
					opponent: group.opponent,
					games: group.games,
					result,
					eloBefore: rated ? rated.rating.before : (parsed[0] && parsed[0].preElo) || null,
					eloAfter: rated ? rated.rating.after : null,
					oppTeam: withTeam ? withTeam.oppTeam : [],
					oppTeamPacked: withSheet ? withSheet.oppPacked : null,
					myPacked: mine ? mine.myPacked : null,
					logs,
					time: parsed.length ? parsed[0].time : 0,
					endTime: group.lastTime,
				};
			});
		}

		/** Is an import candidate already part of the run? */
		function isImported(run, candidate) {
			if (!run) return false;
			const keys = {};
			for (const set of run.sets) {
				keys[set.id] = true;
				for (const g of set.games) keys[gameKey(g.roomid)] = true;
			}
			return !!keys[candidate.id] || candidate.games.some(g => keys[gameKey(g.roomid)]);
		}

		/** Manual sets with no games ("vs ?" placeholders added with Mark W/L). */
		function placeholderSets(run) {
			return run ? run.sets.filter(s => s.manual && !s.games.length) : [];
		}

		/**
		 * Insert imported sets into the run in chronological order. With `replacePlaceholders`,
		 * manual game-less sets are removed (their notes carry over in order). Returns effects.
		 */
		function importSets(state, candidates, replacePlaceholders) {
			const run = state.run;
			const effects = [];
			if (!run) return effects;
			// Even if every set is already in the run, an import can still supply a missing team.
			if (!run.team) {
				const withTeam = candidates.find(c => c.myPacked);
				if (withTeam) effects.push({ type: 'teamCaptured', packed: withTeam.myPacked, source: 'showteam' });
			}
			const fresh = candidates.filter(c => !isImported(run, c)).sort((a, b) => a.time - b.time);
			if (!fresh.length) return effects;
			// oldest placeholders are replaced first, one per imported set
			const placeholders = replacePlaceholders ? placeholderSets(run).slice(0, fresh.length) : [];
			if (placeholders.length) run.sets = run.sets.filter(s => placeholders.indexOf(s) < 0);
			const added = fresh.map((c, i) => {
				const old = placeholders[i];
				return {
					id: c.id,
					opponent: c.opponent,
					games: c.games.map(g => Object.assign({}, g)),
					result: c.result,
					manual: false,
					imported: true,
					eloBefore: c.eloBefore,
					eloAfter: c.eloAfter,
					oppTeam: c.oppTeam.slice(),
					oppTeamPacked: c.oppTeamPacked || null,
					note: old ? old.note : '',
					rating: old ? old.rating : 0,
					endedAt: (c.endTime || c.time) * 1000,
				};
			});
			run.removed = (run.removed || []).filter(id => !added.some(s => s.id === id));
			const order = new Map(run.sets.concat(added).map((s, i) => [s, i]));
			run.sets = run.sets.concat(added).sort((a, b) => {
				const ta = a.result ? a.endedAt || 0 : Infinity;
				const tb = b.result ? b.endedAt || 0 : Infinity;
				return ta - tb || order.get(a) - order.get(b);
			});
			const first = run.sets[0];
			if (first && first.imported && first.eloBefore != null) run.startElo = first.eloBefore;
			const last = run.sets.filter(s => s.eloAfter != null).pop();
			if (last) run.currentElo = last.eloAfter;
			syncRunEnded(state);
			effects.push({ type: 'changed' });
			return effects;
		}

		// ---- History, stats, backup -------------------------------------------

		/** Settings a run was played under (archived runs keep their own copy). */
		function runSettings(run, fallback) {
			return Object.assign({}, DEFAULT_SETTINGS, fallback || {}, run && run.settingsSnapshot || {});
		}

		/** Put a run into the history (newest first), replacing an older copy with the same id. */
		function archiveRun(history, run, settings) {
			if (!run) return history.slice();
			const copy = JSON.parse(JSON.stringify(run));
			if (!copy.id) copy.id = newRunId();
			copy.settingsSnapshot = Object.assign({}, settings || DEFAULT_SETTINGS, copy.settingsSnapshot || {});
			copy.archivedAt = Date.now();
			return history.filter(r => r.id !== copy.id).concat([copy]).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
		}

		function teamKey(run) {
			const species = run && run.team ? packedSpecies(run.team.packed) : [];
			return species.length ? species.slice().sort().join(' / ') : '';
		}

		/** One line per run for the History list. */
		function runSummary(run, settings) {
			const st = runSettings(run, settings);
			const info = stageOf(run, st);
			const end = run.endElo != null ? run.endElo : run.currentElo;
			return {
				id: run.id,
				event: run.event,
				player: run.player,
				startedAt: run.startedAt,
				team: run.team ? packedSpecies(run.team.packed) : [],
				record: recordText(info),
				stage: statusText(info, run),
				eloStart: run.startElo != null ? Math.round(run.startElo) : null,
				eloEnd: end != null ? Math.round(end) : null,
				eloDelta: run.startElo != null && end != null ? Math.round(end) - Math.round(run.startElo) : null,
			};
		}

		function bump(map, key, result, extra) {
			const row = map[key] = map[key] || Object.assign({ key, sets: 0, w: 0, l: 0, t: 0 }, extra || {});
			row.sets++;
			if (result === 'W') row.w++;
			else if (result === 'L') row.l++;
			else row.t++;
			return row;
		}

		/** Win rate (0..1) or null when there's too little data. */
		function winRate(row, minSets) {
			return row.sets >= (minSets || 1) ? row.w / row.sets : null;
		}

		/**
		 * Stats across runs: record per team (by its 6 species), win rate vs opponent Pokemon (team sheets),
		 * win rate per own lead pair (per game), and ELO per run.
		 */
		function computeStats(runs) {
			const teams = {}, vs = {}, leads = {};
			const elo = [];
			for (const run of runs) {
				const key = teamKey(run) || '(team not recorded)';
				const team = teams[key] = teams[key] || { key, species: run.team ? packedSpecies(run.team.packed) : [], runs: 0, sets: 0, w: 0, l: 0, t: 0 };
				team.runs++;
				for (const set of run.sets || []) {
					if (!set.result) continue;
					team.sets++;
					if (set.result === 'W') team.w++;
					else if (set.result === 'L') team.l++;
					else team.t++;
					for (const mon of new Set(set.oppTeam || [])) bump(vs, mon, set.result);
					for (const g of set.games || []) {
						if (!g.result || !g.leads || g.leads.length !== 2) continue;
						bump(leads, g.leads.slice().sort().join(' + '), g.result);
					}
				}
				const end = run.endElo != null ? run.endElo : run.currentElo;
				if (run.startElo != null || end != null) {
					elo.push({ id: run.id, event: run.event, startedAt: run.startedAt, start: run.startElo != null ? Math.round(run.startElo) : null, end: end != null ? Math.round(end) : null });
				}
			}
			elo.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
			return {
				teams: Object.values(teams).sort((a, b) => b.sets - a.sets),
				vsPokemon: Object.values(vs),
				leadPairs: Object.values(leads).sort((a, b) => b.sets - a.sets),
				elo,
			};
		}

		/** Sort vs-Pokemon rows: by 'rate' (rows under minSets last), 'sets' or 'name'. */
		function sortVsRows(rows, by, minSets) {
			const copy = rows.slice();
			if (by === 'name') return copy.sort((a, b) => a.key.localeCompare(b.key));
			if (by === 'sets') return copy.sort((a, b) => b.sets - a.sets || a.key.localeCompare(b.key));
			return copy.sort((a, b) => {
				const ra = winRate(a, minSets), rb = winRate(b, minSets);
				if (ra == null || rb == null) return (ra == null) - (rb == null) || b.sets - a.sets;
				return rb - ra || b.sets - a.sets;
			});
		}

		const BACKUP_SCHEMA = 'mock-regional-helper';
		const BACKUP_VERSION = 1;

		function exportBundle(runs) {
			return { schema: BACKUP_SCHEMA, schemaVersion: BACKUP_VERSION, exportedAt: new Date().toISOString(), runs: JSON.parse(JSON.stringify(runs)) };
		}

		/** Parse and validate a backup file. Throws an Error with a user-facing message if it's not usable. */
		function parseBackup(text) {
			let data;
			try { data = JSON.parse(text); } catch (e) { throw new Error('Not a valid JSON file.'); }
			if (!data || typeof data !== 'object' || data.schema !== BACKUP_SCHEMA) {
				throw new Error('This is not a Mock Regional Helper backup.');
			}
			if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 1) throw new Error('The backup has no valid schema version.');
			if (data.schemaVersion > BACKUP_VERSION) {
				throw new Error(`This backup was made by a newer version of the script (schema ${data.schemaVersion}); update the script first.`);
			}
			if (!Array.isArray(data.runs)) throw new Error('The backup has no list of runs.');
			const results = [null, 'W', 'L', 'T'];
			data.runs.forEach((run, i) => {
				const where = `Run ${i + 1}` + (run && typeof run.event === 'string' ? ` ("${run.event}")` : '');
				if (!run || typeof run !== 'object') throw new Error(`${where} is not an object.`);
				if (typeof run.id !== 'string' || !run.id) throw new Error(`${where} has no id.`);
				if (typeof run.event !== 'string') throw new Error(`${where} has no event name.`);
				if (typeof run.startedAt !== 'number') throw new Error(`${where} has no start date.`);
				if (run.team != null && (typeof run.team !== 'object' || typeof run.team.packed !== 'string')) throw new Error(`${where} has an invalid team.`);
				if (!Array.isArray(run.sets)) throw new Error(`${where} has no list of sets.`);
				run.sets.forEach((set, j) => {
					const at = `${where}, set ${j + 1}`;
					if (!set || typeof set !== 'object' || typeof set.id !== 'string') throw new Error(`${at} is invalid (no id).`);
					if (results.indexOf(set.result == null ? null : set.result) < 0) throw new Error(`${at} has an invalid result "${set.result}".`);
					if (!Array.isArray(set.games) || set.games.some(g => !g || typeof g.roomid !== 'string')) throw new Error(`${at} has invalid games.`);
					if (set.oppTeam != null && !Array.isArray(set.oppTeam)) throw new Error(`${at} has an invalid opponent team.`);
				});
			});
			return { runs: data.runs };
		}

		/** Add imported runs to the history, skipping ids already present (history, current run, or earlier in the file). */
		function mergeRuns(history, currentRun, runs) {
			const ids = new Set(history.map(r => r.id));
			if (currentRun && currentRun.id) ids.add(currentRun.id);
			let merged = history.slice();
			let added = 0, skipped = 0;
			for (const run of runs) {
				if (ids.has(run.id)) { skipped++; continue; }
				ids.add(run.id);
				merged = merged.concat([JSON.parse(JSON.stringify(run))]);
				added++;
			}
			merged.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
			return { history: merged, added, skipped };
		}

		// ---- Opponent team sheets, battle logs, battle data export ----------------

		/**
		 * Structured open team sheet from a packed |showteam| team: species, item, ability, moves, nature,
		 * gender, level (and teraType/hpType if present). Names are resolved with `dex` when given,
		 * otherwise de-ID'd ("SafetyGoggles" -> "Safety Goggles"). Team sheets carry no EVs/IVs.
		 */
		function sheetFromPacked(packed, dex) {
			return unpackTeam(packed, dex).map(set => {
				const mon = {
					species: set.species,
					item: set.item,
					ability: set.ability,
					moves: set.moves,
					nature: set.nature || '',
					gender: set.gender || '',
					level: set.level || 100,
				};
				if (set.teraType) mon.teraType = set.teraType;
				return mon;
			});
		}

		/** GM storage key for a game's battle log. */
		function logKey(roomid) {
			return 'mrh_log_' + roomid;
		}

		/**
		 * Accumulates one battle room's protocol from our own view. Every line is kept except |request|,
		 * whose JSON goes to `requests` (the first team-preview request and the first in-battle one, which
		 * has the exact stats of the brought Pokemon). An |init| block is the full log re-sent on (re)join,
		 * so it replaces what we had.
		 */
		function appendBattleLog(buf, lines) {
			if (lines.some(l => l.indexOf('|init|') === 0)) {
				buf.lines = [];
			}
			for (const line of lines) {
				if (!line) continue;
				if (line.indexOf('|request|') === 0) {
					let req = null;
					try { req = JSON.parse(line.slice(9)); } catch (e) { /* not JSON */ }
					if (!req || !req.side) continue;
					const kind = req.teamPreview ? 'preview' : 'battle';
					if (!buf.requests.some(r => r.kind === kind)) buf.requests.push({ kind, request: req });
					continue;
				}
				buf.lines.push(line);
			}
			return buf;
		}

		function newBattleLog(roomid, source) {
			return { roomid, source: source || 'player', lines: [], requests: [] };
		}

		/** Most common opponent sets per species (item / ability / move frequencies) from stored team sheets. */
		function opponentSetStats(runs, dex) {
			const bySpecies = {};
			const add = (map, key) => { if (key) map[key] = (map[key] || 0) + 1; };
			for (const run of runs) {
				for (const set of run.sets || []) {
					if (!set.oppTeamPacked) continue;
					for (const mon of sheetFromPacked(set.oppTeamPacked, dex)) {
						const row = bySpecies[mon.species] = bySpecies[mon.species] || { species: mon.species, count: 0, items: {}, abilities: {}, moves: {} };
						row.count++;
						add(row.items, mon.item);
						add(row.abilities, mon.ability);
						for (const move of mon.moves) add(row.moves, move);
					}
				}
			}
			const top = (map, n) => Object.keys(map).map(k => ({ name: k, count: map[k] }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
			return Object.values(bySpecies)
				.map(r => ({ species: r.species, count: r.count, items: top(r.items, 3), abilities: top(r.abilities, 2), moves: top(r.moves, 6) }))
				.sort((a, b) => b.count - a.count || a.species.localeCompare(b.species));
		}

		// ---- Backfill from replays (runs recorded before logs/sheets were captured) ------

		/** "<replay url>" -> "https://replay.pokemonshowdown.com/<id>.json" (keeps a -<pw>pw suffix). */
		function replayJsonUrl(url) {
			const id = replayIdFromUrl(url || '');
			return id ? REPLAY_HOST + id + '.json' : null;
		}

		function hasItems(list) {
			return !!(list && list.length);
		}

		/** Does this set/game still lack data a log could provide? */
		function gameNeedsLogData(set, game) {
			return !set.oppTeamPacked || !hasItems(set.oppTeam) || !hasItems(game.leads) || !hasItems(game.bring) ||
				!hasItems(game.oppLeads) || !hasItems(game.oppSeen) || !game.result;
		}

		/**
		 * Fill a set/game from a battle log (stored, or fetched from the replay): opponent team sheet and
		 * species, lineups, game result. Existing data is never overwritten. The log is read from the run
		 * player's side; if that name isn't in it (e.g. renamed), from the recorded opponent's side, swapped.
		 * Returns true if anything changed.
		 */
		function mergeLogIntoGame(run, set, game, lines) {
			const replay = { id: String(game.roomid || '').replace(/^battle-/, ''), log: lines.join('\n') };
			let parsed = parseReplayGame(replay, toID(run.player));
			let swapped = false;
			if (!parsed && set.opponent) {
				parsed = parseReplayGame(replay, toID(set.opponent));
				swapped = !!parsed;
			}
			if (!parsed) return false;
			const lu = parsed.lineup;
			const flip = r => (r === 'W' ? 'L' : r === 'L' ? 'W' : r);
			const view = swapped ? {
				oppPacked: parsed.myPacked,
				oppTeam: parsed.myPacked ? packedSpecies(parsed.myPacked) : [],
				leads: lu.oppLeads, bring: lu.oppSeen.slice(0, 4), oppLeads: lu.leads, oppSeen: lu.bring,
				result: flip(parsed.result),
			} : {
				oppPacked: parsed.oppPacked, oppTeam: parsed.oppTeam,
				leads: lu.leads, bring: lu.bring, oppLeads: lu.oppLeads, oppSeen: lu.oppSeen,
				result: parsed.result, opponent: parsed.opponent,
			};
			let changed = false;
			if (!set.oppTeamPacked && view.oppPacked) { set.oppTeamPacked = view.oppPacked; changed = true; }
			if (!hasItems(set.oppTeam) && hasItems(view.oppTeam)) { set.oppTeam = view.oppTeam.slice(); changed = true; }
			if (!set.opponent && view.opponent) { set.opponent = view.opponent; changed = true; }
			for (const key of ['leads', 'bring', 'oppLeads', 'oppSeen']) {
				if (!hasItems(game[key]) && hasItems(view[key])) { game[key] = view[key].slice(); changed = true; }
			}
			if (!game.result && view.result) { game.result = view.result; changed = true; }
			return changed;
		}

		/**
		 * What a backfill would do: `local` = games with a stored log that can fill missing data,
		 * `fetch` = games with no stored log but a replay link, `missing` = neither.
		 */
		function backfillPlan(runs, hasLog) {
			const plan = { local: [], fetch: [], missing: [] };
			for (const run of runs) {
				for (const set of run.sets || []) {
					for (const game of set.games || []) {
						const item = { run, set, game };
						if (hasLog(game.roomid)) {
							if (gameNeedsLogData(set, game)) plan.local.push(item);
						} else if (replayJsonUrl(game.replay)) {
							plan.fetch.push(Object.assign(item, { url: replayJsonUrl(game.replay) }));
						} else {
							plan.missing.push(item);
						}
					}
				}
			}
			return plan;
		}

		const DATA_SCHEMA = 'mock-regional-helper/battle-data';
		const DATA_VERSION = 1;

		/**
		 * Battle data bundle (for external analysis tools). `helpers`: { format, player, dex, getLog(roomid) -> stored log or null,
		 * paste(packed) -> Showdown export text, settingsFor(run) }.
		 */
		function buildDataExport(runs, helpers) {
			const h = helpers || {};
			return {
				schema: DATA_SCHEMA,
				schemaVersion: DATA_VERSION,
				format: h.format || DEFAULT_SETTINGS.formatId,
				exportedAt: new Date().toISOString(),
				player: h.player || (runs[0] && runs[0].player) || '',
				runs: runs.map(run => {
					const settings = h.settingsFor ? h.settingsFor(run) : runSettings(run);
					return {
						id: run.id,
						event: run.event,
						player: run.player,
						startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
						myTeamPaste: run.team ? run.team.text || (h.paste ? h.paste(run.team.packed) : exportTeam(unpackTeam(run.team.packed))) : null,
						myTeamHasSpreads: !!(run.team && run.team.source === 'utm'),
						sets: run.sets.map((set, i) => ({
							round: roundLabel(i, settings),
							opponent: set.opponent,
							result: set.result,
							oppTeamSheet: set.oppTeamPacked ? sheetFromPacked(set.oppTeamPacked, h.dex) : null,
							oppTeamPacked: set.oppTeamPacked || null,
							oppTeamPaste: set.oppTeamPacked ? (h.paste ? h.paste(set.oppTeamPacked) : exportTeam(unpackTeam(set.oppTeamPacked))) : null,
							oppSpecies: set.oppTeam || [],
							games: set.games.map((g, j) => {
								const log = h.getLog ? h.getLog(g.roomid) : null;
								return {
									n: j + 1,
									roomid: g.roomid,
									result: g.result,
									replayUrl: g.replay || null,
									myLeads: g.leads || [],
									myBring: g.bring || [],
									oppLeads: g.oppLeads || [],
									oppRevealed: g.oppSeen || [],
									logSource: log ? log.source : null,
									logMissing: !(log && log.lines && log.lines.length),
									log: log ? log.lines : [],
									requests: log ? log.requests.map(r => r.request) : [],
								};
							}),
						})),
					};
				}),
			};
		}

		// ---- Report card (layout model; drawing happens in the browser) ----------------

		/** Logical size in CSS px (drawn at 2x). Rows grow with the number of sets. */
		const CARD = { width: 600, pad: 22, header: 236, row: 50, noteExtra: 17, empty: 40, footer: 34 };

		const CARD_ACCENTS = {
			champion: '#f2c14e', // gold
			topcut: '#a371f7', // made top cut
			alive: '#4c8dff', // still in Swiss
			out: '#e5534b', // eliminated in Swiss
			topcutOut: '#d29922', // eliminated in top cut (still a good run)
			ended: '#8b949e', // ended manually
		};

		function cardAccent(info, run) {
			if (info.stage === 'Champion') return 'champion';
			if (info.stage === 'Eliminated') return /^(Top|Finals)/.test(info.eliminatedIn || '') ? 'topcutOut' : 'out';
			if (info.stage === 'Top Cut') return 'topcut';
			if (run && run.ended) return 'ended';
			return 'alive';
		}

		/** Unique lead pairs of a set's games, e.g. "Glimmora+Kingambit, Charizard+Garchomp". */
		function setLeadsText(set) {
			const pairs = [];
			for (const g of set.games || []) {
				if (g.leads && g.leads.length) pushUnique(pairs, g.leads.join('+'));
			}
			return pairs.join(', ');
		}

		/** Everything the report card shows, plus its height. opts: { showNotes } */
		function reportCardModel(run, settings, opts) {
			const showNotes = !(opts && opts.showNotes === false);
			const info = stageOf(run, settings);
			const end = run.endElo != null ? run.endElo : run.currentElo;
			const headline = info.stage === 'Champion' ? 'Champion' :
				info.stage === 'Eliminated' ? `Eliminated · ${info.eliminatedIn}` :
				run.ended ? `${info.stage} · ended` : info.stage;
			const rows = run.sets.map((set, i) => {
				const score = setScore(set);
				const note = showNotes && set.note ? set.note.replace(/\s+/g, ' ').trim() : '';
				return {
					round: roundLabel(i, settings),
					opponent: set.opponent || '?',
					result: set.result || null,
					score: set.games.length ? `${score.w}-${score.l}` : '',
					opp: (set.oppTeam || []).slice(0, 6),
					leads: setLeadsText(set),
					note: note.length > 110 ? note.slice(0, 107) + '…' : note,
					rating: showNotes ? set.rating || 0 : 0,
				};
			});
			const notes = rows.filter(r => r.note).length;
			const height = CARD.header + (rows.length ? rows.length * CARD.row + notes * CARD.noteExtra : CARD.empty) + CARD.footer;
			const accent = cardAccent(info, run);
			return {
				width: CARD.width,
				height,
				event: run.event || 'Mock Regional',
				player: run.player || '',
				date: run.startedAt || null,
				record: recordText(info),
				headline,
				accent,
				accentColor: CARD_ACCENTS[accent],
				elo: { start: run.startElo != null ? Math.round(run.startElo) : null, end: end != null ? Math.round(end) : null },
				team: run.team ? packedSpecies(run.team.packed).slice(0, 6) : [],
				rows,
			};
		}

		// ---- Discord formatting ---------------------------------------------

		function eloText(before, after) {
			if (before == null || after == null) return '';
			const b = Math.round(before), a = Math.round(after);
			const d = a - b;
			return `${b} → ${a} (${d >= 0 ? '+' : ''}${d})`;
		}

		/** "1795 → 1812" for a set; empty when unknown or a manual set with no real change (v0.1 refetch artifact). */
		function setEloText(set) {
			if (set.eloBefore == null || set.eloAfter == null) return '';
			const b = Math.round(set.eloBefore), a = Math.round(set.eloAfter);
			if (set.manual && b === a) return '';
			return `${b} → ${a}`;
		}

		/** Build the post as logical blocks (header, team, one per set). */
		function discordBlocks(run, settings, opts) {
			opts = opts || {};
			const info = stageOf(run, settings);
			const blocks = [];
			let header = `**${run.event}** — ${run.player || 'unknown player'}\n`;
			if (opts.pasteUrl) header += `Team: <${opts.pasteUrl}>\n`;
			const endElo = run.endElo != null ? run.endElo : run.currentElo;
			const elo = eloText(run.startElo, endElo);
			if (elo) header += `ELO: ${elo}\n`;
			header += `Record: **${recordText(info)}** · ${statusText(info, run)}`;
			blocks.push(header);

			if (!opts.pasteUrl && opts.teamText) {
				blocks.push('Team:\n```\n' + opts.teamText.trim() + '\n```');
			}

			run.sets.forEach((set, i) => {
				const score = setScore(set);
				let line = `**${roundLabel(i, settings)}** vs ${set.opponent || '?'} — `;
				line += set.result ? `**${set.result}**` : '*in progress*';
				if (set.games.length) line += ` (${score.w}-${score.l})`;
				const setElo = setEloText(set);
				if (setElo) line += ` · ${setElo}`;
				const lineups = settings.discordLineups !== false;
				const games = set.games.map((g, j) => {
					const lu = lineups ? lineupText(g, false) : '';
					return `G${j + 1} ${g.result || '?'}` + (lu ? ` · ${lu}` : '') + (g.replay ? ` <${g.replay}>` : '');
				});
				// with lineups each game gets its own line; otherwise keep the compact one-line form
				const multiline = lineups && set.games.some(g => lineupText(g, false));
				if (games.length) line += '\n' + games.join(multiline ? '\n' : ' · ');
				if (set.oppTeam.length) line += `\nOpp: ${set.oppTeam.join(' / ')}`;
				if (set.note || set.rating) {
					const note = (set.note || '').trim().replace(/\n+/g, '\n> ');
					line += `\n> ${note}${set.rating ? `${note ? ' ' : ''}(${set.rating}/5)` : ''}`;
				}
				blocks.push(line);
			});
			return blocks;
		}

		/** Split an oversized block by lines, re-opening code fences across pieces. */
		function splitBlock(block, limit) {
			const fenced = block.indexOf('```') >= 0;
			const lines = block.split('\n');
			const pieces = [];
			let cur = '';
			let inFence = false;
			for (const line of lines) {
				const closeLen = inFence ? 4 : 0; // "\n```"
				if (cur && cur.length + 1 + line.length + closeLen > limit) {
					pieces.push(inFence ? cur + '\n```' : cur);
					cur = inFence ? '```\n' : '';
				}
				cur += (cur && cur !== '```\n' ? '\n' : '') + line.slice(0, limit - 8);
				if (fenced && /^```/.test(line)) inFence = !inFence;
			}
			if (cur) pieces.push(cur);
			return pieces;
		}

		/** Pack blocks into messages of at most `limit` chars. */
		function chunkBlocks(blocks, limit) {
			limit = limit || DISCORD_LIMIT;
			const pieces = [];
			for (const b of blocks) {
				if (b.length <= limit) pieces.push(b);
				else pieces.push.apply(pieces, splitBlock(b, limit));
			}
			const chunks = [];
			let cur = '';
			for (const p of pieces) {
				if (!cur) cur = p;
				else if (cur.length + 2 + p.length <= limit) cur += '\n\n' + p;
				else { chunks.push(cur); cur = p; }
			}
			if (cur) chunks.push(cur);
			return chunks;
		}

		function formatDiscord(run, settings, opts) {
			return chunkBlocks(discordBlocks(run, settings, opts), DISCORD_LIMIT);
		}

		return {
			DEFAULT_SETTINGS, DISCORD_LIMIT,
			toID, unescapeHtml, decodeFrame, decodeOutgoing, parseBlock, splitLine, parseIdentity,
			parseRatingLine, parseReplayPopup, replayBaseForRoom, replayMatchesRoom,
			unpackTeam, exportTeam, packedSpecies, stripSpreads,
			swissRounds, roundLabel, computeStage, stageOf, playsOn, canPlayOn, continuePlaying, recordText, statusText,
			newState, loadState, newRun, newTracker, handleIncoming, handleOutgoing,
			markResult, undoLastSet, endRun, resumeRun, syncRunEnded, setScore, teamsDiffer, decideTeam,
			replayIdFromUrl, parseReplayGame, groupImportedGames, isImported, placeholderSets, importSets,
			setEloText, discordBlocks, chunkBlocks, formatDiscord,
			speciesFromDetails, newLineup, lineupLine, lineupFields, lineupText, newRunId,
			runSettings, archiveRun, runSummary, computeStats, winRate, sortVsRows, exportBundle, parseBackup, mergeRuns,
			BACKUP_SCHEMA, BACKUP_VERSION,
			CARD, CARD_ACCENTS, reportCardModel, setLeadsText,
			replayJsonUrl, gameNeedsLogData, mergeLogIntoGame, backfillPlan,
			isBattleRoom, sheetFromPacked, logKey, appendBattleLog, newBattleLog, opponentSetStats, buildDataExport, DATA_SCHEMA, DATA_VERSION,
		};
	})();

	if (typeof module === 'object' && module.exports) {
		module.exports = Core;
		return;
	}

	/* =====================================================================
	 * Browser side
	 * ===================================================================== */

	const STORE_KEY = 'mrh_state';
	const UI_KEY = 'mrh_ui';
	const ELO_FALLBACK_DELAY = 10000;
	const REPLAY_DELAY = 1500;
	const REPLAY_TIMEOUT = 20000;
	const TAB_ROOT_ID = 'mrh-tab-root';
	const REPLAY_HOST = 'https://replay.pokemonshowdown.com/';
	const VERSION = '1.1.1';
	const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

	const state = Core.loadState(GM_getValue(STORE_KEY, null));
	const track = Core.newTracker();
	const ui = {
		pendingNote: null,
		editing: null,
		chunks: null,
		busy: '',
		error: '',
		drafts: {},
		open: {},
		sawTraffic: false,
		/** roomid -> 'saving' | 'failed' (transient replay status) */
		replay: {},
		showDetails: false,
		/** which tab page is shown: 'run' | 'history' | 'archived' | 'stats' | 'backup' */
		view: 'run',
		archivedId: null,
		statsSort: 'rate',
		/** report card being previewed: { runId, archived, from, showNotes, canvas, key, busy } */
		card: null,
		backupMsg: null,
		/** open "different team" alert: { setId } (null setId = the next set, raised at search time) */
		teamAlert: null,
		imp: { loading: '', error: '', candidates: null, picked: {}, replace: true, days: 2 },
		/** where the main view renders: the Showdown tab root or the sidebar body */
		container: null,
		mode: null,
	};
	let badge = null;
	let sidebar = null;
	let toasts = null;
	let alertBox = null;

	function save() {
		GM_setValue(STORE_KEY, JSON.stringify(state));
	}

	// Archived runs live under their own key so the frequent state saves stay small.
	const HISTORY_KEY = 'mrh_history';
	let runHistory = loadHistory();

	function loadHistory() {
		try {
			const list = JSON.parse(GM_getValue(HISTORY_KEY, '[]'));
			return Array.isArray(list) ? list : [];
		} catch (err) {
			console.error('[MockRegional] history could not be read', err);
			return [];
		}
	}

	function saveHistory() {
		GM_setValue(HISTORY_KEY, JSON.stringify(runHistory));
	}

	function log(...args) {
		console.log('[MockRegional]', ...args);
	}

	// ---- Page hook ---------------------------------------------------------
	// Runs in the page context so it wraps the page's own WebSocket / Worker
	// regardless of userscript sandboxing, and can create a real Showdown tab.
	// Talks to us via CustomEvents.
	function pageHook() {
		if (window.__mrhHooked) return;
		window.__mrhHooked = true;
		const emit = (type, data) => {
			if (typeof data === 'string') window.dispatchEvent(new CustomEvent(type, { detail: data }));
		};
		const log = (...args) => console.log('[MockRegional]', ...args);
		let lastSocket = null;
		let lastWorker = null;
		// Once the new client's PS.receive/PS.send are wrapped, they carry all traffic and the
		// transport-level hooks below go quiet (otherwise every message would be seen twice).
		let psHooked = false;

		const NativeWS = window.WebSocket;
		function HookedWebSocket(url, protocols) {
			const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
			if (/psim\.us|pokemonshowdown\.com|\/showdown\//.test(String(url))) {
				lastSocket = ws;
				ws.addEventListener('message', e => { if (!psHooked) emit('mrh:in', e.data); });
				const send = ws.send;
				ws.send = function (data) {
					if (!psHooked) emit('mrh:out', data);
					return send.call(ws, data);
				};
			}
			return ws;
		}
		HookedWebSocket.prototype = NativeWS.prototype;
		['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { HookedWebSocket[k] = NativeWS[k]; });
		window.WebSocket = HookedWebSocket;

		// Preact client connects from a Web Worker; messages cross postMessage already decoded.
		const NativeWorker = window.Worker;
		if (NativeWorker) {
			const HookedWorker = function (url, options) {
				const w = new NativeWorker(url, options);
				if (/client-connection-worker/.test(String(url))) {
					lastWorker = w;
					w.addEventListener('message', e => {
						if (!psHooked && e.data && e.data.type === 'message') emit('mrh:in', e.data.data);
					});
					const post = w.postMessage;
					w.postMessage = function (data) {
						if (!psHooked && data && data.type === 'send') emit('mrh:out', data.data);
						return post.apply(w, arguments);
					};
				}
				return w;
			};
			HookedWorker.prototype = NativeWorker.prototype;
			window.Worker = HookedWorker;
		}

		// New (preact) client: PS.receive gets every server message (">roomid\n|..." text) and
		// PS.send(msg, roomid) every outgoing one, whatever the transport. Unlike the Worker hook this
		// still works if the userscript was injected after the client opened its connection.
		function hookPS() {
			const PS = window.PS;
			if (psHooked || !PS || typeof PS.receive !== 'function' || typeof PS.send !== 'function') return psHooked;
			const receive = PS.receive;
			PS.receive = function (msg) {
				if (typeof msg === 'string') emit('mrh:in', msg);
				return receive.apply(this, arguments);
			};
			const send = PS.send;
			PS.send = function (msg, roomid) {
				if (typeof msg === 'string') emit('mrh:out', (roomid || '') + '|' + msg);
				return send.apply(this, arguments);
			};
			psHooked = true;
			// if we were injected late, the |updateuser| login message has already gone by
			if (PS.user && PS.user.named && PS.user.name) {
				emit('mrh:in', `|updateuser| ${PS.user.name}|1|${PS.user.avatar || ''}|{}`);
			}
			log('new client: hooked PS.receive / PS.send');
			return true;
		}
		if (!hookPS()) {
			const started = Date.now();
			const timer = setInterval(() => {
				// the classic client never defines PS; stop looking once it's clearly running
				if (hookPS() || (window.app && window.app._addRoom) || Date.now() - started > 60000) clearInterval(timer);
			}, 50);
		}

		window.addEventListener('mrh:send', e => {
			let req;
			try { req = JSON.parse(e.detail); } catch (err) { return; }
			const roomid = req.roomid || '';
			if (window.app && typeof window.app.send === 'function') {
				window.app.send(req.msg, roomid);
			} else if (window.PS && typeof window.PS.send === 'function') {
				window.PS.send(req.msg, roomid);
			} else if (lastWorker) {
				lastWorker.postMessage({ type: 'send', data: roomid + '|' + req.msg });
			} else if (lastSocket) {
				const sockjs = /\/\d+\/[^/]+\/websocket$/.test(lastSocket.url);
				lastSocket.send(sockjs ? JSON.stringify([roomid + '|' + req.msg]) : roomid + '|' + req.msg);
			}
		});

		// Side-room tab in the classic client, created the same way Showdex creates its Hellodex tab:
		// app._addRoom(id, 'html', nojoin) then move it from roomList to sideRoomList.
		const TAB_ID = 'view-mockregional';
		const TAB_WAIT_MS = 30000;
		let iconPatched = false;
		let pendingOpen = null;

		const isClassic = () => !!(window.app && typeof window.app._addRoom === 'function' && window.app.rooms && window.app.topbar);
		const isPreact = () => !isClassic() && !!(window.PS && typeof window.PS.send === 'function');
		/** The new client's panel classes load after PS itself (panels.js). */
		const preactReady = () => isPreact() && typeof window.PS.addRoomType === 'function' && typeof window.PS.join === 'function' &&
			typeof window.PSRoom === 'function' && typeof window.PSRoomPanel === 'function' && typeof window.PSPanelWrapper === 'function' &&
			!!window.preact && typeof window.preact.h === 'function';

		/** Create (or repair) and show the tab. Classic client must be ready. */
		function openTab(focus) {
			const app = window.app;
			let room = app.rooms[TAB_ID];
			if (!room) {
				room = app._addRoom(TAB_ID, 'html', true, 'Mock Regional');
				if (!room || !room.el) throw new Error('app._addRoom returned no room');
			}
			// also repairs a room the client created itself (e.g. from a /view-mockregional URL)
			if (app.roomList.indexOf(room) >= 0) {
				app.roomList.splice(app.roomList.indexOf(room), 1);
				if (app.sideRoomList.indexOf(room) < 0) app.sideRoomList.push(room);
			}
			room.isSideRoom = true;
			room.minWidth = 360;
			room.maxWidth = 760;
			// Not a server room: don't send /leave. Report the close from destroy(), which only runs when
			// the room is really removed; requestLeave() is also called on beforeunload just to ask
			// whether leaving is OK, so it can't be used as a close signal.
			room.leave = function () {};
			if (!room.mrhDestroyHooked) {
				room.mrhDestroyHooked = true;
				const destroy = room.destroy;
				room.destroy = function () {
					emit('mrh:tabclosed', '1');
					return typeof destroy === 'function' ? destroy.apply(this, arguments) : undefined;
				};
			}
			if (!room.el.querySelector('#mrh-tab-root')) {
				room.$el.html('');
				const root = document.createElement('div');
				root.id = 'mrh-tab-root';
				room.el.appendChild(root);
			}
			if (!iconPatched && typeof app.topbar.renderRoomTab === 'function') {
				iconPatched = true;
				const original = app.topbar.renderRoomTab.bind(app.topbar);
				app.topbar.renderRoomTab = function (appRoom, appRoomId) {
					const buf = original(appRoom, appRoomId);
					const rid = (appRoom && appRoom.id) || appRoomId;
					return rid === TAB_ID && typeof buf === 'string' ? buf.replace('fa-file-text-o', 'fa-trophy') : buf;
				};
			}
			if (focus) app.focusRoomRight(TAB_ID);
			app.topbar.updateTabbar();
		}

		// New (preact) client: a custom room type in PS.roomTypes, opened as a right-side room, the same
		// way Showdex registers and opens its Hellodex (PS.addRoomType + PS.join).
		const NEW_TAB_ID = 'mockregional';
		let newTypeRegistered = false;
		// Focusing the room puts /mockregional in the URL; after a reload the client would then try to
		// /join a server room of that name. Showdex rewrites its /hellodex URL back to / the same way.
		function resetTabUrl() {
			if (window.location.pathname.indexOf('/' + NEW_TAB_ID) === 0 && window.history) {
				window.history.replaceState(window.PS && window.PS.router ? window.PS.router.panelState : window.history.state, '', '/');
			}
		}
		resetTabUrl(); // runs at document-start, before the client reads the URL
		function registerNewTabType() {
			if (newTypeRegistered) return;
			const { PS, PSRoom, PSRoomPanel, PSPanelWrapper, preact } = window;
			class MockRegionalRoom extends PSRoom {
				constructor(options) {
					super(options);
					this.title = 'Mock Regional';
					this.type = NEW_TAB_ID;
					this.classType = NEW_TAB_ID;
					this.location = 'right';
					this.noURL = true;
				}
				// not a server room, so nothing to /leave; destroy() only runs when the room is really closed
				destroy() {
					emit('mrh:tabclosed', '1');
					return super.destroy();
				}
			}
			class MockRegionalPanel extends PSRoomPanel {
				componentDidMount() {
					super.componentDidMount();
					emit('mrh:tabready', '1');
				}
				focus() {
					if (super.focus) super.focus();
					resetTabUrl();
				}
				render() {
					// the userscript renders into this div; preact leaves children it didn't create alone
					return preact.h(PSPanelWrapper, { room: this.props.room }, preact.h('div', { id: 'mrh-tab-root' }));
				}
			}
			Object.assign(MockRegionalPanel, {
				id: NEW_TAB_ID,
				routes: [NEW_TAB_ID],
				Model: MockRegionalRoom,
				location: 'right',
				title: 'Mock Regional',
				noURL: true,
				icon: preact.h('i', { class: 'fa fa-trophy', 'aria-hidden': true }),
			});
			PS.addRoomType(MockRegionalPanel);
			newTypeRegistered = true;
		}
		function openNewTab(focus) {
			registerNewTabType();
			window.PS.join(NEW_TAB_ID, { noURL: true, autofocus: focus, autoclosePopups: false });
			window.PS.update();
			resetTabUrl();
		}

		// Waits for either client instead of failing on the first try. The sidebar is only a last resort:
		// no usable client (or the new client's panel API) within TAB_WAIT_MS, or the tab code throwing.
		window.addEventListener('mrh:opentab', e => {
			let req = {};
			try { req = JSON.parse(e.detail); } catch (err) { /* defaults */ }
			const focus = req.focus !== false;
			if (pendingOpen) {
				pendingOpen.focus = pendingOpen.focus || focus;
				return;
			}
			const job = pendingOpen = { focus, started: Date.now(), logged: false };
			const attempt = () => {
				if (isClassic()) {
					pendingOpen = null;
					try {
						openTab(job.focus);
					} catch (err) {
						log('classic client found but creating the tab failed:', err);
						emit('mrh:taberror', String(err && err.message || err));
						return;
					}
					log(`mode: tab (classic client; side room ${TAB_ID}${job.logged ? `, after waiting ${Date.now() - job.started} ms` : ''})`);
					emit('mrh:tabready', '1');
					return;
				}
				if (preactReady()) {
					pendingOpen = null;
					try {
						openNewTab(job.focus);
					} catch (err) {
						log('new client found but creating the tab failed; using the sidebar:', err);
						emit('mrh:tabunavailable', 'new client tab error: ' + String(err && err.message || err));
						return;
					}
					log(`mode: tab (new client; room ${NEW_TAB_ID} in PS.rightRoomList${job.logged ? `, after waiting ${Date.now() - job.started} ms` : ''})`);
					// focusing an already-mounted room doesn't remount it, so announce it here too
					emit('mrh:tabready', '1');
					return;
				}
				if (Date.now() - job.started < TAB_WAIT_MS) {
					if (!job.logged) {
						job.logged = true;
						const what = isPreact() ? 'new client panel classes (PSRoomPanel etc.) not loaded yet' :
							window.app ? 'window.app has no _addRoom/rooms/topbar yet' : 'neither window.app nor window.PS defined yet';
						log('waiting for the Showdown client: ' + what);
					}
					setTimeout(attempt, 500);
					return;
				}
				pendingOpen = null;
				const why = isPreact() ? 'new client without PS.addRoomType/PSRoomPanel/PSPanelWrapper/preact' : 'no Showdown client found';
				log(`mode: sidebar (${why} after ${TAB_WAIT_MS / 1000}s; window.app=${typeof window.app}, window.PS=${typeof window.PS})`);
				emit('mrh:tabunavailable', why);
			};
			attempt();
		});
	}

	function injectPageHook() {
		const inject = () => {
			const script = document.createElement('script');
			script.textContent = '(' + pageHook.toString() + ')();';
			(document.head || document.documentElement).appendChild(script);
			script.remove();
		};
		if (document.documentElement) {
			inject();
			return;
		}
		// At document-start there may be no <html> yet. Mutation observer callbacks run in the
		// microtask checkpoint the parser performs before executing the first page script.
		const observer = new MutationObserver(() => {
			if (!document.documentElement) return;
			observer.disconnect();
			inject();
		});
		observer.observe(document, { childList: true });
	}

	function sendToRoom(roomid, msg) {
		window.dispatchEvent(new CustomEvent('mrh:send', { detail: JSON.stringify({ roomid, msg }) }));
	}

	// ---- Network helpers -----------------------------------------------------

	function request(opts) {
		return new Promise(resolve => {
			GM_xmlhttpRequest(Object.assign({
				timeout: 15000,
				onload: res => resolve(res),
				onerror: () => resolve(null),
				ontimeout: () => resolve(null),
			}, opts));
		});
	}

	async function getJson(url) {
		const res = await request({ method: 'GET', url });
		if (!res || res.status !== 200) return null;
		try { return JSON.parse(res.responseText); } catch (e) { return null; }
	}

	async function fetchElo(userid) {
		if (!userid) return null;
		const data = await getJson(`https://pokemonshowdown.com/users/${userid}.json?t=${Date.now()}`);
		if (!data) return null;
		const r = data.ratings && data.ratings[state.settings.formatId];
		return r && typeof r.elo === 'number' ? r.elo : 1000;
	}

	async function createPaste(title, paste, author, notes) {
		const body = new URLSearchParams({ title, paste, author, notes }).toString();
		const res = await request({
			method: 'POST',
			url: 'https://pokepast.es/create',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			data: body,
		});
		if (!res || res.status >= 400) return null;
		const url = res.finalUrl || '';
		return /^https:\/\/pokepast\.es\/[0-9a-f]+\/?$/i.test(url) ? url.replace(/\/$/, '') : null;
	}

	/** Run async `fn` over `items` with limited concurrency. */
	async function mapLimit(items, limit, fn) {
		const out = new Array(items.length);
		let next = 0;
		const worker = async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
		return out;
	}

	// ---- Team ----------------------------------------------------------------

	function teamTextFromPacked(packed) {
		try {
			const S = pageWindow.Storage;
			if (S && typeof S.exportTeam === 'function') {
				const text = S.exportTeam(packed);
				if (text) return text.replace(/ +\n/g, '\n');
			}
		} catch (e) { /* fall back */ }
		try {
			const T = pageWindow.Teams;
			if (T && typeof T.unpack === 'function' && typeof T.export === 'function') {
				const text = T.export(T.unpack(packed));
				if (text) return text;
			}
		} catch (e) { /* fall back */ }
		let dex = null;
		try { dex = pageWindow.Dex && pageWindow.Dex.species ? pageWindow.Dex : null; } catch (e) { /* none */ }
		return Core.exportTeam(Core.unpackTeam(packed, dex));
	}

	/** source: 'utm' (full team from search) or 'showteam' (open team sheet, no EVs/IVs). */
	function captureTeam(packed, source) {
		if (!state.run || !packed) return;
		state.run.team = { packed, text: teamTextFromPacked(packed), pastes: {}, source: source || 'utm' };
		ui.chunks = null;
	}

	function sharedTeamText(run, settings) {
		const team = run && run.team;
		if (!team) return '';
		return settings.includeSpreads ? team.text : Core.stripSpreads(team.text);
	}

	// ---- Effects -------------------------------------------------------------

	function findGame(roomid) {
		if (!state.run) return null;
		for (const set of state.run.sets) {
			for (const g of set.games) if (g.roomid === roomid) return g;
		}
		return null;
	}

	function requestReplay(roomid, delay) {
		ui.replay[roomid] = 'saving';
		setTimeout(() => sendToRoom(roomid, '/savereplay'), delay);
		setTimeout(() => {
			const game = findGame(roomid);
			if (ui.replay[roomid] === 'saving' && !(game && game.replay)) {
				ui.replay[roomid] = 'failed';
				render();
			}
		}, delay + REPLAY_TIMEOUT);
	}

	function applyEffects(effects) {
		if (!effects.length) return;
		for (const fx of effects) {
			if (fx.type === 'savereplay') {
				requestReplay(fx.roomid, REPLAY_DELAY);
			} else if (fx.type === 'replaySaved') {
				delete ui.replay[fx.roomid];
				ui.chunks = null;
				toast(`${fx.label} replay saved`);
			} else if (fx.type === 'replayFailed') {
				for (const id of Object.keys(ui.replay)) if (ui.replay[id] === 'saving') ui.replay[id] = 'failed';
			} else if (fx.type === 'teamMismatch') {
				log('team differs from the run team; asking whether to record', fx.setId || '(next set)');
				ui.teamAlert = { setId: fx.setId };
			} else if (fx.type === 'teamMatch') {
				ui.teamAlert = null;
			} else if (fx.type === 'teamSkipped') {
				ui.teamAlert = null;
				toast('Different team: this set is not being recorded.', 5000);
			} else if (fx.type === 'untracked') {
				log('Bo3 not tracked because the run is ended:', fx.setId);
				toast('A Bo3 started but your run is ended, so it is not being tracked. Use Resume run to track it.', 8000);
			} else if (fx.type === 'setEnded') {
				// an unanswered "different team" alert defaults to recording once the set is over
				if (ui.teamAlert && ui.teamAlert.setId === fx.setId) ui.teamAlert = null;
				ui.pendingNote = fx.setId;
				ui.chunks = null;
				scheduleEloFallback(fx.setId);
			} else if (fx.type === 'runEnded') {
				ui.showDetails = false;
				scheduleFinalElo(ELO_FALLBACK_DELAY + 2000);
			} else if (fx.type === 'teamCaptured') {
				const team = state.run && state.run.team;
				if (!team || (team.source === 'showteam' && fx.source === 'utm')) captureTeam(fx.packed, fx.source);
			}
		}
		save();
		render();
	}

	function scheduleEloFallback(setId) {
		setTimeout(async () => {
			const set = state.run && state.run.sets.find(s => s.id === setId);
			// manual sets have no rating line; a refetch would just repeat the current ELO
			if (!set || set.manual || set.eloAfter != null) return;
			const elo = await fetchElo(Core.toID(state.run.player));
			if (elo == null || !state.run) return;
			set.eloAfter = Math.round(elo);
			state.run.currentElo = elo;
			save();
			render();
		}, ELO_FALLBACK_DELAY);
	}

	/** Final ELO: prefer the last set's rating-line value; only fetch the users JSON if there is none. */
	function scheduleFinalElo(delay) {
		setTimeout(async () => {
			const run = state.run;
			if (!run) return;
			const done = run.sets.filter(s => s.result && s.eloAfter != null);
			const last = done[done.length - 1];
			let elo = last ? last.eloAfter : null;
			if (elo == null) elo = await fetchElo(Core.toID(run.player));
			if (elo == null || state.run !== run) return;
			run.endElo = elo;
			save();
			render();
		}, delay);
	}

	function onIncoming(e) {
		const effects = [];
		if (!ui.sawTraffic) {
			ui.sawTraffic = true;
			effects.push({ type: 'changed' });
		}
		const msgs = Core.decodeFrame(e.detail);
		for (const msg of msgs) {
			try {
				effects.push.apply(effects, Core.handleIncoming(state, track, msg));
			} catch (err) {
				console.error('[mock-regional-helper] incoming', err);
			}
		}
		applyEffects(effects);
		// after applyEffects, so a game created by this message already exists when its log is saved
		for (const msg of msgs) {
			try {
				bufferBattleLog(msg);
			} catch (err) {
				console.error('[mock-regional-helper] battle log', err);
			}
		}
	}

	function onOutgoing(e) {
		const effects = [];
		for (const msg of Core.decodeOutgoing(e.detail)) {
			try {
				effects.push.apply(effects, Core.handleOutgoing(state, msg));
			} catch (err) {
				console.error('[mock-regional-helper] outgoing', err);
			}
		}
		applyEffects(effects);
	}

	// ---- Import ----------------------------------------------------------------

	function importUserid() {
		return (state.me && state.me.userid) || (state.run && Core.toID(state.run.player)) || '';
	}

	async function loadReplays(ids, urlsById) {
		const userid = importUserid();
		ui.imp.loading = `Loading ${ids.length} replay(s)...`;
		render();
		const games = await mapLimit(ids, 4, async id => {
			const data = await getJson(`${REPLAY_HOST}${id}.json`);
			return data ? Core.parseReplayGame(data, userid, urlsById && urlsById[id]) : null;
		});
		const found = games.filter(Boolean);
		const candidates = Core.groupImportedGames(found);
		ui.imp.loading = '';
		ui.imp.candidates = candidates;
		ui.imp.picked = {};
		for (const c of candidates) if (!Core.isImported(state.run, c)) ui.imp.picked[c.id] = true;
		ui.imp.error = found.length < ids.length ? `${ids.length - found.length} replay(s) couldn't be loaded or don't include you.` : '';
		if (!candidates.length && !ui.imp.error) ui.imp.error = 'No sets found.';
		render();
	}

	async function searchMyReplays() {
		const userid = importUserid();
		if (!userid) { ui.imp.error = 'Log in first.'; render(); return; }
		ui.imp.error = '';
		ui.imp.loading = 'Searching replays...';
		render();
		const cutoff = Date.now() / 1000 - ui.imp.days * 86400;
		const ids = [];
		let before = '';
		for (let page = 0; page < 4; page++) {
			const list = await getJson(`${REPLAY_HOST}search.json?user=${userid}&format=${state.settings.formatId}${before}`);
			if (!Array.isArray(list) || !list.length) break;
			for (const r of list) if (r.uploadtime >= cutoff) ids.push(r.password ? `${r.id}-${r.password}pw` : r.id);
			const last = list[list.length - 1];
			if (list.length < 51 || last.uploadtime < cutoff) break;
			before = `&before=${last.uploadtime}`;
		}
		if (!ids.length) {
			ui.imp.loading = '';
			ui.imp.candidates = [];
			ui.imp.error = 'No public replays found in that window. Battles with spectators disallowed save private replays; paste their links below.';
			render();
			return;
		}
		await loadReplays(ids);
	}

	async function loadPastedReplays() {
		const text = ui.drafts['imp-urls'] || '';
		const urlsById = {};
		for (const line of text.split(/[\s,<>]+/)) {
			const id = Core.replayIdFromUrl(line);
			if (id) urlsById[id] = line;
		}
		const ids = Object.keys(urlsById);
		if (!ids.length) { ui.imp.error = 'No replay links recognized.'; render(); return; }
		ui.imp.error = '';
		await loadReplays(ids, urlsById);
	}

	function doImport() {
		const picked = (ui.imp.candidates || []).filter(c => ui.imp.picked[c.id]);
		if (!picked.length) return;
		for (const c of picked) {
			for (const roomid of Object.keys(c.logs || {})) writeLog(roomid, { source: 'spectator', lines: c.logs[roomid], requests: [] });
		}
		const effects = Core.importSets(state, picked, ui.imp.replace);
		ui.imp = { loading: '', error: '', candidates: null, picked: {}, replace: true, days: ui.imp.days };
		ui.open.import = false;
		delete ui.drafts['imp-urls'];
		ui.chunks = null;
		toast(`Imported ${picked.length} set(s)`);
		applyEffects(effects.length ? effects : [{ type: 'changed' }]);
	}

	// ---- UI helpers --------------------------------------------------------------

	const CSS = `
.mrh-view{font-size:13px;line-height:1.5;padding:12px 16px 24px;max-width:760px}
.mrh-view h2{font-size:18px;margin:0}
.mrh-view h3{font-size:14px;margin:14px 0 4px}
.mrh-view .mrh-sub{opacity:.75;margin-bottom:6px}
.mrh-view .mrh-stats{display:flex;gap:22px;flex-wrap:wrap;margin:10px 0}
.mrh-view .mrh-stat b{display:block;font-size:17px}
.mrh-view .mrh-stat span{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.03em}
.mrh-view .mrh-card{border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:7px 10px;margin:6px 0}
.mrh-view .mrh-card-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.mrh-view .mrh-game{display:inline-block;margin-right:14px;white-space:nowrap}
.mrh-view details{margin:10px 0;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:6px 10px}
.mrh-view summary{cursor:pointer;font-weight:bold}
.mrh-view input[type=text],.mrh-view textarea{width:100%;box-sizing:border-box;font-size:13px;padding:3px 6px}
.mrh-view input[type=number]{width:60px}
.mrh-view .mrh-row{margin:6px 0}
.mrh-view .mrh-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.mrh-view .mrh-big{font-size:30px;font-weight:bold;line-height:1.2}
.mrh-view .mrh-hero{text-align:center;padding:18px 0 6px}
.mrh-view .button.mrh-primary{font-size:15px;padding:7px 18px}
.mrh-view .mrh-muted{opacity:.7}
.mrh-view .mrh-link{cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left}
.mrh-W{color:#1d8a2e;font-weight:bold}.mrh-L{color:#c62828;font-weight:bold}.mrh-T{opacity:.7;font-weight:bold}
.mrh-ok{color:#1d8a2e}.mrh-bad{color:#c62828}
.mrh-view a{color:#2f63c4}
html.dark .mrh-view a{color:#8ab4f8}
.mrh-err{color:#c62828}
#mrh-badge{position:fixed;right:16px;bottom:56px;z-index:9999;padding:4px 11px;border-radius:14px;background:#4a5d85;color:#fff;
 font:bold 12px Verdana,Helvetica,Arial,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);user-select:none;white-space:nowrap}
#mrh-badge:hover{background:#5b70a0}
#mrh-sidebar{position:fixed;top:0;right:0;bottom:0;z-index:9998;background:#fff;color:#222;border-left:1px solid #999;
 box-shadow:-2px 0 8px rgba(0,0,0,.25);display:flex;flex-direction:column;font-family:Verdana,Helvetica,Arial,sans-serif}
html.dark #mrh-sidebar{background:#2b2b2b;color:#ddd}
#mrh-sidebar .mrh-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:ew-resize}
#mrh-sidebar .mrh-sidebar-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.35);font-weight:bold}
#mrh-sidebar .mrh-sidebar-body{overflow:auto;flex:1}
#mrh-alert{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:10001;max-width:440px;padding:8px 12px;border-radius:6px;
 background:#fff7d6;color:#3d3000;border:1px solid #d9b84a;box-shadow:0 2px 8px rgba(0,0,0,.3);font:13px Verdana,Helvetica,Arial,sans-serif}
#mrh-alert .mrh-alert-actions{margin-top:6px;display:flex;gap:6px;justify-content:flex-end}
.mrh-view .mrh-nav{display:flex;gap:2px;justify-content:flex-end;margin:-6px 0 6px;font-size:12px}
.mrh-view .mrh-nav-item{background:none;border:0;border-radius:3px;padding:2px 8px;cursor:pointer;color:inherit;opacity:.75;font:inherit}
.mrh-view .mrh-nav-item:hover{opacity:1;text-decoration:underline}
.mrh-view .mrh-version{margin-right:auto;align-self:center;opacity:.5;font-size:11px}
.mrh-view .mrh-nav-on{opacity:1;font-weight:bold;background:rgba(128,128,128,.18)}
.mrh-view .mrh-small{font-size:12px}
.mrh-view .mrh-table{border-collapse:collapse;width:100%;margin:4px 0 8px;font-size:12px}
.mrh-view .mrh-table th,.mrh-view .mrh-table td{text-align:left;padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25);vertical-align:top}
.mrh-view .mrh-table th{font-weight:bold;white-space:nowrap}
.mrh-view .mrh-sorted{font-weight:bold}
.mrh-view .mrh-bar{display:inline-block;width:80px;height:8px;background:rgba(128,128,128,.25);border-radius:4px;vertical-align:middle;overflow:hidden}
.mrh-view .mrh-bar-fill{display:block;height:100%;background:#4a7bd0}
.mrh-view .mrh-card-preview{margin:10px 0}
.mrh-view .mrh-card-preview canvas{display:block;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
#mrh-toasts{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.mrh-toast{background:rgba(30,30,30,.92);color:#fff;padding:6px 14px;border-radius:4px;font:13px Verdana,Helvetica,Arial,sans-serif}
`;

	function el(tag, attrs, children) {
		const node = document.createElement(tag);
		if (attrs) {
			for (const k of Object.keys(attrs)) {
				const v = attrs[k];
				if (k === 'text') node.textContent = v;
				else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
				else if (k === 'className') node.className = v;
				else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
			}
		}
		for (const c of [].concat(children || [])) {
			if (c == null || c === false) continue;
			node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		}
		return node;
	}

	/** Showdown-styled button. */
	function btn(text, onclick, extra) {
		return el('button', Object.assign({ className: 'button', text, onclick }, extra || {}));
	}

	function linkBtn(text, onclick) {
		return el('button', { className: 'mrh-link', text, onclick });
	}

	/** Text input / textarea whose value survives re-renders (stored in ui.drafts). */
	function draftField(key, initial, attrs, tag) {
		const node = el(tag || 'input', Object.assign({ type: tag ? null : 'text', className: 'textbox', 'data-key': key }, attrs));
		node.value = key in ui.drafts ? ui.drafts[key] : (initial || '');
		node.addEventListener('input', () => { ui.drafts[key] = node.value; });
		return node;
	}

	function clearDrafts(prefix) {
		for (const k of Object.keys(ui.drafts)) if (k.indexOf(prefix) === 0) delete ui.drafts[k];
	}

	/** <details> whose open state survives re-renders. */
	function section(key, title, children) {
		const d = el('details', { open: !!ui.open[key] }, [el('summary', { text: title })].concat(children));
		d.addEventListener('toggle', () => { ui.open[key] = d.open; });
		return d;
	}

	function uiPrefs() {
		return Object.assign({ left: null, top: null, tabOpen: false, sidebarWidth: 440 }, GM_getValue(UI_KEY, {}) || {});
	}

	function setPref(key, value) {
		const p = uiPrefs();
		p[key] = value;
		GM_setValue(UI_KEY, p);
	}

	function update(fn) {
		return function () {
			const r = fn.apply(this, arguments);
			save();
			render();
			return r;
		};
	}

	function toast(text, ms) {
		if (!toasts) return;
		const t = el('div', { className: 'mrh-toast', text });
		toasts.appendChild(t);
		setTimeout(() => t.remove(), ms || 3000);
	}

	function stageInfo() {
		return state.run ? Core.stageOf(state.run, state.settings) : null;
	}

	function eloLine(run) {
		const end = run.endElo != null ? run.endElo : run.currentElo;
		if (run.startElo == null) return '?';
		if (end == null) return String(Math.round(run.startElo));
		const d = Math.round(end) - Math.round(run.startElo);
		return `${Math.round(run.startElo)} → ${Math.round(end)} (${d >= 0 ? '+' : ''}${d})`;
	}

	// ---- Badge, tab, sidebar -------------------------------------------------------

	function buildChrome() {
		if (badge) return;
		document.head.appendChild(el('style', { text: CSS }));
		toasts = el('div', { id: 'mrh-toasts' });
		document.body.appendChild(toasts);
		badge = el('div', { id: 'mrh-badge', title: 'Mock Regional Helper: click to open' });
		const prefs = uiPrefs();
		if (prefs.left != null) {
			Object.assign(badge.style, { left: prefs.left + 'px', top: prefs.top + 'px', right: 'auto', bottom: 'auto' });
		}
		makeDraggable(badge, openView);
		document.body.appendChild(badge);
		log('v' + VERSION + ' loaded; reopening tab:', !!prefs.tabOpen);
		if (prefs.tabOpen) requestTab(false);
		render();
	}

	/** Drag to move; a click without movement calls onClick. */
	function makeDraggable(node, onClick) {
		node.addEventListener('mousedown', e => {
			if (e.button !== 0) return;
			const rect = node.getBoundingClientRect();
			const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
			const sx = e.clientX, sy = e.clientY;
			let moved = false;
			const move = ev => {
				if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
				moved = true;
				const left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dx));
				const top = Math.max(0, Math.min(window.innerHeight - 20, ev.clientY - dy));
				Object.assign(node.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
			};
			const up = () => {
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				if (!moved) return onClick();
				const p = uiPrefs();
				p.left = parseInt(node.style.left, 10) || 0;
				p.top = parseInt(node.style.top, 10) || 0;
				GM_setValue(UI_KEY, p);
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
			e.preventDefault();
		});
	}

	/** Ask the page hook to open (or focus) the tab; it waits for the classic client to be ready. */
	function requestTab(focus) {
		window.dispatchEvent(new CustomEvent('mrh:opentab', { detail: JSON.stringify({ focus }) }));
	}

	function openView() {
		if (ui.mode === 'sidebar') {
			closeSidebar();
			return;
		}
		ui.wantView = true;
		requestTab(true);
	}

	function onTabReady() {
		if (sidebar) closeSidebar();
		ui.mode = 'tab';
		ui.wantView = false;
		ui.container = document.getElementById(TAB_ROOT_ID);
		setPref('tabOpen', true);
		render();
	}

	function onTabClosed() {
		log('tab closed');
		ui.mode = null;
		ui.container = null;
		setPref('tabOpen', false);
	}

	/** Last-resort fallback when neither client's room API can be used. */
	function openSidebar() {
		if (sidebar) return;
		const width = uiPrefs().sidebarWidth;
		const body = el('div', { className: 'mrh-sidebar-body' });
		const grip = el('div', { className: 'mrh-grip', title: 'Drag to resize' });
		sidebar = el('div', { id: 'mrh-sidebar' }, [
			grip,
			el('div', { className: 'mrh-sidebar-head' }, ['Mock Regional', btn('Close', closeSidebar)]),
			body,
		]);
		sidebar.style.width = width + 'px';
		grip.addEventListener('mousedown', e => {
			e.preventDefault();
			const move = ev => {
				sidebar.style.width = Math.max(300, Math.min(window.innerWidth - 100, window.innerWidth - ev.clientX)) + 'px';
			};
			const up = () => {
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				setPref('sidebarWidth', parseInt(sidebar.style.width, 10));
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
		document.body.appendChild(sidebar);
		ui.mode = 'sidebar';
		ui.container = body;
		render();
	}

	function closeSidebar() {
		if (sidebar) sidebar.remove();
		sidebar = null;
		ui.mode = null;
		ui.container = null;
	}

	// ---- Rendering -----------------------------------------------------------------

	function render() {
		renderBadge();
		renderAlert();
		if (ui.mode === 'tab' && !(ui.container && ui.container.isConnected)) ui.container = document.getElementById(TAB_ROOT_ID);
		const container = ui.container;
		if (!container || !container.isConnected) return;
		// Re-rendering rebuilds inputs; keep focus/caret and scroll position.
		const active = document.activeElement;
		const activeKey = active && container.contains(active) ? active.getAttribute('data-key') : null;
		const caret = activeKey && typeof active.selectionStart === 'number' ? active.selectionStart : null;
		const scroller = container.parentElement;
		const scrollTop = scroller ? scroller.scrollTop : 0;
		const ownScroll = container.scrollTop;

		container.textContent = '';
		const view = el('div', { className: 'mrh-view' });
		view.appendChild(renderNav());
		if (ui.view === 'history') view.appendChild(renderHistory());
		else if (ui.view === 'archived') view.appendChild(renderArchived());
		else if (ui.view === 'stats') view.appendChild(renderStats());
		else if (ui.view === 'backup') view.appendChild(renderBackup());
		else if (ui.view === 'card') view.appendChild(renderCard());
		else if (!state.run) view.appendChild(renderStart());
		else if (state.run.ended && !ui.showDetails) view.appendChild(renderSummary());
		else view.appendChild(renderRun());
		if (!ui.sawTraffic) {
			view.appendChild(el('p', { className: 'mrh-muted', text: 'No Showdown traffic seen yet. If this stays after you connect, the socket hook failed; try reloading.' }));
		}
		container.appendChild(view);

		if (scroller) scroller.scrollTop = scrollTop;
		container.scrollTop = ownScroll;
		if (activeKey) {
			const again = container.querySelector(`[data-key="${activeKey}"]`);
			if (again) {
				again.focus();
				if (caret != null && typeof again.setSelectionRange === 'function') again.setSelectionRange(caret, caret);
			}
		}
	}

	/** Non-blocking "different team" alert; visible over the battle, not only in the tab. */
	function renderAlert() {
		if (!document.body) return;
		const alert = ui.teamAlert;
		if (!alert || !state.run) {
			if (alertBox) alertBox.remove();
			alertBox = null;
			return;
		}
		if (!alertBox) {
			alertBox = el('div', { id: 'mrh-alert', role: 'alert' });
			document.body.appendChild(alertBox);
		}
		alertBox.textContent = '';
		const answer = record => () => {
			Core.decideTeam(state, alert.setId, record);
			ui.teamAlert = null;
			ui.chunks = null;
			log('different team:', record ? 'record anyway' : "don't record", alert.setId || '(next set)');
			if (!record) toast(alert.setId ? 'Set removed from the run.' : 'The next set will not be recorded.', 4000);
			save();
			render();
		};
		alertBox.appendChild(el('div', null, [
			el('b', { text: 'This team differs from your regional team. ' }),
			'Record this set in the run? (Ignoring it records the set.)',
		]));
		alertBox.appendChild(el('div', { className: 'mrh-alert-actions' }, [
			btn('Record anyway', answer(true)),
			btn("Don't record", answer(false)),
		]));
	}

	function renderBadge() {
		if (!badge) return;
		const info = stageInfo();
		badge.textContent = info ? `MR ${Core.recordText(info)} · ${Core.statusText(info, state.run)}` : 'Mock Regional';
	}

	function renderStart() {
		const eventInput = draftField('start-event', '', { placeholder: 'e.g. Utah Mock Regional #3' });
		const playerInput = draftField('start-player', state.me ? state.me.name : '', { placeholder: 'Showdown username' });
		const start = btn('Start run', async () => {
			const player = playerInput.value.trim() || (state.me && state.me.name) || '';
			if (!player) { ui.error = 'Log in or enter your username first.'; render(); return; }
			ui.error = '';
			start.disabled = true;
			start.textContent = 'Fetching ELO...';
			const elo = await fetchElo(Core.toID(player));
			state.run = Core.newRun(eventInput.value.trim(), player, elo);
			if (state.lastUtm && state.lastUtm.format === state.settings.formatId) captureTeam(state.lastUtm.packed, 'utm');
			ui.chunks = null;
			ui.showDetails = false;
			clearDrafts('start-');
			save();
			render();
		}, { className: 'button mrh-primary' });
		return el('div', null, [
			el('h2', { text: 'Mock Regional' }),
			el('p', { className: 'mrh-sub', text: 'Tracks your Bo3 ladder sets as a mock regional: record, replays, ELO and a Discord post.' }),
			el('div', { className: 'mrh-row' }, ['Event name', eventInput]),
			el('div', { className: 'mrh-row' }, ['Player', playerInput]),
			el('div', { className: 'mrh-actions' }, [start]),
			ui.error ? el('p', { className: 'mrh-err', text: ui.error }) : null,
			renderSettings(),
		]);
	}

	function renderSummary() {
		const run = state.run;
		const info = stageInfo();
		const headline = info.stage === 'Champion' ? 'Champion' :
			info.stage === 'Eliminated' ? `Eliminated in ${info.eliminatedIn}` :
			info.terminal ? info.stage : `Run ended during ${info.stage}`;
		const actions = el('div', { className: 'mrh-actions', style: 'justify-content:center' }, [
			btn(ui.busy || 'Copy for Discord', () => copyForDiscord(state.run, state.settings), { className: 'button mrh-primary', disabled: !!ui.busy }),
			btn('Report card', () => openCard(state.run), { className: 'button mrh-primary' }),
			Core.canPlayOn(run, state.settings) ? btn('Continue playing', update(() => { Core.continuePlaying(state); ui.chunks = null; ui.showDetails = false; }), { className: 'button mrh-primary' }) : null,
			btn('New run', newRun, { className: 'button mrh-primary' }),
		]);
		const wrap = el('div', null, [
			el('h2', { text: run.event }),
			el('div', { className: 'mrh-sub', text: run.player }),
			el('div', { className: 'mrh-hero' }, [
				el('div', { className: 'mrh-big', text: Core.recordText(info) }),
				el('div', { style: 'font-size:17px;margin:4px 0', text: headline }),
				el('div', { className: 'mrh-muted', text: 'ELO ' + eloLine(run) }),
			]),
			actions,
			renderChunks(true),
			ui.error ? el('p', { className: 'mrh-err', text: ui.error }) : null,
			el('p', { style: 'text-align:center' }, [
				linkBtn('View / edit sets', () => { ui.showDetails = true; render(); }),
				' · ',
				linkBtn('Export battle data', () => exportBattleData([state.run], state.run.event)),
				!info.terminal ? ' · ' : null,
				!info.terminal ? linkBtn('Resume run', update(() => { Core.resumeRun(state); ui.chunks = null; })) : null,
			]),
		]);
		return wrap;
	}

	function renderRun() {
		const run = state.run;
		const info = stageInfo();
		const wrap = el('div');
		if (run.ended) {
			wrap.appendChild(el('p', null, [linkBtn('← Back to summary', () => { ui.showDetails = false; render(); })]));
		}
		wrap.appendChild(el('h2', { text: run.event }));
		wrap.appendChild(el('div', { className: 'mrh-sub', text: run.player }));
		const stat = (value, label) => el('div', { className: 'mrh-stat' }, [el('b', { text: value }), el('span', { text: label })]);
		wrap.appendChild(el('div', { className: 'mrh-stats' }, [
			stat(Core.recordText(info), 'Record'),
			stat(Core.statusText(info, run), 'Stage'),
			stat(eloLine(run), 'ELO'),
		]));
		if (info.playingOn) {
			wrap.appendChild(el('p', { className: 'mrh-muted', text: `Out of contention (${info.eliminatedIn}), playing on for practice. ${swissLeft(info)} round(s) left in ${info.eliminatedIn}.` }));
			wrap.appendChild(el('div', { className: 'mrh-actions' }, [
				btn('End run & start new', () => {
					if (!confirm('End this run and start a new one? The current run is kept in History.')) return;
					Core.endRun(state);
					newRun(true);
				}, { className: 'button mrh-primary' }),
			]));
		}
		wrap.appendChild(renderTeam());

		if (ui.pendingNote) {
			const set = run.sets.find(s => s.id === ui.pendingNote);
			if (set) wrap.appendChild(renderNoteEditor(set, true));
			else ui.pendingNote = null;
		}

		wrap.appendChild(el('h3', { text: run.sets.length ? 'Sets' : 'No sets yet' }));
		if (!run.sets.length) {
			wrap.appendChild(el('p', { className: 'mrh-muted', text: 'Queue for the format; sets are recorded automatically. Started late? Use Import past sets below.' }));
		}
		run.sets.forEach((set, i) => wrap.appendChild(renderSet(set, i)));

		wrap.appendChild(el('div', { className: 'mrh-actions' }, [
			btn(ui.busy || 'Copy for Discord', () => copyForDiscord(state.run, state.settings), { disabled: !!ui.busy }),
			btn('Report card', () => openCard(state.run)),
		]));
		wrap.appendChild(renderChunks(false));
		if (ui.error) wrap.appendChild(el('p', { className: 'mrh-err', text: ui.error }));
		wrap.appendChild(renderImport());
		wrap.appendChild(renderAdjust());
		wrap.appendChild(renderSettings());
		return wrap;
	}

	function renderTeam() {
		const run = state.run;
		const row = el('div', { className: 'mrh-row' });
		if (run.team) {
			row.appendChild(el('span', null, [el('b', { text: 'Team: ' }), Core.packedSpecies(run.team.packed).join(' / ')]));
			if (run.team.source === 'showteam') {
				row.appendChild(el('span', { className: 'mrh-muted', text: ' (from the team sheet; no EVs/IVs — search once to record the full team)' }));
			}
		} else {
			row.appendChild(el('span', { className: 'mrh-muted', text: 'Team: recorded on your next search or battle in the format.' }));
		}
		if (state.lastUtm && state.lastUtm.format === state.settings.formatId &&
			(!run.team || run.team.packed !== state.lastUtm.packed)) {
			row.appendChild(document.createTextNode(' '));
			row.appendChild(btn('Use last searched team', update(() => captureTeam(state.lastUtm.packed, 'utm'))));
		}
		return row;
	}

	function renderChunks(center) {
		const box = el('div', { style: center ? 'text-align:center' : '' });
		if (ui.chunks && ui.chunks.length > 1) {
			box.appendChild(el('div', { className: 'mrh-muted', text: `Part 1 copied. The post is ${ui.chunks.length} messages (Discord's 2000-character limit):` }));
			ui.chunks.forEach((chunk, i) => {
				box.appendChild(btn(`Copy part ${i + 1}/${ui.chunks.length}`, () => {
					GM_setClipboard(chunk, 'text');
					toast(`Part ${i + 1} copied`);
				}));
			});
		} else if (ui.chunks) {
			box.appendChild(el('span', { className: 'mrh-muted', text: 'Copied to clipboard.' }));
		}
		return box;
	}

	function renderGame(g, j, readOnly) {
		const label = `G${j + 1} `;
		const res = g.result ? el('span', { className: 'mrh-' + g.result, text: g.result }) : el('i', { text: 'in progress' });
		const parts = [label, res, ' '];
		const status = ui.replay[g.roomid];
		if (g.replay) {
			parts.push(el('a', { href: g.replay, target: '_blank', rel: 'noopener', className: 'no-panel-intercept', text: 'replay' }));
			parts.push(el('span', { className: 'mrh-ok', text: ' ✓' }));
		} else if (readOnly) {
			parts.push(el('span', { className: 'mrh-muted', text: 'no replay' }));
		} else if (status === 'saving') {
			parts.push(el('span', { className: 'mrh-muted', text: 'saving…' }));
		} else if (status === 'failed') {
			parts.push(el('span', { className: 'mrh-bad', text: 'failed ✗ ' }));
			parts.push(btn('Retry', () => { requestReplay(g.roomid, 0); render(); }, { title: 'Sends /savereplay again (the battle tab must still be open)' }));
		} else if (g.result) {
			parts.push(btn('Save replay', () => { requestReplay(g.roomid, 0); render(); }));
		}
		if (g.log) {
			parts.push(el('span', { className: 'mrh-ok mrh-small', title: `${g.log.lines} protocol lines (${g.log.source === 'spectator' ? 'spectator view, from the replay' : 'your view'})`, text: ' · log ✓' }));
		}
		return el('span', { className: 'mrh-game' }, parts);
	}

	/** opts: { readOnly, settings } (archived runs pass their own settings and get no edit controls). */
	function renderSet(set, i, opts) {
		const readOnly = !!(opts && opts.readOnly);
		const settings = (opts && opts.settings) || state.settings;
		const score = Core.setScore(set);
		const card = el('div', { className: 'mrh-card' });
		const setElo = Core.setEloText(set);
		card.appendChild(el('div', { className: 'mrh-card-head' }, [
			el('span', null, [
				el('b', { text: Core.roundLabel(i, settings) }),
				' vs ' + (set.opponent || '?') + ' — ',
				set.result ? el('span', { className: 'mrh-' + set.result, text: set.result }) : el('i', { text: 'in progress' }),
				set.games.length ? ` (${score.w}-${score.l})` : '',
				set.manual && !set.games.length ? el('span', { className: 'mrh-muted', text: ' · manual' }) : null,
			]),
			el('span', { className: 'mrh-muted', text: setElo }),
		]));
		if (set.games.length) card.appendChild(el('div', null, set.games.map((g, j) => renderGame(g, j, readOnly))));
		// bring-4 and leads per game
		set.games.forEach((g, j) => {
			const lineup = Core.lineupText(g, true);
			if (lineup) card.appendChild(el('div', { className: 'mrh-muted mrh-small', text: `G${j + 1}: ${lineup}` }));
		});
		if (set.oppTeam.length) {
			card.appendChild(el('div', { className: 'mrh-muted' }, [
				'Opp: ' + set.oppTeam.join(' / ') + ' ',
				set.oppTeamPacked ? linkBtn('copy opp paste', () => {
					GM_setClipboard(teamTextFromPacked(set.oppTeamPacked), 'text');
					toast(`${set.opponent || 'Opponent'}'s team sheet copied`);
				}) : null,
			]));
		}
		if (!readOnly && ui.editing === set.id) {
			card.appendChild(renderNoteEditor(set, false));
		} else {
			if (set.note || set.rating) {
				card.appendChild(el('div', { text: (set.note ? '“' + set.note + '”' : '') + (set.rating ? ` (${set.rating}/5)` : '') }));
			}
			if (!readOnly) card.appendChild(linkBtn('edit', () => { ui.editing = set.id; render(); }));
		}
		return card;
	}

	function renderNoteEditor(set, isPrompt) {
		const box = el('div', { className: 'mrh-card' });
		if (isPrompt) box.appendChild(el('div', { style: 'font-weight:bold', text: `How'd it go vs ${set.opponent || '?'}?` }));
		const prefix = `set-${set.id}-`;
		const opp = draftField(prefix + 'opp', set.opponent, { placeholder: 'Opponent' });
		const resultKey = prefix + 'result';
		const curResult = resultKey in ui.drafts ? ui.drafts[resultKey] : (set.result || '');
		const result = el('select', { onchange: e => { ui.drafts[resultKey] = e.target.value; } }, ['', 'W', 'L', 'T'].map(r =>
			el('option', { value: r, text: r || '(in progress)', selected: curResult === r })));
		const note = draftField(prefix + 'note', set.note, { rows: '2', placeholder: 'Note (optional)' }, 'textarea');
		const ratingKey = prefix + 'rating';
		const stars = el('span');
		const drawStars = () => {
			const rating = ratingKey in ui.drafts ? ui.drafts[ratingKey] : (set.rating || 0);
			stars.textContent = '';
			for (let n = 1; n <= 5; n++) {
				stars.appendChild(el('button', {
					className: 'button',
					text: n <= rating ? '★' : '☆',
					onclick: () => { ui.drafts[ratingKey] = rating === n ? 0 : n; drawStars(); },
				}));
			}
		};
		drawStars();
		const close = () => {
			if (isPrompt) ui.pendingNote = null;
			else ui.editing = null;
			clearDrafts(prefix);
		};
		if (!isPrompt) {
			box.appendChild(el('div', { className: 'mrh-row' }, [opp]));
			box.appendChild(el('div', { className: 'mrh-row' }, ['Result ', result]));
		}
		box.appendChild(note);
		box.appendChild(el('div', { className: 'mrh-row' }, ['Rating ', stars]));
		box.appendChild(el('div', { className: 'mrh-actions' }, [
			btn('Save', update(() => {
				set.note = note.value.trim();
				if (ratingKey in ui.drafts) set.rating = ui.drafts[ratingKey];
				if (!isPrompt) {
					set.opponent = opp.value.trim();
					if ((result.value || null) !== set.result) set.resultLocked = true;
					set.result = result.value || null;
					if (set.result && !set.endedAt) set.endedAt = Date.now();
					Core.syncRunEnded(state);
				}
				ui.chunks = null;
				close();
			})),
			btn(isPrompt ? 'Skip' : 'Cancel', () => { close(); render(); }),
		]));
		return box;
	}

	function renderAdjust() {
		const run = state.run;
		const oppInput = draftField('manual-opp', '', { placeholder: 'Opponent (optional)' });
		const mark = result => () => {
			const effects = Core.markResult(state, result, oppInput.value.trim());
			ui.chunks = null;
			clearDrafts('manual-');
			applyEffects(effects.length ? effects : [{ type: 'changed' }]);
		};
		return section('adjust', 'Adjust', [
			el('p', { className: 'mrh-muted', text: 'For when automation misses something. Mark W/L finishes the in-progress set, or adds a manual one.' }),
			el('div', { className: 'mrh-row' }, [oppInput]),
			el('div', { className: 'mrh-actions' }, [
				btn('Mark W', mark('W')),
				btn('Mark L', mark('L')),
				btn('Undo last set', () => {
					if (!run.sets.length || !confirm('Remove the last set?')) return;
					Core.undoLastSet(state);
					ui.chunks = null;
					save();
					render();
				}),
				run.ended ? null : btn('End run', () => {
					if (!confirm('End this run?')) return;
					Core.endRun(state);
					ui.chunks = null;
					ui.showDetails = false;
					save();
					render();
					scheduleFinalElo(0);
				}),
			]),
		]);
	}

	function fmtTime(sec) {
		if (!sec) return '';
		const d = new Date(sec * 1000);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
			d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}

	function renderImport() {
		const imp = ui.imp;
		const days = el('select', { onchange: e => { imp.days = Number(e.target.value); } },
			[[1, 'last 24 hours'], [2, 'last 2 days'], [7, 'last 7 days']].map(([v, t]) => el('option', { value: String(v), text: t, selected: imp.days === v })));
		const children = [
			el('p', { className: 'mrh-muted', text: 'Add sets played before the run was tracked. Games are grouped into Bo3 sets and inserted in order.' }),
			el('div', { className: 'mrh-row' }, ['Search my public replays from ', days, ' ', btn('Search', searchMyReplays, { disabled: !!imp.loading })]),
			el('div', { className: 'mrh-row' }, ['Or paste replay links (works for private ones):']),
			draftField('imp-urls', '', { rows: '3', placeholder: 'https://replay.pokemonshowdown.com/...' }, 'textarea'),
			el('div', { className: 'mrh-actions' }, [btn('Load pasted links', loadPastedReplays, { disabled: !!imp.loading })]),
		];
		if (imp.loading) children.push(el('p', { className: 'mrh-muted', text: imp.loading }));
		if (imp.error) children.push(el('p', { className: 'mrh-err', text: imp.error }));
		if (imp.candidates && imp.candidates.length) {
			for (const c of imp.candidates) {
				const already = Core.isImported(state.run, c);
				const score = Core.setScore(c);
				const box = el('input', { type: 'checkbox', checked: !!imp.picked[c.id] && !already, disabled: already });
				box.addEventListener('change', () => { imp.picked[c.id] = box.checked; });
				children.push(el('div', { className: 'mrh-row' }, [el('label', null, [
					box, ` ${fmtTime(c.time)} · vs ${c.opponent} — `,
					c.result ? el('span', { className: 'mrh-' + c.result, text: c.result }) : '?',
					` (${score.w}-${score.l}) · ${c.games.length} game(s)`,
					c.eloBefore != null && c.eloAfter != null ? ` · ${c.eloBefore} → ${c.eloAfter}` : '',
					already ? el('span', { className: 'mrh-muted', text: ' (already in run)' }) : null,
				])]));
			}
			const placeholders = Core.placeholderSets(state.run).length;
			if (placeholders) {
				const rep = el('input', { type: 'checkbox', checked: imp.replace });
				rep.addEventListener('change', () => { imp.replace = rep.checked; });
				children.push(el('div', { className: 'mrh-row' }, [el('label', null, [rep, ` Replace manual placeholder sets (${placeholders}), oldest first; notes carry over`])]));
			}
			children.push(el('div', { className: 'mrh-actions' }, [btn('Import selected', doImport)]));
		}
		return section('import', 'Import past sets', children);
	}

	function swissLeft(info) {
		return Math.max(0, (info.playUntil || Core.swissRounds(state.settings)) - info.completed);
	}

	function renderSettings() {
		const s = state.settings;
		const num = (key, label) => {
			const input = el('input', { type: 'number', min: '0', value: String(s[key]) });
			input.addEventListener('change', update(() => {
				const v = parseInt(input.value, 10);
				if (!isNaN(v) && v >= 0) s[key] = v;
				Core.syncRunEnded(state);
			}));
			return el('div', { className: 'mrh-row' }, [label + ' ', input]);
		};
		const check = (key, label) => {
			const input = el('input', { type: 'checkbox', checked: !!s[key] });
			input.addEventListener('change', update(() => { s[key] = input.checked; ui.chunks = null; }));
			return el('div', { className: 'mrh-row' }, [el('label', null, [input, ' ' + label])]);
		};
		const fmt = el('input', { type: 'text', className: 'textbox', value: s.formatId });
		fmt.addEventListener('change', update(() => { s.formatId = Core.toID(fmt.value) || Core.DEFAULT_SETTINGS.formatId; }));
		return section('settings', 'Settings', [
			el('div', { className: 'mrh-row' }, ['Format ID', fmt]),
			num('day1Rounds', 'Day 1 rounds'),
			num('day2Rounds', 'Day 2 rounds'),
			num('lossThreshold', 'Max losses in Swiss (X-2 = 2)'),
			num('topCutRounds', 'Top cut rounds (3 = Top 8)'),
			check('includeSpreads', 'Include spreads (EVs/IVs/nature) in the shared team'),
			check('usePokepaste', 'Upload team to pokepast.es'),
			check('playOn', 'After going over the loss limit, keep playing the Swiss rounds for practice'),
			check('discordLineups', 'Leads and bring per game in the Discord post (short form)'),
		]);
	}

	/** Archive the current run into History and go back to the start screen. */
	function newRun(skipConfirm) {
		if (skipConfirm !== true && !confirm('Start a new run? The current one is kept in History.')) return;
		runHistory = Core.archiveRun(runHistory, state.run, state.settings);
		saveHistory();
		log('archived run', state.run && state.run.id);
		state.run = null;
		ui.chunks = null;
		ui.pendingNote = null;
		ui.editing = null;
		ui.showDetails = false;
		ui.replay = {};
		ui.view = 'run';
		save();
		render();
	}

	/** Copy a run (current or archived) for Discord, uploading its team to pokepast.es once per spreads setting. */
	async function copyForDiscord(run, settings) {
		if (!run) return;
		ui.error = '';
		const teamText = sharedTeamText(run, settings);
		let pasteUrl = null;
		if (run.team && settings.usePokepaste) {
			const key = settings.includeSpreads ? 'spreads' : 'nospreads';
			run.team.pastes = run.team.pastes || {};
			pasteUrl = run.team.pastes[key] || null;
			if (!pasteUrl) {
				ui.busy = 'Uploading team...';
				render();
				pasteUrl = await createPaste(`${run.event} — ${run.player}`, teamText, run.player, run.event);
				ui.busy = '';
				if (pasteUrl) run.team.pastes[key] = pasteUrl;
				else ui.error = 'pokepast.es upload failed; team included as text instead.';
			}
		}
		ui.chunks = Core.formatDiscord(run, settings, { pasteUrl, teamText });
		GM_setClipboard(ui.chunks[0], 'text');
		toast(ui.chunks.length > 1 ? `Part 1 of ${ui.chunks.length} copied` : 'Copied for Discord');
		if (run === state.run) save();
		else saveHistory();
		render();
	}

	// ---- Battle logs (one GM key per game, never in the main state) -----------------

	const LOG_SAVE_DELAY = 3000;
	/** roomid -> in-memory log buffer for battle rooms in the format (persisted only for tracked games) */
	const logBuffers = {};
	const logTimers = {};

	function bufferBattleLog(msg) {
		const { roomid, lines } = Core.parseBlock(msg);
		if (!roomid || !Core.isBattleRoom(roomid, state.settings.formatId)) return;
		const buf = logBuffers[roomid] = logBuffers[roomid] || Core.newBattleLog(roomid, 'player');
		Core.appendBattleLog(buf, lines);
		const ended = lines.some(l => l.indexOf('|win|') === 0 || l === '|tie' || l.indexOf('|tie|') === 0);
		const leaving = lines.some(l => l.indexOf('|deinit') === 0);
		if (ended || leaving) {
			saveBattleLog(roomid);
			if (leaving) delete logBuffers[roomid];
		} else if (!logTimers[roomid]) {
			logTimers[roomid] = setTimeout(() => saveBattleLog(roomid), LOG_SAVE_DELAY);
		}
	}

	/** Persist a room's buffered log if that room is a game of the current run. */
	function saveBattleLog(roomid) {
		clearTimeout(logTimers[roomid]);
		delete logTimers[roomid];
		const buf = logBuffers[roomid];
		const game = findGame(roomid);
		if (!buf || !game || !buf.lines.length) return;
		writeLog(roomid, buf);
		const meta = { source: buf.source, lines: buf.lines.length, requests: buf.requests.length };
		if (!game.log || game.log.lines !== meta.lines || game.log.requests !== meta.requests) {
			game.log = meta;
			save();
			render();
		}
	}

	function writeLog(roomid, buf) {
		GM_setValue(Core.logKey(roomid), JSON.stringify({ roomid, source: buf.source, savedAt: Date.now(), lines: buf.lines, requests: buf.requests || [] }));
	}

	function readLog(roomid) {
		const raw = GM_getValue(Core.logKey(roomid), null);
		if (!raw) return null;
		try { return JSON.parse(raw); } catch (e) { return null; }
	}

	function logKeys() {
		return (typeof GM_listValues === 'function' ? GM_listValues() : []).filter(k => k.indexOf('mrh_log_') === 0);
	}

	function logUsage() {
		let bytes = 0;
		const keys = logKeys();
		for (const k of keys) bytes += String(GM_getValue(k, '') || '').length;
		return { count: keys.length, bytes };
	}

	function fmtBytes(n) {
		return n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
	}

	/** Delete stored logs matching `keep(log) === false`, and drop the matching "log ✓" markers. */
	function deleteLogs(shouldDelete) {
		const removed = new Set();
		for (const k of logKeys()) {
			let entry = null;
			try { entry = JSON.parse(GM_getValue(k, 'null')); } catch (e) { /* unreadable: delete */ }
			if (!entry || shouldDelete(entry)) {
				GM_deleteValue(k);
				removed.add(k.slice('mrh_log_'.length));
			}
		}
		for (const run of allRuns()) {
			for (const set of run.sets) for (const g of set.games) if (removed.has(g.roomid)) delete g.log;
		}
		save();
		saveHistory();
		log('deleted', removed.size, 'battle log(s)');
		return removed.size;
	}

	function pageDex() {
		try { return pageWindow.Dex && pageWindow.Dex.species ? pageWindow.Dex : null; } catch (e) { return null; }
	}

	function downloadJson(filename, obj) {
		const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = el('a', { href: url, download: filename });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	/**
	 * Battle data bundle (for external analysis tools): team sheets, pastes, lineups and full battle logs. Missing logs and
	 * team sheets are backfilled from the replays first; whatever can't be fetched is exported as
	 * logMissing instead of blocking the export.
	 */
	async function exportBattleData(runs, label) {
		if (ui.backfilling) return;
		ui.backfilling = true;
		render();
		let summary = null;
		try {
			summary = await backfillRuns(runs);
		} catch (err) {
			console.error('[MockRegional] backfill', err);
		}
		ui.backfilling = false;
		const bundle = Core.buildDataExport(runs, {
			format: state.settings.formatId,
			player: (state.me && state.me.name) || (runs[0] && runs[0].player) || '',
			dex: pageDex(),
			getLog: readLog,
			paste: teamTextFromPacked,
			settingsFor: run => Core.runSettings(run, run === state.run ? state.settings : null),
		});
		downloadJson(`battle-data-${slug(label)}-${new Date().toISOString().slice(0, 10)}.json`, bundle);
		const all = bundle.runs.reduce((list, r) => list.concat(...r.sets.map(x => x.games)), []);
		const games = all.filter(g => !g.logMissing).length;
		const missing = all.length - games;
		log('battle data export:', runs.length, 'run(s),', games, 'game log(s),', missing, 'missing');
		let text = `Exported ${runs.length} run(s) as battle data (${games} game logs)`;
		if (summary && summary.failed) text += `; ${summary.failed} replay${summary.failed === 1 ? '' : 's'} couldn't be fetched`;
		if (missing) text += `; ${missing} game${missing === 1 ? '' : 's'} without a log`;
		toast(text, 6000);
		render();
	}

	// ---- Backfill from replays ------------------------------------------------------

	const BACKFILL_CONCURRENCY = 3;
	const BACKFILL_PAUSE = 300; // ms each worker waits between replay fetches

	function hasStoredLog(roomid) {
		return !!GM_getValue(Core.logKey(roomid), null);
	}

	/**
	 * Fill missing battle logs, opponent team sheets and lineups for `runs`: first from logs already
	 * stored, then by fetching <replay>.json (at most 3 at a time). Fetched logs are cached under the
	 * normal log key with source 'replay'. Failures are counted, never thrown.
	 */
	async function backfillRuns(runs) {
		const plan = Core.backfillPlan(runs, hasStoredLog);
		let merged = 0, fetched = 0, failed = 0;
		for (const item of plan.local) {
			const stored = readLog(item.game.roomid);
			if (stored && Core.mergeLogIntoGame(item.run, item.set, item.game, stored.lines || [])) merged++;
		}
		if (plan.fetch.length) {
			toast(`Fetching ${plan.fetch.length} replay${plan.fetch.length === 1 ? '' : 's'}…`, 4000);
			log('backfill: fetching', plan.fetch.length, 'replay(s)');
			await mapLimit(plan.fetch, BACKFILL_CONCURRENCY, async item => {
				const data = await getJson(item.url);
				await new Promise(resolve => setTimeout(resolve, BACKFILL_PAUSE));
				if (!data || typeof data.log !== 'string' || !data.log) {
					failed++;
					log('backfill: could not fetch', item.url);
					return;
				}
				const lines = data.log.split('\n').filter(Boolean);
				writeLog(item.game.roomid, { source: 'replay', lines, requests: [] });
				item.game.log = { source: 'replay', lines: lines.length, requests: 0 };
				Core.mergeLogIntoGame(item.run, item.set, item.game, lines);
				fetched++;
			});
		}
		save();
		saveHistory();
		render();
		const summary = { fetched, failed, merged, missing: plan.missing.length };
		log('backfill:', JSON.stringify(summary));
		return summary;
	}

	function backfillSummaryText(summary) {
		const parts = [];
		if (summary.fetched) parts.push(`${summary.fetched} replay${summary.fetched === 1 ? '' : 's'} fetched`);
		if (summary.merged) parts.push(`${summary.merged} game${summary.merged === 1 ? '' : 's'} filled from stored logs`);
		if (summary.failed) parts.push(`${summary.failed} replay${summary.failed === 1 ? '' : 's'} couldn't be fetched`);
		if (summary.missing) parts.push(`${summary.missing} game${summary.missing === 1 ? '' : 's'} without a replay link`);
		return parts.length ? parts.join('; ') : 'nothing to backfill';
	}

	/** Backup → Battle logs: backfill one run or all, without exporting. */
	function renderBackfillTools() {
		const runs = allRuns();
		const choice = el('select', { onchange: e => { ui.backfillRun = e.target.value; } }, [
			el('option', { value: '', text: 'All runs', selected: !ui.backfillRun }),
		].concat(runs.map(run => el('option', { value: run.id, text: run.event + (run === state.run ? ' (current)' : ''), selected: ui.backfillRun === run.id }))));
		return el('div', { className: 'mrh-row' }, [
			el('p', { className: 'mrh-muted', text: 'Runs recorded by older versions may lack logs and opponent team sheets. Backfill fetches them from the saved replays (3 at a time).' }),
			el('div', { className: 'mrh-actions' }, [
				choice,
				btn(ui.backfilling ? 'Backfilling…' : 'Backfill from replays', async () => {
					const selected = ui.backfillRun ? runs.filter(r => r.id === ui.backfillRun) : runs;
					ui.backfilling = true;
					ui.backfillMsg = null;
					render();
					try {
						const summary = await backfillRuns(selected);
						ui.backfillMsg = { error: !!summary.failed, text: 'Backfill: ' + backfillSummaryText(summary) + '.' };
						toast(ui.backfillMsg.text, 6000);
					} catch (err) {
						ui.backfillMsg = { error: true, text: 'Backfill failed: ' + (err && err.message || err) };
					}
					ui.backfilling = false;
					render();
				}, { disabled: !!ui.backfilling || !runs.length }),
			]),
			ui.backfillMsg ? el('p', { className: ui.backfillMsg.error ? 'mrh-err' : 'mrh-ok', text: ui.backfillMsg.text }) : null,
		]);
	}

	function renderLogTools() {
		const usage = logUsage();
		const days = el('select', { onchange: e => { ui.logDays = Number(e.target.value); } },
			[7, 30, 90].map(d => el('option', { value: String(d), text: `older than ${d} days`, selected: (ui.logDays || 30) === d })));
		const inRuns = new Set();
		for (const run of allRuns()) for (const set of run.sets) for (const g of set.games) inRuns.add(g.roomid);
		return el('div', null, [
			el('h3', { text: 'Battle logs' }),
			el('p', { className: 'mrh-muted', text: `${usage.count} game log(s) stored, ${fmtBytes(usage.bytes)}. They feed the battle data export.` }),
			el('div', { className: 'mrh-actions' }, [
				btn('Delete logs', () => {
					const cutoff = Date.now() - (ui.logDays || 30) * 86400000;
					const n = deleteLogs(entry => (entry.savedAt || 0) < cutoff);
					toast(`Deleted ${n} log(s)`);
					render();
				}),
				days,
				btn('Delete logs not in any run', () => {
					const n = deleteLogs(entry => !inRuns.has(entry.roomid));
					toast(`Deleted ${n} log(s)`);
					render();
				}),
				btn('Delete all logs', () => {
					if (!confirm('Delete every stored battle log? Runs and replays links are kept.')) return;
					const n = deleteLogs(() => true);
					toast(`Deleted ${n} log(s)`);
					render();
				}),
			]),
			renderBackfillTools(),
		]);
	}

	// ---- Report card (canvas PNG) ---------------------------------------------------

	const SPRITE_BASE = 'https://play.pokemonshowdown.com/sprites/';
	const imageCache = {};

	/** Load an image (same origin as the page, so the canvas stays exportable); null on error/timeout. */
	function loadImage(url) {
		if (!imageCache[url]) {
			imageCache[url] = new Promise(resolve => {
				const img = new Image();
				const timer = setTimeout(() => resolve(null), 6000);
				img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth ? img : null); };
				img.onerror = () => { clearTimeout(timer); resolve(null); };
				img.src = url;
			});
		}
		return imageCache[url];
	}

	async function firstImage(urls) {
		for (const url of urls) {
			const img = await loadImage(url);
			if (img) return img;
		}
		return null;
	}

	function spriteId(species) {
		const dex = pageDex();
		try {
			const sp = dex && dex.species.get(species);
			if (sp && sp.exists !== false && sp.spriteid) return sp.spriteid;
		} catch (e) { /* fall back */ }
		const dash = species.indexOf('-');
		return dash > 0 ? Core.toID(species.slice(0, dash)) + '-' + Core.toID(species.slice(dash + 1)) : Core.toID(species);
	}

	/**
	 * Showdown serves a grey Poke Ball (HTTP 200, same size) for HOME renders it doesn't have, e.g.
	 * Floette-Eternal. Treat an image with almost no saturated pixels as that placeholder.
	 */
	function isPlaceholderSprite(img) {
		try {
			const c = document.createElement('canvas');
			c.width = c.height = 48;
			const ctx = c.getContext('2d');
			ctx.drawImage(img, 0, 0, 48, 48);
			const px = ctx.getImageData(0, 0, 48, 48).data;
			let opaque = 0, colourful = 0;
			for (let i = 0; i < px.length; i += 4) {
				if (px[i + 3] < 128) continue;
				opaque++;
				if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 40) colourful++;
			}
			return opaque > 0 && colourful / opaque < 0.03;
		} catch (e) {
			return false;
		}
	}

	/** Team sprite: HOME render (unless it's the placeholder), then the dex sprite, then gen5. */
	async function teamSprite(species) {
		const id = spriteId(species);
		const home = await loadImage(`${SPRITE_BASE}home-centered/${id}.png`);
		if (home && !isPlaceholderSprite(home)) return home;
		return firstImage(['dex', 'gen5'].map(dir => `${SPRITE_BASE}${dir}/${id}.png`));
	}

	/** Small icon from the client's own icon sheet (as in the teambuilder), else the gen5 sprite. */
	async function iconSprite(species) {
		const dex = pageDex();
		try {
			if (dex && typeof dex.getPokemonIcon === 'function') {
				const css = String(dex.getPokemonIcon(species));
				const url = /url\(['"]?([^'")]+)['"]?\)/.exec(css);
				const pos = /(-?\d+)px\s+(-?\d+)px/.exec(css);
				if (url && pos) {
					const sheet = await loadImage(new URL(url[1], location.href).href);
					if (sheet) return { img: sheet, sx: -Number(pos[1]), sy: -Number(pos[2]), sw: 40, sh: 30 };
				}
			}
		} catch (e) { /* fall back */ }
		const img = await loadImage(`${SPRITE_BASE}gen5/${spriteId(species)}.png`);
		return img ? { img, sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight } : null;
	}

	function roundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	/** fillText, shortened with "…" to fit maxWidth. Returns the drawn width. */
	function fillFit(ctx, text, x, y, maxWidth) {
		let t = String(text);
		if (ctx.measureText(t).width > maxWidth) {
			while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
			t += '…';
		}
		ctx.fillText(t, x, y);
		return ctx.measureText(t).width;
	}

	/** Draw an image scaled to fit (contain) a box, centered. */
	function drawContain(ctx, src, x, y, w, h) {
		const scale = Math.min(w / src.sw, h / src.sh);
		const dw = src.sw * scale, dh = src.sh * scale;
		ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
	}

	const CARD_COLORS = { bg: '#14161b', panel: '#1d2129', text: '#e6edf3', muted: '#8b949e', line: '#2a2f38', W: '#3fb950', L: '#f85149', T: '#8b949e' };
	const cardFont = (size, weight, style) => `${style || ''} ${weight || 400} ${size}px "Segoe UI", Verdana, Helvetica, Arial, sans-serif`;

	/** Render the report card for a run onto a 2x canvas. opts: { showNotes, noImages } */
	async function drawReportCard(run, settings, opts) {
		const m = Core.reportCardModel(run, settings, { showNotes: opts.showNotes });
		const C = Core.CARD, W = m.width, P = C.pad, K = CARD_COLORS;
		// load every sprite first so drawing is synchronous
		const team = opts.noImages ? [] : await Promise.all(m.team.map(teamSprite));
		const oppSpecies = [...new Set(m.rows.reduce((a, r) => a.concat(r.opp), []))];
		const icons = {};
		if (!opts.noImages) (await Promise.all(oppSpecies.map(iconSprite))).forEach((icon, i) => { icons[oppSpecies[i]] = icon; });

		const scale = 2;
		const canvas = document.createElement('canvas');
		canvas.width = W * scale;
		canvas.height = m.height * scale;
		const ctx = canvas.getContext('2d');
		ctx.scale(scale, scale);
		ctx.textBaseline = 'alphabetic';

		// card + accent strip + soft glow
		roundRect(ctx, 0, 0, W, m.height, 16);
		ctx.fillStyle = K.bg;
		ctx.fill();
		ctx.save();
		roundRect(ctx, 0, 0, W, m.height, 16);
		ctx.clip();
		const glow = ctx.createRadialGradient(W - 80, 30, 10, W - 80, 30, 260);
		glow.addColorStop(0, m.accentColor + '40');
		glow.addColorStop(1, m.accentColor + '00');
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, W, 260);
		ctx.fillStyle = m.accentColor;
		ctx.fillRect(0, 0, W, 6);
		ctx.restore();

		// header: event / player · date (left), record + stage (right)
		ctx.fillStyle = K.text;
		ctx.font = cardFont(22, 700);
		fillFit(ctx, m.event, P, 46, W - 2 * P - 190);
		ctx.fillStyle = K.muted;
		ctx.font = cardFont(13);
		const date = m.date ? new Date(m.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
		fillFit(ctx, [m.player, date].filter(Boolean).join(' · '), P, 68, W - 2 * P - 190);
		ctx.textAlign = 'right';
		ctx.fillStyle = K.text;
		ctx.font = cardFont(46, 800);
		ctx.fillText(m.record, W - P, 62);
		ctx.fillStyle = m.accentColor;
		ctx.font = cardFont(13, 700);
		ctx.fillText(m.headline.toUpperCase(), W - P, 84);
		ctx.textAlign = 'left';

		// ELO start -> end (delta)
		if (m.elo.start != null || m.elo.end != null) {
			let x = P;
			ctx.font = cardFont(12, 700);
			ctx.fillStyle = K.muted;
			ctx.fillText('ELO', x, 98);
			x += ctx.measureText('ELO ').width + 4;
			ctx.font = cardFont(15, 600);
			ctx.fillStyle = K.text;
			const span = m.elo.start != null && m.elo.end != null ? `${m.elo.start} → ${m.elo.end}` : String(m.elo.end != null ? m.elo.end : m.elo.start);
			ctx.fillText(span, x, 98);
			x += ctx.measureText(span + ' ').width;
			if (m.elo.start != null && m.elo.end != null) {
				const d = m.elo.end - m.elo.start;
				ctx.fillStyle = d > 0 ? K.W : d < 0 ? K.L : K.muted;
				ctx.fillText(`(${d >= 0 ? '+' : ''}${d})`, x, 98);
			}
		}

		// team: 6 sprites on panels with names
		const slot = (W - 2 * P) / 6;
		const teamTop = 112;
		if (m.team.length) {
			m.team.forEach((species, i) => {
				const x = P + i * slot;
				roundRect(ctx, x + 3, teamTop, slot - 6, 100, 10);
				ctx.fillStyle = K.panel;
				ctx.fill();
				const img = team[i];
				if (img) {
					drawContain(ctx, { img, sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight }, x + 10, teamTop + 6, slot - 20, 70);
				} else {
					ctx.fillStyle = K.text;
					ctx.font = cardFont(13, 700);
					ctx.textAlign = 'center';
					ctx.fillText(species.slice(0, 3).toUpperCase(), x + slot / 2, teamTop + 48);
					ctx.textAlign = 'left';
				}
				ctx.fillStyle = K.muted;
				ctx.font = cardFont(11);
				ctx.textAlign = 'center';
				fillFit(ctx, species, x + slot / 2, teamTop + 94, slot - 12);
				ctx.textAlign = 'left';
			});
		} else {
			ctx.fillStyle = K.muted;
			ctx.font = cardFont(13, 400, 'italic');
			ctx.fillText('Team not recorded', P, teamTop + 50);
		}

		// set rows
		let y = C.header;
		ctx.fillStyle = K.line;
		ctx.fillRect(P, y - 10, W - 2 * P, 1);
		if (!m.rows.length) {
			ctx.fillStyle = K.muted;
			ctx.font = cardFont(13, 400, 'italic');
			ctx.fillText('No sets played yet', P, y + 22);
			y += C.empty;
		}
		const iconW = 32, iconGap = 3;
		const iconsWidth = 6 * iconW + 5 * iconGap;
		for (const row of m.rows) {
			const h = C.row + (row.note ? C.noteExtra : 0);
			const color = K[row.result] || K.muted;
			roundRect(ctx, P, y + 7, 4, h - 14, 2);
			ctx.fillStyle = color;
			ctx.fill();
			const textX = P + 14;
			const textW = W - P - iconsWidth - 12 - textX;
			// line 1: round + opponent
			ctx.font = cardFont(12, 700);
			ctx.fillStyle = K.muted;
			ctx.fillText(row.round, textX, y + 21);
			const rw = ctx.measureText(row.round + '  ').width;
			ctx.font = cardFont(15, 600);
			ctx.fillStyle = K.text;
			fillFit(ctx, row.opponent, textX + rw, y + 21, textW - rw);
			// line 2: result + score + leads
			ctx.font = cardFont(13, 800);
			ctx.fillStyle = color;
			const res = (row.result || '…') + (row.score ? ' ' + row.score : '');
			ctx.fillText(res, textX, y + 40);
			const resW = ctx.measureText(res + '  ').width;
			if (row.leads) {
				ctx.font = cardFont(12);
				ctx.fillStyle = K.muted;
				fillFit(ctx, 'Led ' + row.leads, textX + resW, y + 40, textW - resW);
			}
			// opponent's six
			row.opp.forEach((species, j) => {
				const x = W - P - iconsWidth + j * (iconW + iconGap);
				const icon = icons[species];
				if (icon) {
					drawContain(ctx, icon, x, y + (C.row - 28) / 2, iconW, 28);
				} else {
					ctx.fillStyle = K.panel;
					roundRect(ctx, x, y + 13, iconW, 22, 5);
					ctx.fill();
					ctx.fillStyle = K.muted;
					ctx.font = cardFont(9, 700);
					ctx.textAlign = 'center';
					ctx.fillText(species.slice(0, 4), x + iconW / 2, y + 28);
					ctx.textAlign = 'left';
				}
			});
			if (row.note) {
				ctx.font = cardFont(12, 400, 'italic');
				ctx.fillStyle = K.muted;
				const stars = row.rating ? '  ' + '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating) : '';
				fillFit(ctx, '“' + row.note + '”' + stars, textX, y + 58, W - P - textX);
			}
			y += h;
			ctx.fillStyle = K.line;
			ctx.fillRect(textX, y - 1, W - P - textX, 1);
		}

		// footer
		ctx.fillStyle = K.muted;
		ctx.font = cardFont(11);
		ctx.fillText('Mock Regional Helper', P, m.height - 13);
		ctx.textAlign = 'right';
		ctx.fillText(settings.formatId || '', W - P, m.height - 13);
		ctx.textAlign = 'left';
		return canvas;
	}

	function cardRun() {
		if (!ui.card) return null;
		return ui.card.archived ? runHistory.find(r => r.id === ui.card.runId) || null : state.run;
	}

	function openCard(run) {
		ui.card = { runId: run.id, archived: run !== state.run, from: ui.view, showNotes: true, canvas: null, key: null, busy: false };
		ui.view = 'card';
		render();
	}

	function cardSettings(run) {
		return run === state.run ? state.settings : Core.runSettings(run, state.settings);
	}

	/** (Re)draw the card when its content or the notes toggle changed. */
	async function ensureCard() {
		const card = ui.card;
		const run = cardRun();
		if (!card || !run || card.busy) return;
		const key = JSON.stringify(Core.reportCardModel(run, cardSettings(run), { showNotes: card.showNotes }));
		if (card.key === key && card.canvas) return;
		card.busy = true;
		try {
			card.canvas = await drawReportCard(run, cardSettings(run), { showNotes: card.showNotes });
			card.key = key;
		} catch (err) {
			console.error('[MockRegional] report card', err);
			card.error = String(err && err.message || err);
		}
		card.busy = false;
		render();
	}

	/** PNG blob of the card; if sprites made the canvas unexportable, redraw text-only and retry. */
	async function cardBlob() {
		const card = ui.card;
		const toBlob = canvas => new Promise((resolve, reject) => {
			try {
				canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode PNG'))), 'image/png');
			} catch (err) {
				reject(err);
			}
		});
		try {
			return await toBlob(card.canvas);
		} catch (err) {
			if (!err || err.name !== 'SecurityError') throw err;
			log('report card canvas not exportable (sprites); redrawing without sprites');
			const run = cardRun();
			card.canvas = await drawReportCard(run, cardSettings(run), { showNotes: card.showNotes, noImages: true });
			return toBlob(card.canvas);
		}
	}

	async function downloadCard() {
		const run = cardRun();
		const blob = await cardBlob();
		const url = URL.createObjectURL(blob);
		const a = el('a', { href: url, download: `report-card-${slug(run ? run.event : 'run')}.png` });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	/** Must run inside the click handler: the ClipboardItem gets a promise so the user gesture is kept. */
	function copyCardImage() {
		const fallback = err => {
			log('copy image failed:', err);
			toast('Could not copy the image to the clipboard, so it was downloaded instead.', 5000);
			downloadCard().catch(e => toast('Download failed: ' + (e && e.message || e), 5000));
		};
		try {
			if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
				throw new Error('image clipboard not supported');
			}
			const item = new ClipboardItem({ 'image/png': cardBlob() });
			navigator.clipboard.write([item]).then(() => toast('Report card copied, paste it in Discord'), fallback);
		} catch (err) {
			fallback(err);
		}
	}

	function renderCard() {
		const card = ui.card;
		const run = cardRun();
		const back = () => {
			ui.view = card && card.from && card.from !== 'card' ? card.from : 'run';
			render();
		};
		if (!card || !run) {
			ui.view = 'run';
			return el('div');
		}
		const notes = el('input', { type: 'checkbox', checked: card.showNotes });
		notes.addEventListener('change', () => {
			card.showNotes = notes.checked;
			render();
		});
		const preview = el('div', { className: 'mrh-card-preview' });
		const ready = card.canvas && card.key === JSON.stringify(Core.reportCardModel(run, cardSettings(run), { showNotes: card.showNotes }));
		if (ready) {
			card.canvas.style.width = '100%';
			card.canvas.style.maxWidth = Core.CARD.width + 'px';
			preview.appendChild(card.canvas);
		} else {
			preview.appendChild(el('p', { className: 'mrh-muted', text: card.error ? 'Could not draw the card: ' + card.error : 'Rendering…' }));
			setTimeout(ensureCard, 0);
		}
		return el('div', null, [
			el('p', null, [linkBtn('← Back', back)]),
			el('h2', { text: 'Report card' }),
			el('div', { className: 'mrh-row' }, [el('label', null, [notes, ' Show notes'])]),
			el('div', { className: 'mrh-actions' }, [
				btn('Copy image', copyCardImage, { className: 'button mrh-primary', disabled: !ready }),
				btn('Download PNG', () => downloadCard().catch(err => toast('Download failed: ' + (err && err.message || err), 5000)), { disabled: !ready }),
			]),
			preview,
		]);
	}

	// ---- History, stats, backup views ---------------------------------------------

	function renderNav() {
		const item = (view, label) => el('button', {
			className: 'mrh-nav-item' + (ui.view === view || (view === 'history' && ui.view === 'archived') ? ' mrh-nav-on' : ''),
			text: label,
			onclick: () => {
				ui.view = view;
				ui.chunks = null;
				ui.error = '';
				ui.backupMsg = null;
				render();
			},
		});
		return el('div', { className: 'mrh-nav' }, [
			el('span', { className: 'mrh-version', text: 'v' + VERSION, title: 'Mock Regional Helper version' }),
			item('run', state.run ? 'Run' : 'New run'),
			item('history', 'History'),
			item('stats', 'Stats'),
			item('backup', 'Backup'),
		]);
	}

	function fmtDate(ms) {
		return ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
	}

	function deltaText(d) {
		return d == null ? '' : (d >= 0 ? '+' : '') + d;
	}

	/** The current run plus every archived one (current first). */
	function allRuns() {
		return (state.run ? [state.run] : []).concat(runHistory);
	}

	function renderHistory() {
		const wrap = el('div', null, [el('h2', { text: 'History' })]);
		const runs = allRuns();
		if (!runs.length) {
			wrap.appendChild(el('p', { className: 'mrh-muted', text: 'No runs yet. Finished runs are kept here when you start a new one.' }));
			return wrap;
		}
		const rows = runs.map(run => {
			const sum = Core.runSummary(run, state.settings);
			const current = run === state.run;
			return el('tr', null, [
				el('td', { text: fmtDate(sum.startedAt) }),
				el('td', null, [
					current ? el('b', { text: sum.event }) : linkBtn(sum.event, () => openArchived(run.id)),
					current ? el('span', { className: 'mrh-muted', text: ' (current)' }) : null,
				]),
				el('td', { className: 'mrh-small', text: sum.team.join(' / ') || '—' }),
				el('td', { text: sum.record }),
				el('td', { text: sum.stage }),
				el('td', { className: sum.eloDelta > 0 ? 'mrh-ok' : sum.eloDelta < 0 ? 'mrh-bad' : '', text: deltaText(sum.eloDelta) }),
				el('td', null, current ? [linkBtn('open', () => { ui.view = 'run'; render(); })] : [
					linkBtn('view', () => openArchived(run.id)),
					' · ',
					linkBtn('delete', () => deleteArchived(run)),
				]),
			]);
		});
		wrap.appendChild(el('table', { className: 'mrh-table' }, [
			el('thead', null, el('tr', null, ['Date', 'Event', 'Team', 'Record', 'Stage', 'ELO', ''].map(h => el('th', { text: h })))),
			el('tbody', null, rows),
		]));
		return wrap;
	}

	function openArchived(id) {
		ui.view = 'archived';
		ui.archivedId = id;
		ui.chunks = null;
		ui.error = '';
		render();
	}

	function deleteArchived(run) {
		if (!confirm(`Delete "${run.event}" from your history? This can't be undone (export it first if you want a copy).`)) return;
		runHistory = runHistory.filter(r => r.id !== run.id);
		saveHistory();
		if (ui.archivedId === run.id) ui.view = 'history';
		toast('Run deleted');
		render();
	}

	/** Read-only view of an archived run, with Copy for Discord and export. */
	function renderArchived() {
		const run = runHistory.find(r => r.id === ui.archivedId);
		if (!run) {
			ui.view = 'history';
			return renderHistory();
		}
		const settings = Core.runSettings(run, state.settings);
		const info = Core.stageOf(run, settings);
		const stat = (value, label) => el('div', { className: 'mrh-stat' }, [el('b', { text: value }), el('span', { text: label })]);
		const wrap = el('div', null, [
			el('p', null, [linkBtn('← History', () => { ui.view = 'history'; ui.chunks = null; render(); })]),
			el('h2', { text: run.event }),
			el('div', { className: 'mrh-sub', text: `${run.player} · ${fmtDate(run.startedAt)} · read-only` }),
			el('div', { className: 'mrh-stats' }, [
				stat(Core.recordText(info), 'Record'),
				stat(Core.statusText(info, run), 'Stage'),
				stat(eloLine(run), 'ELO'),
			]),
			run.team ? el('div', { className: 'mrh-row' }, [el('b', { text: 'Team: ' }), Core.packedSpecies(run.team.packed).join(' / ')]) : null,
			el('h3', { text: run.sets.length ? 'Sets' : 'No sets' }),
		]);
		run.sets.forEach((set, i) => wrap.appendChild(renderSet(set, i, { readOnly: true, settings })));
		wrap.appendChild(el('div', { className: 'mrh-actions' }, [
			btn(ui.busy || 'Copy for Discord', () => copyForDiscord(run, settings), { disabled: !!ui.busy }),
			btn('Report card', () => openCard(run)),
			btn('Export this run', () => exportRuns([run], run.event)),
			btn('Export battle data', () => exportBattleData([run], run.event)),
			btn('Delete', () => deleteArchived(run)),
		]));
		wrap.appendChild(renderChunks(false));
		if (ui.error) wrap.appendChild(el('p', { className: 'mrh-err', text: ui.error }));
		return wrap;
	}

	function pct(rate) {
		return rate == null ? '' : Math.round(rate * 100) + '%';
	}

	/** Small horizontal bar (0..1). */
	function bar(fraction, title) {
		const width = Math.max(0, Math.min(1, fraction || 0)) * 100;
		return el('span', { className: 'mrh-bar', title: title || '' }, [el('span', { className: 'mrh-bar-fill', style: `width:${width.toFixed(1)}%` })]);
	}

	function recordCell(row) {
		return `${row.w}-${row.l}` + (row.t ? `-${row.t}` : '');
	}

	const MIN_SETS_FOR_RATE = 2;

	function renderStats() {
		const runs = allRuns();
		const st = Core.computeStats(runs);
		const wrap = el('div', null, [
			el('h2', { text: 'Stats' }),
			el('p', { className: 'mrh-muted', text: `Across ${runs.length} run(s), including the current one. Ties count as sets but not wins.` }),
		]);
		if (!runs.length) return wrap;

		wrap.appendChild(el('h3', { text: 'Record per team' }));
		wrap.appendChild(el('table', { className: 'mrh-table' }, [
			el('thead', null, el('tr', null, ['Team (6 species)', 'Runs', 'Sets', 'Record', 'Win rate'].map(h => el('th', { text: h })))),
			el('tbody', null, st.teams.map(t => el('tr', null, [
				el('td', { className: 'mrh-small', text: t.key }),
				el('td', { text: String(t.runs) }),
				el('td', { text: String(t.sets) }),
				el('td', { text: recordCell(t) }),
				el('td', null, t.sets ? [bar(t.w / t.sets), ' ' + pct(t.w / t.sets)] : []),
			]))),
		]));

		wrap.appendChild(el('h3', { text: 'Win rate vs opponent Pokémon' }));
		wrap.appendChild(el('p', { className: 'mrh-muted', text: `From opponents' team sheets, per set. Rates shown from ${MIN_SETS_FOR_RATE} sets. Click a column to sort.` }));
		const sortBy = ui.statsSort || 'rate';
		const sortHead = (key, label) => el('th', null, [
			el('button', { className: 'mrh-link' + (sortBy === key ? ' mrh-sorted' : ''), text: label + (sortBy === key ? ' ▾' : ''), onclick: () => { ui.statsSort = key; render(); } }),
		]);
		const vsRows = Core.sortVsRows(st.vsPokemon, sortBy, MIN_SETS_FOR_RATE);
		wrap.appendChild(vsRows.length ? el('table', { className: 'mrh-table' }, [
			el('thead', null, el('tr', null, [sortHead('name', 'Pokémon'), sortHead('sets', 'Sets'), el('th', { text: 'Record' }), sortHead('rate', 'Win rate')])),
			el('tbody', null, vsRows.map(r => {
				const rate = Core.winRate(r, MIN_SETS_FOR_RATE);
				return el('tr', null, [
					el('td', { text: r.key }),
					el('td', { text: String(r.sets) }),
					el('td', { text: recordCell(r) }),
					el('td', null, rate == null ? [el('span', { className: 'mrh-muted', text: 'too few sets' })] : [bar(rate), ' ' + pct(rate)]),
				]);
			})),
		]) : el('p', { className: 'mrh-muted', text: 'No opponent team sheets recorded yet.' }));

		wrap.appendChild(el('h3', { text: 'Win rate per lead pair' }));
		wrap.appendChild(st.leadPairs.length ? el('table', { className: 'mrh-table' }, [
			el('thead', null, el('tr', null, ['Leads', 'Games', 'Record', 'Win rate'].map(h => el('th', { text: h })))),
			el('tbody', null, st.leadPairs.map(r => el('tr', null, [
				el('td', { text: r.key }),
				el('td', { text: String(r.sets) }),
				el('td', { text: recordCell(r) }),
				el('td', null, [bar(r.w / r.sets), ' ' + pct(r.w / r.sets)]),
			]))),
		]) : el('p', { className: 'mrh-muted', text: 'No leads recorded yet (tracked from v0.4 on, and from imported replays).' }));

		const oppSets = Core.opponentSetStats(runs, pageDex()).slice(0, 15);
		if (oppSets.length) {
			wrap.appendChild(el('h3', { text: 'Most common opponent sets' }));
			wrap.appendChild(el('p', { className: 'mrh-muted', text: 'From opponents\' team sheets (top 15 species). Numbers are how many sheets had it.' }));
			const freq = list => list.map(x => `${x.name} ${x.count}`).join(', ');
			wrap.appendChild(el('table', { className: 'mrh-table' }, [
				el('thead', null, el('tr', null, ['Pokémon', 'Seen', 'Items', 'Abilities', 'Moves'].map(h => el('th', { text: h })))),
				el('tbody', null, oppSets.map(r => el('tr', null, [
					el('td', { text: r.species }),
					el('td', { text: String(r.count) }),
					el('td', { className: 'mrh-small', text: freq(r.items) }),
					el('td', { className: 'mrh-small', text: freq(r.abilities) }),
					el('td', { className: 'mrh-small', text: freq(r.moves) }),
				]))),
			]));
		}

		wrap.appendChild(el('h3', { text: 'ELO across runs' }));
		if (!st.elo.length) {
			wrap.appendChild(el('p', { className: 'mrh-muted', text: 'No ELO recorded yet.' }));
			return wrap;
		}
		const values = st.elo.reduce((acc, e) => acc.concat([e.start, e.end].filter(v => v != null)), []);
		const lo = Math.min.apply(null, values) - 20, hi = Math.max.apply(null, values) + 20;
		wrap.appendChild(el('table', { className: 'mrh-table' }, [
			el('thead', null, el('tr', null, ['Run', 'Start', 'End', 'Δ', ''].map(h => el('th', { text: h })))),
			el('tbody', null, st.elo.map(e => {
				const d = e.start != null && e.end != null ? e.end - e.start : null;
				return el('tr', null, [
					el('td', { text: `${fmtDate(e.startedAt)} · ${e.event}` }),
					el('td', { text: e.start != null ? String(e.start) : '' }),
					el('td', { text: e.end != null ? String(e.end) : '' }),
					el('td', { className: d > 0 ? 'mrh-ok' : d < 0 ? 'mrh-bad' : '', text: deltaText(d) }),
					el('td', null, [bar(((e.end != null ? e.end : e.start) - lo) / (hi - lo), `${lo + 20}–${hi - 20}`)]),
				]);
			})),
		]));
		return wrap;
	}

	function slug(text) {
		return String(text || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run';
	}

	/** Export runs as a downloaded .json file (Blob + a.download). */
	function exportRuns(runs, label) {
		const copies = runs.map(run => run === state.run ?
			Object.assign(JSON.parse(JSON.stringify(run)), { settingsSnapshot: Object.assign({}, state.settings) }) : run);
		const bundle = Core.exportBundle(copies);
		downloadJson(`mock-regional-${slug(label)}-${new Date().toISOString().slice(0, 10)}.json`, bundle);
		log('exported', runs.length, 'run(s)');
		toast(`Exported ${runs.length} run(s)`);
	}

	function importBackupText(text) {
		let parsed;
		try {
			parsed = Core.parseBackup(text);
		} catch (err) {
			ui.backupMsg = { error: true, text: 'Import failed: ' + err.message };
			render();
			return;
		}
		const result = Core.mergeRuns(runHistory, state.run, parsed.runs);
		runHistory = result.history;
		saveHistory();
		ui.backupMsg = {
			error: false,
			text: `Imported ${result.added} run(s) into History` + (result.skipped ? `; ${result.skipped} already present (skipped)` : '') + '.',
		};
		log('import:', ui.backupMsg.text);
		render();
	}

	function renderBackup() {
		const file = el('input', { type: 'file', accept: '.json,application/json' });
		file.addEventListener('change', () => {
			const f = file.files && file.files[0];
			if (!f) return;
			const reader = new FileReader();
			reader.onload = () => importBackupText(String(reader.result || ''));
			reader.onerror = () => { ui.backupMsg = { error: true, text: 'Could not read the file.' }; render(); };
			reader.readAsText(f);
		});
		return el('div', null, [
			el('h2', { text: 'Backup' }),
			el('h3', { text: 'Export' }),
			el('div', { className: 'mrh-actions' }, [
				btn('Export current run', () => exportRuns([state.run], state.run.event), { disabled: !state.run }),
				btn('Export everything', () => exportRuns(allRuns(), 'backup'), { disabled: !allRuns().length }),
			]),
			el('p', { className: 'mrh-muted', text: 'Single archived runs can be exported from their page in History.' }),
			el('h3', { text: 'Export battle data' }),
			el('p', { className: 'mrh-muted', text: 'Team sheets, pastes, leads and the full battle log of every game, as one .json bundle (see the README).' }),
			el('div', { className: 'mrh-actions' }, [
				btn('Current run', () => exportBattleData([state.run], state.run.event), { disabled: !state.run }),
				btn('All runs', () => exportBattleData(allRuns(), 'all-runs'), { disabled: !allRuns().length }),
			]),
			renderLogTools(),
			el('h3', { text: 'Import' }),
			el('p', { className: 'mrh-muted', text: 'Restores runs from an exported .json file into History. Runs you already have (same id) are skipped; the current run is never replaced.' }),
			el('div', { className: 'mrh-row' }, [file]),
			ui.backupMsg ? el('p', { className: ui.backupMsg.error ? 'mrh-err' : 'mrh-ok', text: ui.backupMsg.text }) : null,
		]);
	}

	// ---- Bootstrap -----------------------------------------------------------

	window.addEventListener('mrh:in', onIncoming);
	window.addEventListener('mrh:out', onOutgoing);
	window.addEventListener('mrh:tabready', onTabReady);
	window.addEventListener('mrh:tabclosed', onTabClosed);
	window.addEventListener('mrh:tabunavailable', e => {
		// only fall back to the sidebar when the user asked to open the view
		if (ui.wantView) {
			log('mode: sidebar (' + e.detail + ')');
			openSidebar();
		} else {
			log('tab unavailable (' + e.detail + '); badge only until clicked');
		}
	});
	window.addEventListener('mrh:taberror', e => {
		ui.wantView = false;
		toast('Could not open the Mock Regional tab: ' + e.detail + ' (details in the console)');
	});
	injectPageHook();

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', buildChrome);
	} else {
		buildChrome();
	}
})();
