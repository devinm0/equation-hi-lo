import { OperatorCards, Suits, NumberCards, GamePhases } from './public/enums.js';
import { Game, Player, Card } from './public/classes.js';
import { findNextKeyWithWrap } from './public/utilities.js';
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static("public"));

let games = new Map();
let players = new Map();
const RATE_LIMIT = 20;
const INTERVAL = 10000;
let endEquationFormingTimeout;

function heartbeat() {
    this.isAlive = true;
}

wss.on("connection", (ws) => {
    // keep alive, in the case of 90 seconds equation forming
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    console.log("connection");
    // only our domain can upgrade from http to ws
    // const origin = req.headers.origin;
    // if (!allowedOrigins.includes(origin)) {
    //     console.log("Blocked unauthorized origin: ", origin);
    //     ws.close();
    //     return;
    // }
    ws.msgCount = 0;
    setInterval(() => ws.msgCount = 0, INTERVAL);

    const userColor = `hsl(${Math.random() * 360}, 100%, 70%)`; // same here
    const userId = uuidv4();
    ws.userId = userId; // in the case of rejoin or room code, this will be overwritten later
    ws.send(JSON.stringify({ type: "init", id: userId, color: userColor/*, hostId: hostId */ }));
    
    console.log(`Socket connected, generating userId ${userId} but it may not be used in the case that someone is rejoining, in which case the existing client userId will overwrite this.`);

    ws.on("message", (message) => {
        if (++ws.msgCount > RATE_LIMIT) {
            console.log("went over rate limit");
            ws.close();
            return;
        }
        let clientMsg;

        try {
            clientMsg = JSON.parse(message.toString());
        } catch { return; }

        if (!clientMsg.type) return;


        // TESTS create new game, have others join
        //      rejoin a game I created and make sure I'm still host
        //      rejoin a game I didn't create and make sure I'm not host
        //          make sure others can still join AFTER someone rejoins
        //      join a game I haven't created
        //*      be in lobby and see others joining
        //*      start a game where no one rejoined
        //      start a game where someone rejoined
        //      rejoin a game in progress
        //      rejoin a game in progress as host ( what does host really matter!?)

        switch (clientMsg.type) {

            case "create": {
                let game = new Game();
                games.set(game.roomCode, game);

                game.currentTurnPlayerId = game.hostId = ws.userId; // no, right? TODO remove concept of hostId?? or add host promotion

                enterRoom(game, clientMsg);
                console.log(game);
                break;
            }
            
            case "enter": { // TODO change to enter, and then just check if game is in lobby phase and if player already exists
                if (!games.has(clientMsg.roomCode)) {
                    // send room code does not exist message
                    ws.send(JSON.stringify({ type: "room-join-reject" }));

                    return;
                }

                const game = games.get(clientMsg.roomCode);

                enterRoom(game, clientMsg);
                break;
            }

            case "refresh": { 
                ws.userId = clientMsg.userId; // should actually be the same
                // what about set ws.userId equal to it
                if (players.has(clientMsg.userId)) {
                    const player = players.get(clientMsg.userId);
                    ws.send(JSON.stringify({ type: "suggest-room", roomCode: player.roomCode })); // TODO client will say must be players 2 even if the reject reason is client not being host
                } else {

                }
                
                break;
            }

            case "discard": {
                const player = players.get(clientMsg.id);
                const game = games.get(player.roomCode);

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-discarded",
                    id: clientMsg.id,
                    username: clientMsg.username,
                    value: clientMsg.value
                });

                // rename to discard(player, data.value);
                const index = player.hand.findIndex(card => card.value === clientMsg.value); // TODO rename to data.cardValue
                if (index !== -1) {
                    player.hand.splice(index, 1);
                }

                const draw = drawNumberCardFromDeck(game.deck);
                player.hand.push(draw);

                notifyAllPlayersOfNewlyDealtCards(game.roomCode, player);
                player.needToDiscard = false;

                if (playersThatNeedToDiscard(game.roomCode).length === 0) {
                    if (game.phase === GamePhases.SECONDDEAL) {
                        commenceEquationForming(game);
                    } else if (game.phase === GamePhases.FIRSTDEAL) {
                        commenceFirstRoundBetting(game); 
                    }
                    // would break if someone leaves. in that case reduce num players that need to discard by 1?
                }
                break;
            }
        
            case "start": {
                const game = games.get(players.get(clientMsg.id).roomCode);
                if (clientMsg.id !== game.hostId || players.size < 2) {
                    ws.send(JSON.stringify({ type: "reject-start" })); // TODO client will say must be players 2 even if the reject reason is client not being host
                    return;
                }

                sendSocketMessageToEveryClientInRoom(game.roomCode, { 
                    type: "game-started", 
                    // chipCount: players.get(client.userId).chipCount, // TODO have we initialized chip count here
                    // id: client.userId
                });

                initializeHand(game);
                break;
            }

            case "leave": {
                const player = players.get(clientMsg.id);
                const game = games.get(player.roomCode);

                if (clientMsg.id === game.hostId) {
                    // set a new host. if last player, end the game
                }

                sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "player-left" });

                player.out = true; //ws.userId or userId??
                // console.log(`User disconnected: ${ws.userId}`);
                break;
            }

            case "join": { // TODO change to set Name
                console.log("join");
                // if (ws.isHost) { // without this, later players joining become the host
                //     currentTurnPlayerId = clientMsg.userId; // TODO surely we can set this later? as just the first player in players list?
                //     hostId = clientMsg.userId; // just use ws.userId here?
                // }
                const player = players.get(ws.userId);
                if (player.username !== null) {
                    // this player already submitted their username, so this must be a duplicate message
                    return;
                }

                const game = games.get(player.roomCode);

                players.get(ws.userId).username = clientMsg.username.removeWhitespace();
                console.log(`***** 👩‍💻 ${game.hostId === ws.userId ? 'Host' : 'Player'} joined: ${clientMsg.username} *****`);

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-joined",
                    id: clientMsg.userId,
                    hostId: game.hostId,// client.userId === hostId, // this is wrong because it means the host will show everyone joining as host
                    color: clientMsg.color, // what happens if we put user color here?
                    username: clientMsg.username,
                });

                logRoomsAndPlayers(); // this will be outside game class
                break;
            }

            function enterRoom(game, clientMsg) {

                if (game.phase === GamePhases.LOBBY) {
                    // send a newly connected player the list of all players that have joined thus far
                    // player.username != null is because we don't want to share players that have entered but not submitted name
                    [...players.values()].filter(player => player.roomCode === game.roomCode && player.username != null).forEach(player => {
                        ws.send(JSON.stringify({
                            type: "player-joined",
                            id: player.id,
                            hostId: game.hostId,// client.userId === hostId, // this is wrong because it means the host will show everyone joining as host
                            color: player.color, // what happens if we put user color here?
                            username: player.username,
                        }));
                    });

                    if (players.has(clientMsg.userId)) {
                        // TODO how to change the flow so we don't have to trust this
                        const player = players.get(clientMsg.userId);
                        ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: player.username !== null }));

                        if (player.roomCode === game.roomCode){
                            ws.userId = clientMsg.userId;

                            logRoomsAndPlayers();
                        } else {

                        }
                    } else {
                        ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: false }));

                        console.log("creating userId but no username yet");
                        // if (ws.isHost) { // without this, later players joining become the host
                        //     currentTurnPlayerId = clientMsg.userId; // TODO surely we can set this later? as just the first player in players list?
                        //     hostId = clientMsg.userId; // just use ws.userId here?
                        // }

                        console.log(`***** 👩‍💻 ${game.hostId === clientMsg.userId ? 'Host' : 'Player'} joined: ${clientMsg.userId} *****`);

                        // TODO THIS for rejoining active rooms
                        // have to reassign userId because what if someone refreshes? have to ignore the init message // TODO rethink this in the context of join/ enter
                        // need to assign ws.userId because it's used to check clientId === id on server
                        ws.userId = clientMsg.userId; // TODO need this??
                        players.set(clientMsg.userId, new Player(clientMsg.userId, null, [], 25)); // TODO sanitize clientMsg.username to standards
                        players.get(clientMsg.userId).color = clientMsg.color;
                        players.get(clientMsg.userId).roomCode = game.roomCode;

                        console.log([...players].filter(([id, player]) => player.roomCode === game.roomCode));
                        
                        logRoomsAndPlayers();
                    }
                } else if (game.phase !== GamePhases.LOBBY) {
                    ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: true, inProgress: true }));

                    const playerToNotify = players.get(ws.userId); // can use ws if not gamephase bc must be true
                    // send game state
                    switch (game.phase) {
                        case GamePhases.FIRSTDEAL:
                            playersInRoom(game.roomCode).forEach(player => {
                                notifyPlayerOfNewlyDealtCards(player, playerToNotify, player.needToDiscard);
                            });
                            break;
                        case GamePhases.FIRSTBETTING:
                            playersInRoom(game.roomCode).forEach(player => {
                                notifyPlayerOfNewlyDealtCards(player, playerToNotify, false);
                            });
                            break;
                        case GamePhases.SECONDDEAL:
                            break;
                        case GamePhases.EQUATIONFORMING:
                            break;
                        case GamePhases.SECONDBETTING:
                            break;
                        case GamePhases.HILOSELECTION:
                            break;
                        case GamePhases.RESULTVIEWING:
                            break;
                    }
                }
                    console.log("made it to sending game state");
            }

            // tests
            // two players call and third player folds
            // one player calls and two players fold = distribute pot to first player and end round
            case "bet-placed": {
                const justPlayedPlayer = players.get(clientMsg.userId);
                const game = games.get(justPlayedPlayer.roomCode);

                if (clientMsg.userId !== game.currentTurnPlayerId) return;

                justPlayedPlayer.turnTakenThisRound = true;
                justPlayedPlayer.stake += clientMsg.betAmount;
                justPlayedPlayer.contribution += clientMsg.betAmount;
                justPlayedPlayer.chipCount -= clientMsg.betAmount;

                const betType = justPlayedPlayer.betAmount === 0 ? "check" :
                                game.phase === GamePhases.FIRSTBETTING && justPlayedPlayer.betAmount === 1 ? "ante" : // TODO implement proper ante
                                game.toCall === justPlayedPlayer.stake ? "check" :
                                justPlayedPlayer.stake - game.toCall >= 10 ? "raise10" :
                                "raise";

                game.toCall = Math.max(justPlayedPlayer.stake, game.toCall); // TODO rename game.toCall... it's not really toCall. it's the current stake of the game. toCall is the different between that and player.stake
                game.pot += clientMsg.betAmount;

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "bet-placed",
                    id: clientMsg.userId,
                    username: justPlayedPlayer.username,
                    betAmount: clientMsg.betAmount, // so users can see "so and so bet x chips"
                    chipCount: justPlayedPlayer.chipCount, // to update the chip stack visual of player x for each player
                    pot: game.pot, // otherwise, pot won't get updated on last player of the round
                    betType: betType
                });
                endRoundOrProceedToNextPlayer(game, justPlayedPlayer);
                break;
            }

            // TODO more tests - have a folded player submit an equation anyway and confirm it's discarded by server.
            case "equation-result": {
                // definitely DON'T want to tell everyone what the results are yet
                const player = players.get(clientMsg.userId);
                const game = games.get(player.roomCode);

                if (player.equationResult !== null) { // duplicate message
                    return;
                }
                if (game.phase !== GamePhases.EQUATIONFORMING) {
                    return;
                }
                // a folded player may have manually sent a formed equation despite not given the opportunity, just ignore
                // if (player.foldedThisTurn) { return; }
                console.log("equation-result received " + clientMsg.result);

                player.hand = clientMsg.order.map(i => player.hand[i]);
                player.equationResult = clientMsg.result;

                // let everyone else know I've moved my cards, so they can see the order.
                wss.clients.forEach((client) => {
                    let handToSend = getHandToSendFromHand(player.hand, client.userId === clientMsg.userId);
                    
                    if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === player.roomCode) { //some kind of clientsInRoom function
                        client.send(JSON.stringify({
                            type: "player-formed-equation",
                            id: clientMsg.userId,
                            username: players.get(clientMsg.userId).username,
                            chipCount: players.get(clientMsg.userId).chipCount,
                            hand: handToSend
                        }));
                    }
                })

                if (nonFoldedPlayers(game).every(player => player.equationResult !== null)) {
                    endEquationForming(game);
                    clearTimeout(endEquationFormingTimeout);

                    if (nonFoldedPlayers(game).length === 1){
                        distributePotToOnlyRemainingPlayer(game, nonFoldedPlayers(game)[0]);
                        return;
                    }
                
                    // I feel like there could be a bug here. Let's say everyone submits there equations early.
                    // so we are hitting this code, and about to progress to hiloselection
                    // but if the interval runs out in that time in between, we send end equation socket message
                    // and everyone will resend equation results.
                    if (game.maxRaiseReached) {
                        console.log('Max bet was reached on first round of betting. Skipping second round.');

                        sendSocketMessageToNonFoldedPlayers(game, { type: "second-round-betting-skipped" });

                        commenceHiLoSelection(game);
                    } else {
                        console.log('All equations received. Proceeding to second round of betting.');

                        commenceSecondRoundBetting(game);
                    }
                }
                break;
            }

            case "fold": {
                const foldedPlayer = players.get(ws.userId); // use ws.userId because we can't trust client to provide the id
                const game = games.get(foldedPlayer.roomCode); // remove when going to OOP?
                
                // can only fold in these 3 phases
                if (game.phase !== GamePhases.FIRSTBETTING && game.phase !== GamePhases.SECONDBETTING && game.phase !== GamePhases.EQUATIONFORMING) {
                    return;
                }
                
                foldedPlayer.foldedThisTurn = true;
                foldedPlayer.hand.forEach(card => {
                    card.hidden = true;
                });

                sendSocketMessageThatPlayerFolded(foldedPlayer.roomCode, foldedPlayer.id);
                    
                // two cases to check:

                // player manually folded in first betting round, and there's only one player left, go ahead and distribute pot
                if (clientMsg.manual === true || 
                    // if we've received equation result socket messages from every player, we can proceed to second round of betting.
                    // this check must be inside the parent if loop, otherwise we may have a case where no one submitted an equation,
                    // so whichever client is last to have its message received actually takes the whole pot
                    nonFoldedPlayers(game).every(player => player.equationResult !== null)) 
                {
                    // TODO I think this if statement only can be moved outside the parent if. No way to race condition to 0
                    if (nonFoldedPlayers(game).length === 0){
                        returnChipsToAllPlayers(game);
                        return;
                    }

                    if (nonFoldedPlayers(game).length === 1){
                        distributePotToOnlyRemainingPlayer(game, nonFoldedPlayers(game)[0]);
                        return;
                    }
                }

                if (clientMsg.manual === true) { // TODO unreadable
                    endRoundOrProceedToNextPlayer(game, foldedPlayer);
                }
                break;
            }

            // TODO (putting this in random place so I see it later) - test every number of automatically folded players during equation forming
            case "hi-lo-selected": {
                // TODO need some game phase check here
                console.log(clientMsg.userId, clientMsg.username, clientMsg.choices, clientMsg.otherEquationResult, clientMsg.order);
                const player = players.get(ws.userId);
                player.choices = clientMsg.choices;

                if (player.choices.includes("low") && !player.choices.includes("high")) {
                    player.lowHand = player.hand;
                    player.lowEquationResult = player.equationResult;
                } else if (player.choices.includes("low") && !player.choices.includes("high")) {
                    player.lowHand = player.hand;
                    player.lowEquationResult = player.equationResult;
                } else if (player.choices.includes("low") && player.choices.includes("high")) {
                    player.otherEquationResult = clientMsg.otherEquationResult;
                    player.otherHand = clientMsg.order.map(i => player.hand[i]); // is this gonna be reordered? do I need to copy?
                    
                    // this shouldn't be true. What if their results are 21, and 23. They might want to choose 21 as high equation, and 23 as low (even though they could have just kept 21 for both)
                    if (player.otherEquationResult < player.equationResult) {
                        player.lowEquationResult = player.otherEquationResult;
                        player.highEquationResult = player.equationResult;
                        player.lowHand = player.otherHand;
                        player.highHand = player.hand;
                    } else {
                        player.lowEquationResult = player.equationResult;
                        player.highEquationResult = player.otherEquationResult;
                        player.highHand = player.otherHand;
                        player.lowHand = player.hand;
                    }

                }
                const game = games.get(player.roomCode);

                if (nonFoldedPlayers(game).every(player => player.choices.length > 0)) {
                    game.phase = GamePhases.RESULTVIEWING;

                    console.log('everyone submitted their hi or lo selections');
                    revealHiddenCards(game);
                    determineWinners(game);
                }
                break;
            }

            // need this so that players have time to view results
            case "acknowledge-hand-results": {
                const player = players.get(ws.userId);
                const game = games.get(player.roomCode);
                
                if (game.phase !== GamePhases.RESULTVIEWING) {
                    return;
                }

                player.acknowledgedResults = true;

                if (playersInRoom(game.roomCode).every(player => player.acknowledgedResults === true)) { // change to accept just game, and then move to class based game
                    endHand(game);
                }
                break;
            }

            default: {
                ws.send(JSON.stringify({ type: "unknown-message" }));
                break;
            }
        }
    });
});

server.listen(8080, "0.0.0.0", () => {
  console.log("Server running on port 8080");
});

function nonFoldedPlayers(game){
    return [...(playersInRoom(game.roomCode).filter(player => player.foldedThisTurn !== true))];
}

function endRoundOrProceedToNextPlayer(game, justPlayedPlayer) {
    if (bettingRoundIsComplete(game)) {
        endBettingRound(game);

        if (game.phase === GamePhases.SECONDBETTING) {
            commenceHiLoSelection(game);
        } else if (game.phase === GamePhases.FIRSTBETTING) {
            dealLastOpenCardToEachPlayer(game);

            // possible that players receive multiply cards on last deal
            // so don't commence equation forming unless all discards are complete
            if (playersThatNeedToDiscard(game.roomCode).length === 0) {
                commenceEquationForming(game);
            }
        }
    } else { 
        if (justPlayedPlayer.chipCount === 0) {
            // if anyone is 0, it means someone is all in and no one can bet anymore
            game.maxRaiseReached = true;
        }
        game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO make this a method of class game
        console.log(players.get(game.currentTurnPlayerId).username);
        // subtract player's stake.
        // if someone bets 10, then next raises 4, we can toCall to be 4, NOT 14
        // it would also allow betting more chips than a player has
        advanceToNextPlayersTurn(game, game.toCall - players.get(game.currentTurnPlayerId).stake); // TODO refactor, this is just bad
    }
}

function clearHandsAndDealOperatorCards(roomCode, players) {
    players.forEach(player => { // change players in room to be just the values. then modify logic everywhere
        player.hand = [];

        player.hand.push(new Card(OperatorCards.ADD, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.DIVIDE, Suits.OPERATOR));
        player.hand.push(new Card(OperatorCards.SUBTRACT, Suits.OPERATOR));

        notifyAllPlayersOfNewlyDealtCards(roomCode, player);
    })
}

function dealFirstHiddenCardToEachPlayer(game, players) {
    players.forEach(player => {
        for (let i = 0; i < game.deck.length; i++) {
            // cannot be operator card
            if (game.deck[i].suit !== Suits.OPERATOR) {
                // Remove the card and give it to player
                player.hand.push(game.deck.splice(i, 1)[0]);
                // set hidden to true, so when message is sent to other players it's obfuscated
                player.hand[player.hand.length - 1].hidden = true;
                break; // having to index here is so trash omg
            }
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player);
    });
}

function drawNumberCardFromDeck(deck) {
    for (let i = 0; i < deck.length; i++) {
        // cannot be operator card
        if (deck[i].suit !== Suits.OPERATOR) {
            // Remove the card and give it to player
            return deck.splice(i, 1)[0];
        }
    }
}

function drawFromDeck(deck) {
    return deck.splice(0, 1)[0];
}

// TODO write tests for these
// that two operators cannot be dealt
// that number count is now 3 if there's a root

function dealTwoOpenCardsToEachPlayer(game, players) {
    players.forEach(player => { 
        // first card can be any card
        const draw = drawFromDeck(game.deck);

        player.hand.push(draw);
    
        // technically should put returned cards at the bottom, but the math should be the same
        let draw2;
        // can't have both open cards be operators according to game rules.
        if (draw.suit === Suits.OPERATOR) {
            draw2 = drawNumberCardFromDeck(game.deck);
        } else {
            draw2 = drawFromDeck(game.deck);
        }
        player.hand.push(draw2);

        if (draw.value === OperatorCards.ROOT || draw2.value === OperatorCards.ROOT) { // push another number
            const draw3 = drawNumberCardFromDeck(game.deck); // TODO change this to deck.drawNumberCard()
            player.hand.push(draw3);
        }

        if (draw.value === OperatorCards.MULTIPLY || draw2.value === OperatorCards.MULTIPLY) { // expect one more person to discard before advancing game state
            player.needToDiscard = true;
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player, player.needToDiscard); // magic bool parameters are bad. just call notifyOfFirstOpenDeal

        console.log("dealt 2 open cards to " + player.username);
        printHand(player.hand);
    });

    return playersThatNeedToDiscard(game.roomCode).length;
}

function dealLastOpenCardToEachPlayer(game) {
    game.phase = GamePhases.SECONDDEAL;

    // can't wanna deal to folded players
    nonFoldedPlayers(game).forEach(player => {    
        const draw = drawFromDeck(game.deck);
        player.hand.push(draw);
    
        if (draw.value === OperatorCards.ROOT) {
            let draw2 = drawNumberCardFromDeck(game.deck);
            player.hand.push(draw2);
        }


        if (draw.value === OperatorCards.MULTIPLY) { // expect one more person to discard before advancing game state
            player.needToDiscard = true;
        }

        notifyAllPlayersOfNewlyDealtCards(game.roomCode, player, player.needToDiscard);
    });

    return playersThatNeedToDiscard(game.roomCode).length;
}

function endHand(game) {
    console.log("endHand");
    playersInRoom(game.roomCode).forEach(player => { console.log(player.username, "chipCount:", player.chipCount); });

    game.maxRaiseReached = false;
    game.handNumber += 1;

    playersInRoom(game.roomCode).forEach(player => { // refactor to this.players() which is a function
        if (player.chipCount === 0) {
            sendSocketMessageToEveryClientInRoom(game.roomCode, { 
                type: "kicked",
                userId: player.id,
                username: player.username
            });

            players.get(player.id).out = true;
        }

        player.foldedThisTurn = false;
        player.equationResult = null;
        player.otherEquationResult = null;
        player.lowEquationResult = null;
        player.highEquationResult = null;
        player.choices = [];
        player.acknowledgedResults = false;
        player.contribution = 0;
        player.needToDiscard = false;
    })

    initializeHand(game);
}

function sendSocketMessageThatPlayerFolded(roomCode, foldedUserId) {
    wss.clients.forEach((client) => { // TODO have clientsInRoom function
        let handToSend = getHandToSendFromHand(players.get(foldedUserId).hand, client.userId === foldedUserId);
        
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === roomCode) {
            client.send(JSON.stringify({
                type: "player-folded",
                id: foldedUserId,
                username: players.get(foldedUserId).username,
                hand: handToSend
            }));
        }
    })
}

function sendSocketMessageToEveryClientInRoom(roomCode, objectToSend) {
    wss.clients.forEach((client) => {
        // should we retry if not ready state? one missed message could mean game never continues
        // ? is required on players.get for the following case:
        //      if someone has gone to the site (opened the tab) but is still on the homepage,
        //      there is a client and userId, but no player entry for them yet. so players.get will return undefined and therefore there will be no room code
        if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === roomCode /* checking if this player is in the game */) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

// TODO test have one person fold BEFORE equation forming and make sure
// they don't receive an end-equation-result message
// then have remaining players fold AFTER and make sure it still ends

// TODO test that hi lo selection ends correctly even with one or more folded players
function sendSocketMessageToNonFoldedPlayers(game, objectToSend) {
    wss.clients.forEach((client) => {
        if (!players.get(client.userId)?.foldedThisTurn && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

function sendSocketMessageToFoldedPlayers(game, objectToSend) {
    wss.clients.forEach((client) => {
        if (players.get(client.userId)?.foldedThisTurn && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            const payload = JSON.stringify(objectToSend);
            client.send(payload);
        }
    });
}

function initializeHand(game) { // means start a hand of play
    console.log("Initializing hand.");

    playersInRoom(game.roomCode).forEach(player => {
        if (player.out) { // fold automatically if out
            player.foldedThisTurn = true;
        } else {
            console.log(player.username, "chipCount:", player.chipCount);
        }
    })

    game.deck = generateDeck(); // TODO rename all game.something to room.something
    printDeck(game.deck);    
    
    sendSocketMessageToEveryClientInRoom(game.roomCode, { 
        type: "begin-hand", 
        handNumber: game.handNumber 
    });
    
    game.phase = GamePhases.FIRSTDEAL;
    clearHandsAndDealOperatorCards(game.roomCode, playersInRoom(game.roomCode));

    //TODO maybe don't need this?
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
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

    dealFirstHiddenCardToEachPlayer(game, playersInRoom(game.roomCode)); 

    dealTwoOpenCardsToEachPlayer(game, playersInRoom(game.roomCode));

    console.log("toDiscard: ", playersThatNeedToDiscard(game.roomCode).length) // refactor to one variable

    // upon reading, thought this should be numPlayersThatNeedToDiscard === numPlayersThatHaveDiscarded
    // it could be
    // but anyway, this shows we can commence right away if no multiplies were dealt
    // the other condition is that there WERE people who need to discard, and that is checked elsewhere
    //      so there are two calls to commenceFirstRoundBetting();

    if (playersThatNeedToDiscard(game.roomCode).length === 0) { // no multiply cards were dealt
        commenceFirstRoundBetting(game);
    }
}

function playersInRoom(roomCode) { return [...players.values()].filter(player => player.roomCode === roomCode) };

function playersInRoomEntries(roomCode) { return [...players].filter(([id, player]) => player.roomCode === roomCode) }; 

function playersThatNeedToDiscard(roomCode) { return playersInRoom(roomCode).filter(player => player.needToDiscard === true) };

function endBettingRound(game) {
    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "end-betting-round", round: game.phase });

    game.toCall = 0;

    for (const player of playersInRoom(game.roomCode)) {
        player.turnTakenThisRound = false;
        player.stake = 0;
    }
}

function notifyPlayerOfNewlyDealtCards(playerDealtTo, playerNotifying, multiplicationCardDealt = false) {
    wss.clients.forEach((client) => {
        if (client.userId === playerNotifying.id) {
            let payload = {
                type: "deal",
                id: playerDealtTo.id,
                username: playerDealtTo.username,
                chipCount: playerDealtTo.chipCount,
                multiplicationCardDealt: multiplicationCardDealt
            };
            if (playerNotifying.id == playerDealtTo.id) {
                payload.hand = playerDealtTo.hand;
                // only the player who is dealt a multiplication card gets prompted to discard 
            } else {
                // hide the hidden card. NOTE [...hand] only works if contains primitives
                let handToSend = getHandToSendFromHand(playerDealtTo.hand, playerNotifying.id === playerDealtTo.id);
                payload.hand = handToSend
            }

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
            }
        }
    });
}

// TODO test that only the player who is dealt a multiplication card gets prompted to discard
// TODO test that card is hidden from each other player
// TODO test that a player knows which one of their cards is hidden
function notifyAllPlayersOfNewlyDealtCards(roomCode, player, multiplicationCardDealt = false) {
    wss.clients.forEach((client) => {
        if (players.get(client.userId)?.roomCode === roomCode) { // just change to client.userId in room map?
            let payload = {
                type: "deal",
                id: player.id,
                username: player.username,
                chipCount: player.chipCount,
                multiplicationCardDealt: multiplicationCardDealt
            };
            if (client.userId == player.id) {
                payload.hand = player.hand;
                // only the player who is dealt a multiplication card gets prompted to discard 
            } else {
                // hide the hidden card. NOTE [...hand] only works if contains primitives
                let handToSend = getHandToSendFromHand(player.hand, client.userId === player.id);
                payload.hand = handToSend
            }

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(payload));
            }
        }
    });
}

function commenceFirstRoundBetting(game) {
    console.log("Commencing first round of betting");

    game.phase = GamePhases.FIRSTBETTING;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "first-round-betting-commenced",
    });

    advanceToNextPlayersTurn(game, 1); // TODO change to anteAmount (and then modify as game goes on)
}

function commenceSecondRoundBetting(game) {
    game.phase = GamePhases.SECONDBETTING;

    sendSocketMessageToNonFoldedPlayers(game, { type: "second-round-betting-commenced" });

    // put findNextPlayerTurn inside advanceToNextPlayersTurn
    // i think I want to just continue in round robin.
    // We can change this implementation later to always follow left of the dealer
    game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO we should be passing player id into advanceToNextPlayersTurn
    advanceToNextPlayersTurn(game, 0); // no ante to match on the second round
}

function advanceToNextPlayersTurn(game, toCall) { // should take a parameter here
    console.log("Advancing to next player's turn, with id:", game.currentTurnPlayerId);
    // Player A bets 10 and then has 20 chips. Player B has 30 chips. Max bet is still 30, not 20. 
    // So add the 10 and 20 to get 30. (Add chips PLUS the chips they have in this round)
    const nonFoldedPlayerChipCounts = nonFoldedPlayers(game).map(player => player.chipCount + player.stake);
    const maxBet = Math.min(...nonFoldedPlayerChipCounts);
    
    // modify this so that we don't trust the client?
    // but technically we do because only currentTurnPlayer can send a betting message.
    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) { // TODO refactor to room.clients.forEach
            // something like game.player.forEach ({ wss.clients[player.userId]. send whatever}
          client.send(JSON.stringify({
            type: "next-turn",
            toCall: toCall, // change to game.toCall and remove second parameter to this method
            maxBet: maxBet,
            currentTurnPlayerId: game.currentTurnPlayerId,
            username: players.get(game.currentTurnPlayerId).username,
            playerChipCount: players.get(client.userId).chipCount
            // pot: pot
          }));
        }
    });
}

function findNextPlayerTurn(game) {
    return findNextKeyWithWrap(playersInRoomEntries(game.roomCode), game.currentTurnPlayerId, v => v.foldedThisTurn !== true);
}

function bettingRoundIsComplete(game) {
    const playerBetAmounts = nonFoldedPlayers(game).map(player => player.stake);
    const setOfBets = new Set(playerBetAmounts);
    // bets are all equal AND active players have all bet at least once, then betting round is complete
    if (setOfBets.size === 1 && nonFoldedPlayers(game).every(player => player.turnTakenThisRound === true)){ 
        return true;
    }

    return false;
}

function commenceEquationForming(game) {
    console.log("Waiting 90 seconds for equation forming...");

    game.phase = GamePhases.EQUATIONFORMING;
    // actually this doesn't even matter. the client could still cheat say they aren't folded, so
    // just let the client decide if they are folded or not in the first place.
    sendSocketMessageToNonFoldedPlayers(game, { type: "commence-equation-forming" });
    sendSocketMessageToFoldedPlayers(game, { type: "commence-equation-forming", folded: true });

    endEquationFormingTimeout = setTimeout(() => {
        endEquationForming(game);

        requestPlayerEquations(game);
    }, 90 * 1000);
}

function endEquationForming(game) {
    sendSocketMessageToEveryClientInRoom(game.roomCode, { // NEED to change this to game
        type: "end-equation-forming"
    });
}

function requestPlayerEquations(game) {
    console.log("Timer expired for equation forming, notifying clients to receive equation results.");

    sendSocketMessageToNonFoldedPlayers(game, { 
        type: "request-formed-equation", 
    });
}

function commenceHiLoSelection(game) {
    game.phase = GamePhases.HILOSELECTION;
    
    sendSocketMessageToNonFoldedPlayers(game, { 
        type: "hi-lo-selection", 
    });
}

function returnChipsToAllPlayers(game){
    console.log("No players formed a valid equation. Returning chips and starting new hand.");

    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            let payload = JSON.stringify({
                type: "round-result",
                message: "No players formed a valid equation. Returning chips and starting new hand.",
                becauseNoOneFormedEquation: true
            });
            client.send(payload);
        }
    });

    playersInRoom(game.roomCode).forEach(player => {
        player.chipCount += player.contribution; // not stake... because it will be 0 once betting round over
        player.contribution = 0;
    });

    game.pot = 0;

    // sendSocketMessageToEveryClientInRoom(game.roomCode, {
    //     type: "chip-distribution",
    //     chipCount: game.pot,
    //     id: onlyRemainingPlayerThisHand.id
    // });

    // need to call endBettingRound because we have to reset everyone's bets. Otherwise
    // next hand will begin with toCall equaling the raise from the first hand
    endBettingRound(game);
    endHand(game);
}

function distributePotToOnlyRemainingPlayer(game, onlyRemainingPlayerThisHand){
    // end turn
    console.log("All but one player folded this hand. Ending hand.");

    wss.clients.forEach((client) => {
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
            let message;
            if (client.userId === onlyRemainingPlayerThisHand.id) {
                message = "Everyone else folded. You take the pot by default.";
            } else {
                message = `Everyone but ${onlyRemainingPlayerThisHand.username} has folded. They take the pot of ${game.pot}`;
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
    onlyRemainingPlayerThisHand.chipCount += game.pot;
    game.pot = 0;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "chip-distribution",
        chipCount: game.pot,
        id: onlyRemainingPlayerThisHand.id
    });

    // need to call endBettingRound because we have to reset everyone's bets. Otherwise
    // next hand will begin with toCall equaling the raise from the first hand
    console.log("bet-placed");
    playersInRoom(game.roomCode).forEach(player => {
        console.log(player.username, "chipCount:", player.chipCount);
    })

    endBettingRound(game);
    endHand(game);
}

function revealHiddenCards(game) {
    // Don't reveal folded players' hidden cards

    // TODO deal is kind of a misnomer ... we are just rerendering the whole hand, not dealing cards
    // maybe name it "render hand"
    nonFoldedPlayers(game).forEach((player) => {
        wss.clients.forEach((client) => {
            let handToSend = getHandToSendFromHand(player.hand, true);
            
            if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) {
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

function findLowestCard(hand) {
    return hand.filter(card => card.suit !== Suits.OPERATOR).reduce((minCard, currentCard) => {
        return currentCard.value < minCard.value ? currentCard : minCard;
    });
}

function findHighestCard(hand) {
    return hand.filter(card => card.suit !== Suits.OPERATOR).reduce((maxCard, currentCard) => {
        return currentCard.value > maxCard.value ? currentCard : maxCard;
    });
}

function findLoWinner(loBettingPlayers) {
    const loTarget = 1;
    let loWinner = null;
    let loWinnerLowCard = null;
    let winningDiff = Infinity;
    for (const player of loBettingPlayers) {
        const diff = Math.abs(player.lowEquationResult - loTarget);
        if (diff < winningDiff) {
            winningDiff = diff;
            loWinner = player;
            // wipe out in case of second place tie. but TODO this doesn't work because what if there's a 3 way tie. this will wipe out the first
            // TODO need extra if (diff < loContenderDiff)
            loBettingPlayers.forEach(player => player.isLoContender = false);
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isLoContender = true;
            loWinner.isLoContender = true;

            let playerLowCard = findLowestCard(player.hand);
            loWinnerLowCard = findLowestCard(loWinner.hand);

            if (playerLowCard.value < loWinnerLowCard.value) {
                loWinner = player;
            } else if (playerLowCard.value === loWinnerLowCard.value) {
                if (playerLowCard.suit < loWinnerLowCard.suit) {
                    loWinner = player;
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }

    return [loWinner, loWinnerLowCard];
}

function findHiWinner(hiBettingPlayers) {
    const hiTarget = 20;
    let hiWinner = null;
    let hiWinnerHighCard = null;
    let winningDiff = Infinity;
    for (const player of hiBettingPlayers) {
        const diff = Math.abs(player.highEquationResult - hiTarget);
        if (diff < winningDiff) {
            winningDiff = diff;
            hiWinner = player;
            // wipe out in case of second place tie
            hiBettingPlayers.forEach(player => player.isHiContender = false);
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isHiContender = true;
            hiWinner.isHiContender = true;
            
            // right now, let's say two people tie for second place. we compare the highest card of each
            // but we don't really need it because then the first place ends up winning. bit of a waste
            const playerHighCard = findHighestCard(player.hand);
            hiWinnerHighCard = findHighestCard(hiWinner.hand);

            if (playerHighCard.value > hiWinnerHighCard.value) {
                hiWinner = player;
            } else if (playerHighCard.value === hiWinnerHighCard.value) {
                if (playerHighCard.suit > hiWinnerHighCard.suit) {
                    hiWinner = player;
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }
    
    return [hiWinner, hiWinnerHighCard];
}

function determineWinners(game) {
    // TESTS
    // only swing betters
    // one swing better and all hi betters
    // one swing better and all lo betters
    // one swing better and hi and lo betters
    // swing betters and hi and lo betters (6 total)

    // TODO change to player.choice = "swing"
    const swingBettingPlayers = nonFoldedPlayers(game).filter(player => player.choices.includes('low') && player.choices.includes('high'));
    const loBettingPlayers = nonFoldedPlayers(game).filter(player => player.choices.includes('low') && !player.choices.includes('high'));
    const hiBettingPlayers = nonFoldedPlayers(game).filter(player => player.choices.includes('high') && !player.choices.includes('low'));
    
    let [loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard] = findLoWinner(swingBettingPlayers.concat(loBettingPlayers));
    let [hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard] = findHiWinner(swingBettingPlayers.concat(hiBettingPlayers));
    let [loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard] = findLoWinner(swingBettingPlayers);
    let [hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard] = findHiWinner(swingBettingPlayers);
    let [loWinner, loWinnerLowCard] = findLoWinner(loBettingPlayers);
    let [hiWinner, hiWinnerHighCard] = findHiWinner(hiBettingPlayers);
    
          /* If player is greater         compare(diff)
    If value is greater             compare(value)
    If suit is greater              compare(suit) */
    // function findHiWinner(players) {
    //     return hiBettingPlayers.reduce((hiWinner, player) => {
    //         const playerDiff = Math.abs(player.equationResult - hiTarget);
    //         const hiWinnerDiff = Math.abs(hiWinner.equationResult - hiTarget);

    //         const playerHighCard = findHighestCard(player.hand);
    //         const hiWinnerHighCard = findHighestCard(hiWinner.hand);
            
    //         return playerDiff > hiWinnerDiff ? player 
    //             : playerDiff === hiWinnerDiff ? 
    //             : hiWinner;
    //     });
    // }

    // equationResult > high card > high suit
    // TODO findLowestCard(reversedCards) something like this

    let hiWinnerChipsDelta;
    let loWinnerChipsDelta;
    let message;

    // what if there were no swing betters at all

    // TODO what if everyone swing bets but not one wins both... do chips just get returned?
    // what about just find winnerAmongSwingBetters
    // what if someone bets swing and others bet only low. then hiWinner is null
    const swingBetterWon = swingBettingPlayers.length > 0 && loWinnerIncludingSwingBetters.id === loWinnerOfSwingBetters.id && loWinnerOfSwingBetters.id === hiWinnerIncludingSwingBetters.id && hiWinnerIncludingSwingBetters.id === hiWinnerOfSwingBetters.id;
    if (swingBetterWon) { // TODO rename loSwingWinner...
        players.get(loWinnerOfSwingBetters.id).chipCount += game.pot;
        hiWinnerChipsDelta = loWinnerChipsDelta = game.pot;
        message = loWinnerOfSwingBetters.username + " won the swing bet.";
    } else {
        const potWillSplit = loWinner !== null && hiWinner !== null;

        // TODO right now, if everyone bets swing but no one sweeps, the chips are lost. Should they be returned? Or should it default to normal betting?
        // like ifAllPlayersBetSwing, potWillSplit should be loWinnerIncludingSwingBetters !== null and hiWinnerIncludingSwingBetters !== null
        
        // TODO isHiWinner and isLoWinner should be fields on player class I guess
        // send chips to the winners. if there are both lo and hi betters, split the pot among the winner of each
        if (potWillSplit) {
            if (game.pot % 2 !== 0) {
                game.pot = game.pot - 1 // discard a chip if pot is uneven
            }

            const splitPot = game.pot / 2;
            hiWinnerChipsDelta = splitPot;
            loWinnerChipsDelta = splitPot;
            players.get(hiWinner.id).chipCount += splitPot;
            players.get(loWinner.id).chipCount += splitPot;

            message = hiWinner.username + " won the high bet and " + loWinner.username + " won the low bet.";
        } else if (loWinner !== null) {
            players.get(loWinner.id).chipCount += game.pot;
            loWinnerChipsDelta = game.pot;

            message = loWinner.username + " won the low bet.";
        } else if (hiWinner !== null) {
            players.get(hiWinner.id).chipCount += game.pot;
            hiWinnerChipsDelta = game.pot;

            message = hiWinner.username + " won the high bet.";
        }
    }

    game.pot = 0; // TODO put this inside of endHand??

    // notify everyone about the winners
    let results = [...nonFoldedPlayers(game).values()].map(player => ({
        id: player.id,
        chipCount: player.chipCount,
        chipDifferential: swingBetterWon ? player.id === loWinnerOfSwingBetters.id ? loWinnerChipsDelta : 0 :
            player.id === hiWinner?.id ? hiWinnerChipsDelta : // todo rename to hiWinnerExcludingSwingBetters
            player.id === loWinner?.id ? loWinnerChipsDelta : 0,
        lowHand: player.lowHand, // TODO adjust for swing
        highHand: player.highHand,
        folded: player.foldedThisTurn,
        // TODO debug this
        lowCard : findLowestCard(player.hand).value,
        highCard : findHighestCard(player.hand).value,
        choices: player.choices, // TODO adjust this for swing betting, need to send choices
        lowResult: player.choices.includes('low') ? player.lowEquationResult : null, // TODO how to send right result for each
        highResult: player.choices.includes('high') ? player.highEquationResult : null, // TODO how to send right result for each
        lowDifference: player.choices.includes('low') ? Math.abs(player.lowEquationResult - 1) : null, // adjust for swing
        highDifference: player.choices.includes('high')? Math.abs(player.highEquationResult - 20) : null, // adjust for swing
        isHiWinner: swingBetterWon ? player.id === hiWinnerIncludingSwingBetters?.id : player.id === hiWinner?.id, // what if swing one the hi but not the low
        isLoWinner: swingBetterWon ? player.id === loWinnerIncludingSwingBetters?.id : player.id === loWinner?.id,
        loWinnerLowCard: swingBetterWon ? loWinnerIncludingSwingBettersLowCard?.value : loWinnerLowCard?.value,
        hiWinnerHighCard: swingBetterWon ? hiWinnerIncludingSwingBettersHighCard?.value : hiWinnerHighCard?.value,
        // this doesn't work either, because it will highlight the low or high card EVEN if there is no tie. UGH
        isLoContender: player.isLoContender,
        isHiContender: player.isHiContender
    }));

    console.log(results);
    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "round-result",
        message: message,
        loWinner: loWinner,
        hiWinner: hiWinner,
        results: results
    });
}
  
// TODO above code - test that pot splits correctly, and also if there's only one winner

function printDeck(deck, rows = 10) {
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
    let deck = [];

    // TODO bug? should be 5?
    for (let i = 0; i < 4; i++) {
        deck.push(new Card(OperatorCards.MULTIPLY, Suits.OPERATOR));
        deck.push(new Card(OperatorCards.ROOT, Suits.OPERATOR));
    }
    
    // One of each of numbers 0-10 of each of 4 suits.
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

function logRoomsAndPlayers() {
    console.log("=== Current Rooms & Players ===");

    // build a roomCode → [userId] map
    const grouped = new Map();
    for (const [userId, player] of players.entries()) {
        const roomCode = player.roomCode;
        if (!grouped.has(roomCode)) {
            grouped.set(roomCode, []);
        }
        grouped.get(roomCode).push(player);
    }

    // pretty print
    for (const [roomCode, players] of grouped.entries()) {
        console.log(`Room ${roomCode}:`);
        for (const player of players) {
            console.log(`  - ${player.id} - ${player.username} `);
        }
    }

    console.log("================================");
}

const heartbeatInterval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();  // Browser auto-responds with pong
    });
}, 30000);

const roomCleanupInterval = setInterval(function ping() {
    games.forEach(function each(game) {
        if (Date.now() - game.createdAt > 24 * 60 * 60 * 1000) {
            games.delete(game.id);
        }
    });
}, 24 * 60 * 60 * 1000);

wss.on('close', function close() {
    clearInterval(heartbeatInterval);
    clearInterval(roomCleanupInterval);
});