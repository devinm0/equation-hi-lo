import { OperatorCard, NumberCard, Suit } from '../enums.js';
import { Card } from '../public/classes.js';

export function generateDeck(): Card[] {
    let deck: Card[] = [];

    // TODO bug? should be 5?
    for (let i = 0; i < 4; i++) {
        deck.push(new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR)); //TODO bad to have false first argument
        deck.push(new Card(false, OperatorCard.ROOT, Suit.OPERATOR));
    }

    // TODO I think this is different in TypeScript
    // One of each of numbers 0-10 of each of 4 suits.
    for (const key in NumberCard) {
        const value = NumberCard[key as keyof typeof NumberCard];
        if (typeof value === "number") {
            for (const key2 in Suit) {
                const value2 = Suit[key2 as keyof typeof Suit];
                if (typeof value2 === "number") { // can probably refactor since I have a number to string method elsewhere as well
                    if (value2 !== 4) { // rewrite to be Suit.operator
                        deck.push(new Card(false, value as NumberCard, value2 as Suit));
                    }
                }
            }
        }
    }

    deck.sort(() => Math.random() - 0.5);

    return deck;
}

export function drawNumberCardFromDeck(deck: Card[]): Card {
    if (deck.length === 0) {
        throw Error("No more cards in deck.");
    }
    for (let i = 0; i < deck.length; i++) {
        const peek = deck[i];
        if (!peek) throw new Error("Card is undefined (Deck malformed)");
        // cannot be operator card
        if (peek.suit !== Suit.OPERATOR) {
            // Remove the card and give it to player
            return deck.splice(i, 1)[0]!;
        }
    }

    throw new Error("No number cards left in deck.");
}

export function drawFromDeck(deck: Card[]): Card {
    if (deck.length === 0) throw new Error("deck is empty");

    return deck.splice(0, 1)[0]!;
}
