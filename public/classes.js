import { mintUniqueCode } from "./utilities.js";
import { GamePhases } from "./enums.js"

export class Game {
  constructor() {
    this.roomCode = mintUniqueCode();
    this.currentTurnPlayerId = 0;
    this.pot = 0;
    this.handNumber = 0; // hand, as in round of play
    this.deck;
    this.hostId = null;
    this.numPlayersThatHaveDiscarded = 0;
    this.numPlayersThatNeedToDiscard = 0; 
    this.firstBettingRoundHasPassed = false;
    this.maxRaiseReached = false;
    this.toCall = 0;
    this.phase = GamePhases.LOBBY;
    this.createdAt = Date.now();
  }
}

export class Player {
  constructor(id, username, hand, chipCount, foldedThisTurn = false, stake = 0, turnTakenThisRound = false, equationResult = null, choices = [], color = null) {
      this.id = id;
      this.username = username;
      this.hand = hand;
      this.chipCount = chipCount;
      this.foldedThisTurn = foldedThisTurn;
      this.stake = stake; // the total chips a player has added to the pot for a given betting round
      this.turnTakenThisRound = turnTakenThisRound;   
      this.equationResult = equationResult;
      this.choices = choices;
      this.out = false;
      this.color = color;
      this.isLoContender = false;
      this.isHiContender = false;
      this.roomCode = null;
      this.contribution = 0; // the total chips a player has added to the pot for a given hand
  }
}

export class Card {
    constructor(value, suit, hidden=false) {
        this.value = value;
        this.suit = suit;
        this.hidden = hidden
    }
}