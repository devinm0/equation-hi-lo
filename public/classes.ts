import { mintUniqueCode } from "./utilities.js";
import { GamePhase, NumberCard, OperatorCard, Suit } from "./enums.js" // LEARN enums should be singular

const startingChipCount = 25;

export class Game {
  // TODO private players: Player[]

  roomCode: string;
  currentTurnPlayerId: string | null; // LEARN not question mark, but a pipe operator. ? means string | undefined
  pot: number;
  handNumber: number;
  deck: Card[] = []; // TODO is this best practice
  hostId: string | null;
  maxRaiseReached: boolean;
  toCall: number;
  phase: GamePhase;
  createdAt: number;

  constructor() {
    this.roomCode = mintUniqueCode();
    this.currentTurnPlayerId = null;
    this.pot = 0;
    this.handNumber = 0; // hand, as in round of play
    this.deck;
    this.hostId = null;
    this.maxRaiseReached = false;
    this.toCall = 0;
    this.phase = GamePhase.LOBBY;
    this.createdAt = Date.now();
  }
}

export class Player {
  id: string; 
  username?: string;
  hand: Card[] = [];
  chipCount: number = startingChipCount;
  foldedThisTurn: boolean = false;
  stake: number = 0; // the total chips a player has added to the pot for a given betting round
  turnTakenThisRound: boolean = false;
  equationResult?: number | null;
  betAmount: number = 0;
  choices: string[] = []; // TODO make choice type / enum
  out: boolean = false;
  color?: string;
  isLoContender: boolean = false;
  isHiContender: boolean = false;
  roomCode: string;
  contribution: number = 0; // rename to like, stakeThisHand // the total chips a player has added to the pot for a given hand
  needToDiscard = false;
  otherHand: Card[] = [];
  lowHand: Card[] = [];
  highHand: Card[] = [];
  otherEquationResult?: number | null;
  lowEquationResult?: number | null;
  highEquationResult?: number | null;
  acknowledgedResults: boolean = false;

  constructor(id: string, roomCode: string, color: string) {
      this.id = id;
      this.roomCode = roomCode;
      this.color = color;
  }
}

export class Card {
    value: OperatorCard | NumberCard | null;
    suit: Suit | null;
    hidden: boolean = false;

    constructor(hidden = false, value?: OperatorCard | NumberCard, suit?: Suit ) {
      this.hidden = hidden

      if (hidden) {
        this.value = null;
        this.suit = null;
      } else {
        this.value = value ?? null;
        this.suit = suit ?? null;
      }
    }
}