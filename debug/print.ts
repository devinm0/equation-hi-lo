import { Card, players } from '../state.js';

export function printDeck(deck: Card[], rows = 10) {
    console.log("Deck size:", deck.length, "cards.");

    const toPrint: Card[][] = Array.from({ length: rows }, () => [] as Card[]);
    deck.forEach((card, index) => {
        toPrint[index % rows]!.push(card);
    });

    for (let r = 0; r < rows; r++) {
        let rowOutput = '';
        for (let c = 0; c < toPrint[r]!.length; c++) {
            let card = toPrint[r]![c];
            if (!card) return;
            rowOutput += printCard(card);
        }
        console.log(rowOutput);
    }
}

export function printHand(hand: Card[]) {
    let output = '';
    for (let c = 0; c < hand.length; c++) {
        let card = hand[c];
        if (!card) return;
        output += printCard(card);
    }
    console.log(output);
}

export function printCard(card: Card) {
    let cardOutput = getStringFromSuit(card.suit!) + ' ' + card.value + ', ';
    let colorCodedCardOutput = getANSICodeFromSuit(card.suit!) + cardOutput.padEnd(12) + '\x1b[0m';
    return colorCodedCardOutput;
}

export function getANSICodeFromSuit(suit: number) {
    switch(suit) {
        case 0: return '\x1b[90m';
        case 1: return '\x1b[33m';
        case 2: return '\x1b[37m';
        case 3: return '\x1b[33;1m';
        default: return '';
    }
}

export function getStringFromSuit(suit: number) {
    switch(suit) {
        case 0: return 'Stone';
        case 1: return 'Bronze';
        case 2: return 'Silver';
        case 3: return 'Gold';
        default: return 'Operator';
    }
}

export function logRoomsAndPlayers() {
    console.log("=== Current Rooms & Players ===");

    const grouped = new Map();
    for (const [, player] of players.entries()) {
        const roomCode = player.roomCode;
        if (!grouped.has(roomCode)) grouped.set(roomCode, []);
        grouped.get(roomCode).push(player);
    }

    for (const [roomCode, roomPlayers] of grouped.entries()) {
        console.log(`Room ${roomCode}:`);
        for (const player of roomPlayers) {
            console.log(`  - ${player.id} - ${player.username} `);
        }
    }

    console.log("================================");
}
