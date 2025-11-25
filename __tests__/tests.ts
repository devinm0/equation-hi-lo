// backend/tests.ts
// import { sum } from '../sum';
import { OperatorCard, Suit, NumberCard, GamePhase } from '../enums';
import { Game, Player, Card } from '../public/classes.js';
import { getHandToSendFromHand, findLowestCard, findHighestCard, findLoWinner, findHiWinner, determineWinnersInternal } from '../server';

test
.each([
    [false, null],
    [true, NumberCard.ONE]
])
('showing hidden card if it\'s mine, hiding it if showing to others', (cardIsRevealed, expectedCardValue) => {
    const hand: Card[] = 
        [
            ...Array.from({ length: 3 }, () => new Card(false, NumberCard.ONE, Suit.BRONZE)), 
            new Card(false, NumberCard.ONE, Suit.BRONZE)
        ];
    hand[3]!.hidden = true;

    // maybe rename getHandToShowOtherPlayers
    const result = getHandToSendFromHand(hand, cardIsRevealed);

    expect(result[3]!.value).toEqual(expectedCardValue);
});

test
.each([
    [[
        new Card(false, NumberCard.ONE, Suit.BRONZE),
        new Card(false, NumberCard.TWO, Suit.BRONZE),
        new Card(false, NumberCard.THREE, Suit.BRONZE),
        new Card(false, NumberCard.FOUR, Suit.BRONZE)
    ], new Card(false, NumberCard.ONE, Suit.BRONZE)],
    [[
        new Card(false, NumberCard.ONE, Suit.BRONZE),
        new Card(false, NumberCard.ONE, Suit.SILVER),
        new Card(false, NumberCard.ONE, Suit.GOLD),
        new Card(false, NumberCard.ONE, Suit.STONE)
    ], new Card(false, NumberCard.ONE, Suit.STONE)]
])
('find lowest card in a hand', (hand, expected) => {
    const result = findLowestCard(hand);

    expect(result.value).toEqual(expected.value);
    expect(result.suit).toEqual(expected.suit);
});

test
.each([
    [[
        new Card(false, NumberCard.ONE, Suit.BRONZE),
        new Card(false, NumberCard.TWO, Suit.BRONZE),
        new Card(false, NumberCard.THREE, Suit.BRONZE),
        new Card(false, NumberCard.FOUR, Suit.BRONZE)
    ], new Card(false, NumberCard.FOUR, Suit.BRONZE)],
    [[
        new Card(false, NumberCard.ONE, Suit.BRONZE),
        new Card(false, NumberCard.ONE, Suit.SILVER),
        new Card(false, NumberCard.ONE, Suit.GOLD),
        new Card(false, NumberCard.ONE, Suit.STONE)
    ], new Card(false, NumberCard.ONE, Suit.GOLD)]
])
('find highest card in a hand', (hand, expected) => {
    const result = findHighestCard(hand);

    expect(result.value).toEqual(expected.value);
    expect(result.suit).toEqual(expected.suit);
});

let player1 = new Player("id1", "roomCode1", "color1");// TODO constructor without roomCode or color
let player2 = new Player("id2", "roomCode1", "color2");
let player3 = new Player("id3", "roomCode1", "color3");
let player4 = new Player("id4", "roomCode1", "color4");
let player5 = new Player("id5", "roomCode1", "color5");
let player6 = new Player("id6", "roomCode1", "color6");
let player7 = new Player("id7", "roomCode1", "color7");
let player8 = new Player("id8", "roomCode1", "color8");
let player9 = new Player("id9", "roomCode1", "color9");
let player10 = new Player("id10", "roomCode1", "color10");
let player11 = new Player("id11", "roomCode1", "color11");

player1.hand = [
    new Card(false, NumberCard.ZERO, Suit.STONE),
    new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.STONE)
];
player1.lowEquationResult = 1;
player1.highEquationResult = 1; // technically could achieve a better result given this hand but let's assume player submitted the same hand for both

player2.hand = [
    new Card(false, NumberCard.ZERO, Suit.GOLD),
    new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.STONE)
];
player2.lowEquationResult = 1;
player2.highEquationResult = 1;

player3.hand = [
    new Card(false, NumberCard.ONE, Suit.GOLD),
    new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.STONE)
];
player3.lowEquationResult = 1.5;
player3.highEquationResult = 1.5;

player4.hand = [
    new Card(false, NumberCard.ONE, Suit.GOLD),
    new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.TWO, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.SILVER)
];
player4.lowEquationResult = 2;
player4.highEquationResult = 2;

player5.hand = [ // maybe rename players to like, "winningSwingBetter" 
    new Card(false,   NumberCard.ONE,      Suit.GOLD),
    new Card(false, OperatorCard.DIVIDE,   Suit.OPERATOR),
    new Card(false,   NumberCard.ONE,      Suit.BRONZE),
    new Card(false, OperatorCard.ADD,      Suit.OPERATOR),
    new Card(false,   NumberCard.TWO,      Suit.GOLD),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false,   NumberCard.ONE,      Suit.STONE)
];
player5.lowEquationResult = 2;
player5.highEquationResult = 2;

player6.hand = [
    new Card(false, NumberCard.FIVE, Suit.GOLD),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.FOUR, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ZERO, Suit.BRONZE),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.STONE)
]
player6.lowEquationResult = 1;
player6.highEquationResult = 20;
player6.choices = ["high", "low"];

player7.hand = [
    new Card(false, NumberCard.FIVE, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.FOUR, Suit.STONE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ZERO, Suit.GOLD),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.GOLD)
]
player7.lowEquationResult = 1;
player7.highEquationResult = 20;
player7.choices = ["high", "low"];

player8.hand = [
    new Card(false, NumberCard.FIVE, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.FOUR, Suit.STONE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.SILVER),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.GOLD)
]
player8.lowEquationResult = 2;
player8.highEquationResult = 20;
player8.choices = ["high", "low"];

player9.hand = [
    new Card(false, NumberCard.FOUR, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.THREE, Suit.STONE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ZERO, Suit.SILVER),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ZERO, Suit.GOLD)
]
player9.lowEquationResult = 1;
player9.highEquationResult = 12;
player9.choices = ["high", "low"];

player10.hand = [
    new Card(false, NumberCard.FOUR, Suit.GOLD),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.THREE, Suit.STONE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.SILVER),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.GOLD)
]
player10.lowEquationResult = 2;
player10.highEquationResult = 12;
player10.choices = ["high", "low"];

player11.hand = [
    new Card(false, NumberCard.FIVE, Suit.SILVER),
    new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR),
    new Card(false, NumberCard.FOUR, Suit.BRONZE),
    new Card(false, OperatorCard.ADD, Suit.OPERATOR),
    new Card(false, NumberCard.ZERO, Suit.STONE),
    new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR),
    new Card(false, NumberCard.ONE, Suit.STONE)
]
player11.lowEquationResult = 1;
player11.highEquationResult = 20;
player11.choices = ["high", "low"];

test
.each([
    { name: "Low bet winner: Tie on value", 
        players: [
            player1,
            player2,
            player3,
            player4
        ], 
        expectedWinnerId: "id1", 
        expectedLowCard: player1.hand[0],
        expectedContenders: [player1, player2]
    },
    { name: "Low bet winner: No tie on suit, clear winner", 
        players: [
            player2,
            player3,
            player4    
        ], 
        expectedWinnerId: "id2", 
        expectedLowCard: player2.hand[0],
        expectedContenders: []
    },
    { name: "Low bet winner: Tie for second place, clear winner", 
        players: [
            player2,
            player3,
            player4,
            player5    
        ], 
        expectedWinnerId: "id2", 
        expectedLowCard: player2.hand[0],
        expectedContenders: []
    },
    { name: "Low bet winner: Tie for second place, tie on value", 
        players: [
            player1,
            player2,
            player3,
            player4,
            player5    
        ], 
        expectedWinnerId: "id1", 
        expectedLowCard: player1.hand[0],
        expectedContenders: [player1, player2]
    }
])
("$name", ({players, expectedWinnerId, expectedLowCard, expectedContenders}) => {
    const [loWinner, loWinnerLowCard] = findLoWinner(players);

    expect(loWinner!.id).toEqual(expectedWinnerId);
    expect(loWinnerLowCard!.value).toEqual(expectedLowCard!.value);
    expect(loWinnerLowCard!.suit).toEqual(expectedLowCard!.suit);

    players.forEach(player => {
        if (expectedContenders.includes(player)) {
            expect(player.isLoContender).toBe(true);
            
        } else {
            expect(player.isLoContender).not.toBe(true);
        }
    });
});

test
.each([
    { name: "High bet winner: Tie on value", 
        players: [
                     player2, player3, player4, player5    
        ], 
        expectedWinnerId: "id5", 
        expectedCard: player5.hand[4],
        expectedContenders: [player4, player5]
    },
    { name: "High bet winner: No tie on suit, clear winner", 
        players: [
                     player2, player3, player4
        ], 
        expectedWinnerId: "id4", 
        expectedCard: player4.hand[4],
        expectedContenders: []
    },
    { name: "High bet winner: Tie for second place, clear winner", 
        players: [
            player1, player2, player3,          player5    
        ], 
        expectedWinnerId: "id5", 
        expectedCard: player5.hand[4],
        expectedContenders: []
    },
    { name: "High bet winner: Tie for second place, tie on value", 
        players: [
            player1, player2, player3, player4, player5    
        ], 
        expectedWinnerId: "id5", 
        expectedCard: player5.hand[4],
        expectedContenders: [player4, player5]
    }
])
("$name", ({players, expectedWinnerId, expectedCard, expectedContenders}) => {
    const [hiWinner, hiWinnerHighCard] = findHiWinner(players);

    expect(hiWinner!.id).toEqual(expectedWinnerId);
    expect(hiWinnerHighCard!.value).toEqual(expectedCard!.value);
    expect(hiWinnerHighCard!.suit).toEqual(expectedCard!.suit);

    players.forEach(player => {
        if (expectedContenders.includes(player)) {
            expect(player.isHiContender).toBe(true);
        } else {
            expect(player.isHiContender).not.toBe(true);
        }
    });
});

// TODO if suits are equal, throw error. impossible for there to be duplicate cards

// one winning swing better, several low betters 
// one losing swing better, several low betters

// two swing betters (one winning), several low betters
// two swing betters (both losing), several low betters

// one winning swing better, several hi betters
// one losing swing better, several hi betters

// two swing betters (one winning), several hi betters
// two swing betters (both losing), several hi betters

// one winning swing better, hi and lo betters
// one winning swing better, hi better
// one winning swing better, hi betters
// one winning swing better, lo better
// one winning swing better, lo betters
// one losing swing better, hi and lo betters. won the lo bet technically
// one losing swing better, hi and lo betters. won the hi bet technically
// one losing swing better, hi and lo betters. totally lost

// two losing swing betters, hi and lo betters. each won the lo and hi bet technically
// two losing swing betters, hi and lo betters. one won the lo bet technically
// two losing swing betters, hi and lo betters. each won the hi bet technically
// two losing swing betters, hi and lo betters. each won the hi bet technically 

// two swing betters, one wins X
// three swing betters, one wins X
// two losing swing betters (hi and lo split) X
// three losing swing betters (hi and lo split) X

// TIES for each of the above - swing betters tie on just high, just low, and both

////////// test if chips get returned

test
.each([
    { name: "Two swing betters tie on high card and low card", 
        players: [
            player6, player7
        ], 
        expectedWinnerId: "id6", 
        // would it be better to show expected losing card as well
        expectedHiCard: player6.hand[0],
        expectedLoCard: player6.hand[4],
        expectedLoContenders: [player6, player7],
        expectedHiContenders: [player6, player7],
        expectedSwingBetterWon: true
    },
    { name: "Two swing betters tie on high card only", 
        players: [
            player6, player8
        ], 
        expectedWinnerId: "id6", 
        expectedHiCard: player6.hand[0],
        expectedLoContenders: [],
        expectedHiContenders: [player6, player8],
        expectedSwingBetterWon: true
    },
    { name: "Two swing betters tie on low card only", 
        players: [
            player6, player9
        ], 
        expectedWinnerId: "id6", 
        expectedLoCard: player6.hand[4],
        expectedHiContenders: [],
        expectedLoContenders: [player6, player9],
        expectedSwingBetterWon: true
    },
    { name: "Two swing betters, no ties, one wins", 
        players: [
            player6, player10
        ], 
        expectedWinnerId: "id6", 
        expectedHiContenders: [],
        expectedLoContenders: [], // or should I just not pass this..? need it bc need to make sure noncontenders are noncontenders
        expectedSwingBetterWon: true
    },
    { name: "Two swing betters, no ties, both lose", 
        players: [
            player8, player9
        ], 
        expectedWinnerId: null, 
        expectedHiContenders: [],
        expectedLoContenders: [],
        expectedSwingBetterWon: false
    },
    { name: "Two swing betters, lo tie, both lose", 
        players: [
            player7, player9
        ], 
        expectedWinnerId: null, 
        expectedLoCard: player9.hand[4],
        expectedHiContenders: [],
        expectedLoContenders: [player7, player9],
        expectedSwingBetterWon: false
    },
    { name: "Two swing betters, hi tie, both lose", 
        players: [
            player9, player10
        ], 
        expectedWinnerId: null, 
        expectedHiCard: player10.hand[0],
        expectedHiContenders: [player9, player10],
        expectedLoContenders: [],
        expectedSwingBetterWon: false
    },
    { name: "Two swing betters, hi and lo tie, both lose", 
        players: [
            player6, player11
        ], 
        expectedWinnerId: null, 
        expectedLoCard: player11.hand[4],
        expectedHiCard: player6.hand[0],
        expectedHiContenders: [player6, player11],
        expectedLoContenders: [player6, player11],
        expectedSwingBetterWon: false
    },
    { name: "Three swing betters, one wins", 
        players: [
            player6, player8, player9
        ], 
        expectedWinnerId: "id6", 
        expectedLoCard: player6.hand[4],
        expectedHiCard: player6.hand[0],
        expectedHiContenders: [player6, player8],
        expectedLoContenders: [player6, player9],
        expectedSwingBetterWon: true
    },
    { name: "Three swing betters, all lose, no ties", 
        players: [
            player8, player9, player10
        ], 
        expectedWinnerId: null, 
        expectedHiContenders: [],
        expectedLoContenders: [],
        expectedSwingBetterWon: false
    }
])

// TODO have expectedloWinnerIncludingSwingBetters, expectedhiWinnerIncludingSwingBetters, etc in the case a swing better doesn't win but we still want to verify
// but really what I should do is simplify the logic...
("$name", ({players, expectedWinnerId, expectedHiCard, expectedLoCard, expectedLoContenders, expectedHiContenders, expectedSwingBetterWon}) => {
    // should be who won the low bet, and who won the high bet
    const {loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard,
        hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard,
        loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard, // TODO why are these not used
        hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard,
        loWinner, loWinnerLowCard,
        hiWinner, hiWinnerHighCard,
        swingBetterWon} = determineWinnersInternal(players);

    expect(swingBetterWon).toBe(expectedSwingBetterWon);
    if (swingBetterWon === true) {
        expect(loWinnerIncludingSwingBetters!.id).toBe(expectedWinnerId);
        expect(hiWinnerIncludingSwingBetters!.id).toBe(expectedWinnerId);
        expect(loWinnerOfSwingBetters!.id).toBe(expectedWinnerId);
        expect(hiWinnerOfSwingBetters!.id).toBe(expectedWinnerId);
    }
    // expect(loWinner!.id).toBe(expectedWinnerId);
    // expect(hiWinner!.id).toBe(expectedWinnerId);

    // expect equationResult to equal applyOps? my test cases could be wrong
    // or simply do applyOps WITHOUT specifying expected equation result
    // and have different tests for applyOps
    // need to do applyOps server side
    if (expectedHiCard != null) {
        expect(hiWinnerOfSwingBettersHighCard!.value).toBe(expectedHiCard.value);
        expect(hiWinnerOfSwingBettersHighCard!.suit).toBe(expectedHiCard.suit);
    }
    if (expectedLoCard != null) {
        expect(loWinnerOfSwingBettersLowCard!.value).toBe(expectedLoCard.value);
        expect(loWinnerOfSwingBettersLowCard!.suit).toBe(expectedLoCard.suit);
    }

    players.forEach(player => {
        if (expectedLoContenders.includes(player)) {
            expect(player.isLoContender).toBe(true);
        } else {
            expect(player.isLoContender).not.toBe(true);
        }
        if (expectedHiContenders.includes(player)) {
            expect(player.isHiContender).toBe(true);
        } else {
            expect(player.isHiContender).not.toBe(true);
        }
    });
});

//TODO push this to GitHub for projects

/* applyOps (rename to reduce expression?)

can't divide by zero
test each op
can't have 2 consecutive roots
can't have 2 consecutive numbers
can't start with any operator that isn't root


*/