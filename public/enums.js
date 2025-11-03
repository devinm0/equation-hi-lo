export var NumberCard;
(function (NumberCard) {
    NumberCard[NumberCard["ZERO"] = 0] = "ZERO";
    NumberCard[NumberCard["ONE"] = 1] = "ONE";
    NumberCard[NumberCard["TWO"] = 2] = "TWO";
    NumberCard[NumberCard["THREE"] = 3] = "THREE";
    NumberCard[NumberCard["FOUR"] = 4] = "FOUR";
    NumberCard[NumberCard["FIVE"] = 5] = "FIVE";
    NumberCard[NumberCard["SIX"] = 6] = "SIX";
    NumberCard[NumberCard["SEVEN"] = 7] = "SEVEN";
    NumberCard[NumberCard["EIGHT"] = 8] = "EIGHT";
    NumberCard[NumberCard["NINE"] = 9] = "NINE";
    NumberCard[NumberCard["TEN"] = 10] = "TEN";
})(NumberCard || (NumberCard = {}));
export var OperatorCard;
(function (OperatorCard) {
    OperatorCard["ADD"] = "+";
    OperatorCard["SUBTRACT"] = "\u2212";
    OperatorCard["DIVIDE"] = "\u00F7";
    OperatorCard["MULTIPLY"] = "\u00D7";
    OperatorCard["ROOT"] = "\u221A";
})(OperatorCard || (OperatorCard = {}));
;
export var Suit;
(function (Suit) {
    Suit[Suit["STONE"] = 0] = "STONE";
    Suit[Suit["BRONZE"] = 1] = "BRONZE";
    Suit[Suit["SILVER"] = 2] = "SILVER";
    Suit[Suit["GOLD"] = 3] = "GOLD";
    Suit[Suit["OPERATOR"] = 4] = "OPERATOR";
})(Suit || (Suit = {}));
export var GamePhase;
(function (GamePhase) {
    GamePhase["LOBBY"] = "lobby";
    GamePhase["FIRSTDEAL"] = "first-deal";
    GamePhase["FIRSTBETTING"] = "first-betting";
    GamePhase["SECONDDEAL"] = "second-deal";
    GamePhase["EQUATIONFORMING"] = "equation-forming";
    GamePhase["SECONDBETTING"] = "second-betting";
    GamePhase["HILOSELECTION"] = "hi-lo-selection";
    GamePhase["RESULTVIEWING"] = "result-viewing";
})(GamePhase || (GamePhase = {}));
