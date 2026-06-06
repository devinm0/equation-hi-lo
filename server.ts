import { logRoomsAndPlayers } from './debug/print.js';
import { drawNumberCardFromDeck } from './game/deck.js';
import { removeWhitespace } from './public/utilities.js';
import {
    games, players, emojis, RATE_LIMIT, INTERVAL, EQUATION_DURATION,
    ExtendedWebSocket, ClientMessage, ServerMessage,
    Game, Player, GamePhase,
    CreateMessage, EnterMessage, JoinMessage, StartMessage, RefreshMessage,
    DiscardMessage, FoldMessage, HandOrderMessage, LockInMessage,
    HiLoSelectedMessage, BetMessage, AcknowledgeHandResultsMessage, LeaveMessage,
    setWss,
} from './state.js';
import {
    sendSocketMessageToEveryClientInRoom,
} from './ws/broadcast.js';
import {
    getHandToSendFromHand,
    notifyPlayerOfNewlyDealtCards,
    notifyAllPlayersOfNewlyDealtCards,
} from './game/notify.js';
import {
    playersInRoom,
    activePlayersInRoom,
    nonFoldedAndNotOutPlayers,
} from './game/rooms.js';
import {
    playersThatNeedToDiscard,
} from './game/deal.js';
import {
    advanceToNextPlayersTurn,
} from './game/betting.js';
import { applyOps } from './game/equation.js';
import {
    revealHiddenCards,
} from './game/results.js';
import {
    fold,
    endRoundOrProceedToNextPlayer,
    endHand,
    initializeHand,
    commenceFirstRoundBetting,
    commenceEquationForming,
    endEquationForming,
    getSecondsLeft,
    determineWinners,
} from './game/lifecycle.js';
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