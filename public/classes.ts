import { mintUniqueCode } from "./utilities.js";
import { GamePhase, NumberCard, OperatorCard, Suit } from "../enums.js"

export const startingChipCount = 25;

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
  usedColors: Set<number>;
  equationEndTime: number = 0;
  endEquationFormingTimeout?: NodeJS.Timeout; // TODO make this game.endEquationFormingTimeout
  // Hi/Lo selection timer — kept SEPARATE from the equation-forming timer above so the
  // all-locked-in early-exit (which clears endEquationFormingTimeout) can't clobber it.
  hiLoEndTime: number = 0;
  hiLoSelectionTimeout?: NodeJS.Timeout;
  // Per-turn betting timer — each player gets a fixed window to act on their turn during the
  // first/second betting rounds; if they don't, they're auto-folded. endTime lets a rejoining
  // client recover the correct remaining time. Kept separate from the equation/hi-lo timers.
  bettingTurnEndTime: number = 0;
  bettingTurnTimeout?: NodeJS.Timeout;
  results: any[] = []; // TODO type this better

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
    this.usedColors = new Set<number>();
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
  isLockedIn: boolean = false;
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