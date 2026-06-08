import { games, players, Game, Player } from '../state.js';

// Tear a room down completely: stop its timers and delete BOTH the game and every
// player record tied to it, so no in-memory state (or stale "rejoin this room"
// suggestion) survives. Called on game-over acknowledgement and by the periodic
// stale-room sweep. Leaf module (imports nothing from lifecycle) so it stays cycle-free.
export function cleanupGame(game: Game): void {
    clearTimeout(game.endEquationFormingTimeout);
    playersInRoom(game.roomCode).forEach(player => players.delete(player.id));
    games.delete(game.roomCode);
}

export function playersInRoom(roomCode: string): Player[] {
    return [...players.values()].filter(player => player.roomCode === roomCode);
}

export function playersInRoomEntries(roomCode: string): [string, Player][] {
    return [...players].filter(([, player]) => player.roomCode === roomCode);
}

export function activePlayersInRoom(roomCode: string): Player[] {
    return playersInRoom(roomCode).filter(player => player.out === false);
}

export function nonFoldedAndNotOutPlayers(game: Game): Player[] {
    return [...activePlayersInRoom(game.roomCode).filter(player => player.foldedThisTurn !== true)];
}
