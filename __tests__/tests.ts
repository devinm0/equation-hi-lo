// backend/tests.ts
// import { sum } from '../sum';
import { OperatorCard, Suit, NumberCard, GamePhase } from '../enums.js';
import { Game, Player, Card } from '../public/classes.js';
import { getHandToSendFromHand } from '../game/notify.js';
import { findLowestCard, findHighestCard, findLoWinner, findHiWinner, determineWinnersInternal, computePotDistribution } from '../game/results.js';
import { evaluateTokens, Token } from '../equation-core.js';
import { applyOps } from '../game/equation.js';

// Regression tests for the shared equation evaluator. The √ cases guard the bug where
// unary √ was applied to a whole sub-expression (√(9/6-10) -> NaN) instead of just its
// operand ((√9)/6-10 -> -9.5), which made the server disagree with the client.
describe('evaluateTokens', () => {
    const n = (value: number): Token => ({ kind: 'number', value });
    const op = (value: '+' | '-' | '*' | '/'): Token => ({ kind: 'op', value });
    const sqrt: Token = { kind: 'sqrt' };

    test('√ binds to its operand, not the rest of the expression', () => {
        // √0 + √9 / 6 - 10  =  0 + 3/6 - 10  =  -9.5
        expect(evaluateTokens([sqrt, n(0), op('+'), sqrt, n(9), op('/'), n(6), op('-'), n(10)])).toBeCloseTo(-9.5);
    });

    test('√9 / 6 = 0.5 (not √(9/6))', () => {
        expect(evaluateTokens([sqrt, n(9), op('/'), n(6)])).toBeCloseTo(0.5);
    });

    test('chained √√16 = 2', () => {
        expect(evaluateTokens([sqrt, sqrt, n(16)])).toBeCloseTo(2);
    });

    test('multiplication precedence: 2 + 3 * 4 = 14', () => {
        expect(evaluateTokens([n(2), op('+'), n(3), op('*'), n(4)])).toBe(14);
    });

    test('division by zero is non-finite', () => {
        expect(Number.isFinite(evaluateTokens([n(1), op('/'), n(0)]))).toBe(false);
        expect(Number.isFinite(evaluateTokens([n(0), op('/'), n(0)]))).toBe(false);
    });

    test('malformed expression throws', () => {
        expect(() => evaluateTokens([n(1), op('+')])).toThrow();
        expect(() => evaluateTokens([n(1), n(2)])).toThrow();
    });
});

// Exhaustive PEMDAS coverage for the server-side adapter applyOps(), which converts dealt
// Card objects into tokens and evaluates them with the shared core. These exercise operator
// precedence (× ÷ before + −), left-to-right associativity for equal precedence, the unary
// √ binding rule, mixed chains, fractional/zero results, and validation errors — all through
// the same path the server uses to score a real hand.
describe('applyOps PEMDAS', () => {
    const N   = (v: number, suit: Suit = Suit.BRONZE): Card => new Card(false, v as NumberCard, suit);
    const ADD = (): Card => new Card(false, OperatorCard.ADD, Suit.OPERATOR);
    const SUB = (): Card => new Card(false, OperatorCard.SUBTRACT, Suit.OPERATOR);
    const MUL = (): Card => new Card(false, OperatorCard.MULTIPLY, Suit.OPERATOR);
    const DIV = (): Card => new Card(false, OperatorCard.DIVIDE, Suit.OPERATOR);
    const RT  = (): Card => new Card(false, OperatorCard.ROOT, Suit.OPERATOR);
    const HID = (): Card => new Card(true); // hidden card has null value

    describe('each operator in isolation', () => {
        test.each<[string, Card[], number]>([
            ['addition',       [N(3), ADD(), N(4)],       7],
            ['subtraction',    [N(7), SUB(), N(2)],       5],
            ['multiplication', [N(6), MUL(), N(7)],      42],
            ['division',       [N(8), DIV(), N(2)],       4],
            ['square root',    [RT(), N(9)],              3],
            ['single number',  [N(5)],                    5],
        ])('%s', (_label, cards, expected) => {
            expect(applyOps(cards)).toBe(expected);
        });
    });

    describe('multiplication/division bind tighter than addition/subtraction', () => {
        test.each<[string, Card[], number]>([
            ['2 + 3 × 4 = 14',       [N(2), ADD(), N(3), MUL(), N(4)],            14],
            ['2 × 3 + 4 = 10',       [N(2), MUL(), N(3), ADD(), N(4)],            10],
            ['10 − 2 × 3 = 4',       [N(10), SUB(), N(2), MUL(), N(3)],            4],
            ['2 × 3 − 4 = 2',        [N(2), MUL(), N(3), SUB(), N(4)],             2],
            ['6 + 8 ÷ 2 = 10',       [N(6), ADD(), N(8), DIV(), N(2)],            10],
            ['8 ÷ 2 + 6 = 10',       [N(8), DIV(), N(2), ADD(), N(6)],            10],
            ['10 − 8 ÷ 2 = 6',       [N(10), SUB(), N(8), DIV(), N(2)],            6],
            ['1 + 2 × 3 + 4 = 11',   [N(1), ADD(), N(2), MUL(), N(3), ADD(), N(4)], 11],
            ['2 × 3 + 4 × 5 = 26',   [N(2), MUL(), N(3), ADD(), N(4), MUL(), N(5)], 26],
        ])('%s', (_label, cards, expected) => {
            expect(applyOps(cards)).toBe(expected);
        });
    });

    // Number cards only range 0–10, so equal-precedence × ÷ chains stay within range.
    describe('equal-precedence operators evaluate left to right', () => {
        test.each<[string, Card[], number]>([
            ['10 − 3 − 2 = 5',           [N(10), SUB(), N(3), SUB(), N(2)],  5],
            ['10 − 3 + 2 = 9',           [N(10), SUB(), N(3), ADD(), N(2)],  9],
            ['8 ÷ 4 ÷ 2 = 1',            [N(8), DIV(), N(4), DIV(), N(2)],   1],
            ['6 × 2 ÷ 4 = 3',            [N(6), MUL(), N(2), DIV(), N(4)],   3],
            ['2 ÷ 4 × 8 = 4 (not 2÷32)', [N(2), DIV(), N(4), MUL(), N(8)],   4],
        ])('%s', (_label, cards, expected) => {
            expect(applyOps(cards)).toBeCloseTo(expected);
        });
    });

    describe('√ is unary, exponent-level, and binds only to the next number', () => {
        test.each<[string, Card[], number]>([
            ['√9 + 1 = 4',  [RT(), N(9), ADD(), N(1)],       4],
            ['1 + √9 = 4',  [N(1), ADD(), RT(), N(9)],       4],
            ['√9 × 2 = 6',  [RT(), N(9), MUL(), N(2)],       6],
            ['10 − √9 = 7', [N(10), SUB(), RT(), N(9)],      7],
            ['√4 + √9 = 5', [RT(), N(4), ADD(), RT(), N(9)], 5],
        ])('%s', (_label, cards, expected) => {
            expect(applyOps(cards)).toBe(expected);
        });

        test('√9 ÷ 6 = 0.5, NOT √(9 ÷ 6) (regression guard)', () => {
            expect(applyOps([RT(), N(9), DIV(), N(6)])).toBeCloseTo(0.5);
        });
        test('chained roots: √√9 ≈ 1.732', () => {
            expect(applyOps([RT(), RT(), N(9)])).toBeCloseTo(Math.sqrt(3));
        });
    });

    describe('comprehensive mixed-precedence chains', () => {
        test('2 + 3 × 4 − 6 ÷ 2 = 11', () => {
            expect(applyOps([N(2), ADD(), N(3), MUL(), N(4), SUB(), N(6), DIV(), N(2)])).toBe(11);
        });
        test('√9 + 2 × 5 − 8 ÷ 4 = 11', () => {
            expect(applyOps([RT(), N(9), ADD(), N(2), MUL(), N(5), SUB(), N(8), DIV(), N(4)])).toBe(11);
        });
        test('10 ÷ 5 + 3 × 2 − √4 = 6', () => {
            expect(applyOps([N(10), DIV(), N(5), ADD(), N(3), MUL(), N(2), SUB(), RT(), N(4)])).toBe(6);
        });
    });

    describe('fractional and zero results', () => {
        test.each<[string, Card[], number]>([
            ['1 ÷ 4 = 0.25', [N(1), DIV(), N(4)], 0.25],
            ['5 ÷ 2 = 2.5',  [N(5), DIV(), N(2)], 2.5],
            ['0 ÷ 5 = 0',    [N(0), DIV(), N(5)], 0],
            ['0 × 9 = 0',    [N(0), MUL(), N(9)], 0],
        ])('%s', (_label, cards, expected) => {
            expect(applyOps(cards)).toBeCloseTo(expected);
        });
    });

    describe('division by zero is non-finite', () => {
        test('5 ÷ 0 is not finite', () => {
            expect(Number.isFinite(applyOps([N(5), DIV(), N(0)]))).toBe(false);
        });
        test('0 ÷ 0 is NaN', () => {
            expect(Number.isNaN(applyOps([N(0), DIV(), N(0)]))).toBe(true);
        });
    });

    describe('hidden cards (null value) are skipped', () => {
        test('a hidden card between tokens does not affect the result', () => {
            expect(applyOps([N(3), HID(), ADD(), N(4)])).toBe(7);
        });
    });

    describe('invalid expressions throw', () => {
        test('two consecutive numbers', () => {
            expect(() => applyOps([N(3), N(4)])).toThrow();
        });
        test('trailing operator', () => {
            expect(() => applyOps([N(3), ADD()])).toThrow();
        });
        test('leading binary operator', () => {
            expect(() => applyOps([ADD(), N(3)])).toThrow();
        });
        test('√ immediately after a number', () => {
            expect(() => applyOps([N(9), RT()])).toThrow();
        });
        test('empty hand', () => {
            expect(() => applyOps([])).toThrow();
        });
    });
});

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

// Covered below / in the new describe blocks: pure low win, pure high win, split pot,
// a swing better sweeping vs lo+hi betters, two swing betters splitting sides + a hi better
// (neither sweeps -> hi better takes the pot), all-swing-no-sweep forfeit, and the
// swing-only tie cases (high-only, low-only, both). Still uncovered:
//   - swing-better ties WITH lo/hi betters present (above only tie swing-vs-swing)
//   - isLoContender / isHiContender highlighting across swing AND non-swing tied players

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

    // players.forEach(player => {
    //     if (expectedLoContenders.includes(player)) {
    //         expect(player.isLoContender).toBe(true);
    //     } else {
    //         expect(player.isLoContender).not.toBe(true);
    //     }
    //     if (expectedHiContenders.includes(player)) {
    //         expect(player.isHiContender).toBe(true);
    //     } else {
    //         expect(player.isHiContender).not.toBe(true);
    //     }
    // });
});

// The test.each block above only ever passes all-swing tables. These cover the mixed
// tables that drive the real pot distribution in lifecycle.ts: pure low/high winners,
// split pots, a swing sweep, and the key rule the user asked about — if no swing better
// wins BOTH sides, swing betters get nothing and the pot falls to the pure lo/hi winners.
describe('determineWinnersInternal — mixed lo / hi / swing tables', () => {
    const handWith = (value: NumberCard, suit: Suit = Suit.BRONZE): Card[] => [
        new Card(false, value, suit),
        new Card(false, OperatorCard.ADD, Suit.OPERATOR),
        new Card(false, NumberCard.ONE, Suit.STONE),
    ];

    const makePlayer = (id: string, choices: string[], lowResult: number, highResult: number): Player => {
        const p = new Player(id, "room", "color");
        p.choices = choices;
        p.lowEquationResult = lowResult;
        p.highEquationResult = highResult;
        p.hand = handWith(NumberCard.TWO);
        return p;
    };

    test('pure low betters: closest to 1 wins, no high winner', () => {
        const loA = makePlayer("loA", ["low"], 1, 1);
        const loB = makePlayer("loB", ["low"], 3, 3);
        const { loWinner, hiWinner, swingBetterWon } = determineWinnersInternal([loA, loB]);
        expect(swingBetterWon).toBe(false);
        expect(loWinner!.id).toBe("loA");
        expect(hiWinner).toBeNull(); // distribution: loWinner takes the whole pot
    });

    test('pure high betters: closest to 20 wins, no low winner', () => {
        const hiA = makePlayer("hiA", ["high"], 20, 20);
        const hiB = makePlayer("hiB", ["high"], 14, 14);
        const { loWinner, hiWinner, swingBetterWon } = determineWinnersInternal([hiA, hiB]);
        expect(swingBetterWon).toBe(false);
        expect(hiWinner!.id).toBe("hiA");
        expect(loWinner).toBeNull(); // distribution: hiWinner takes the whole pot
    });

    test('split pot: a low better and a high better each take a side', () => {
        const loA = makePlayer("loA", ["low"], 1, 1);
        const loB = makePlayer("loB", ["low"], 4, 4);
        const hiA = makePlayer("hiA", ["high"], 20, 20);
        const hiB = makePlayer("hiB", ["high"], 13, 13);
        const { loWinner, hiWinner, swingBetterWon } = determineWinnersInternal([loA, loB, hiA, hiB]);
        expect(swingBetterWon).toBe(false);
        // Both non-null => lifecycle.ts splits the pot 50/50 between these two.
        expect(loWinner!.id).toBe("loA");
        expect(hiWinner!.id).toBe("hiA");
    });

    test('one swing better sweeps both sides against lo and hi betters', () => {
        const swing = makePlayer("swing", ["low", "high"], 1, 20); // closest to BOTH 1 and 20
        const lo = makePlayer("lo", ["low"], 3, 3);
        const hi = makePlayer("hi", ["high"], 16, 16);
        const { loWinnerIncludingSwingBetters, hiWinnerIncludingSwingBetters,
                loWinnerOfSwingBetters, hiWinnerOfSwingBetters, swingBetterWon } =
            determineWinnersInternal([swing, lo, hi]);
        expect(swingBetterWon).toBe(true);
        expect(loWinnerOfSwingBetters!.id).toBe("swing");
        expect(hiWinnerOfSwingBetters!.id).toBe("swing");
        expect(loWinnerIncludingSwingBetters!.id).toBe("swing");
        expect(hiWinnerIncludingSwingBetters!.id).toBe("swing");
    });

    test('two swing betters split sides (neither sweeps) + one high better => entire pot to the high better', () => {
        // swingHi wins the HIGH side among swing betters but loses to the pure high better.
        // swingLo wins the LOW side among swing betters. Neither swing better wins BOTH,
        // so no swing sweep; with no pure low better, the pure high better takes everything.
        const swingHi = makePlayer("swingHi", ["low", "high"], 6, 18); // good high, bad low
        const swingLo = makePlayer("swingLo", ["low", "high"], 1, 9);  // good low, bad high
        const hiBetter = makePlayer("hiBetter", ["high"], 99, 20);     // closest to 20 overall

        const { loWinner, hiWinner,
                loWinnerIncludingSwingBetters, hiWinnerIncludingSwingBetters,
                loWinnerOfSwingBetters, hiWinnerOfSwingBetters, swingBetterWon } =
            determineWinnersInternal([swingHi, swingLo, hiBetter]);

        // No swing better won both sides.
        expect(swingBetterWon).toBe(false);

        // Among swing betters, each won exactly one side.
        expect(hiWinnerOfSwingBetters!.id).toBe("swingHi");
        expect(loWinnerOfSwingBetters!.id).toBe("swingLo");

        // The pure high better beats the swing betters on the high side overall,
        // while the low side (incl. swing) is still the low-leaning swing better.
        expect(hiWinnerIncludingSwingBetters!.id).toBe("hiBetter");
        expect(loWinnerIncludingSwingBetters!.id).toBe("swingLo");

        // Distribution (lifecycle.ts) uses the PURE-side winners when there's no swing sweep:
        // no pure low better => loWinner null; pure high better => hiWinner. With loWinner
        // null and hiWinner set, the high better takes the WHOLE pot.
        expect(loWinner).toBeNull();
        expect(hiWinner!.id).toBe("hiBetter");
    });
});

// Pure pot-payout decision extracted from determineWinners. Drives the chip math the E2E
// chip-conservation check verifies, so it is worth covering each branch directly.
describe('computePotDistribution (pure pot payout)', () => {
    const handWith = (value: NumberCard): Card[] => [
        new Card(false, value, Suit.BRONZE),
        new Card(false, OperatorCard.ADD, Suit.OPERATOR),
        new Card(false, NumberCard.ONE, Suit.STONE),
    ];
    const makeP = (id: string, choices: string[], low: number, high: number): Player => {
        const p = new Player(id, "room", "color");
        p.username = id;
        p.choices = choices;
        p.lowEquationResult = low;
        p.highEquationResult = high;
        p.hand = handWith(NumberCard.TWO);
        return p;
    };
    const distribute = (players: Player[], pot: number) =>
        computePotDistribution(determineWinnersInternal(players), pot);

    test('swing sweep: winner takes the whole pot', () => {
        const players = [makeP("swing", ["low", "high"], 1, 20), makeP("lo", ["low"], 3, 3), makeP("hi", ["high"], 15, 15)];
        const { deltas, nobodyWon, message } = distribute(players, 30);
        expect(nobodyWon).toBe(false);
        expect(deltas.get("swing")).toBe(30);
        expect(deltas.size).toBe(1);
        expect(message).toContain("swing");
    });

    test('split pot (even): low and high winners each get half', () => {
        const { deltas, nobodyWon } = distribute([makeP("lo", ["low"], 1, 1), makeP("hi", ["high"], 20, 20)], 30);
        expect(nobodyWon).toBe(false);
        expect(deltas.get("lo")).toBe(15);
        expect(deltas.get("hi")).toBe(15);
    });

    test('split pot (odd): the odd chip is discarded (credited total = pot − 1)', () => {
        const { deltas } = distribute([makeP("lo", ["low"], 1, 1), makeP("hi", ["high"], 20, 20)], 31);
        expect(deltas.get("lo")).toBe(15);
        expect(deltas.get("hi")).toBe(15);
        const total = [...deltas.values()].reduce((a, b) => a + b, 0);
        expect(total).toBe(30); // one chip forfeited so the pot halves evenly
    });

    test('pure low betters: low winner takes the whole pot', () => {
        const { deltas } = distribute([makeP("loA", ["low"], 1, 1), makeP("loB", ["low"], 4, 4)], 20);
        expect(deltas.get("loA")).toBe(20);
        expect(deltas.size).toBe(1);
    });

    test('pure high betters: high winner takes the whole pot', () => {
        const { deltas } = distribute([makeP("hiA", ["high"], 20, 20), makeP("hiB", ["high"], 12, 12)], 20);
        expect(deltas.get("hiA")).toBe(20);
        expect(deltas.size).toBe(1);
    });

    test('only swing betters, none sweep: nobody wins, pot forfeited (chips lost)', () => {
        // swingHi wins high among swing betters, swingLo wins low — neither wins both.
        const { deltas, nobodyWon } = distribute([makeP("swingHi", ["low", "high"], 6, 18), makeP("swingLo", ["low", "high"], 1, 9)], 40);
        expect(nobodyWon).toBe(true);
        expect(deltas.size).toBe(0); // no chips credited — the pot is lost, by design
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