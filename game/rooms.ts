import { players, Game, Player } from '../state.js';

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
