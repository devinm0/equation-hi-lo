import { WebSocket } from 'ws';
import { wss, players, BETTING_TURN_DURATION, ExtendedWebSocket, Game, Player } from '../state.js';
import { findNextKeyWithWrap } from '../public/utilities.js';
import { playersInRoomEntries, nonFoldedAndNotOutPlayers } from './rooms.js';

// Seconds left on the current player's betting-turn timer, for the client's countdown bar.
// Reads the shared endTime so a re-sent next-turn (e.g. on rejoin) restores the true remaining.
export function getBettingTurnSecondsLeft(game: Game) {
    return Math.max(0, Math.ceil((game.bettingTurnEndTime - Date.now()) / 1000));
}

export function findNextPlayerTurn(game: Game): string {
    return findNextKeyWithWrap<Player>(
        playersInRoomEntries(game.roomCode),
        game.currentTurnPlayerId!,
        v => v.foldedThisTurn !== true && v.out !== true
    );
}

export function bettingRoundIsComplete(game: Game) {
    const playerBetAmounts = nonFoldedAndNotOutPlayers(game).map(player => player.stake);
    const setOfBets = new Set(playerBetAmounts);
    // bets are all equal AND active players have all bet at least once, then betting round is complete
    if (setOfBets.size === 1 && nonFoldedAndNotOutPlayers(game).every(player => player.turnTakenThisRound === true)) {
        return true;
    }
    return false;
}

export function advanceToNextPlayersTurn(game: Game, toCall: number) {
    console.log("Advancing to next player's turn, with id:", game.currentTurnPlayerId);
    // Player A bets 10 and then has 20 chips. Player B has 30 chips. Max bet is still 30, not 20.
    // So add the 10 and 20 to get 30. (Add chips PLUS the chips they have in this round)
    const nonFoldedPlayerChipCounts = nonFoldedAndNotOutPlayers(game).map(player => player.chipCount + player.stake);
    const maxStake = Math.min(...nonFoldedPlayerChipCounts);

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            client.send(JSON.stringify({
                type: "next-turn",
                toCall: toCall,
                maxBet: maxStake - players.get(game.currentTurnPlayerId!)!.stake,
                currentTurnPlayerId: game.currentTurnPlayerId,
                username: players.get(game.currentTurnPlayerId!)!.username,
                playerChipCount: players.get(client.userId)!.chipCount,
                remainingSeconds: getBettingTurnSecondsLeft(game),
                totalSeconds: BETTING_TURN_DURATION / 1000
            }));
        }
    });
}
