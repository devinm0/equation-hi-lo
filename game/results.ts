import { WebSocket } from 'ws';
import { Suit } from '../enums.js';
import { wss, players, ExtendedWebSocket, Game, Player, Card } from '../state.js';
import { nonFoldedAndNotOutPlayers } from './rooms.js';
import { getHandToSendFromHand } from './notify.js';

export function revealHiddenCards(game: Game) {
    // Don't reveal folded players' hidden cards.
    // TODO "deal" is a misnomer — we are re-rendering the whole hand, not dealing cards.
    nonFoldedAndNotOutPlayers(game).forEach((player) => {
        wss.clients.forEach((c) => {
            const client = c as ExtendedWebSocket;
            let handToSend = getHandToSendFromHand(player.hand, true);

            if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
                client.send(JSON.stringify({
                    type: "deal",
                    id: player.id,
                    username: player.username,
                    hand: handToSend
                }));
            }
        });
    });
}

export function findLowestCard(hand: Card[]): Card {
    return hand.filter(card => card.suit !== Suit.OPERATOR).reduce((minCard, currentCard) => {
        if (currentCard.value! < minCard.value!) {
            return currentCard;
        }

        if (currentCard.value! == minCard.value! && currentCard.suit! < minCard.suit!) {
            return currentCard;
        }

        return minCard;
    });
}

export function findHighestCard(hand: Card[]): Card {
    return hand.filter(card => card.suit !== Suit.OPERATOR).reduce((maxCard, currentCard) => {
        if (currentCard.value! > maxCard.value!) {
            return currentCard;
        }

        if (currentCard.value! == maxCard.value! && currentCard.suit! > maxCard.suit!) {
            return currentCard;
        }

        return maxCard;
    });
}

export function findLoWinner(loBettingPlayers: Player[]): [Player | null, Card | null] {
    const loTarget = 1;
    let loWinner = null;
    let loWinnerLowCard = null;
    let winningDiff = Infinity;
    for (const player of loBettingPlayers) {
        const diff = Math.abs(player.lowEquationResult! - loTarget);
        if (diff < winningDiff) {
            winningDiff = diff;
            loWinner = player;
            // wipe out in case of second place tie. but TODO this doesn't work because what if there's a 3 way tie. this will wipe out the first
            // TODO need extra if (diff < loContenderDiff)
            // if we are in this block (diff < winningDiff) it means there's no tie. So we can clear all contenders.
            loBettingPlayers.forEach(player => player.isLoContender = false);
            loWinnerLowCard = findLowestCard(loWinner!.hand); // have this line here just so return statement doesn't break. don't really need it tho
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isLoContender = true;
            loWinner!.isLoContender = true; // loWinner! is because we can never hit this case given the diff is Infinity to start

            let playerLowCard = findLowestCard(player.hand);

            if (playerLowCard.value! < loWinnerLowCard!.value!) {
                loWinner = player;
            } else if (playerLowCard.value === loWinnerLowCard!.value) {
                if (playerLowCard.suit! < loWinnerLowCard!.suit!) {
                    loWinner = player;
                    loWinnerLowCard = findLowestCard(loWinner!.hand);
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }

    return [loWinner, loWinnerLowCard];
}

export function findHiWinner(hiBettingPlayers: Player[]): [Player | null, Card | null] {
    const hiTarget = 20;
    let hiWinner = null;
    let hiWinnerHighCard = null;
    let winningDiff = Infinity;
    for (const player of hiBettingPlayers) {
        const diff = Math.abs(player.highEquationResult! - hiTarget); // should not force this here. there was a bug. throw if no highEquationResult
        if (diff < winningDiff) {
            winningDiff = diff;
            hiWinner = player;
            // wipe out in case of second place tie
            hiBettingPlayers.forEach(player => player.isHiContender = false);
            hiWinnerHighCard = findHighestCard(hiWinner!.hand); // have this line here just so return statement doesn't break. don't really need it tho
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isHiContender = true;
            hiWinner!.isHiContender = true;

            // right now, let's say two people tie for second place. we compare the highest card of each
            // but we don't really need it because then the first place ends up winning. bit of a waste
            const playerHighCard = findHighestCard(player.hand);

            if (playerHighCard.value! > hiWinnerHighCard!.value!) {
                hiWinner = player;
            } else if (playerHighCard.value === hiWinnerHighCard!.value) {
                if (playerHighCard.suit! > hiWinnerHighCard!.suit!) {
                    hiWinner = player;
                    hiWinnerHighCard = findHighestCard(hiWinner!.hand);
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }

    return [hiWinner, hiWinnerHighCard];
}

// can't we simply have hiBetWinner and loBetWinner!?
export function determineWinnersInternal(notFoldedPlayers: Player[]) { // TODO rename to just determine winners
    const swingBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('low') && player.choices.includes('high'));
    const loBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('low') && !player.choices.includes('high'));
    const hiBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('high') && !player.choices.includes('low'));

    let [loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard] = findLoWinner(swingBettingPlayers.concat(loBettingPlayers));
    let [hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard] = findHiWinner(swingBettingPlayers.concat(hiBettingPlayers));
    let [loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard] = findLoWinner(swingBettingPlayers);
    let [hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard] = findHiWinner(swingBettingPlayers);
    let [loWinner, loWinnerLowCard] = findLoWinner(loBettingPlayers);
    let [hiWinner, hiWinnerHighCard] = findHiWinner(hiBettingPlayers);
    const swingBetterWon = swingBettingPlayers.length > 0 && loWinnerIncludingSwingBetters?.id === loWinnerOfSwingBetters?.id && loWinnerOfSwingBetters?.id === hiWinnerIncludingSwingBetters?.id && hiWinnerIncludingSwingBetters?.id === hiWinnerOfSwingBetters?.id;
    // TODO why can't swingBetterWon just be hiWinner.id === loWinner.id?
        // the reason, what if one swing better wins the hi, but a lo only better wins lo, for example.
        // then we need to have known who was the hiWinner excluding swing betters.
    // i think this present implementation allows for two swing players to have their tie card highlighted, AND two non swing players to have their tie card highlighted.
        // TEST add this

    return {loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard,
        hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard,
        loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard,
        hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard,
        loWinner, loWinnerLowCard,
        hiWinner, hiWinnerHighCard,
        swingBetterWon
    }; // TODO clean up this return
}
