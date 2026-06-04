import { OperatorCard, Suit, NumberCard } from './enums.js';
import { printDeck, printHand, logRoomsAndPlayers } from './debug/print.js';
import { generateDeck, drawNumberCardFromDeck, drawFromDeck } from './game/deck.js';
import { findNextKeyWithWrap, removeWhitespace } from './public/utilities.js';
import {
    games, players, emojis, RATE_LIMIT, INTERVAL, EQUATION_DURATION,
    ExtendedWebSocket, ClientMessage, ServerMessage,
    Game, Player, Card, GamePhase,
    CreateMessage, EnterMessage, JoinMessage, StartMessage, RefreshMessage,
    DiscardMessage, FoldMessage, HandOrderMessage, LockInMessage,
    HiLoSelectedMessage, BetMessage, AcknowledgeHandResultsMessage, LeaveMessage,
    setWss,
} from './state.js';
import {
    sendSocketMessageToEveryClientInRoom,
    sendSocketMessageToNonFoldedPlayers,
    sendSocketMessageToNonFoldedAndNotOutPlayers,
    sendSocketMessageToFoldedOrOutPlayers,
} from './ws/broadcast.js';
import {
    getHandToSendFromHand,
    sendSocketMessageThatPlayerFolded,
    notifyPlayerOfNewlyDealtCards,
    notifyAllPlayersOfNewlyDealtCards,
} from './game/notify.js';
import {
    playersInRoom,
    playersInRoomEntries,
    activePlayersInRoom,
    nonFoldedAndNotOutPlayers,
} from './game/rooms.js';
import {
    playersThatNeedToDiscard,
    dealOperatorCards,
    dealFirstHiddenCardToEachPlayer,
    dealTwoOpenCardsToEachPlayer,
    dealLastOpenCardToEachPlayer,
} from './game/deal.js';
import express from "express";
import http from "http";
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from "uuid";
import dotenv from 'dotenv';
dotenv.config();

const app = express();

app.use((req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.originalUrl} took ${duration}ms`);
    });

    next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
setWss(wss);

app.use(express.static("public"));


server.on("upgrade", (req, socket, head) => {
    console.log("### UPGRADE RECEIVED ###");
    console.log(req.headers);
});

wss.on("connection", (ws: ExtendedWebSocket) => { // LEARN pass in extended
    // keep alive, in the case of 90 seconds equation forming
    ws.isAlive = true;
    ws.on('pong', () => {ws.isAlive = true;});

    console.log("=== CONNECTION ===");
    // only our domain can upgrade from http to ws
    // const origin = req.headers.origin;
    // if (!allowedOrigins.includes(origin)) {
    //     console.log("Blocked unauthorized origin: ", origin);
    //     ws.close();
    //     return;
    // }
    ws.msgCount = 0;
    setInterval(() => ws.msgCount = 0, INTERVAL);


    // const userColor = `hsl(${Math.random() * 360}, 100%, 70%)`; // same here
    const userId = uuidv4();
    ws.userId = userId; // in the case of rejoin or room code, this will be overwritten later
    ws.send(JSON.stringify({ type: "init", id: userId/*, color: userColor/*, hostId: hostId */ }));
    
    console.log(`Socket connected, generating userId ${userId} but it may not be used in the case that someone is rejoining, in which case the existing client userId will overwrite this.`);

    ws.on("message", (message: unknown) => {
        if (++ws.msgCount > RATE_LIMIT) {
            console.log("went over rate limit");
            ws.close();
            return;
        }
        let clientMsg : ClientMessage;

        try {
            clientMsg = JSON.parse(message as string);
        } catch { return; }

        if (!clientMsg || typeof clientMsg !== "object" || !("type" in clientMsg)) return;

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
                console.log(games);
                game.currentTurnPlayerId = game.hostId = ws.userId; // no, right? TODO remove concept of hostId?? or add host promotion

                enterRoom(game, clientMsg, ws);
                console.log(game);
                break;
            }
            
            case "enter": { // TODO change to enter, and then just check if game is in lobby phase and if player already exists
                const game = games.get(clientMsg.roomCode);

                if (!game) {
                    // send room code does not exist message
                    ws.send(JSON.stringify({ type: "room-join-reject" }));

                    return;
                }

                enterRoom(game, clientMsg, ws);
                break;
            }

            case "refresh": { 
                ws.userId = clientMsg.userId; // should actually be the same
                // what about set ws.userId equal to it
                const player = players.get(clientMsg.userId);
                if (!player) return;
                
                ws.send(JSON.stringify({ type: "suggest-room", roomCode: player.roomCode })); // TODO client will say must be players 2 even if the reject reason is client not being host
                
                break;
            }

            case "discard": {
                const player = players.get(clientMsg.userId);
                if (!player) return;
                const game = games.get(player.roomCode);
                if (!game) return;

                if (game.phase !== GamePhase.FIRSTDEAL && game.phase !== GamePhase.SECONDDEAL) return;
                if (!player.needToDiscard) return;

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-discarded",
                    id: clientMsg.userId,
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
                    if (game.phase === GamePhase.SECONDDEAL) {
                        commenceEquationForming(game);
                    } else if (game.phase === GamePhase.FIRSTDEAL) {
                        commenceFirstRoundBetting(game); 
                    }
                    // would break if someone leaves. in that case reduce num players that need to discard by 1?
                }
                break;
            }
        
            case "start": {
                const player = players.get(ws.userId);

                if (player?.roomCode == null) {
                    ws.send(JSON.stringify({ type: "reject-start" })); // TODO client will say must be players 2 even if the reject reason is client not being host
                    return;
                }

                const game = games.get(player.roomCode); // commit message: fixed this

                if (game == null || clientMsg.userId !== game.hostId || players.size < 2) {
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
                const player = players.get(clientMsg.userId);
                if (!player) return;
                const game = games.get(player.roomCode);
                if (!game) return;

                if (clientMsg.userId === game.hostId) {
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

                if (player === null || player === undefined) {
                    return;
                }

                if (player.username != null) {
                    // this player already submitted their username, so this must be a duplicate message
                    return;
                }

                player.username = player.emoji + " " + removeWhitespace(clientMsg.username);
                const game = games.get(player.roomCode);
                if (game == null) {
                    // must be incorrect room code
                    return;
                }

                console.log(`***** 👩‍💻 ${game.hostId === ws.userId ? 'Host' : 'Player'} joined: ${clientMsg.username} *****`);

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-joined",
                    id: clientMsg.userId,
                    hostId: game.hostId!,// client.userId === hostId, // this is wrong because it means the host will show everyone joining as host
                    color: player.color!,
                    username: player.username,
                });

                logRoomsAndPlayers(); // this will be outside game class
                break;
            }

            // tests
            // two players call and third player folds
            // one player calls and two players fold = distribute pot to first player and end round
            case "bet-placed": {
                const justPlayedPlayer = players.get(clientMsg.userId);
                if (!justPlayedPlayer) return;

                const game = games.get(justPlayedPlayer.roomCode);
                if (!game) return;

                if (clientMsg.userId !== game.currentTurnPlayerId) return;

                if (typeof clientMsg.betAmount !== 'number' || !isFinite(clientMsg.betAmount)
                    || clientMsg.betAmount < 0 || clientMsg.betAmount > justPlayedPlayer.chipCount) return;

                justPlayedPlayer.turnTakenThisRound = true;
                justPlayedPlayer.stake += clientMsg.betAmount;
                justPlayedPlayer.contribution += clientMsg.betAmount;
                justPlayedPlayer.chipCount -= clientMsg.betAmount;

                const betType = justPlayedPlayer.betAmount === 0 ? "check" :
                                game.phase === GamePhase.FIRSTBETTING && justPlayedPlayer.betAmount === 1 ? "ante" : // TODO implement proper ante
                                game.toCall === justPlayedPlayer.stake ? "check" :
                                justPlayedPlayer.stake - game.toCall >= 10 ? "raise10" :
                                "raise";

                game.toCall = Math.max(justPlayedPlayer.stake, game.toCall); // TODO rename game.toCall... it's not really toCall. it's the current stake of the game. toCall is the different between that and player.stake
                game.pot += clientMsg.betAmount;

                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "bet-placed",
                    id: clientMsg.userId,
                    username: justPlayedPlayer.username!,
                    betAmount: clientMsg.betAmount, // so users can see "so and so bet x chips"
                    chipCount: justPlayedPlayer.chipCount, // to update the chip stack visual of player x for each player
                    pot: game.pot, // otherwise, pot won't get updated on last player of the round
                    betType: betType
                });
                endRoundOrProceedToNextPlayer(game, justPlayedPlayer);
                break;
            }
            // TODO more tests - have a folded player submit an equation anyway and confirm it's discarded by server.
            case "hand-order": {
                // definitely DON'T want to tell everyone what the results are yet
                const player = players.get(clientMsg.userId);
                if (!player) return;
                const game = games.get(player.roomCode);
                if (!game) return;

                if (game.phase !== GamePhase.EQUATIONFORMING) {
                    return;
                }

                const order: unknown[] = clientMsg.order;
                if (!Array.isArray(order) || order.length !== player.hand.length) return;
                const seen = new Set<number>();
                for (const i of order) {
                    const idx = Number(i);
                    if (!Number.isInteger(idx) || idx < 0 || idx >= player.hand.length || seen.has(idx)) return;
                    seen.add(idx);
                }
                player.hand = order.map(i => player.hand[Number(i)]!);
                
                // let everyone else know I've moved my cards, so they can see the order.
                wss.clients.forEach((c) => {
                    const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
                    let handToSend = getHandToSendFromHand(player.hand, client.userId === clientMsg.userId);
                    
                    if (/*client !== ws && */client.readyState === WebSocket.OPEN && player.roomCode === player.roomCode) { //some kind of clientsInRoom function
                        client.send(JSON.stringify({
                            type: "player-reordered-hand",
                            id: clientMsg.userId,
                            color: player.color!,
                            username: player.username,
                            chipCount: player.chipCount,
                            hand: handToSend
                        }));
                    }
                })
                break;
            }

            case "lock-in": {
                const player = players.get(clientMsg.userId);
                if (!player) return;
                const game = games.get(player.roomCode);
                if (!game) return;

                if (game.phase !== GamePhase.EQUATIONFORMING) {
                    return;
                }

                player.isLockedIn = true;

                // TODO send this. Also need to send it for every locked in player to a rejoining player
                // wss.clients.forEach((c) => {
                //     const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
                //     let handToSend = getHandToSendFromHand(player.hand, client.userId === clientMsg.userId);
                    
                //     if (client.userId !== player.id && client.readyState === WebSocket.OPEN && player.roomCode === player.roomCode) { //some kind of clientsInRoom function
                //         client.send(JSON.stringify({
                //             type: "player-locked-in",
                //             id: clientMsg.userId,
                //             color: player.color!,
                //             username: player.username,
                //             chipCount: player.chipCount,
                //             hand: handToSend
                //         }));
                //     }
                // })

                if (nonFoldedAndNotOutPlayers(game).every(player => player.isLockedIn === true)) {
                    endEquationForming(game); 
                    clearTimeout(game.endEquationFormingTimeout);

                    // checkIfOneRemainingPlayerOrMaxRaiseReachedOrProceedToSecondRoundBetting(game);
                }
                break;
            }

            case "fold": {
                const foldedPlayer = players.get(ws.userId); // use ws.userId because we can't trust client to provide the id
                if (!foldedPlayer) return;
                const game = games.get(foldedPlayer.roomCode); // remove when going to OOP?
                if (!game) return;
                    // can only fold in these 3 phases
                    if (game.phase !== GamePhase.FIRSTBETTING && game.phase !== GamePhase.SECONDBETTING && game.phase !== GamePhase.EQUATIONFORMING) {
                    return;
                }

                fold(foldedPlayer, clientMsg.manual, game);
                break;
            }

            // TODO (putting this in random place so I see it later) - test every number of automatically folded players during equation forming
            case "hi-lo-selected": {
                console.log(clientMsg.userId, clientMsg.username, clientMsg.choices, clientMsg.otherEquationResult, clientMsg.order);
                const player = players.get(ws.userId);
                if (!player || player.equationResult == null) return;
                const game = games.get(player.roomCode);
                if (!game || game.phase !== GamePhase.HILOSELECTION) return;

                const choices: unknown[] = clientMsg.choices;
                if (!Array.isArray(choices) || choices.length === 0) return;
                if (!choices.every(c => c === 'low' || c === 'high')) return;
                player.choices = choices as string[];

                if (player.choices.includes("low") && !player.choices.includes("high")) {
                    player.lowHand = player.hand;
                    player.lowEquationResult = player.equationResult;
                } else if (player.choices.includes("high") && !player.choices.includes("low")) {
                    player.highHand = player.hand;
                    player.highEquationResult = player.equationResult;
                } else if (player.choices.includes("low") && player.choices.includes("high")) {
                    if (!clientMsg.order) {
                        console.log("swing betting requires a second card order");
                        return;
                    }

                    const swingOrder: unknown[] = clientMsg.order;
                    if (!Array.isArray(swingOrder) || swingOrder.length !== player.hand.length) return;
                    const swingSeen = new Set<number>();
                    for (const i of swingOrder) {
                        if (typeof i !== 'number' || i < 0 || i >= player.hand.length || swingSeen.has(i)) return;
                        swingSeen.add(i);
                    }
                    player.otherHand = swingOrder.map(i => player.hand[Number(i)]!);

                    try {
                        player.otherEquationResult = applyOps(player.otherHand);
                    } catch {
                        return;
                    }
                    if (!isFinite(player.otherEquationResult!)) return;

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
                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-selected-hilo",
                    id: player.id,
                });

                if (nonFoldedAndNotOutPlayers(game).every(player => player.choices.length > 0)) {
                    game.phase = GamePhase.RESULTVIEWING;

                    console.log('everyone submitted their hi or lo selections');
                    revealHiddenCards(game);
                    determineWinners(game);
                }
                break;
            }

            // need this so that players have time to view results
            case "acknowledge-hand-results": {
                const player = players.get(ws.userId);
                if (!player) return;
                const game = games.get(player.roomCode);
                if (!game) return;
                
                if (game.phase !== GamePhase.RESULTVIEWING) {
                    return;
                }

                player.acknowledgedResults = true;

                // should probably rename to NonEliminatedPlayers. because it looks like it doesn't include folded players here but it does
                if (activePlayersInRoom(game.roomCode).every(player => player.acknowledgedResults === true)) { // change to accept just game, and then move to class based game
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

    ws.on("close", (code, reason) => {
        console.log(`[WS] close code: ${code}`);
        console.log(`[WS] reason: ${reason.toString()}`);
    });
});

server.listen(8080, "0.0.0.0", () => {
  console.log("Server running on port 8080");
});

function enterRoom(game: Game, clientMsg: CreateMessage | EnterMessage, ws: ExtendedWebSocket) { // TODO  this union is bad

    if (game.phase === GamePhase.LOBBY) {
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

        const player = players.get(clientMsg.userId);

        console.log(player);
        if (player && player.roomCode === game.roomCode) {
            // TODO how to change the flow so we don't have to trust this
            ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: player.username !== null }));

            if (player.roomCode === game.roomCode){
                ws.userId = clientMsg.userId;

                logRoomsAndPlayers();
            } else {

            }
        } else {
            // more test cases - a player in an existing game can change autofilled room code
            // to join a different game, thus overwriting and leaving that game

            // either there's no player, or a player for a different game and we are joining a new one
            // so overwrite it
            console.log("creating userId but no username yet"); // is this message still right?
            // if (ws.isHost) { // without this, later players joining become the host
            //     currentTurnPlayerId = clientMsg.userId; // TODO surely we can set this later? as just the first player in players list?
            //     hostId = clientMsg.userId; // just use ws.userId here?
            // }

            console.log(`***** 👩‍💻 ${game.hostId === clientMsg.userId ? 'Host' : 'Player'} joined: ${clientMsg.userId} *****`);

            // TODO THIS for rejoining active rooms
            // have to reassign userId because what if someone refreshes? have to ignore the init message // TODO rethink this in the context of join/ enter
            // need to assign ws.userId because it's used to check clientId === id on server
            ws.userId = clientMsg.userId; // TODO need this??
            
            let color;
            let emoji;
            // assign color and emoji to player
            while (true) {
                const index = Math.floor(Math.random() * 12);
                if (game.usedColors.has(index)) {
                    continue;
                } else {
                    color = `hsl(${index * 30}, 100%, 70%)`;
                    emoji = emojis[index];
                    game.usedColors.add(index);
                    break;
                }
            }

            players.set(clientMsg.userId, new Player(clientMsg.userId, game.roomCode, color)); // TODO sanitize clientMsg.username to standards
            players.get(clientMsg.userId)!.emoji = emoji;
            ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: false, color: color }));

            console.log([...players].filter(([id, player]) => player.roomCode === game.roomCode));
            
            logRoomsAndPlayers();
        }
    } else { // gamephase is not lobby
        // TODO what makes this a "rejoin"? I should have that word, that's what I expected.
        ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: true, inProgress: true }));

        const rejoiningPlayer = players.get(ws.userId); // can use ws if not gamephase bc must be true
        if (!rejoiningPlayer) return;

        // send game state
        switch (game.phase) {
            case GamePhase.FIRSTDEAL:
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, player.needToDiscard);
                });
                break;
            case GamePhase.FIRSTBETTING:
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, false);
                });
                // test cases
                // one player needs to discard. refreshes, still needs to discard
                // one players has discarded. refreshes, still does not need to
                // one player needs to discard. different player refreshes, they still see player X discarding
                // two players need to discard. One discards, each refresh and still see correct state

                // player is betting when toCall > 0. refreshes, still sees correct toCall
                // player is betting when toCall > 0 and their stake > 0. and sees correct

                // actually don't need the commented code... bc for players whose turn it isn't,
                // it'll just say "player X is betting" so they'll have context on whose turn it is
                // TODO rename advance to NotifyItIsPlayersTurn (because it might not actually be advancing)
                // TODO Also if I refresh when toCall was the ante 1, it is now 0. so just implement ante right
                // if (rejoiningPlayer.id === game.currentTurnPlayerId) {
                    // TODO need to notify a player if they are betting or not here
                    advanceToNextPlayersTurn(game, game.toCall - rejoiningPlayer.stake);
                // }
                break;
            case GamePhase.SECONDDEAL:
                // TODO need to send the pot here as well

                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, player.needToDiscard);
                });
                // this happens instantaneously unless there is a discard...
                break;
            case GamePhase.EQUATIONFORMING:
                // need to send whether they've locked, and their card order. and the time left
                // and everyone else's card order. 
                // TODO players might start refreshing to get the fresh card order, so have it live
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, false);
                });
                // TODO need to send roomCode as well, it gets lost
                console.log(getSecondsLeft(game))
                ws.send(JSON.stringify({ 
                    type: "commence-equation-forming", 
                    cannotFormEquation: rejoiningPlayer.equationResult != null, 
                    remainingSeconds: getSecondsLeft(game),
                    pot: game.pot
                }));
                break;
            case GamePhase.SECONDBETTING:
                // TODO REALLY need to send the pot here as well
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, false);
                });
                advanceToNextPlayersTurn(game, game.toCall - rejoiningPlayer.stake);
                break;
            case GamePhase.HILOSELECTION:
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, false);
                });

                ws.send(JSON.stringify({
                    type: "hi-lo-selection-commenced",
                    pendingPlayerIds: nonFoldedAndNotOutPlayers(game)
                        .filter(p => p.choices.length === 0)
                        .map(p => p.id),
                }));

                if (rejoiningPlayer.choices.length === 0) {
                    ws.send(JSON.stringify({ type: "hi-lo-selection" }));
                }
                break;
            case GamePhase.RESULTVIEWING:
                // TODO rewrite index.html to only use msg.results, not hiWinner or loWinner
                /* 
                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "round-result",
                    message: message!,
                    loWinner: loWinner,
                    hiWinner: hiWinner,
                    results: results
                });
                */
                playersInRoom(game.roomCode).forEach(player => {
                    notifyPlayerOfNewlyDealtCards(player, rejoiningPlayer, false);
                });

                ws.send(JSON.stringify({ 
                    type: "round-result",
                    results: game.results
                }));
                break;
        }
    }
        console.log("made it to sending game state");
}

function fold(foldedPlayer: Player, manual: Boolean, game: Game) {           
    foldedPlayer.foldedThisTurn = true;
    foldedPlayer.hand.forEach(card => {
        card.hidden = true;
    });

    sendSocketMessageThatPlayerFolded(foldedPlayer.roomCode, foldedPlayer.id);
    
    // two cases to check:

    // player manually folded in first betting round, and there's only one player left, go ahead and distribute pot
    if (manual === true || 
        // if we've received equation result socket messages from every player, we can proceed to second round of betting.
        // this check must be inside the parent if loop, otherwise we may have a case where no one submitted an equation,
        // so whichever client is last to have its message received actually takes the whole pot
        nonFoldedAndNotOutPlayers(game).every(player => player.equationResult != null)) 
    {
        // TODO I think this if statement only can be moved outside the parent if. No way to race condition to 0
        if (nonFoldedAndNotOutPlayers(game).length === 0){
            returnChipsToAllPlayers(game);
            return;
        }

        if (nonFoldedAndNotOutPlayers(game).length === 1){
            const onlyRemainingPlayer = nonFoldedAndNotOutPlayers(game)[0];
            if (!onlyRemainingPlayer) return;

            distributePotToOnlyRemainingPlayer(game, onlyRemainingPlayer);
            return;
        }

        // more tests
        // everyone but one submits equations early, last person is invalid and folds. make sure betting controls still shown
        // one person submits early, one person submits valid with ending tiemout, and one person folds
        // one person submits early, 2 people fold
        // all people fold

        /* TODO this is repeated */

        // this is the case that everyone force submitted equations except one person,
        // so they folded on equation submission
        // we have to wrap in a check for gamephase.equationforming because, if two people go all in in 1st round betting, and one folds,
        // without this check, we'd proceed to hi lo selection before going to equation forming

        // I feel like there could be a bug here. Let's say everyone submits there equations early.
        // so we are hitting this code, and about to progress to hiloselection
        // but if the interval runs out in that time in between, we send end equation socket message
        // and everyone will resend equation results.
        if (game.phase === GamePhase.EQUATIONFORMING) {
            if (game.maxRaiseReached) {
                console.log('Max bet was reached on first round of betting. Skipping second round.');

                sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-skipped" });

                commenceHiLoSelection(game);
            } else {
                console.log('All equations received. Proceeding to second round of betting.');

                commenceSecondRoundBetting(game);
            }
        }
    }

    if (manual === true) { // TODO unreadable (looks like same condition above but it's not)
        endRoundOrProceedToNextPlayer(game, foldedPlayer);
    }
}

function endRoundOrProceedToNextPlayer(game: Game, justPlayedPlayer: Player) {
    if (bettingRoundIsComplete(game)) {
        endBettingRound(game);

        if (game.phase === GamePhase.SECONDBETTING) {
            commenceHiLoSelection(game);
        } else if (game.phase === GamePhase.FIRSTBETTING) {
            dealLastOpenCardToEachPlayer(game);

            // possible that players receive multiply cards on last deal
            // so don't commence equation forming unless all discards are complete
            if (playersThatNeedToDiscard(game.roomCode).length === 0) {
                commenceEquationForming(game);
            }
        }
    } else { 
        // TODO what if they are out? they will have 0 chips in that case as well
        if (justPlayedPlayer.chipCount === 0) {
            // if anyone is 0, it means someone is all in and no one can bet anymore
            game.maxRaiseReached = true;
        }
        game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO make this a method of class game
        if (!game.currentTurnPlayerId) throw new Error;

        const currentTurnPlayer = players.get(game.currentTurnPlayerId);
        if (!currentTurnPlayer) throw new Error;

        console.log(currentTurnPlayer.username);
        // subtract player's stake.
        // if someone bets 10, then next raises 4, we can toCall to be 4, NOT 14
        // it would also allow betting more chips than a player has
        advanceToNextPlayersTurn(game, game.toCall - currentTurnPlayer.stake); // TODO refactor, this is just bad
    }
}

function clearHands(roomCode: string, playersInThisRoom: Player[]) {
    playersInThisRoom.forEach(player => { // change players in room to be just the values. then modify logic everywhere
        player.hand = [];

        notifyAllPlayersOfNewlyDealtCards(roomCode, player);
    })
}

function endHand(game: Game) {
    console.log("endHand");
    playersInRoom(game.roomCode).forEach(player => { console.log(player.username, "chipCount:", player.chipCount); });

    clearTimeout(game.endEquationFormingTimeout);
    clearHands(game.roomCode, playersInRoom(game.roomCode));
    game.maxRaiseReached = false;
    game.handNumber += 1;
    game.results = [];

    playersInRoom(game.roomCode).forEach(player => { // refactor to this.players() which is a function
        if (player.chipCount === 0) {
            sendSocketMessageToEveryClientInRoom(game.roomCode, {
                type: "kicked",
                userId: player.id,
                color: player.color!,
                username: player.username!,
                hand: player.hand,
                chipCount: 0
            });

            player.out = true;
        }

        player.foldedThisTurn = false;
        player.equationResult = null;
        player.isLockedIn = false;
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

function initializeHand(game: Game) { // means start a hand of play
    console.log("Initializing hand.");

    playersInRoom(game.roomCode).forEach(player => {
        if (player.out) { // fold automatically if out
            // player.foldedThisTurn = true;
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
    
    game.phase = GamePhase.FIRSTDEAL;
    // or would it be better to have one method, which determines players and active inside?
    dealOperatorCards(game.roomCode, activePlayersInRoom(game.roomCode));

    /*
    //TODO maybe don't need this?
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
        const playerToSendMessage = players.get(client.userId);
        if (!playerToSendMessage) return;
        if (client.readyState === WebSocket.OPEN && playerToSendMessage.roomCode === game.roomCode) {
            const payload = JSON.stringify({ 
                type: "deal",
                color: players.get(client.userId)!.color!,
                // something to do with client.userId not equaling anyone's userId
                chipCount: playerToSendMessage.chipCount, 
                id: client.userId, 
                hand: playerToSendMessage.hand 
            });
            client.send(payload);
        }
    });
    */

    dealFirstHiddenCardToEachPlayer(game, activePlayersInRoom(game.roomCode)); 

    dealTwoOpenCardsToEachPlayer(game, activePlayersInRoom(game.roomCode));

    console.log("numPlayersToDiscard: ", playersThatNeedToDiscard(game.roomCode).length) // refactor to one variable

    // upon reading, thought this should be numPlayersThatNeedToDiscard === numPlayersThatHaveDiscarded
    // it could be
    // but anyway, this shows we can commence right away if no multiplies were dealt
    // the other condition is that there WERE people who need to discard, and that is checked elsewhere
    //      so there are two calls to commenceFirstRoundBetting();

    if (playersThatNeedToDiscard(game.roomCode).length === 0) { // no multiply cards were dealt
        commenceFirstRoundBetting(game);
    }
}


function endBettingRound(game: Game) {
    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "end-betting-round", round: game.phase });

    game.toCall = 0;

    for (const player of playersInRoom(game.roomCode)) {
        player.turnTakenThisRound = false;
        player.stake = 0;
    }
}

function commenceFirstRoundBetting(game: Game) {
    console.log("Commencing first round of betting");

    game.phase = GamePhase.FIRSTBETTING;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "first-round-betting-commenced",
    });

    const currentPlayer = players.get(game.currentTurnPlayerId!);
    if (!currentPlayer || currentPlayer.out || currentPlayer.foldedThisTurn) {
        game.currentTurnPlayerId = findNextPlayerTurn(game);
    }
    advanceToNextPlayersTurn(game, 1); // TODO change to anteAmount (and then modify as game goes on)
}

function commenceSecondRoundBetting(game: Game) {
    game.phase = GamePhase.SECONDBETTING;

    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-commenced" });

    // put findNextPlayerTurn inside advanceToNextPlayersTurn
    // i think I want to just continue in round robin.
    // We can change this implementation later to always follow left of the dealer
    game.currentTurnPlayerId = findNextPlayerTurn(game); // TODO we should be passing player id into advanceToNextPlayersTurn
    advanceToNextPlayersTurn(game, 0); // no ante to match on the second round
}

function advanceToNextPlayersTurn(game: Game, toCall: number) { // should take a parameter here
    console.log("Advancing to next player's turn, with id:", game.currentTurnPlayerId);
    // Player A bets 10 and then has 20 chips. Player B has 30 chips. Max bet is still 30, not 20. 
    // So add the 10 and 20 to get 30. (Add chips PLUS the chips they have in this round)
    const nonFoldedPlayerChipCounts = nonFoldedAndNotOutPlayers(game).map(player => player.chipCount + player.stake);
        // if I raised 9 when I ahd 15, so i have 6 left. This will make the max Bet 15, when it should be 6
        // but in the other scenario, if I don't add the player stakes, the next 15 player will think max bet is 6 when it should be 15
    const maxStake = Math.min(...nonFoldedPlayerChipCounts);
    
    // modify this so that we don't trust the client?
    // but technically we do because only currentTurnPlayer can send a betting message.
    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
        if (/*client !== ws && */client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === game.roomCode) { // TODO refactor to room.clients.forEach
            // something like game.player.forEach ({ wss.clients[player.userId]. send whatever}
          client.send(JSON.stringify({
            type: "next-turn",
            toCall: toCall, // change to game.toCall and remove second parameter to this method
            maxBet: maxStake - players.get(game.currentTurnPlayerId!)!.stake, // need to resubtract player stake here I think
            currentTurnPlayerId: game.currentTurnPlayerId,
            username: players.get(game.currentTurnPlayerId!)!.username,
            playerChipCount: players.get(client.userId)!.chipCount
            // pot: pot
          }));
        }
        });
}

function findNextPlayerTurn(game: Game): string {
    return findNextKeyWithWrap<Player>(playersInRoomEntries(game.roomCode), 
        game.currentTurnPlayerId!, v => v.foldedThisTurn !== true && v.out !== true);
}

function bettingRoundIsComplete(game: Game) {
    const playerBetAmounts = nonFoldedAndNotOutPlayers(game).map(player => player.stake);
    const setOfBets = new Set(playerBetAmounts);
    // bets are all equal AND active players have all bet at least once, then betting round is complete
    if (setOfBets.size === 1 && nonFoldedAndNotOutPlayers(game).every(player => player.turnTakenThisRound === true)){ 
        return true;
    }

    return false;
}

function commenceEquationForming(game: Game) {
    console.log("Waiting 90 seconds for equation forming...");

    game.phase = GamePhase.EQUATIONFORMING;
    // actually this doesn't even matter. the client could still cheat say they aren't folded, so
    // just let the client decide if they are folded or not in the first place.
    sendSocketMessageToNonFoldedAndNotOutPlayers(game, { type: "commence-equation-forming" });
    sendSocketMessageToFoldedOrOutPlayers(game, { type: "commence-equation-forming", cannotFormEquation: true });

    game.equationEndTime = Date.now() + EQUATION_DURATION;

    game.endEquationFormingTimeout = setTimeout(() => {
        endEquationForming(game);
    }, EQUATION_DURATION);
}

function endEquationForming(game: Game) {
    nonFoldedAndNotOutPlayers(game).forEach(player => {
        try {
            player.equationResult = applyOps(player.hand);

            if (!isFinite(player.equationResult)) {
                console.log("Non-finite equation result for player " + player.id + ": " + player.equationResult);
                fold(player, false, game);
                return;
            }

            console.log("final order received and equationResult calculated " + player.equationResult);
        } catch (e) {
            console.log("Malformed equation for player " + player.id);
            fold(player, false, game);
        }
    });

    sendSocketMessageToEveryClientInRoom(game.roomCode, { // NEED to change this to game
        type: "end-equation-forming"
    });

    checkIfOneRemainingPlayerOrMaxRaiseReachedOrProceedToSecondRoundBetting(game);
}

function checkIfOneRemainingPlayerOrMaxRaiseReachedOrProceedToSecondRoundBetting(game: Game) {
    if (nonFoldedAndNotOutPlayers(game).length === 1){
        const onlyRemainingPlayer = nonFoldedAndNotOutPlayers(game)[0];
        if (!onlyRemainingPlayer) return;

        distributePotToOnlyRemainingPlayer(game, onlyRemainingPlayer);
        return;
    }

    if (game.maxRaiseReached) {
        console.log('Max bet was reached on first round of betting. Skipping second round.');

        sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "second-round-betting-skipped" });

        commenceHiLoSelection(game);
    } else {
        console.log('All equations received. Proceeding to second round of betting.');

        commenceSecondRoundBetting(game);
    }
}

function getSecondsLeft(game: Game) {
    const msLeft = game.equationEndTime - Date.now();
    return Math.max(0, Math.ceil(msLeft / 1000));
}

function commenceHiLoSelection(game: Game) {
    game.phase = GamePhase.HILOSELECTION;

    const pendingPlayerIds = nonFoldedAndNotOutPlayers(game).map(p => p.id);
    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "hi-lo-selection-commenced",
        pendingPlayerIds,
    });

    sendSocketMessageToNonFoldedAndNotOutPlayers(game, {
        type: "hi-lo-selection",
    });
}

function returnChipsToAllPlayers(game: Game){
    console.log("No players formed a valid equation. Returning chips and starting new hand.");

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
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

function distributePotToOnlyRemainingPlayer(game: Game, onlyRemainingPlayerThisHand: Player){
    // end turn
    console.log("All but one player folded this hand. Ending hand.");

    wss.clients.forEach((c) => {
        const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
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
    playersInRoom(game.roomCode).forEach(player => {
        console.log(player.username, "chipCount:", player.chipCount);
    })

    endBettingRound(game);
    endHand(game);
}

function revealHiddenCards(game: Game) {
    // Don't reveal folded players' hidden cards

    // TODO deal is kind of a misnomer ... we are just rerendering the whole hand, not dealing cards
    // maybe name it "render hand"
    nonFoldedAndNotOutPlayers(game).forEach((player) => {
        wss.clients.forEach((c) => {
            const client = c as ExtendedWebSocket; // TODO better to have Map then I guess?
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

export function findLowestCard(hand: Card[]): Card {
    return hand.filter(card => card.suit !== Suit.OPERATOR).reduce((minCard, currentCard) => {
        if (currentCard.value! < minCard.value!) {
            return currentCard;
        }

        if (currentCard.value! == minCard.value! && currentCard.suit! < minCard.suit!) {
            return currentCard;
        }

        return minCard;
    });
}

export function findHighestCard(hand: Card[]): Card {
    return hand.filter(card => card.suit !== Suit.OPERATOR).reduce((maxCard, currentCard) => {
        if (currentCard.value! > maxCard.value!) {
            return currentCard;
        }

        if (currentCard.value! == maxCard.value! && currentCard.suit! > maxCard.suit!) {
            return currentCard;
        }

        return maxCard;
    });
}

export function findLoWinner(loBettingPlayers: Player[]): [Player | null, Card | null] {
    const loTarget = 1;
    let loWinner = null;
    let loWinnerLowCard = null;
    let winningDiff = Infinity;
    for (const player of loBettingPlayers) {
        const diff = Math.abs(player.lowEquationResult! - loTarget);
        if (diff < winningDiff) {
            winningDiff = diff;
            loWinner = player;
            // wipe out in case of second place tie. but TODO this doesn't work because what if there's a 3 way tie. this will wipe out the first
            // TODO need extra if (diff < loContenderDiff)
            // if we are in this block (diff < winningDiff) it means there's no tie. So we can clear all contenders.
            loBettingPlayers.forEach(player => player.isLoContender = false);
            loWinnerLowCard = findLowestCard(loWinner!.hand); // have this line here just so return statement doesn't break. don't really need it tho
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isLoContender = true;
            loWinner!.isLoContender = true; // loWinner! is because we can never hit this case given the diff is Infinity to start

            let playerLowCard = findLowestCard(player.hand);

            if (playerLowCard.value! < loWinnerLowCard!.value!) {
                loWinner = player;
            } else if (playerLowCard.value === loWinnerLowCard!.value) {
                if (playerLowCard.suit! < loWinnerLowCard!.suit!) {
                    loWinner = player;
                    loWinnerLowCard = findLowestCard(loWinner!.hand);
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }

    // if (!loWinner || !loWinnerLowCard) throw new Error; // TODO need to handle this error. but it's a true error

    return [loWinner, loWinnerLowCard];
}

export function findHiWinner(hiBettingPlayers: Player[]): [Player | null, Card | null]  {
    const hiTarget = 20;
    let hiWinner = null;
    let hiWinnerHighCard = null;
    let winningDiff = Infinity;
    for (const player of hiBettingPlayers) {
        const diff = Math.abs(player.highEquationResult! - hiTarget); // should not force this here. there was a bug. throw if no highEquationResult
        if (diff < winningDiff) {
            winningDiff = diff;
            hiWinner = player;
            // wipe out in case of second place tie
            hiBettingPlayers.forEach(player => player.isHiContender = false);
            hiWinnerHighCard = findHighestCard(hiWinner!.hand); // have this line here just so return statement doesn't break. don't really need it tho
        } else if (diff === winningDiff) {
            // make tied players contenders for card highlighting later
            player.isHiContender = true;
            hiWinner!.isHiContender = true;
            
            // right now, let's say two people tie for second place. we compare the highest card of each
            // but we don't really need it because then the first place ends up winning. bit of a waste
            const playerHighCard = findHighestCard(player.hand);

            if (playerHighCard.value! > hiWinnerHighCard!.value!) {
                hiWinner = player;
            } else if (playerHighCard.value === hiWinnerHighCard!.value) {
                if (playerHighCard.suit! > hiWinnerHighCard!.suit!) {
                    hiWinner = player;
                    hiWinnerHighCard = findHighestCard(hiWinner!.hand);
                } // impossible to be equal. suit+number pairs (cards) are unique
            }
        }
    }
    
    // if (!hiWinner || !hiWinnerHighCard) throw new Error;

    return [hiWinner, hiWinnerHighCard];
}

// can't we simply have hiBetWinner and loBetWinner!?
export function determineWinnersInternal(notFoldedPlayers: Player[]) { // TODO rename to just determine winners
    const swingBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('low') && player.choices.includes('high'));
    const loBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('low') && !player.choices.includes('high'));
    const hiBettingPlayers = notFoldedPlayers.filter(player => player.choices.includes('high') && !player.choices.includes('low'));
    
    let [loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard] = findLoWinner(swingBettingPlayers.concat(loBettingPlayers));
    let [hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard] = findHiWinner(swingBettingPlayers.concat(hiBettingPlayers));
    let [loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard] = findLoWinner(swingBettingPlayers);
    let [hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard] = findHiWinner(swingBettingPlayers);
    let [loWinner, loWinnerLowCard] = findLoWinner(loBettingPlayers);
    let [hiWinner, hiWinnerHighCard] = findHiWinner(hiBettingPlayers);
    const swingBetterWon = swingBettingPlayers.length > 0 && loWinnerIncludingSwingBetters?.id === loWinnerOfSwingBetters?.id && loWinnerOfSwingBetters?.id === hiWinnerIncludingSwingBetters?.id && hiWinnerIncludingSwingBetters?.id === hiWinnerOfSwingBetters?.id;
    // TODO why can't swingBetterWon just be hiWinner.id === loWinner.id?
        // the reason, what if one swing better wins the hi, but a lo only better wins lo, for example.
        // then we need to have known who was the hiWinner excluding swing betters.
    // i think this present implementation allows for two swing players to have their tie card highlighted, AND two non swing players to have their tie card highlighted.
        // TEST add this

    // what about, find hi and lo winners of all. if there are any swing betters, check if hi and lo id are equal. if not, redo hi and lo finding excluding any swing betters
        // this is flawed as well. because what if the swing betters lost by a tie. then on redo, their lo cards won't be highlighted.
        // or maybe they will. but let's say 
        // this would work for the case of oen swing better and one hi better. the hi better would win the whole pot as expected
        // TESTS: correct chip distributions for each win (probably separate this out to another method to be separate from the determineWinners tests)


    return {loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard,
        hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard,
        loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard,
        hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard,
        loWinner, loWinnerLowCard,
        hiWinner, hiWinnerHighCard,
        swingBetterWon
    }; // TODO clean up this return
}

export function determineWinners(game: Game) { // this is determineWinners and send results. need to decouple
    // TODO change to player.choice = "swing"
    const {loWinnerIncludingSwingBetters, loWinnerIncludingSwingBettersLowCard,
        hiWinnerIncludingSwingBetters, hiWinnerIncludingSwingBettersHighCard,
        loWinnerOfSwingBetters, loWinnerOfSwingBettersLowCard, // TODO why are these not used
        hiWinnerOfSwingBetters, hiWinnerOfSwingBettersHighCard,
        loWinner, loWinnerLowCard,
        hiWinner, hiWinnerHighCard,
        swingBetterWon} = determineWinnersInternal(nonFoldedAndNotOutPlayers(game));
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

    // equationResult > high card > high suit //TODO BREAK UP THE FUNCTION LIKE THIS
    // TODO findLowestCard(reversedCards) something like this

    let hiWinnerChipsDelta: number;
    let loWinnerChipsDelta: number;
    let message;

    // what if there were no swing betters at all

    // TODO what if everyone swing bets but not one wins both... do chips just get returned?
    // what about just find winnerAmongSwingBetters
    // what if someone bets swing and others bet only low. then hiWinner is null
    if (swingBetterWon) { // TODO rename loSwingWinner...
        loWinnerOfSwingBetters!.chipCount += game.pot; // TODO refactor to have control flow. "If swing better won, etc"
        hiWinnerChipsDelta = loWinnerChipsDelta = game.pot;
        message = loWinnerOfSwingBetters!.username + " won the swing bet.";
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
            hiWinner!.chipCount += splitPot;
            loWinner.chipCount += splitPot;

            message = hiWinner.username + " won the high bet and " + loWinner.username + " won the low bet.";
        } else if (loWinner !== null) {
            loWinner.chipCount += game.pot;
            loWinnerChipsDelta = game.pot;

            message = loWinner.username + " won the low bet.";
        } else if (hiWinner !== null) {
            hiWinner.chipCount += game.pot;
            hiWinnerChipsDelta = game.pot;

            message = hiWinner.username + " won the high bet.";
        }
    }

    game.pot = 0; // TODO put this inside of endHand??

    // should I have game.results variable? probably easiest...
    // need to set it to undefined in endHand
    let results = [...playersInRoom(game.roomCode).values()].map(player => { 
        if (player.out === true || player.foldedThisTurn === true) {
            return ({
                id: player.id,
                color: player.color,
                chipCount: player.chipCount,
                folded: player.foldedThisTurn,
                out: player.out
            });
        } else return ({
            id: player.id,
            color: player.color,
            chipCount: player.chipCount,
            chipDifferential: swingBetterWon ? player.id === loWinnerOfSwingBetters?.id ? loWinnerChipsDelta : 0 :
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
            lowDifference: player.choices.includes('low') && player.lowEquationResult ? Math.abs(player.lowEquationResult - 1) : null, // adjust for swing
            highDifference: player.choices.includes('high') && player.highEquationResult ? Math.abs(player.highEquationResult - 20) : null, // adjust for swing
            isHiWinner: swingBetterWon ? player.id === hiWinnerIncludingSwingBetters?.id : player.id === hiWinner?.id, // what if swing one the hi but not the low
            isLoWinner: swingBetterWon ? player.id === loWinnerIncludingSwingBetters?.id : player.id === loWinner?.id,
            loWinnerLowCard: swingBetterWon ? loWinnerIncludingSwingBettersLowCard?.value : loWinnerLowCard?.value,
            hiWinnerHighCard: swingBetterWon ? hiWinnerIncludingSwingBettersHighCard?.value : hiWinnerHighCard?.value,
            // this doesn't work either, because it will highlight the low or high card EVEN if there is no tie. UGH
            isLoContender: player.isLoContender,
            isHiContender: player.isHiContender
        })
    });

    game.results = results;

    sendSocketMessageToEveryClientInRoom(game.roomCode, {
        type: "round-result",
        message: message!,
        loWinner: loWinner,
        hiWinner: hiWinner,
        results: results
    });

    return results; // just for unit tests
}
  
function isNumberCard(
    value: NumberCard | OperatorCard
  ): value is NumberCard {
    return typeof value === "number" && NumberCard[value] !== undefined;
  }
  
  type Op = "+" | "-" | "*" | "/";

  type Token =
    | { kind: "number"; value: number }
    | { kind: "op"; value: Op }
    | { kind: "sqrt" };
  
  const precedence: Record<Op, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
  };
  
  function isOpToken(tok: Token | undefined): tok is { kind: "op"; value: Op } {
    return tok?.kind === "op";
  }
  
  function operatorFromCard(card: OperatorCard): Op | null {
    switch (card) {
      case OperatorCard.ADD: return "+";
      case OperatorCard.SUBTRACT: return "-";
      case OperatorCard.MULTIPLY: return "*";
      case OperatorCard.DIVIDE: return "/";
      default: return null;
    }
  }
  
  /*
cases I need to test: 3 players lock in and it proceeds
2 players lock in or not, but one has a bad hand
1 player is disconnected, and either their hand was good or bad

applyOps tests: one valid and one invalid. and one with divide by zero
  */

  // TODO factor this function out to be shared by server and client
  function applyOps(cardElements: Card[]): number {
    const tokens: Token[] = [];
  
    // 1️⃣ Cards → tokens
    for (const card of cardElements) {
      const val = card.value;
      if (val == null) continue;
  
      if (isNumberCard(val)) {
        tokens.push({ kind: "number", value: Number(val) });
      }
      else if (val === OperatorCard.ROOT) {
        tokens.push({ kind: "sqrt" });
      }
      else {
        const op = operatorFromCard(val);
        if (!op) throw new Error(`Unhandled card value: ${val}`);
        tokens.push({ kind: "op", value: op });
      }
    }
  
    if (tokens.length === 0) {
      throw new Error("Empty expression");
    }
  
    // 2️⃣ Shunting-yard + infix validation
    const output: Token[] = [];
    const ops: Token[] = [];
    let prev: Token | null = null;
  
    for (const tok of tokens) {
  
      // 🔢 Number
      if (tok.kind === "number") {
        // number cannot directly follow another number
        if (prev?.kind === "number") {
          throw new Error("Missing operator between numbers");
        }
        output.push(tok);
      }
  
      // √ Unary operator
      else if (tok.kind === "sqrt") {
        // √ can only appear at start or after another operator
        if (prev && prev.kind === "number") {
          throw new Error("√ cannot follow a number");
        }
        ops.push(tok);
      }
  
      // ➕ Binary operator
      else if (tok.kind === "op") {
        // binary operators must follow a number
        if (!prev || prev.kind !== "number") {
          throw new Error(`Operator '${tok.value}' must follow a number`);
        }
  
        while (true) {
          const top = ops[ops.length - 1];
          if (!isOpToken(top)) break;
          if (precedence[top.value] < precedence[tok.value]) break;
          output.push(ops.pop()!);
        }
  
        ops.push(tok);
      }
  
      prev = tok;
    }
  
    // expression cannot end with an operator or √
    if (prev && prev.kind !== "number") {
      throw new Error("Expression cannot end with an operator");
    }
  
    while (ops.length > 0) {
      output.push(ops.pop()!);
    }
  
    // 3️⃣ Evaluate postfix
    const stack: number[] = [];
  
    for (const tok of output) {
  
      if (tok.kind === "number") {
        stack.push(tok.value);
      }
  
      else if (tok.kind === "sqrt") {
        const v = stack.pop();
        if (v === undefined) {
          throw new Error("√ missing operand");
        }
        stack.push(Math.sqrt(v));
      }
  
      else if (tok.kind === "op") {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) {
          throw new Error("Operator missing operands");
        }
  
        switch (tok.value) {
          case "+": stack.push(a + b); break;
          case "-": stack.push(a - b); break;
          case "*": stack.push(a * b); break;
          case "/": stack.push(a / b); break;
        }
      }
    }
  
    if (stack.length !== 1) {
      throw new Error("Invalid expression");
    }
  
    const result = stack.pop();
    if (result === undefined) {
      throw new Error("Invalid expression");
    }
    return result;
} // TODO tests for applyOps - make sure infix expressions do not count. only root can be unary
  
// TODO above code - test that pot splits correctly, and also if there's only one winner






const heartbeatInterval = setInterval(function ping() {
    wss.clients.forEach(function each(c) {
        const ws = c as ExtendedWebSocket; // TODO better to have Map then I guess?

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
            games.delete(game.roomCode);
        }
    });
}, 24 * 60 * 60 * 1000);

wss.on('close', function close() {
    console.log()
    clearInterval(heartbeatInterval);
    clearInterval(roomCleanupInterval);
});