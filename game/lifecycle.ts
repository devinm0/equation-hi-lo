// game/lifecycle.ts — THE ORCHESTRATOR.
//
// This is the single home for the whole phase state machine. Every function that
// assigns game.phase or decides "what happens next" lives here together. The
// mutually-recursive transition functions (fold <-> endRoundOrProceedToNextPlayer
// <-> commenceEquationForming <-> endEquationForming, endHand <-> initializeHand)
// are fine intra-file — the only thing ESM can't do is an import *cycle*, and there
// is none because every leaf module below is PURE and never imports lifecycle.
import { WebSocket } from 'ws';
import {
    games, players, wss, EQUATION_DURATION, HI_LO_DURATION,
    Game, Player, GamePhase, ExtendedWebSocket,
} from '../state.js';
import { printDeck } from '../debug/print.js';
import { generateDeck } from './deck.js';
import {
    sendSocketMessageToEveryClientInRoom,
    sendSocketMessageToNonFoldedAndNotOutPlayers,
    sendSocketMessageToFoldedOrOutPlayers,
} from '../ws/broadcast.js';
import {
    sendSocketMessageThatPlayerFolded,
    notifyAllPlayersOfNewlyDealtCards,
} from './notify.js';
import {
    playersInRoom,
    activePlayersInRoom,
    nonFoldedAndNotOutPlayers,
} from './rooms.js';
import {
    playersThatNeedToDiscard,
    dealOperatorCards,
    dealFirstHiddenCardToEachPlayer,
    dealTwoOpenCardsToEachPlayer,
    dealLastOpenCardToEachPlayer,
} from './deal.js';
import {
    findNextPlayerTurn,
    bettingRoundIsComplete,
    advanceToNextPlayersTurn,
} from './betting.js';
import { applyOps } from './equation.js';
import {
    revealHiddenCards,
    findLowestCard,
    findHighestCard,
    determineWinnersInternal,
    computePotDistribution,
} from './results.js';

export function fold(foldedPlayer: Player, manual: Boolean, game: Game) {
    foldedPlayer.foldedThisTurn = true;
    foldedPlayer.hand.forEach(card => {
        card.hidden = true;
    });

    sendSocketMessageThatPlayerFolded(foldedPlayer.roomCode, foldedPlayer.id);

    // two cases to check:

    // player manually folded in first betting round, and there's only one player left, go ahead and distribute pot
    if (manual === true ||
        // if we've received equation result socket messages from every player, we can proceed to second round of betting.
        // this check must be inside the parent if loop, otherwise we may have a case where no one submitted an equation,
        // so whichever client is last to have its message received actually takes the whole pot
        nonFoldedAndNotOutPlayers(game).every(player => player.equationResult != null))
    {
        // TODO I think this if statement only can be moved outside the parent if. No way to race condition to 0
        if (nonFoldedAndNotOutPlayers(game).length === 0){
            returnChipsToAllPlayers(game);
            return;
        }

        if (nonFoldedAndNotOutPlayers(game).length === 1){
            const onlyRemainingPlayer = nonFoldedAndNotOutPlayers(game)[0];
            if (!onlyRemainingPlayer) return;

            distributePotToOnlyRemainingPlayer(game, onlyRemainingPlayer);
            return;
        }

        // more tests
        // everyone but one submits equations early, last person is invalid and folds. make sure betting controls still shown
        // one person submits early, one person submits valid with ending tiemout, and one person folds
        // one person submits early, 2 people fold
        // all people fold

        /* TODO this is repeated */

        // this is the case that everyone force submitted equations except one person,
        // so they folded on equation submission
        // we have to wrap in a check for gamephase.equationforming because, if two people go all in in 1st round betting, and one folds,
        // without this check, we'd proceed to hi lo selection before going to equation forming

        // I feel like there could be a bug here. Let's say everyone submits there equations early.
        // so we are hitting this code, and about to progress to hiloselection
        // but if the interval runs out in that time in between, we send end equation socket message
        // and everyone will resend equation results.
        if (game.phase === GamePhase.EQUATIONFORMING) {
            if (game.maxRaiseReached) {
                console.log('Max bet was reached on first round of betting. Skipping second round.');

                sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-skipped" });

                commenceHiLoSelection(game);
            } else {
                console.log('All equations received. Proceeding to second round of betting.');

                commenceSecondRoundBetting(game);
            }
        }
    }

    if (manual === true) { // TODO unreadable (looks like same condition above but it's not)
        endRoundOrProceedToNextPlayer(game, foldedPlayer);
    }
}

export function endRoundOrProceedToNextPlayer(game: Game, justPlayedPlayer: Player) {
    if (bettingRoundIsComplete(game)) {
        endBettingRound(game);

        if (game.phase === GamePhase.SECONDBETTING) {
            commenceHiLoSelection(game);
        } else if (game.phase === GamePhase.FIRSTBETTING) {
            dealLastOpenCardToEachPlayer(game);

            // possible that players receive multiply cards on last deal
            // so don't commence equation forming unless all discards are complete
            if (playersThatNeedToDiscard(game.roomCode).length === 0) {
                commenceEquationForming(game);
            }
        }
    } else {
        // TODO what if they are out? they will have 0 chips in that case as well
        if (justPlayedPlayer.chipCount === 0) {
            // if anyone is 0, it means someone is all in and no one can bet anymore
            game.maxRaiseReached = true;
        }
        game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO make this a method of class game
        if (!game.currentTurnPlayerId) throw new Error;

        const currentTurnPlayer = players.get(game.currentTurnPlayerId);
        if (!currentTurnPlayer) throw new Error;

        console.log(currentTurnPlayer.username);
        // subtract player's stake.
        // if someone bets 10, then next raises 4, we can toCall to be 4, NOT 14
        // it would also allow betting more chips than a player has
        advanceToNextPlayersTurn(game, game.toCall - currentTurnPlayer.stake); // TODO refactor, this is just bad
    }
}

function clearHands(roomCode: string, playersInThisRoom: Player[]) {
    playersInThisRoom.forEach(player => { // change players in room to be just the values. then modify logic everywhere
        player.hand = [];

        notifyAllPlayersOfNewlyDealtCards(roomCode, player);
    })
}

export function endHand(game: Game) {
    console.log("endHand");
    playersInRoom(game.roomCode).forEach(player => { console.log(player.username, "chipCount:", player.chipCount); });

    clearTimeout(game.endEquationFormingTimeout);
    clearTimeout(game.hiLoSelectionTimeout);
    clearHands(game.roomCode, playersInRoom(game.roomCode));
    game.maxRaiseReached = false;
    game.handNumber += 1;
    game.results = [];

    playersInRoom(game.roomCode).forEach(player => { // refactor to this.players() which is a function
        // Only fire "kicked" the hand a player is NEWLY eliminated. Without the !player.out
        // guard, an already-out player (still at 0 chips) gets re-kicked every endHand, which
        // replays the elimination sound on every hand.
        if (player.chipCount === 0 && !player.out) {
            sendSocketMessageToEveryClientInRoom(game.roomCode, {
                type: "kicked",
                userId: player.id,
                color: player.color!,
                username: player.username!,
                hand: player.hand,
                chipCount: 0
            });

            player.out = true;
        }

        player.foldedThisTurn = false;
        player.equationResult = null;
        player.isLockedIn = false;
        player.otherEquationResult = null;
        player.lowEquationResult = null;
        player.highEquationResult = null;
        player.choices = [];
        player.acknowledgedResults = false;
        player.contribution = 0;
        player.needToDiscard = false;
    })

    // Game-over check: once everyone but one player has been eliminated (0 chips ->
    // out), there is no one left to play against. End the game instead of dealing a
    // new hand. The lone survivor is the winner; their whole stack is their winnings.
    const stillIn = playersInRoom(game.roomCode).filter(player => !player.out);
    if (stillIn.length <= 1) {
        declareGameOver(game, stillIn[0] ?? null);
        return;
    }

    initializeHand(game);
}

// Broadcast the winner and freeze the game in GAMEOVER. We do NOT delete state here —
// the clients still need to receive this message (broadcast keys off each player's
// room record), and the winner's "Accept"/leave is what triggers cleanupGame. The
// periodic stale-room sweep is the backstop if they never acknowledge.
export function declareGameOver(game: Game, winner: Player | null): void {
    clearTimeout(game.endEquationFormingTimeout);
    clearTimeout(game.hiLoSelectionTimeout);
    game.phase = GamePhase.GAMEOVER;

    // Edge case: a simultaneous bust (e.g. all-swing-no-sweep forfeits the pot) can
    // leave zero players with chips. Fall back to whoever holds the most so the game
    // still terminates with a named winner rather than hanging.
    const champion = winner
        ?? playersInRoom(game.roomCode).reduce<Player | null>(
            (best, p) => (best === null || p.chipCount > best.chipCount ? p : best), null);

    if (!champion) return; // empty room — nothing to announce

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "game-won",
        winnerId: champion.id,
        username: champion.username!,
        color: champion.color!,
        chipCount: champion.chipCount,
    });
}

export function initializeHand(game: Game) { // means start a hand of play
    console.log("Initializing hand.");

    playersInRoom(game.roomCode).forEach(player => {
        if (player.out) { // fold automatically if out
            // player.foldedThisTurn = true;
        } else {
            console.log(player.username, "chipCount:", player.chipCount);
        }
    })

    game.deck = generateDeck(); // TODO rename all game.something to room.something
    printDeck(game.deck);

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "begin-hand",
        handNumber: game.handNumber
    });

    game.phase = GamePhase.FIRSTDEAL;
    // or would it be better to have one method, which determines players and active inside?
    dealOperatorCards(game.roomCode, activePlayersInRoom(game.roomCode));

    dealFirstHiddenCardToEachPlayer(game, activePlayersInRoom(game.roomCode));

    dealTwoOpenCardsToEachPlayer(game, activePlayersInRoom(game.roomCode));

    console.log("numPlayersToDiscard: ", playersThatNeedToDiscard(game.roomCode).length) // refactor to one variable

    // upon reading, thought this should be numPlayersThatNeedToDiscard === numPlayersThatHaveDiscarded
    // it could be
    // but anyway, this shows we can commence right away if no multiplies were dealt
    // the other condition is that there WERE people who need to discard, and that is checked elsewhere
    //      so there are two calls to commenceFirstRoundBetting();

    if (playersThatNeedToDiscard(game.roomCode).length === 0) { // no multiply cards were dealt
        commenceFirstRoundBetting(game);
    }
}

export function endBettingRound(game: Game) {
    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "end-betting-round", round: game.phase });

    game.toCall = 0;

    for (const player of playersInRoom(game.roomCode)) {
        player.turnTakenThisRound = false;
        player.stake = 0;
    }
}

export function commenceFirstRoundBetting(game: Game) {
    console.log("Commencing first round of betting");

    game.phase = GamePhase.FIRSTBETTING;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "first-round-betting-commenced",
    });

    const currentPlayer = players.get(game.currentTurnPlayerId!);
    if (!currentPlayer || currentPlayer.out || currentPlayer.foldedThisTurn) {
        game.currentTurnPlayerId = findNextPlayerTurn(game);
    }
    advanceToNextPlayersTurn(game, 1); // TODO change to anteAmount (and then modify as game goes on)
}

export function commenceSecondRoundBetting(game: Game) {
    game.phase = GamePhase.SECONDBETTING;

    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-commenced" });

    // put findNextPlayerTurn inside advanceToNextPlayersTurn
    // i think I want to just continue in round robin.
    // We can change this implementation later to always follow left of the dealer
    game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO we should be passing player id into advanceToNextPlayersTurn
    advanceToNextPlayersTurn(game, 0); // no ante to match on the second round
}

export function commenceEquationForming(game: Game) {
    console.log("Waiting 90 seconds for equation forming...");

    game.phase = GamePhase.EQUATIONFORMING;
    // actually this doesn't even matter. the client could still cheat say they aren't folded, so
    // just let the client decide if they are folded or not in the first place.
    sendSocketMessageToNonFoldedAndNotOutPlayers(game, { type: "commence-equation-forming" });
    sendSocketMessageToFoldedOrOutPlayers(game, { type: "commence-equation-forming", cannotFormEquation: true });

    game.equationEndTime = Date.now() + EQUATION_DURATION;

    game.endEquationFormingTimeout = setTimeout(() => {
        endEquationForming(game);
    }, EQUATION_DURATION);
}

export function endEquationForming(game: Game) {
    // Always reset the equation timer as the FIRST thing we do when the phase ends, so it's
    // guaranteed cleared BEFORE any downstream transition (e.g. straight to hi/lo selection,
    // which then arms its own separate timer). Harmless no-op when we got here via the timer
    // firing. (Replaces the fragile clear that used to sit in the lock-in handler.)
    clearTimeout(game.endEquationFormingTimeout);

    nonFoldedAndNotOutPlayers(game).forEach(player => {
        try {
            player.equationResult = applyOps(player.hand);

            if (!isFinite(player.equationResult)) {
                console.log("Non-finite equation result for player " + player.id + ": " + player.equationResult);
                fold(player, false, game);
                return;
            }

            console.log("final order received and equationResult calculated " + player.equationResult);
        } catch (e) {
            console.log("Malformed equation for player " + player.id);
            fold(player, false, game);
        }
    });

    sendSocketMessageToEveryClientInRoom(game.roomCode, { // NEED to change this to game
        type: "end-equation-forming"
    });

    checkIfOneRemainingPlayerOrMaxRaiseReachedOrProceedToSecondRoundBetting(game);
}

export function checkIfOneRemainingPlayerOrMaxRaiseReachedOrProceedToSecondRoundBetting(game: Game) {
    if (nonFoldedAndNotOutPlayers(game).length === 1){
        const onlyRemainingPlayer = nonFoldedAndNotOutPlayers(game)[0];
        if (!onlyRemainingPlayer) return;

        distributePotToOnlyRemainingPlayer(game, onlyRemainingPlayer);
        return;
    }

    if (game.maxRaiseReached) {
        console.log('Max bet was reached on first round of betting. Skipping second round.');

        sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-skipped" });

        commenceHiLoSelection(game);
    } else {
        console.log('All equations received. Proceeding to second round of betting.');

        commenceSecondRoundBetting(game);
    }
}

export function getSecondsLeft(game: Game) {
    const msLeft = game.equationEndTime - Date.now();
    return Math.max(0, Math.ceil(msLeft / 1000));
}

export function commenceHiLoSelection(game: Game) {
    game.phase = GamePhase.HILOSELECTION;

    // Arm the hi/lo timer on its OWN field. We clear any prior hi/lo timer first; the
    // equation-forming timer was already cleared at the top of endEquationForming, so it
    // cannot fire during this phase. On expiry, endHiLoSelection folds anyone who never
    // picked a side and resolves the hand — so one unresponsive client can't hang the table.
    clearTimeout(game.hiLoSelectionTimeout);
    game.hiLoEndTime = Date.now() + HI_LO_DURATION;
    game.hiLoSelectionTimeout = setTimeout(() => endHiLoSelection(game), HI_LO_DURATION);

    const pendingPlayerIds = nonFoldedAndNotOutPlayers(game).map(p => p.id);
    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "hi-lo-selection-commenced",
        pendingPlayerIds,
    });

    sendSocketMessageToNonFoldedAndNotOutPlayers(game, {
        type: "hi-lo-selection",
        remainingSeconds: getHiLoSecondsLeft(game),
        totalSeconds: HI_LO_DURATION / 1000,
    });
}

export function getHiLoSecondsLeft(game: Game) {
    const msLeft = game.hiLoEndTime - Date.now();
    return Math.max(0, Math.ceil(msLeft / 1000));
}

// Fires when the hi/lo timer runs out: fold every still-in player who never chose a side,
// then resolve the hand with whoever did. Mirrors endEquationForming's auto-fold pattern.
export function endHiLoSelection(game: Game) {
    if (game.phase !== GamePhase.HILOSELECTION) return;

    nonFoldedAndNotOutPlayers(game)
        .filter(player => player.choices.length === 0)
        .forEach(player => {
            // Mark folded directly — fold() carries betting/equation-phase orchestration that
            // doesn't apply here; we only want the "this player is out of the showdown" effect.
            player.foldedThisTurn = true;
            player.hand.forEach(card => { card.hidden = true; });
            sendSocketMessageThatPlayerFolded(player.roomCode, player.id);
        });

    resolveHiLoSelection(game);
}

// Shared end-of-hi/lo resolution. Called both when every player has selected (normal path,
// from the hi-lo-selected handler) and on timeout (after auto-folding the non-selectors).
export function resolveHiLoSelection(game: Game) {
    clearTimeout(game.hiLoSelectionTimeout);
    game.phase = GamePhase.RESULTVIEWING;

    // Everyone timed out without choosing — return contributions, no showdown.
    if (nonFoldedAndNotOutPlayers(game).length === 0) {
        returnChipsToAllPlayers(game);
        return;
    }

    revealHiddenCards(game);
    determineWinners(game);
}

export function returnChipsToAllPlayers(game: Game){
    console.log("No players formed a valid equation. Returning chips and starting new hand.");

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            let payload = JSON.stringify({
                type: "round-result",
                message: "No players formed a valid equation. Returning chips and starting new hand.",
                becauseNoOneFormedEquation: true
            });
            client.send(payload);
        }
    });

    playersInRoom(game.roomCode).forEach(player => {
        player.chipCount += player.contribution; // not stake... because it will be 0 once betting round over
        player.contribution = 0;
    });

    game.pot = 0;

    // need to call endBettingRound because we have to reset everyone's bets. Otherwise
    // next hand will begin with toCall equaling the raise from the first hand
    endBettingRound(game);
    endHand(game);
}

export function distributePotToOnlyRemainingPlayer(game: Game, onlyRemainingPlayerThisHand: Player){
    // end turn
    console.log("All but one player folded this hand. Ending hand.");

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            let message;
            if (client.userId === onlyRemainingPlayerThisHand.id) {
                message = "Everyone else folded. You take the pot by default.";
            } else {
                message = `Everyone but ${onlyRemainingPlayerThisHand.username} has folded. They take the pot of ${game.pot}`;
            }
            let payload = JSON.stringify({
                type: "round-result",
                message: message,
                becauseAllButOneFolded: true
            });
            client.send(payload);
        }
    });

    // that person takes the whole pot
    onlyRemainingPlayerThisHand.chipCount += game.pot;
    game.pot = 0;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "chip-distribution",
        chipCount: game.pot,
        id: onlyRemainingPlayerThisHand.id
    });

    // need to call endBettingRound because we have to reset everyone's bets. Otherwise
    // next hand will begin with toCall equaling the raise from the first hand
    playersInRoom(game.roomCode).forEach(player => {
        console.log(player.username, "chipCount:", player.chipCount);
    })

    endBettingRound(game);
    endHand(game);
}

export function determineWinners(game: Game) { // this is determineWinners and send results. need to decouple
    // TODO change to player.choice = "swing"
    const outcome = determineWinnersInternal(nonFoldedAndNotOutPlayers(game));
    const {loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard,
        hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard,
        loWinner, loWinnerLowCard,
        hiWinner, hiWinnerHighCard,
        swingBetterWon} = outcome;

    // Pure pot-distribution decision (split out into results.ts so it can be unit-tested).
    // Returns the chip delta for each winner and the result message. Note: if only swing
    // betters remained and none swept both sides, nobody wins and the pot is forfeited
    // (deltas is empty) — that lost-chips behavior is intentional/unchanged.
    const distribution = computePotDistribution(outcome, game.pot);
    const byId = new Map(playersInRoom(game.roomCode).map(p => [p.id, p]));
    distribution.deltas.forEach((delta, id) => {
        const winner = byId.get(id);
        if (winner) winner.chipCount += delta;
    });
    const message = distribution.message;
    const chipDeltaFor = (id: string) => distribution.deltas.get(id) ?? 0;

    game.pot = 0; // TODO put this inside of endHand??

    // should I have game.results variable? probably easiest...
    // need to set it to undefined in endHand
    let results = [...playersInRoom(game.roomCode).values()].map(player => {
        if (player.out === true || player.foldedThisTurn === true) {
            return ({
                id: player.id,
                color: player.color,
                chipCount: player.chipCount,
                folded: player.foldedThisTurn,
                out: player.out
            });
        } else return ({
            id: player.id,
            color: player.color,
            chipCount: player.chipCount,
            chipDifferential: chipDeltaFor(player.id),
            lowHand: player.lowHand, // TODO adjust for swing
            highHand: player.highHand,
            folded: player.foldedThisTurn,
            // TODO debug this
            lowCard : findLowestCard(player.hand).value,
            highCard : findHighestCard(player.hand).value,
            choices: player.choices, // TODO adjust this for swing betting, need to send choices
            lowResult: player.choices.includes('low') ? player.lowEquationResult : null, // TODO how to send right result for each
            highResult: player.choices.includes('high') ? player.highEquationResult : null, // TODO how to send right result for each
            lowDifference: player.choices.includes('low') && player.lowEquationResult ? Math.abs(player.lowEquationResult - 1) : null, // adjust for swing
            highDifference: player.choices.includes('high') && player.highEquationResult ? Math.abs(player.highEquationResult - 20) : null, // adjust for swing
            isHiWinner: swingBetterWon ? player.id === hiWinnerIncludingSwingBetters?.id : player.id === hiWinner?.id, // what if swing one the hi but not the low
            isLoWinner: swingBetterWon ? player.id === loWinnerIncludingSwingBetters?.id : player.id === loWinner?.id,
            loWinnerLowCard: swingBetterWon ? loWinnerIncludingSwingBettersLowCard?.value : loWinnerLowCard?.value,
            hiWinnerHighCard: swingBetterWon ? hiWinnerIncludingSwingBettersHighCard?.value : hiWinnerHighCard?.value,
            // this doesn't work either, because it will highlight the low or high card EVEN if there is no tie. UGH
            isLoContender: player.isLoContender,
            isHiContender: player.isHiContender
        })
    });

    game.results = results;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "round-result",
        message: message!,
        loWinner: loWinner,
        hiWinner: hiWinner,
        results: results
    });

    return results; // just for unit tests
}
