import { OperatorCard, Suit } from '../enums.js';
import { Game, Player, Card, GamePhase } from '../state.js';
import { drawFromDeck, drawNumberCardFromDeck } from './deck.js';
import { notifyAllPlayersOfNewlyDealtCards } from './notify.js';
import { playersInRoom, nonFoldedAndNotOutPlayers } from './rooms.js';
import { printHand } from '../debug/print.js';

export function playersThatNeedToDiscard(roomCode: string): Player[] {
    return playersInRoom(roomCode).filter(player => player.needToDiscard === true);
}

export function dealOperatorCards(roomCode: string, playersInThisRoom: Player[]) {
    playersInThisRoom.forEach(player => {
        player.hand.push(new Card(false, OperatorCard.ADD, Suit.OPERATOR));
        player.hand.push(new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR));
        player.hand.push(new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR));

        notifyAllPlayersOfNewlyDealtCards(roomCode, player);
    });
}

export function dealFirstHiddenCardToEachPlayer(game: Game, players: Player[]) {
    if (game.deck.length === 0) {
        throw Error("Deck has run out of cards.");
    }
    players.forEach(player => {
        for (let i = 0; i < game.deck.length; i++) {
            const card = game.deck[i];

            if (card!.suit !== Suit.OPERATOR) {
                player.hand.push(game.deck.splice(i, 1)[0]!);
                player.hand[player.hand.length - 1]!.hidden = true;
                break;
            }
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player);
    });
}

// TODO write tests for these
// that two operators cannot be dealt
// that number count is now 3 if there's a root

export function dealTwoOpenCardsToEachPlayer(game: Game, players: Player[]) {
    if (!game) return;
    players.forEach(player => {
        const draw = drawFromDeck(game.deck);

        player.hand.push(draw);

        // can't have both open cards be operators according to game rules.
        let draw2;
        if (draw.suit === Suit.OPERATOR) {
            draw2 = drawNumberCardFromDeck(game.deck);
        } else {
            draw2 = drawFromDeck(game.deck);
        }
        player.hand.push(draw2);

        if (draw.value === OperatorCard.ROOT || draw2.value === OperatorCard.ROOT) {
            const draw3 = drawNumberCardFromDeck(game.deck);
            player.hand.push(draw3);
        }

        if (draw.value === OperatorCard.MULTIPLY || draw2.value === OperatorCard.MULTIPLY) {
            player.needToDiscard = true;
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player, player.needToDiscard);

        console.log("dealt 2 open cards to " + player.username);
        printHand(player.hand);
    });

    return playersThatNeedToDiscard(game.roomCode).length;
}

export function dealLastOpenCardToEachPlayer(game: Game) {
    game.phase = GamePhase.SECONDDEAL;

    nonFoldedAndNotOutPlayers(game).forEach(player => {
        const draw = drawFromDeck(game.deck);
        if (!draw) return;
        player.hand.push(draw);

        if (draw.value === OperatorCard.ROOT) {
            let draw2 = drawNumberCardFromDeck(game.deck);
            if (!draw2) return;
            player.hand.push(draw2);
        }

        if (draw.value === OperatorCard.MULTIPLY) {
            player.needToDiscard = true;
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player, player.needToDiscard);
    });

    return playersThatNeedToDiscard(game.roomCode).length;
}
