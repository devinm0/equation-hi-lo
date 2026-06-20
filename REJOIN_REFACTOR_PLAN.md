# Refactor: Unify rejoin replay into a single `game-state` message

## Goal

When a player re-enters an **in-progress** game (page reload or transport-drop reconnect),
the server currently replays state with a **per-phase patchwork** of messages that reuse the
*live* broadcast helpers. Replace that with **one** server→client message — `game-state` — that
fully describes the game **regardless of phase**, and have the client reconstruct the entire
in-game UI from that single message in one handler.

This message must combine the contents of **every** message a rejoining client can receive today
(`room-entered{inProgress}`, `deal` ×players, `next-turn`, `commence-equation-forming`,
`hi-lo-selection-commenced`, `hi-lo-selection`, `round-result`) **plus** the state that is
currently *missing* on rejoin (who has folded, who is locked in, the pot in most phases, per-player
staged bets).

Non-goals: changing the *live* in-game messages (`deal`, `next-turn`, etc. stay as-is for normal
play). We only change the **rejoin/replay** path and add a new message.

---

## Current behavior (read these first)

### Server — `ws/handlers/session.ts`
- `handleEnter` (line 32) → `enterRoom` (line 165).
- `enterRoom` LOBBY branch (167–260): unchanged by this refactor.
- `enterRoom` **in-progress** branch (261–393) is what we replace:
  - Binds `ws.userId`, kills duplicate sockets (266–277) — **keep this**.
  - Rejects non-members (284–287) — **keep this**.
  - Sends `room-entered {inProgress:true}` (290).
  - `switch (game.phase)` (293–392) replays state per phase by calling:
    - `notifyPlayerOfNewlyDealtCards(...)` per player (sends a `deal` each),
    - `advanceToNextPlayersTurn(game, toCall)` for betting phases,
    - `commence-equation-forming`, `hi-lo-selection-commenced`, `hi-lo-selection`, `round-result`.

### Known gaps / bugs in the current rejoin path (this refactor fixes them)
1. **`advanceToNextPlayersTurn` broadcasts to the WHOLE room** (`game/betting.ts:31` loops all
   clients) even though only one player rejoined — re-notifying everyone it's X's turn. Side effect.
2. **Pot not sent** in `SECONDDEAL`/`FIRSTBETTING`/`SECONDBETTING` (see TODOs at session.ts:322,
   346, and the `next-turn` payload has no pot). A rejoiner sees a blank/stale pot.
3. **Folded players not replayed.** The switch only sends `deal` (face-down hands); there is no
   `player-folded` replay, so a rejoining player can't tell who folded.
4. **Locked-in indicators not replayed** during `EQUATIONFORMING` (the `player-locked-in` send is
   commented out at session.ts:302–317). Rejoiner can't see who already locked in.
5. **Staged bets (`player.stake`) not restored** — chip-staging visuals reset.
6. **Frontend `case "game-state"` is an empty stub that falls through to `case "kicked"`**
   (`public/index.html:1030` — missing `break`). Building out `game-state` removes this latent bug.

### Frontend — `public/index.html`
- `onSocketOpen` (1078) sends `{type:"enter", ...}` on reconnect.
- `case "room-entered"` (998) does container show/hide; the `inProgress` branch hides `uiContainer`.
- Per-phase live handlers we will REUSE as building blocks (do not delete): `deal` (576),
  `next-turn` (757), `commence-equation-forming` (793), `hi-lo-selection-commenced` (644),
  `hi-lo-selection` (870), `round-result` (954), `player-folded` (681), `player-reordered-hand`
  (738), `drawHand` (1286), `showPlayingLayout` (2059), `showResultsLayout` (2081),
  `setupBettingControls`, `updatePot`, `updateChipStack`, `beginCountdownNotification`.

---

## Design — the `game-state` message

The server builds ONE object for the rejoining socket only (no broadcast). Shape:

```ts
{
  type: "game-state",

  // --- meta (replaces room-entered{inProgress}) ---
  roomCode: string,
  hostId: string,
  phase: GamePhase,          // e.g. "EQUATIONFORMING"
  pot: number,               // ALWAYS sent (fixes gap #2)
  inProgress: true,
  joined: true,

  // --- me (the rejoining player) ---
  me: {
    id: string,
    hand: Card[],            // FULL hand, hidden card revealed to its owner
    chipCount: number,
    stake: number,           // chips staged this betting round (fixes gap #5)
    needToDiscard: boolean,
    isLockedIn: boolean,
    cannotFormEquation: boolean,  // equationResult != null
    choices: string[],       // [] if not yet selected
    folded: boolean,         // foldedThisTurn || foldedPreviously (match server fold flags)
    out: boolean,
    acknowledgedResults: boolean,
  },

  // --- every player in the room (including me) ---
  players: Array<{
    id: string,
    username: string,
    color: string,
    chipCount: number,
    stake: number,
    hand: Card[],            // masked (hidden card face-down) unless id === me.id
    folded: boolean,
    out: boolean,
    isLockedIn: boolean,     // for EQUATIONFORMING lock indicators (fixes gap #4)
    hasSelectedHiLo: boolean,// choices.length > 0 (for hi/lo "selecting..." tags)
    needToDiscard: boolean,
  }>,

  // --- betting (present only for FIRSTBETTING / SECONDBETTING) ---
  betting?: {
    currentTurnPlayerId: string,
    currentTurnUsername: string,
    toCall: number,          // game.toCall - me.stake  (what I still owe)
    maxBet: number,          // same formula as advanceToNextPlayersTurn (betting.ts:28-37)
  },

  // --- equation forming (present only for EQUATIONFORMING) ---
  equationForming?: {
    remainingSeconds: number,   // getSecondsLeft(game)
  },

  // --- hi/lo selection (present only for HILOSELECTION) ---
  hiLo?: {
    pendingPlayerIds: string[], // nonFoldedAndNotOut with choices.length === 0
    remainingSeconds: number,   // getHiLoSecondsLeft(game)
    totalSeconds: number,       // HI_LO_DURATION / 1000
    meNeedsToSelect: boolean,   // me.choices.length === 0
  },

  // --- results (present only for RESULTVIEWING) ---
  results?: typeof game.results,  // exactly what round-result sends today
}
```

Notes:
- `betting`/`equationForming`/`hiLo`/`results` are **mutually exclusive** by phase; include only
  the one matching `game.phase`. `meta` + `me` + `players` are sent in **all** phases.
- Masking rule: reuse `getHandToSendFromHand(hand, reveal)` (`game/notify.ts:14`) with
  `reveal = (player.id === rejoiningPlayer.id)`. `me.hand` is the full unmasked hand.
- For card **ordering** during EQUATIONFORMING: `player.hand` already reflects live reorders
  (mutated in the `hand-order` handler `server.ts:269`), so sending `players[].hand` in array order
  restores everyone's current ordering for free — no extra field needed.

---

## Server implementation steps

### 1. Add the message type — `state.ts`
Add `GameStateMessage` to the `ServerMessage` union (mirror how `room-entered`/`round-result` are
typed). It's only ever server→client, so no client-message changes.

### 2. Build the snapshot — `ws/handlers/session.ts` (or a new `game/snapshot.ts`)
Add `buildGameState(game: Game, me: Player): GameStateMessage`:
- Import helpers already used in this file: `getHandToSendFromHand` (game/notify.ts),
  `getSecondsLeft`, `getHiLoSecondsLeft`, `HI_LO_DURATION` (game/lifecycle.ts),
  `nonFoldedAndNotOutPlayers` (game/rooms.ts), `playersInRoom`.
- `players`: `playersInRoom(game.roomCode).map(...)` producing the per-player objects above.
- `me`: from the rejoining `Player` record.
- For `betting.maxBet`, copy the exact computation from `advanceToNextPlayersTurn`
  (`betting.ts:28-37`): `maxStake = min(nonFoldedAndNotOut.map(p => p.chipCount + p.stake))`,
  then `maxBet = maxStake - players.get(currentTurnPlayerId).stake`.
- **Confirm the exact fold flags.** Grep `Player` in `state.ts` / `public/classes.ts` for
  `folded`, `foldedThisTurn`, `foldedPreviously`, `out`, `needToDiscard`, `isLockedIn`,
  `equationResult`, `choices`, `acknowledgedResults`, `stake` and use the real field names.
  Derive `folded` to match whatever `nonFoldedAndNotOutPlayers` (game/rooms.ts) treats as folded.

### 3. Replace the in-progress switch — `ws/handlers/session.ts:289-393`
- **Keep** lines 261–287 (userId bind, duplicate-socket termination, non-member rejection).
- **Delete** the `room-entered {inProgress:true}` send (290) and the entire `switch` (293–392).
- Replace with:
  ```ts
  ws.send(JSON.stringify(buildGameState(game, rejoiningPlayer)));
  ```
- Leave the LOBBY branch and its `room-entered` sends untouched.

### 4. Do NOT change live-play messages
`notifyPlayerOfNewlyDealtCards`, `advanceToNextPlayersTurn`, `commence-equation-forming`, etc.
remain for normal play. Only the rejoin path stops using them.

---

## Frontend implementation steps — `public/index.html`

### 5. Implement `case "game-state"` (replace the empty stub at ~1030; ADD the missing `break`)
The handler must do everything `room-entered{inProgress}` + the per-phase messages did. Reuse the
existing functions rather than reimplementing rendering:

```
case "game-state": {
  // (a) session/reconnect bookkeeping — mirror room-entered (998-1019)
  inRoom = true; currentRoomCode = msg.roomCode;
  myId stays from localStorage; set host start button if msg.hostId === myId.

  // (b) container transitions — exactly what room-entered{inProgress} does today:
  hide homeContainer, show uiContainer, hide nameContainer, set uiContainer display per inProgress,
  set roomCodeContainer text.

  // (c) board layout
  if (msg.phase === RESULTVIEWING) showResultsLayout(...) else showPlayingLayout();

  // (d) pot
  updatePot(msg.pot);

  // (e) draw every player's hand (replaces the per-player `deal` replays)
  for (const p of msg.players) {
    drawHand(p.id, p.color, p.username, p.hand, p.needToDiscard /*=highlight discard*/,
             p.folded, p.out);
    updateChipStack(p.chipCount, chipStacksContainer-p.id);
    if (p.id === myId) myHand = msg.me.hand;     // own full hand
    if (p.isLockedIn) /* show locked-in indicator (NEW; see gap #4) */;
    if (p.hasSelectedHiLo === false) /* nothing */;
  }
  // re-attach discard click listeners for highlighted cards if msg.me.needToDiscard
  // (factor the listener-adding block out of `case "deal"` 589-614 into a helper and call it here)

  // (f) phase-specific UI
  if (msg.betting) {
    if (msg.betting.currentTurnPlayerId === myId)
        setupBettingControls(msg.betting.toCall, msg.betting.maxBet, msg.me.chipCount);
    else notifyThatAnotherPlayerIsBetting(msg.betting.currentTurnUsername);
    highlightCurrentBettingPlayerAndDehighlightOthers(msg.betting.currentTurnPlayerId);
  }
  if (msg.equationForming) {
    // mirror case "commence-equation-forming" (793-849):
    beginCountdownNotification(msg.equationForming.remainingSeconds);
    if (msg.me.cannotFormEquation) showNotification("Other players are forming...");
    else { show confirmEquationFormed button + wire onclick (reuse same closure); enable sortable; }
  }
  if (msg.hiLo) {
    // mirror hi-lo-selection-commenced (644) + hi-lo-selection (870):
    rebuild hiloSelectingSet from msg.hiLo.pendingPlayerIds (show "selecting..." tags);
    if (msg.hiLo.meNeedsToSelect) {
      beginCountdownNotification(remainingSeconds, totalSeconds, true);
      openChoiceModal(...) // same closure as case "hi-lo-selection"
    }
  }
  if (msg.results) {
    // mirror round-result (954): showResultsLayout + displayHandResults(msg.results-shaped object)
  }
  break;   // <-- the missing break that currently causes fall-through to "kicked"
}
```

### 6. Extract shared closures to avoid duplication
The equation-forming confirm-button `onclick` (793-849) and the hi/lo `openChoiceModal` closure
(870-952) are large. Extract each into a named function so both the live handler **and** the
`game-state` handler call the same code (DRY; prevents drift). Same for the discard click-listener
block (589-614).

### 7. Stop sending `room-entered` for the in-progress path; keep it for lobby/fresh-join
Since `game-state` now carries the container flags, the in-progress `room-entered` is gone (step 3).
Verify no other client code depends on receiving `room-entered` with `inProgress:true`.

---

## Testing

### 8. Unit tests — `__tests__/tests.ts`
Add tests for `buildGameState(game, me)` (call it directly with constructed `Game`/`Player`):
- **Phase coverage:** one test per phase (FIRSTDEAL, FIRSTBETTING, SECONDDEAL, EQUATIONFORMING,
  SECONDBETTING, HILOSELECTION, RESULTVIEWING) asserting the right optional block is present and the
  others are absent.
- **Masking:** another player's hidden card is face-down in `players[]`; `me.hand` is fully revealed.
- **Pot always present** (regression for gap #2).
- **Folded player** appears with `folded:true` (gap #3).
- **Locked-in player** appears with `isLockedIn:true` during EQUATIONFORMING (gap #4).
- **Betting math:** `betting.toCall === game.toCall - me.stake` and `maxBet` matches the
  `advanceToNextPlayersTurn` formula; `me.stake` reflects staged chips (gap #5).
- **hiLo:** `pendingPlayerIds` excludes players who already chose; `meNeedsToSelect` correct.

### 9. E2E — extend `automated_testing/reconnect.test.ts`
The existing test already drops+reconnects one player in FIRSTDEAL (discard), FIRSTBETTING,
EQUATIONFORMING, and HILOSELECTION. Strengthen/add assertions so the **single `game-state`** path
is exercised and proven complete. The test currently asserts on `room-entered` frames
(`roomEntered` map, lines 57-73, 167-174); switch this to capture `game-state` frames instead
(record frames where `msg.type === 'game-state'`), and assert `msg.inProgress === true` and
`msg.roomCode === roomCode` on the rejoin frame.

Add these assertions (each verifies a slice of state that the OLD patchwork dropped):

1. **Pot restored (gap #2):** after reconnecting during FIRSTBETTING/SECONDBETTING, assert the
   reconnected page's pot reads the same nonzero value other players see (read `#potDiv`/pot text on
   an always-connected page, compare to the reconnected page). Previously blank on rejoin.
2. **Folded player visible (gap #3):** have one player FOLD, then drop+reconnect a *different*
   player; assert the reconnected page shows the folder as folded (folded card styling / the
   `player-folded` visual). New scenario — add a fold before a reconnect.
3. **Locked-in indicator (gap #4):** during EQUATIONFORMING, have player A lock in, then
   drop+reconnect player B; assert B's view shows A's locked-in indicator.
4. **SECONDDEAL discard restore:** the test already reconnects during discard via
   `discardWithReconnect` — also assert it works on the **second** deal explicitly (it loops both
   deals today; add an assertion that the discard highlight/prompt is restored after the
   second-deal reconnect, not just the first).
5. **RESULTVIEWING rejoin (NEW phase coverage):** currently no reconnect happens during
   RESULTVIEWING. Add: after the hand resolves and the results screen shows, drop+reconnect one
   player and assert the results layout + winner rows re-render from `game-state.results`
   (reuse `assertResultsPageWinners` from `_helpers.ts`).
6. **Single-message assertion:** assert that on each reconnect the page receives **exactly one**
   `game-state` frame and **zero** legacy `deal`/`next-turn`/`commence-equation-forming` frames on
   the reconnect socket (proves the patchwork is gone). Capture frames per-socket like the existing
   `page.on('websocket')` block does.
7. **Staged-bet restore (gap #5):** drop+reconnect a player who has already staked chips this
   betting round; assert their chip-staging visual / `#betAmountLabel` reflects the staked amount,
   not 0.

Helper updates in `automated_testing/_helpers.ts`: `discardWithReconnect`,
`equationFormingWithReconnect`, `hiLoSelectionWithReconnect` currently assert UI is restored after
reconnect — keep those, they now implicitly validate `game-state`. Add a small
`resultViewingWithReconnect(pages, contexts)` helper mirroring the others for assertion #5.

### 10. Run before commit (per CLAUDE.md)
- `npm test` — all unit tests must pass (24 + the new `buildGameState` tests).
- `npm run test:e2e` — headless; the reconnect test must pass with the new assertions.
- `npm run build` — confirm TS compiles (server + `enums.ts`); spot-check the frontend manually.

---

## Suggested commit sequence
1. `state.ts` + `buildGameState` + unit tests (server compiles, tests green) — no behavior change yet.
2. Swap the server rejoin switch to `game-state`; implement frontend `case "game-state"` + extract
   shared closures. (E2E green.)
3. Add the new E2E assertions/scenarios (fold-before-reconnect, RESULTVIEWING reconnect,
   single-frame, pot/locked-in/staged-bet checks).

## Rollback safety
Steps 1 is additive. Step 2 is the cutover — if E2E regresses, the old switch is one revert away.
Keep the live-play handlers untouched so only the rejoin path is in scope.
