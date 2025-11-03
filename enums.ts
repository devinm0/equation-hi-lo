export enum NumberCard {
  ZERO = 0,
  ONE = 1,
  TWO = 2,
  THREE = 3,
  FOUR = 4,
  FIVE = 5,
  SIX = 6,
  SEVEN = 7,
  EIGHT = 8,
  NINE = 9,
  TEN = 10
}

export enum OperatorCard {
  ADD = '+',
  SUBTRACT = '−',
  DIVIDE = '÷',
  MULTIPLY = '×',
  ROOT = '√',
};

export enum Suit {
  STONE = 0,
  BRONZE = 1,
  SILVER = 2,
  GOLD = 3,
  OPERATOR = 4
}

export enum GamePhase { // LEARN enum syntax is different
  LOBBY = "lobby",
  FIRSTDEAL = "first-deal",
  FIRSTBETTING = "first-betting",
  SECONDDEAL = "second-deal",
  EQUATIONFORMING = "equation-forming",
  SECONDBETTING = "second-betting",
  HILOSELECTION = "hi-lo-selection",
  RESULTVIEWING = "result-viewing"
}