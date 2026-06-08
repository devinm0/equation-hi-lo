var NumberCard = /* @__PURE__ */ ((NumberCard2) => {
  NumberCard2[NumberCard2["ZERO"] = 0] = "ZERO";
  NumberCard2[NumberCard2["ONE"] = 1] = "ONE";
  NumberCard2[NumberCard2["TWO"] = 2] = "TWO";
  NumberCard2[NumberCard2["THREE"] = 3] = "THREE";
  NumberCard2[NumberCard2["FOUR"] = 4] = "FOUR";
  NumberCard2[NumberCard2["FIVE"] = 5] = "FIVE";
  NumberCard2[NumberCard2["SIX"] = 6] = "SIX";
  NumberCard2[NumberCard2["SEVEN"] = 7] = "SEVEN";
  NumberCard2[NumberCard2["EIGHT"] = 8] = "EIGHT";
  NumberCard2[NumberCard2["NINE"] = 9] = "NINE";
  NumberCard2[NumberCard2["TEN"] = 10] = "TEN";
  return NumberCard2;
})(NumberCard || {});
var OperatorCard = /* @__PURE__ */ ((OperatorCard2) => {
  OperatorCard2["ADD"] = "+";
  OperatorCard2["SUBTRACT"] = "\u2212";
  OperatorCard2["DIVIDE"] = "\xF7";
  OperatorCard2["MULTIPLY"] = "\xD7";
  OperatorCard2["ROOT"] = "\u221A";
  return OperatorCard2;
})(OperatorCard || {});
;
var Suit = /* @__PURE__ */ ((Suit2) => {
  Suit2[Suit2["STONE"] = 0] = "STONE";
  Suit2[Suit2["BRONZE"] = 1] = "BRONZE";
  Suit2[Suit2["SILVER"] = 2] = "SILVER";
  Suit2[Suit2["GOLD"] = 3] = "GOLD";
  Suit2[Suit2["OPERATOR"] = 4] = "OPERATOR";
  return Suit2;
})(Suit || {});
var GamePhase = /* @__PURE__ */ ((GamePhase2) => {
  GamePhase2["LOBBY"] = "lobby";
  GamePhase2["FIRSTDEAL"] = "first-deal";
  GamePhase2["FIRSTBETTING"] = "first-betting";
  GamePhase2["SECONDDEAL"] = "second-deal";
  GamePhase2["EQUATIONFORMING"] = "equation-forming";
  GamePhase2["SECONDBETTING"] = "second-betting";
  GamePhase2["HILOSELECTION"] = "hi-lo-selection";
  GamePhase2["RESULTVIEWING"] = "result-viewing";
  GamePhase2["GAMEOVER"] = "game-over";
  return GamePhase2;
})(GamePhase || {});
export {
  GamePhase,
  NumberCard,
  OperatorCard,
  Suit
};
