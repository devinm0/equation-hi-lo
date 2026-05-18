import { WebSocket } from 'ws';
import { wss, players, ExtendedWebSocket, ServerMessage, Game } from '../state.js';

export function sendSocketMessageToEveryClientInRoom(roomCode: string, objectToSend: ServerMessage) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        // ? is required on players.get for the following case:
        //      if someone has gone to the site (opened the tab) but is still on the homepage,
        //      there is a client and userId, but no player entry for them yet. so players.get will return undefined and therefore there will be no room code
        if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === roomCode) {
            client.send(JSON.stringify(objectToSend));
        }
    });
}

// TODO test have one person fold BEFORE equation forming and make sure
// they don't receive an end-equation-result message
// then have remaining players fold AFTER and make sure it still ends

export function sendSocketMessageToNonFoldedPlayers(game: Game, objectToSend: ServerMessage) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        if (!players.get(client.userId)?.foldedThisTurn && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            client.send(JSON.stringify(objectToSend));
        }
    });
}

// TODO test that hi lo selection ends correctly even with one or more folded players
export function sendSocketMessageToNonFoldedAndNotOutPlayers(game: Game, objectToSend: ServerMessage) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        if (!players.get(client.userId)?.foldedThisTurn && !players.get(client.userId)?.out && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            client.send(JSON.stringify(objectToSend));
        }
    });
}

export function sendSocketMessageToFoldedOrOutPlayers(game: Game, objectToSend: ServerMessage) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        if ((players.get(client.userId)?.foldedThisTurn || players.get(client.userId)?.out) && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            client.send(JSON.stringify(objectToSend));
        }
    });
}
