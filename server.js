const { OperatorCards, Suits, NumberCards } = require('./public/enums.js');

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static("public"));

class Player {
    constructor(id, username, hand, chipCount, foldedThisTurn = false, stake = 0, turnTakenThisRound = false, equationResult = null, choices = [], color = null) {
        this.id = id;
        this.username = username;
        this.hand = hand;
        this.chipCount = chipCount;
        this.foldedThisTurn = foldedThisTurn;
        this.stake = stake;
        this.turnTakenThisRound = turnTakenThisRound;   
        this.equationResult = equationResult;
        this.choices = choices;
        this.out = false;
        this.color = color;
    }
}

let players = new Map();
let currentTurnPlayerId = 0;
let pot = 0;
let handNumber = 0; // hand, as in round of play

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
let deck;
let hostId = null;
// rather than global variables how can we make this functional
let numPlayersThatHaveDiscarded = 0;
let numPlayersThatNeedToDiscard = 0; 
let isNotFirstBettingRound = false; // TODO reset to false when a whole game round is done
let maxRaiseReached = false;
let toCall = 0;

wss.on("connection", (ws) => {
  const userId = uuidv4();
  ws.userId = userId; // in the case of rejoin, this will be overwritten later
  const userColor = `hsl(${Math.random() * 360}, 100%, 70%)`; // same here
  
  if (!hostId) {
    hostId = userId;
    ws.isHost = true;
    console.log("hostId is " + hostId);
  }

  console.log(`Socket connected, generating userId ${userId} but it may not be used in the case that someone is rejoining, in which case the existing client userId will overwrite this.`);

  // Send init message with the userId                                 
  ws.send(JSON.stringify({ type: "init", id: userId, color: userColor, hostId: hostId }));

  // send a newly connected player the list of all players that have joined thus far
  players.forEach(player => {
    ws.send(JSON.stringify({
        type: "player-joined",
        id: player.id,
        hostId: hostId,// client.userId === hostId, // this is wrong because it means the host will show everyone joining as host
        color: player.color, // what happens if we put user color here?
        username: player.username,
    }));
  });

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
        // remove discarded card ( fixed this from before )
        const index = player.hand.findIndex(card => card.value === data.value);
        if (index !== -1) {
            player.hand.splice(index, 1);
        }

        const draw = dealNumberCard();
        player.hand.push(draw);

        notifyAllPlayersOfNewlyDealtCards(player);

        numPlayersThatHaveDiscarded += 1;

        // TODO need to change this to allow for second round of betting
        console.log(numPlayersThatHaveDiscarded, numPlayersThatNeedToDiscard)
        if (numPlayersThatHaveDiscarded === numPlayersThatNeedToDiscard) {
            if (isNotFirstBettingRound) {
                commenceEquationForming();
            } else {
                commenceFirstRoundBetting(); 
            }
            // this would break if someone leaves the game.
            // if someone leaves, reduce num players that need ro discard by 1?
        }
    }
    
    if (data.type === "start" && data.id === hostId) {
        if (players.size < 2) {
            ws.send(JSON.stringify({ type: "reject" }));
            return;
        }

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ 
                type: "game-started", 
                chipCount: players.get(client.userId).chipCount, // TODO have we initialized chip count here
                id: client.userId
            });
              client.send(payload);
            }
          });

        initializeHand();
    }

    if (data.type === "leave") {
        if (data.id === hostId) {
            // set a new host. if last player, end the game
        }

        sendSocketMessageToEveryClient({ type: "player-left" });

        players.get(data.id).out = true; //ws.userId or userId??
        // console.log(`User disconnected: ${ws.userId}`);
    }

    if (data.type === "rejoin") {
        console.log(players);
        console.log("ws.userId and data.userId", ws.userId, data.id);
        ws.userId = data.id;
        console.log(players.get(data.id));
        // players.get(data.id).color = data.color;

        console.log("listing all clients now. on rejoin, this should match up to what it was before");
        wss.clients.forEach((client) => {
            console.log(client.userId);
        });
    }

    if (data.type === "join") {
        if (ws.isHost) { // without this, later players joining become the host
            currentTurnPlayerId = data.userId;
            hostId = data.userId; // just use ws.userId here?
        }

        console.log(`***** 👩‍💻 ${hostId === data.userId ? 'Host' : 'Player'} joined: ${data.username} *****`);

        // have to reassign userId because what if someone refreshes? have to ignore the init message
        // need to assign ws.userId because it's used to check clientId === id on server
        ws.userId = data.userId;
        players.set(data.userId, new Player(data.userId, data.username, [], 25));
        players.get(data.userId).color = data.color;

        sendSocketMessageToEveryClient({
            type: "player-joined",
            id: data.userId,
            hostId: hostId,// client.userId === hostId, // this is wrong because it means the host will show everyone joining as host
            color: data.color, // what happens if we put user color here?
            username: data.username,
        });

        console.log(players);
        // log all ws userIds and all playerIds to make sure they all match at all times
        wss.clients.forEach((client) => {
            console.log(client.userId);
        });
    }
    // tests
    // two players call and third player folds
    // one player calls and two players fold = distribute pot to first player and end round
    if (data.type === "bet-placed"){
        if (data.userId !== currentTurnPlayerId) return; // invalid message

        const justPlayedPlayer = players.get(data.userId);
        justPlayedPlayer.turnTakenThisRound = true;
        // TODO this logic is unreadable. Come back and refactor after it's been a while
        // It's actually good to refactor when I don't understand it. Forces me to make it understandable.
        justPlayedPlayer.stake += data.betAmount // even if folded. (just passing on last players bet amount) 
        //TODO need to skip following logic if player folded
        //TODO rename betAmount to total bet this round

        justPlayedPlayer.chipCount -= data.betAmount // should only be the diff
        toCall += data.betAmount;
        pot += data.betAmount;

        sendSocketMessageToEveryClient({
            type: "bet-placed",
            id: data.userId,
            username: players.get(data.userId).username,
            betAmount: data.betAmount, // so users can see "so and so bet x chips"
            chipCount: players.get(data.userId).chipCount, // to update the chip stack visual of player x for each player
            pot: pot // otherwise, pot won't get updated on last player of the round
        });
        endRoundOrProceedToNextPlayer(justPlayedPlayer);
    }

    // TODO more tests - have a folded player submit an equation anyway and confirm it's discarded by server.
    if (data.type === "equation-result") {
        // definitely DON'T want to tell everyone what the results are yet
        const player = players.get(data.userId);
        // a folded player may have manually sent a formed equation despite not given the opportunity, just ignore
        if (player.foldedThisTurn) { return; }
        console.log("299 equation-result received " + data.result);

        player.hand = data.order.map(i => player.hand[i]);
        player.equationResult = data.result;

        // let everyone else know I've moved my cards, so they can see the order.
        wss.clients.forEach((client) => {
            let handToSend = getHandToSendFromHand(player.hand, client.userId === data.userId);
            
            if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: "player-formed-equation",
                    id: data.userId,
                    username: players.get(data.userId).username,
                    chipCount: players.get(data.userId).chipCount,
                    hand: handToSend
                }));
            }
        })

        // if we've received equation result socket messages from every player, we can proceed to second round of betting.
        if (nonFoldedPlayers().length === 1){
            distributePotToOnlyRemainingPlayer(nonFoldedPlayers()[0]);
            return;
        }

        // check that every player submitted choices
        if (nonFoldedPlayers().every(player => player.equationResult !== null)) {
            if (maxRaiseReached) {
                console.log('Max bet was reached on first round of betting. Skipping second round.');

                sendSocketMessageToNonFoldedPlayers({ type: "second-round-betting-skipped" });

                commenceHiLoSelection();
            } else {
                console.log('All equations received. Proceeding to second round of betting.');

                commenceSecondRoundBetting();
            }
        }
    }

    if (data.type === "folded") {
        const foldedPlayer = players.get(data.userId)
        foldedPlayer.foldedThisTurn = true; // can we pass nothing in the case of placing a bet?
        foldedPlayer.hand.forEach(card => {
            card.hidden = true;
        });

        sendSocketMessageThatPlayerFolded(data.userId);

        if (nonFoldedPlayers().length === 1){
            distributePotToOnlyRemainingPlayer(nonFoldedPlayers()[0]);
            return;
        }

        if (data.manual === true) { // TODO unreadable
            endRoundOrProceedToNextPlayer(foldedPlayer);
        }
    }

    if (data.type === "hi-lo-selected") {
        console.log(data.userId, data.username, data.choices);
        const player = players.get(data.userId);
        player.choices = data.choices;

        // check that every player submitted choices
        if (nonFoldedPlayers().every(player => player.choices.length > 0)) {
            console.log('everyone submitted their hi or lo selections');

            revealHiddenCards();

            determineWinners();
        }
    }

    // need this so that players have time to view results
    if (data.type === "acknowledge-hand-results") {
        const player = players.get(data.userId);
        player.acknowledgedResults = true;

        // check that every player submitted choices
        if (nonFoldedPlayers().every(player => player.acknowledgedResults === true)) {
            endHand();
        }
    }
  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});

function nonFoldedPlayers(){
    return [...players.values()].filter(player => player.foldedThisTurn !== true);
}

function endRoundOrProceedToNextPlayer(justPlayedPlayer) {
    if (bettingRoundIsComplete()) {
        if (isNotFirstBettingRound) {
            endBettingRound("second");
            commenceHiLoSelection();
        } else {
            endBettingRound("first");
            dealLastOpenCardToEachPlayer();

            // possible that players receive multiply cards on last deal
            // so don't commence equation forming unless all discards are complete
            if (numPlayersThatHaveDiscarded === numPlayersThatNeedToDiscard) {
                commenceEquationForming();
            }
        }
    } else { 
        if (justPlayedPlayer.chipCount === 0) {
            // if anyone is 0, it means someone is all in and no one can bet anymore
            maxRaiseReached = true;
        }
        currentTurnPlayerId = findNextPlayerTurn();

        // subtract player's stake.
        // if someone bets 10, then next raises 4, we can toCall to be 4, NOT 14
        // it would also allow betting more chips than a player has
        advanceToNextPlayersTurn(toCall - players.get(currentTurnPlayerId).stake);
    }
}

function clearHandsAndDealOperatorCards() {
    players.forEach((player, id) => { // why does value come before key. so annoying
        player.hand = [];

        player.hand.push(new Card(OperatorCards.ADD, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.DIVIDE, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.SUBTRACT, Suits.OPERATOR));

        notifyAllPlayersOfNewlyDealtCards(player);
    })
}

function dealFirstHiddenCardToEachPlayer() {
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

        notifyAllPlayersOfNewlyDealtCards(player);
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

function dealTwoOpenCardsToEachPlayer() {
    players.forEach((player, id) => { // why does value come before key. so annoying    
        // first card can be any card
        const draw = dealAnyCard();
        player.hand.push(draw);
    
        // technically i should be putting returned cards at the bottom, but the math should be the same
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

        notifyAllPlayersOfNewlyDealtCards(player, multiplicationCardDealt); // magic bool parameters are bad. just call notifyOfFirstOpenDeal

        console.log("dealt 2 open cards to " + player.username);
        printHand(player.hand);
    });

    return numPlayersThatNeedToDiscard;
}

function dealLastOpenCardToEachPlayer() {
    // can't wanna deal to folded players
    nonFoldedPlayers().forEach((player, id) => { // why does value come before key. so annoying    
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

        notifyAllPlayersOfNewlyDealtCards(player, multiplicationCardDealt);
    });

    return numPlayersThatNeedToDiscard;    
}

function endHand() {
    // need to check if anyone is down to 0 chips
    console.log("endHand");
    players.values().forEach(player => {
        console.log(player.username, "chipCount:", player.chipCount);
    })

    maxRaiseReached = false;
    isNotFirstBettingRound = false;
    handNumber += 1;
    numPlayersThatHaveDiscarded = 0;
    numPlayersThatNeedToDiscard = 0; 
    players.values().forEach(player => {
        if (player.chipCount === 0) {
            sendSocketMessageToEveryClient({ 
                type: "kicked",
                userId: player.id,
                username: player.username
            });

            // or, just set their status to "out" so they can still view the game
            // players.delete(player.id); // TODO make them folded permanently
        }

        player.foldedThisTurn = false;
        player.equationResult = null;
        player.choices = [];
        player.acknowledgedResults = false;
    })
    // send socket message

    initializeHand();
}

function sendSocketMessageThatPlayerFolded(foldedUserId) {
    wss.clients.forEach((client) => {
        let handToSend = getHandToSendFromHand(players.get(foldedUserId).hand, client.userId === foldedUserId);
        
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: "player-folded",
                id: foldedUserId,
                username: players.get(foldedUserId).username,
                hand: handToSend
            }));
        }
    })
}

function sendSocketMessageToEveryClient(objectToSend) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

// TODO test have one person fold BEFORE equtaion forming and make sure
// they don't receive an end-equation-result message
// then have remaining players fold AFTER and make sure it still ends

// TODO test that hi lo selection ends correctly even with one or more folded players
function sendSocketMessageToNonFoldedPlayers(objectToSend) {
    wss.clients.forEach((client) => {
        if (!players.get(client.userId).foldedThisTurn && client.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

function sendSocketMessageToFoldedPlayers(objectToSend) {
    wss.clients.forEach((client) => {
        if (players.get(client.userId).foldedThisTurn && client.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

function initializeHand() { // means start a hand of play
    console.log("initializedHand");
    players.values().forEach(player => {
        if (player.out) { // fold automatically if out
            player.foldedThisTurn = true;
        } else {
            console.log(player.username, "chipCount:", player.chipCount);
        }
    })
    deck = generateDeck()
    printDeck(deck, 10);    
    
    // so client can say "beginning hand number n!"
    sendSocketMessageToEveryClient({ 
        type: "begin-hand", 
        handNumber: handNumber 
    });
    
    clearHandsAndDealOperatorCards(); // this should actually be initializeHand

    //TODO maybe don't need this?
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({ 
                type: "deal", 
                // something to do with client.userId not equaling anyone's userId
                chipCount: players.get(client.userId).chipCount, 
                id: client.userId, 
                hand: players.get(client.userId).hand 
            });
            client.send(payload);
        }
    });

    dealFirstHiddenCardToEachPlayer(); 

    dealTwoOpenCardsToEachPlayer();

    console.log("toDiscard, haveDiscarded:", numPlayersThatNeedToDiscard, numPlayersThatHaveDiscarded)
    if (numPlayersThatNeedToDiscard === 0) {
        commenceFirstRoundBetting();
    }
}

function endBettingRound(round) {
    isNotFirstBettingRound = true;
    toCall = 0;

    for (const [id, player] of players) {
        player.turnTakenThisRound = false;
        player.stake = 0;
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
function notifyAllPlayersOfNewlyDealtCards(player, multiplicationCardDealt = false) {
    wss.clients.forEach((client) => {
        let payload;
        if (client.userId == player.id) {
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
                let handToSend = getHandToSendFromHand(player.hand, client.userId === player.id);
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
    console.log("Commencing first round of betting")
    sendSocketMessageToEveryClient({
        type: "first-round-betting-commenced",
    });

    advanceToNextPlayersTurn(1); // TODO change to anteAmount (and then modify as game goes on)
}

function commenceSecondRoundBetting() {
    sendSocketMessageToNonFoldedPlayers({ type: "second-round-betting-commenced" });

    /* TODO
        What I SHOULD have is a variable on the server side of currentBet.

        Then here, I can check if it's equal to the smallest players chips and forego 
        the second betting round.

        As is, I have to take the chipAmount from the socket message of the last player and 
        set some bool from there.
    */

    // put findNextPlayerTurn inside advanceToNextPlayersTurn
    // i think I want to just continue in round robin.
    // We can change this implementation later to always follow left of the dealer
    currentTurnPlayerId = findNextPlayerTurn();
    advanceToNextPlayersTurn(0); // no ante to match on the second round
}

function advanceToNextPlayersTurn(betAmount) { // should take a parameter here
    console.log("Advancing to next player's turn, with id:", currentTurnPlayerId);
    // Player A bets 10 and then has 20 chips. Player B has 30 chips. Max bet is still 30, not 20. 
    // So add the 10 and 20 to get 30. (Add chips PLUS the chips they have in this round)
    const nonFoldedPlayerChipCounts = nonFoldedPlayers().map(player => player.chipCount + player.stake);
    const maxBet = Math.min(...nonFoldedPlayerChipCounts);
    
    // modify this so that we don't trust the client?
    // but technically we do because only currentTurnPlayer can send a betting message.
    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "next-turn",
            toCall: betAmount - players.get(currentTurnPlayerId).stake,
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
    return findNextKeyWithWrap(players, currentTurnPlayerId, v => v.foldedThisTurn !== true);

    function findNextKeyWithWrap(map, startKey, predicate) {
        const entries = [...map];
        const startIndex = entries.findIndex(([key]) => key === startKey);
      
        if (startIndex === -1) return undefined;
      
        const total = entries.length;
      
        // for loop won't execute if total is 1
        // doesn't matter because we should end the game if there's only one player
        // don't start unless there's >= 2 players
        // end ROUND if there's only 1
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
    const playerBetAmounts = nonFoldedPlayers().map(player => player.stake);
    const setOfBets = new Set(playerBetAmounts);
    // bets are all equal AND active players have all bet at least once, then betting round is complete
    if (setOfBets.size === 1 && nonFoldedPlayers().every(player => player.turnTakenThisRound === true)){ 
        return true;
    }

    return false;
}
         
function commenceEquationForming() {
    console.log("Waiting 90 seconds for equation forming...");

    sendSocketMessageToNonFoldedPlayers({ type: "commence-equation-forming" });
    sendSocketMessageToFoldedPlayers({ type: "commence-equation-forming", folded: true });

    setTimeout(() => {
        endEquationForming();
    }, 90000);
}

function endEquationForming() {
    console.log("Timer expired for equation forming, notifying clients to receive equation results.");

    sendSocketMessageToNonFoldedPlayers({ 
        type: "end-equation-forming", 
    });
}

function commenceHiLoSelection() {
    sendSocketMessageToNonFoldedPlayers({ 
        type: "hi-lo-selection", 
    });
}

function distributePotToOnlyRemainingPlayer(onlyRemainingPlayerThisHand){
    // end turn
    console.log("All but one player folded this hand. Ending hand.");

    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
            let message;
            if (client.userId === onlyRemainingPlayerThisHand.id) {
                message = "Everyone else folded. You take the pot by default.";
            } else {
                message = `Everyone but ${onlyRemainingPlayerThisHand.username} has folded. They take the pot of ${pot}`;
            }
            let payload = JSON.stringify({
                type: "round-result",
                message: message,
                becauseAllButOneFolded: true
            });
            client.send(payload);
        }
    });

    // that person takes the whole pot
    onlyRemainingPlayerThisHand.chipCount += pot;
    pot = 0;

    sendSocketMessageToEveryClient({
        type: "chip-distribution",
        chipCount: pot,
        id: onlyRemainingPlayerThisHand.id
    });

    // need to call endBettingRound because we have to reset everyone's bets. Otherwise
    // next hand will begin with toCall equaling the raise from the first hand
    console.log("bet-placed");
    players.values().forEach(player => {
        console.log(player.username, "chipCount:", player.chipCount);
    })

    isNotFirstBettingRound ? endBettingRound("second") : endBettingRound("first");
    endHand();    
}

function revealHiddenCards() {
    // Don't reveal folded players' hidden cards

    // TODO deal is kind of a misnomer ... we are just rerendering the whole hand, not dealing cards
    // maybe name it "render hand"
    nonFoldedPlayers().forEach((player) => {
        wss.clients.forEach((client) => {
            let handToSend = getHandToSendFromHand(player.hand, revealCard = true);
            
            if (/*client !== ws && */client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: "deal",
                    id: player.id,
                    username: player.username,
                    hand: handToSend
                }));
            }
        })
    })
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

    const loBettingPlayers = nonFoldedPlayers().filter(player => player.choices.includes('low'));
    const hiBettingPlayers = nonFoldedPlayers().filter(player => player.choices.includes('high'));
      
    const loTarget = 1;
    const hiTarget = 20;
      
    let currentHighestPlayersHighestCard = null;
    let currentLowestPlayersLowestCard = null;

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
            currentLowestPlayersLowestCard = findLowestCard(loWinner.hand);

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
            currentHighestPlayersHighestCard = findHighestCard(hiWinner.hand);

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
    let results = [...nonFoldedPlayers().values()].map(player => ({
        id: player.id,
        hand: player.hand,
        result: player.equationResult,
        choice: player.choices[0], // TODO adjust this for swing betting, need to send choices
        difference: player.choices[0] === "low" ? Math.abs(player.equationResult - 1) : Math.abs(player.equationResult - 20),
        isHiWinner: player.id === hiWinner?.id,
        isLoWinner: player.id === loWinner?.id,
        currentLowestPlayersLowestCard: currentLowestPlayersLowestCard?.value,
        currentHighestPlayersHighestCard: currentHighestPlayersHighestCard?.value
        // TODO pass in lo cards and hi cards here.
    }));
    // there's distinct lo and hi winners
    if (loWinner !== null && hiWinner !== null) {
        payload = {
            type: "round-result",
            message: loWinner.username + " won the low bet and " + hiWinner.username + " won the high bet.",
            loWinner: loWinner,
            hiWinner: hiWinner,
            results: results
        };
    } else if (loWinner !== null) { // players only bet on lo
        payload = {
            type: "round-result",
            message: loWinner.username + " won the low bet.",
            loWinner: loWinner,
            hiWinner: hiWinner,
            results: results
        };
    } else if (hiWinner !== null) { // players only bet on hi
        payload = {
            type: "round-result",
            message: hiWinner.username + " won the high bet.",
            loWinner: loWinner,
            hiWinner: hiWinner,
            results: results
        };
    }

    sendSocketMessageToEveryClient(payload);

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

    pot = 0; // TODO put this inside of endHand??
}
  
function printDeck(deck, rows) {
    console.log("Deck size:", deck.length, "cards.");

    const toPrint = Array.from({ length: rows }, () => []);
    // Initialize an array of columns
    deck.forEach((card, index) => {
        toPrint[index % rows].push(card);
    });
  
    // Print row by row
    for (let r = 0; r < rows; r++) {
        let rowOutput = '';
        for (let c = 0; c < toPrint[r].length; c++) {
            let card = toPrint[r][c]
            rowOutput += printCard(card);
        }
        console.log(rowOutput);
    }
}

function printHand(hand) {
    let output = '';
    for (let c = 0; c < hand.length; c++) {
        let card = hand[c];
        output += printCard(card);
    }
    console.log(output);
}

function printCard(card) {
    let cardOutput = getStringFromSuit(card.suit) + ' ' + card.value + ', ';
    let colorCodedCardOutput = getANSICodeFromSuit(card.suit) + cardOutput.padEnd(12) + '\x1b[0m'
    return colorCodedCardOutput;
}

function getANSICodeFromSuit(suit) {
    switch(suit) {
        case 0:
            return '\x1b[90m';
        case 1:
            return '\x1b[33m';
        case 2:
            return '\x1b[37m';
        case 3:
            return '\x1b[33;1m';
        default: // operators
            return ''
    }
}

function getStringFromSuit(suit) {
    switch(suit) {
        case 0:
            return 'Stone';
        case 1:
            return 'Bronze';
        case 2:
            return 'Silver';
        case 3:
            return 'Gold';
        default: // operators
            return 'Operator';
    }
}

function generateDeck() {
    let deck = []
    // add 5 each of multiply and root cards to deck
    for (let i = 0; i < 4; i++) {
        deck.push(new Card(OperatorCards.MULTIPLY, Suits.OPERATOR));
        deck.push(new Card(OperatorCards.ROOT, Suits.OPERATOR));
    }
    
    // add all numbers of all suits to deck
    for (const number of Object.values(NumberCards)) {
        for (const suit of Object.values(Suits)) {
            if (suit !== Suits.OPERATOR) {
                deck.push(new Card(number, suit));
            }
        }
    }
    
    deck.sort(() => Math.random() - 0.5);
    
    return deck;
}

function getHandToSendFromHand(hand, revealHiddenCard) {
    let handToSend = JSON.parse(JSON.stringify(hand));

    for (let i = 0; i < handToSend.length; i++) {
        if (handToSend[i].hidden === true) {
            if (!revealHiddenCard) {
                // hide the card if the user is not the owner of the card
                handToSend[i] = new Card(null, null, true);
            }
        }
    }

    return handToSend;
}