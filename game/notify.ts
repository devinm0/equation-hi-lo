import { WebSocket } from 'ws';
import { wss, players, ExtendedWebSocket, Player, Card } from '../state.js';

interface DealPayload {
    type: "deal";
    id: string;
    color: string;
    username: string;
    chipCount: number;
    multiplicationCardDealt: boolean;
    hand?: Card[];
}

export function getHandToSendFromHand(hand: Card[], revealHiddenCard: boolean) {
    let handToSend = JSON.parse(JSON.stringify(hand));

    for (let i = 0; i < handToSend.length; i++) {
        if (handToSend[i].hidden === true) {
            if (!revealHiddenCard) {
                handToSend[i] = new Card(true);
            }
        }
    }

    return handToSend;
}

export function sendSocketMessageThatPlayerFolded(roomCode: string, foldedUserId: string) {
    const foldedPlayer = players.get(foldedUserId);
    if (!foldedPlayer) return false;

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        let handToSend = getHandToSendFromHand(foldedPlayer.hand, client.userId === foldedUserId);

        if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === roomCode) {
            client.send(JSON.stringify({
                type: "player-folded",
                id: foldedUserId,
                color: foldedPlayer.color!,
                username: foldedPlayer.username,
                hand: handToSend,
                chipCount: foldedPlayer.chipCount
            }));
        }
    });
}

export function notifyPlayerOfNewlyDealtCards(playerDealtTo: Player, playerNotifying: Player, multiplicationCardDealt = false) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;

        if (client.userId === playerNotifying.id) {
            let payload: DealPayload = {
                type: "deal",
                id: playerDealtTo.id,
                color: playerDealtTo.color!,
                username: playerDealtTo.username!,
                chipCount: playerDealtTo.chipCount,
                multiplicationCardDealt: multiplicationCardDealt,
            };
            if (playerNotifying.id == playerDealtTo.id) {
                payload.hand = playerDealtTo.hand;
            } else {
                let handToSend = getHandToSendFromHand(playerDealtTo.hand, playerNotifying.id === playerDealtTo.id);
                payload.hand = handToSend;
            }

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
            }
        }
    });
}

// TODO test that only the player who is dealt a multiplication card gets prompted to discard
// TODO test that card is hidden from each other player
// TODO test that a player knows which one of their cards is hidden
export function notifyAllPlayersOfNewlyDealtCards(roomCode: string, player: Player, multiplicationCardDealt = false) {
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket;
        if (players.get(client.userId)?.roomCode === roomCode) {
            let payload: DealPayload = {
                type: "deal",
                color: player.color!,
                id: player.id,
                username: player.username!,
                chipCount: player.chipCount,
                multiplicationCardDealt: multiplicationCardDealt
            };
            if (client.userId == player.id) {
                payload.hand = player.hand;
            } else {
                let handToSend = getHandToSendFromHand(player.hand, client.userId === player.id);
                payload.hand = handToSend;
            }

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
            }
        }
    });
}
