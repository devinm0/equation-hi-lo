const { OperatorCards, Suits, NumberCards } = require('./public/enums.js');

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

class Player {
    constructor(id, username, hand, chipCount, foldedThisTurn = false, betAmount = 0, turnTakenThisRound = false, equationResult = 0, choices = []) {
        this.id = id;
        this.username = username;
        this.hand = hand;
        this.chipCount = chipCount;
        this.foldedThisTurn = foldedThisTurn;
        this.betAmount = betAmount;
        this.turnTakenThisRound = turnTakenThisRound;
        this.equationResult = equationResult;
        this.choices = choices;
    }
}

let players = new Map();
let currentTurnPlayerId = 0;
let pot = 0;

const GamePhases = {
    FIRSTDEAL: "firstdeal",
    FIRSTBETTING: "firstbetting",
    SECONDDEAL: "seconddeal",
    SECONDBETTING: "secondbetting"
}

class Card {
    constructor(value, suit, hidden=false) {
        this.value = value;
        this.suit = suit;
        this.hidden = hidden
    }
}
let deck = []
// add 5 each of multiply and root cards to deck
for (let i = 0; i < 4; i++) {
    deck.push(new Card(OperatorCards.MULTIPLY, Suits.OPERATOR));
    deck.push(new Card(OperatorCards.ROOT, Suits.OPERATOR));
}

// add all numbers of all suits to deck
for (const number of Object.values(NumberCards)) {
    for (const suit of Object.values(Suits)) {
        deck.push(new Card(number, suit));
    }
}

deck.sort(() => Math.random() - 0.5);

console.log(deck);
let hostId = null;
// rather than global variables how can we make this functional
let numPlayersThatHaveDiscarded = 0;
let numPlayersThatNeedToDiscard = 0; 
firstRoundBettingCompleted = false; // TODO reset to false when a whole game round is done

app.use(express.static("public"));

// still not clear whether we use myColor or just color from the 
// messages. is all code inside connection block here
// as if it's one "user"? 
// difference between wss and ws
wss.on("connection", (ws) => {
    // ahhh, i guess the ws represents this one user's conenction
  const userId = uuidv4();
  ws.userId = userId; // Store on socket
  
  console.log('checking host');

  if (!hostId) { // ! applies to null!?
    console.log('not host');
    hostId = userId;
    ws.isHost = true;
    console.log("hostId is " + hostId);
  }

  const userColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
  // need to remove this... it's a user that never gets used
  // only log it if socket message comes BACK
  console.log(`User connected: ${userId}`);

  // Send init message with the userId
  ws.send(JSON.stringify({ type: "init", id: userId, color: userColor, isHost: ws.isHost || false }));

  ws.on("message", (message) => {
    const str = message.toString();
    let data;

    try {
      data = JSON.parse(str);
    } catch {
      return;
    }

    if (data.type === "discard") {
        const payload = JSON.stringify({
            type: "player-discarded",
            id: data.id,
            username: data.username,
            value: data.value
        });

        // also this check for not equal ws might be wrong
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });

        const player = players.get(data.id);
        // remove discarded card
        player.hand = player.hand.filter(card => card.value != data.value);
        const draw = dealNumberCard();
        player.hand.push(draw);

        notifyAllPlayersOfNewlyDealtCards(ws, player);

        numPlayersThatHaveDiscarded += 1;

        // TODO need to change this to allow for second round of betting
        console.log(numPlayersThatHaveDiscarded, numPlayersThatNeedToDiscard)
        if (numPlayersThatHaveDiscarded === numPlayersThatNeedToDiscard) {
            if (firstRoundBettingCompleted) {
                commenceEquationForming();
            } else {
                commenceFirstRoundBetting(); 
            }
            // this would break if someone leaves the game.
            // if someone leaves, reduce num players that need ro discard by 1?
        }
    }
    
    if (data.type === "start" /*&& ws.userId === hostId*/) { // should I check isHost instead?
        console.log("150" + ws.userId + " " + hostId);

        initializeGame(ws);

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ 
                type: "game-started", 
                chipCount: players.get(client.userId).chipCount, 
                id: client.userId, 
                hand: players.get(client.userId).hand 
            });
              client.send(payload);
            }
          });

        dealFirstHiddenCardToEachPlayer(ws); // okay so ws is whoever started the game
    
        dealTwoOpenCardsToEachPlayer(ws); // okay so ws is whoever started the game

        if (numPlayersThatNeedToDiscard == 0) {
            commenceFirstRoundBetting();
        }
    }

    if (data.type === "leave") {
        if (ws.userId === hostId) {
            // set a new host. if last player, end the game
        }
        const payload = JSON.stringify({ type: "player-left" });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });

        players.delete(ws.userId); //ws.userId or userId??
        console.log(`User disconnected: ${ws.userId}`);
    }

    if (data.type === "join") {
        console.log('player actually joined here' + data.username);

        if (ws.isHost) { // without this, later players joining become the host
            // but don't have a start button. so game can't start
            currentTurnPlayerId = data.userId;
            hostId = data.userId; // just use ws.userId here?
        }
        console.log(data.userId + " " + hostId);
        ws.userId = data.userId;
        hostId = data.userId;
        console.log(hostId + " " + ws.userId);
        // need a null check on players[data.id] here
        players.set(data.userId, new Player(data.userId, data.username, [], Math.floor(Math.random()*10) + 10));

        console.log(data.userId);
            // notify other players of joining
        const payload = JSON.stringify({
            type: "player-joined",
            //id: data.id,
            //x: data.x,
            //y: data.y,
            isHost: ws.isHost,
            color: data.color, // what happens if we put user color here?
            username: data.username
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
    if (data.type === "bet-placed"){
        if (data.userId !== currentTurnPlayerId) return; // invalid message

        const justPlayedPlayer = players.get(data.userId);
        justPlayedPlayer.turnTakenThisRound = true;
        justPlayedPlayer.betAmount += data.betAmount // even if folded. (just passing on last players bet amount) 
        // refactor to use a global server-side currentBetAmount variable
        // when I do, need to reset it in endBettingRound function

        //TODO need to skip following logic if player folded
        //TODO rename betAmount to total bet this round

        if (data.folded) {
            justPlayedPlayer.foldedThisTurn = data.folded; // can we pass nothing in the case of placing a bet?
            
            wss.clients.forEach((client) => {
                let handToSend = JSON.parse(JSON.stringify(players.get(data.userId).hand));
                if (client.userId !== data.userId) {
                    // keep the card hidden, if it the receiver of the socket message is not the owner of the card
                    // this code is duplicated from the notifyPlayersOfAnewDeal method. 
                    // TODO refactor for DRY. it's repeated
                    for (let i = 0; i < handToSend.length; i++) {
                        if (handToSend[i].hidden === true) {
                            handToSend[i] = new Card(null, 'hidden');
                        }
                    }
                } 
                if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: "player-folded",
                    id: data.userId,
                    username: players.get(data.userId).username,
                    hand: handToSend
                }));
                }
            });
        } else {
            justPlayedPlayer.chipCount -= data.betAmount // should only be the diff
            pot += data.betAmount;

            wss.clients.forEach((client) => {
                if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: "bet-placed",
                    id: data.userId,
                    username: players.get(data.userId).username,
                    betAmount: data.betAmount, // so users can see "so and so bet x chips"
                    chipCount: players.get(data.userId).chipCount, // to update the chip stack visual of player x for each player
                    pot: pot // otherwise, pot won't get updated on last player of the round
                }));
                }
            });
        }

        if (bettingRoundIsComplete()) {
            // need a check on game state here if firstRoundBetting, dealLastOpenCard. if lastroundBetting, go to equation making mode
            if (firstRoundBettingCompleted) { // confusing, sounds like we end second round at the end of first. rename to in secondroundbetting
                endBettingRound("second");
                commenceHiLoSelection();
            } else {
                endBettingRound("first");
                firstRoundBettingCompleted = true;
                dealLastOpenCardToEachPlayer();
                console.log(numPlayersThatNeedToDiscard);
                if (numPlayersThatHaveDiscarded === numPlayersThatNeedToDiscard) {
                    commenceEquationForming();
                }
            }
        } else { 
            // using else so that we don't send the "next turn" even when it's over - 
            // but is this an issue for second betting round? 
            // who will we start with
            currentTurnPlayerId = findNextPlayerTurn();
            advanceToNextPlayersTurn(justPlayedPlayer.betAmount);
        }
    }

    if (data.type === "equation-result") {
        // definitely DON'T want to tell everyone what the results are yet

        const player = players.get(data.userId);
        console.log(data.result);
        player.equationResult = data.result;
        // TODO will have to reset this with each round.
        // I guess I should just have an object I throw everything in which gets reset when a new round happens
    }

    if (data.type === "hi-lo-selected") {
        console.log(data.userId, data.username, data.choices);
        const player = players.get(data.userId);
        player.choices = data.choices;

        // check that every player submitted choices
        if ([...players.values()].every(player => player.choices.length > 0)) {
            console.log('everyone submitted their hi or lo selections');
            determineWinners();
        }
    }
  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});

function initializeGame(ws) {    // don't need ws
    console.log("initializeGame");

    players.forEach((player, id) => { // why does value come before key. so annoying
        player.hand.push(new Card(OperatorCards.ADD, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.DIVIDE, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.SUBTRACT, Suits.OPERATOR));

        notifyAllPlayersOfNewlyDealtCards(ws, player);
    })
}

function dealFirstHiddenCardToEachPlayer(ws) {
    players.forEach((player, id) => { // why does value come before key. so annoying
        for (let i = 0; i < deck.length; i++) {
            // cannot be operator card
            if (deck[i].suit !== Suits.OPERATOR) {
                // Remove the card and give it to player
                player.hand.push(deck.splice(i, 1)[0]);
                // set hidden to true, so when message is sent to other players its obfuscated
                player.hand[player.hand.length - 1].hidden = true;
                break; // having to index here is so trash omg
            }
        }

        notifyAllPlayersOfNewlyDealtCards(ws, player);
    });
}

function dealNumberCard() {
    for (let i = 0; i < deck.length; i++) {
        // cannot be operator card
        if (deck[i].suit !== Suits.OPERATOR) {
            // Remove the card and give it to player
            return deck.splice(i, 1)[0];
        }
    }
}

function dealAnyCard() {
    return deck.splice(0, 1)[0];
}

// TODO write tests for these
// that two operators cannot be dealt
// that number count is now 3 if there's a root

function dealTwoOpenCardsToEachPlayer(ws) {
    // could be three if there is a root
    players.forEach((player, id) => { // why does value come before key. so annoying    
        // first card can be any card
        const draw = dealAnyCard();
        player.hand.push(draw);
    
        // technically i should be putting returned cards at the bottom, but the math should be the same
        // TODO also need to program in the new card being dealt after discard choice
        let draw2;
        if (draw.suit === Suits.OPERATOR) {
            draw2 = dealNumberCard();
        } else {
            draw2 = dealAnyCard();
        }
        player.hand.push(draw2);

        if (draw.value === OperatorCards.ROOT || draw2.value === OperatorCards.ROOT) { // push another number
            const draw3 = dealNumberCard();
            player.hand.push(draw3);
        }

        let multiplicationCardDealt = false;
        if (draw.value === OperatorCards.MULTIPLY || draw2.value === OperatorCards.MULTIPLY) { // expect one more person to discard before advancing game state
            numPlayersThatNeedToDiscard += 1;
            multiplicationCardDealt = true;
        }

        notifyAllPlayersOfNewlyDealtCards(ws, player, multiplicationCardDealt); // magic bool parameters are bad. just call notifyOfFirstOpenDeal

        console.log("dealt two open cards to " + player.id);
        console.log(player.hand);
    });

    return numPlayersThatNeedToDiscard;
}

function dealLastOpenCardToEachPlayer(ws) {
    // can't wanna deal to folded players
    const nonFoldedPlayers = [...players.values()].filter(player => player.foldedThisTurn !== true);
    nonFoldedPlayers.forEach((player, id) => { // why does value come before key. so annoying    
        // first card can be any card
        const draw = dealAnyCard();
        player.hand.push(draw);
    
        // technically i should be putting returned cards at the bottom, but the math should be the same

        if (draw.value === OperatorCards.ROOT) {
            let draw2 = dealNumberCard();
            player.hand.push(draw2);
        }

        let multiplicationCardDealt = false;

        if (draw.value === OperatorCards.MULTIPLY) { // expect one more person to discard before advancing game state
            numPlayersThatNeedToDiscard += 1;
            multiplicationCardDealt = true;
        }

        notifyAllPlayersOfNewlyDealtCards(ws, player, multiplicationCardDealt);
    });

    return numPlayersThatNeedToDiscard;    
}

function endBettingRound(round) {
    for (const [key, value] of players) {
        value.turnTakenThisRound = false;
        // value.foldedThisTurn = false; // actually wrong, folding is for whole game round
        value.betAmount = 0;
    }

    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "end-betting-round",
            playerChipCount: players.get(client.userId).chipCount,
            pot: pot,
            round: round
          }));
        }
    });

}
function notifyAllPlayersOfNewlyDealtCards(ws, player, multiplicationCardDealt = false) {
    wss.clients.forEach((client) => {
        let payload;
        if (client.userId == player.id) { // need to check if client = username
             payload = JSON.stringify({
                type: "deal",
                id: player.id,
                username: player.username,
                hand: player.hand,
                chipCount: player.chipCount,
                multiplicationCardDealt: multiplicationCardDealt 
                // ^ only send this socket message to the player 
                // who has the multiplication card. otherwise, 
                // player 2 getting a multiply means player 1 will have to discard
              });
            } else {
                // hide the hidden card.
                let handToSend = JSON.parse(JSON.stringify(player.hand));
                for (let i = 0; i < handToSend.length; i++) {
                    if (handToSend[i].hidden === true) {
                        handToSend[i] = new Card(null, 'hidden');
                    }
                }
                // [...hand] //  only works if contains primitives
             payload = JSON.stringify({
                type: "deal",
                id: player.id,
                username: player.username,
                hand: handToSend, // Array. fill with nulls or something
                chipCount: player.chipCount // need to pass chipCount so we can draw the chip stack. TODO decouple from drawHand or call it drawPlayer
              });
            }

        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
    });
}

function commenceFirstRoundBetting() {
    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "first-round-betting-commenced",
          }));
        }
    });

    advanceToNextPlayersTurn(1);
}

function commenceSecondRoundBetting() {
    wss.clients.forEach((client) => {
        if (players.get(client.userId).foldedThisTurn !== true) { // can't allow folded players to participate in betting
            if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: "second-round-betting-commenced",
            }));
            }
        }
    });

    // put findNextPlayerTurn inside advanceToNextPlayersTurn
    // i think I want to just continue in round robin.
    // We can change this implementation later to always follow left of the dealer
    currentTurnPlayerId = findNextPlayerTurn();
    advanceToNextPlayersTurn(0); // no ante to match on the second round
}

function advanceToNextPlayersTurn(betAmount) { // should take a parameter here
    const playerChipCounts = players.values().map(player => player.chipCount);
    const maxBet = Math.min(...playerChipCounts);
    console.log("NOTIFICATION", maxBet, currentTurnPlayerId, players.get(currentTurnPlayerId));
    
    // modify this so that we don't trust the client?
    // but technically we do because only currentTurnPlayer can send a betting message.
    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "next-turn",
            toCall: betAmount - players.get(currentTurnPlayerId).betAmount,
            maxBet: maxBet,
            currentTurnPlayerId: currentTurnPlayerId,
            username: players.get(currentTurnPlayerId).username,
            playerChipCount: players.get(client.userId).chipCount
            // pot: pot
          }));
        }
    });
}

function findNextPlayerTurn() {
    console.log(currentTurnPlayerId);
    return findNextKeyWithWrap(players, currentTurnPlayerId, v => v.foldedThisTurn !== true);

    function findNextKeyWithWrap(map, startKey, predicate) {
        const entries = [...map];
        const startIndex = entries.findIndex(([key]) => key === startKey);
      
        if (startIndex === -1) return undefined;
      
        const total = entries.length;
      
        for (let i = 1; i < total; i++) {
          const [key, value] = entries[(startIndex + i) % total];
          if (predicate(value, key)) {
            return key;
          }
        }
      
        return undefined; // No match found
    }
}

function bettingRoundIsComplete() {
    const nonFoldedPlayers = Array.from(players).filter(([id, player]) => player.foldedThisTurn !== true)
    if (nonFoldedPlayers.length === 1){
        // end turn
        console.log("only one active player");
        return true;
    }
    const playerBetAmounts = nonFoldedPlayers.map(([id, player]) => player.betAmount);
    const setOfBets = new Set(playerBetAmounts);
    // bets are all equal AND active players have all bet at least once, then betting round is complete
    if (setOfBets.size === 1 && nonFoldedPlayers.every(([id, player]) => player.turnTakenThisRound === true)){ 
        // end turn
        console.log("everyone has called or folded");
        return true;
    }

    return false;
}
         
function commenceEquationForming() {
    wss.clients.forEach((client) => {
        if (players.get(client.userId).foldedThisTurn !== true) { // can't allow folded players to form equations
            if (client.readyState === WebSocket.OPEN) {
                const payload = JSON.stringify({ 
                    type: "commence-equation-forming", 
                });
                client.send(payload);
            }
        } else {
            if (client.readyState === WebSocket.OPEN) {
                const payload = JSON.stringify({ 
                    type: "players-are-equation-forming", 
                });
                client.send(payload);
            }
        }
      });
    
    console.log("Waiting 60 seconds...");

    setTimeout(() => {
        console.log("Equation forming over, notifying clients.");
        endEquationForming();
    }, 60000);
}

function endEquationForming() {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify({ 
            type: "end-equation-forming", 
        });
          client.send(payload);
        }
      });

    commenceSecondRoundBetting();
}

function commenceHiLoSelection() {
    wss.clients.forEach((client) => {
        if (players.get(client.userId).foldedThisTurn !== true) { // can't allow folded players to participate in betting
            if (client.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({ 
                type: "hi-lo-selection", 
            });
            client.send(payload);
            }
        }
      });
}

function determineWinners() {
    function findLowestCard(hand) {
        return hand.filter(card => card.suit !== Suits.OPERATOR).reduce((minCard, currentCard) => {
            const currentVal = currentCard.value;
            const minVal = minCard.value;
            return currentVal < minVal ? currentCard : minCard;
          });
    }

    function findHighestCard(hand) {
        return hand.filter(card => card.suit !== Suits.OPERATOR).reduce((maxCard, currentCard) => {
            const currentVal = currentCard.value;
            const maxVal = maxCard.value;
            return currentVal > maxVal ? currentCard : maxCard;
          });
    }

    const nonFoldedPlayers = [...players.values()].filter(player => player.foldedThisTurn !== true);
    const loBettingPlayers = nonFoldedPlayers.filter(player => player.choices.includes('low'));
    const hiBettingPlayers = nonFoldedPlayers.filter(player => player.choices.includes('high'));
      
    const loTarget = 1;
    const hiTarget = 20;
      
    let loWinner = null;
    let minDiff = Infinity;
    
    for (const player of loBettingPlayers) {
        const diff = Math.abs(player.equationResult - loTarget);
        if (diff < minDiff) {
            minDiff = diff;
            loWinner = player;
        } else if (diff === minDiff) { // triple equals?
            // find the lowest card of each player
            
            // technically a waste, only need to compare if we end up with two lowest cards.
            // as it is, a tie for second place gets compared
            let currentPlayersLowestCard = findLowestCard(player.hand);
            let currentLowestPlayersLowestCard = findLowestCard(player.hand);

            if (currentPlayersLowestCard.value < currentLowestPlayersLowestCard.value) {
                loWinner = player;
            } else if (currentPlayersLowestCard.value === currentLowestPlayersLowestCard.value) {
                // need to compare suit then
                if (currentPlayersLowestCard.suit < currentLowestPlayersLowestCard.suit) {
                    loWinner = player;
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }
    


    let hiWinner = null;
    minDiff = Infinity;
      
    for (const player of hiBettingPlayers) {
        const diff = Math.abs(player.equationResult - hiTarget);
        if (diff < minDiff) {
          minDiff = diff;
          hiWinner = player;
          //TODO following is exactly a copy of the lowest value. I should make this code a function with option highest or lowest
        } else if (diff === minDiff) { // triple equals?
            // find the highest card of each player
            
            // technically a waste, only need to compare if we end up with two highest cards.
            // as it is, a tie for second place gets compared
            let currentPlayersHighestCard = findHighestCard(player.hand);
            let currentHighestPlayersHighestCard = findHighestCard(player.hand);

            if (currentPlayersHighestCard.value > currentHighestPlayersHighestCard.value) {
                hiWinner = player;
            } else if (currentPlayersHighestCard.value === currentHighestPlayersHighestCard.value) {
                // need to compare suit then
                if (currentPlayersHighestCard.suit > currentHighestPlayersHighestCard.suit) {
                    hiWinner = player;
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }
      
    // notify everyone about the winners
    let payload;
    // there's distinct lo and hi winners
    if (loWinner !== null && hiWinner !== null) {
        payload = JSON.stringify({
            type: "round-result",
            message: loWinner.username + " won the low bet and " + hiWinner.username + " won the high bet."
        });
    } else if (loWinner !== null) { // players only bet on lo
        payload = JSON.stringify({
            type: "round-result",
            message: loWinner.username + " won the low bet."
        });
    } else if (hiWinner !== null) { // players only bet on hi
        payload = JSON.stringify({
            type: "round-result",
            message: hiWinner.username + " won the high bet."
        });
    }

    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });

    // send chips to the winners
    // if there are both lo and hi betters, split the pot among the winner of each
    if (loWinner !== null && hiWinner !== null) {
        if (pot % 2 !== 0) {
            pot = pot - 1 // discard a chip if pot is uneven
        }

        const chipsToSend = pot / 2;
        players.get(hiWinner.id).chipCount += chipsToSend;
        players.get(loWinner.id).chipCount += chipsToSend;

        payload = JSON.stringify({
            type: "chip-distribution",
            chipCount: chipsToSend
        });

        wss.clients.forEach((client) => {
            // only send chips to the winners
            if ((client.userId === hiWinner.id || client.userId === loWinner.id) && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    } else if (loWinner !== null) {
        players.get(loWinner.id).chipCount += pot;

        payload = JSON.stringify({
            type: "chip-distribution",
            chipCount: pot
        });

        wss.clients.forEach((client) => {
            // send to only the winners
            if (client.userId === loWinner.id && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    } else if (hiWinner !== null) {
        players.get(hiWinner.id).chipCount += pot;

        payload = JSON.stringify({
            type: "chip-distribution",
            chipCount: pot
        });

        wss.clients.forEach((client) => {
            // send to only the winners
            if (client.userId === hiWinner.id && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    pot = 0;

    //TODO check if any players reached 0, and kick them out of the game.
}
  
// function printDeck(deck, n) {
//     const columns = Math.ceil(deck.length / n);
//     const rows = n;
  
//     // Initialize an array of columns
//     const colData = Array.from({ length: columns }, (_, colIndex) =>
//       deck.slice(colIndex * n, (colIndex + 1) * n)
//     );
  
//     // Print row by row
//     for (let row = 0; row < rows; row++) {
//       let line = '';
//       for (let col = 0; col < columns; col++) {
//         const card = colData[col][row] || ''; // pad if column is shorter
//         console.log(card);
//         line += `${getANSICodeFromSuit(card.suit)}${card.value.toString()}\x1b[0m`;
//       }
//       console.log(line);
//     }

//     function getANSICodeFromSuit(suit) {
//         switch(suit) {
//             case 0:
//                 return '\x1b[90m';
//             case 1:
//                 return '\x1b[33m';
//             case 2:
//                 return '\x1b[37m';
//             case 3:
//                 return '\x1b[33;1m';
//         }
//     }
// }