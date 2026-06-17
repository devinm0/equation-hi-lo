import { drawNumberCardFromDeck } from './game/deck.js';
import {
    games, players, RATE_LIMIT, INTERVAL, EQUATION_DURATION,
    ExtendedWebSocket, ClientMessage, ServerMessage,
    GamePhase,
    JoinMessage, StartMessage, RefreshMessage,
    DiscardMessage, FoldMessage, HandOrderMessage, LockInMessage,
    HiLoSelectedMessage, BetMessage, AcknowledgeHandResultsMessage, LeaveMessage,
    setWss,
} from './state.js';
import {
    sendSocketMessageToEveryClientInRoom,
} from './ws/broadcast.js';
import {
    handleCreate,
    handleEnter,
    handleRefresh,
    handleStart,
    handleLeave,
    handleJoin,
    handleAcknowledgeGameOver,
    handleDebugForceGameOver,
} from './ws/handlers/session.js';
import {
    getHandToSendFromHand,
    notifyAllPlayersOfNewlyDealtCards,
} from './game/notify.js';
import {
    activePlayersInRoom,
    nonFoldedAndNotOutPlayers,
    cleanupGame,
} from './game/rooms.js';
import {
    playersThatNeedToDiscard,
} from './game/deal.js';
import { applyOps } from './game/equation.js';
import {
    fold,
    endRoundOrProceedToNextPlayer,
    endHand,
    commenceFirstRoundBetting,
    commenceEquationForming,
    endEquationForming,
    resolveHiLoSelection,
} from './game/lifecycle.js';
import express from "express";
import http from "http";
import path from "path";
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

// Shareable room URLs: equationhi.lol/GB45 serves the SPA so the client can auto-enter
// that room (see the `init` handler in index.html). Matches ONLY a 4-char room-code path
// so real static assets (style.css, enums.js, favicon.png, preview.png) still hit
// express.static above. Express 5 uses path-to-regexp v8, which dropped bare "*" routes,
// so we match with a RegExp instead. public/ sits at the project root in both dev
// (tsx server.ts) and prod (node dist/server.js), so resolve from cwd like express.static.
app.get(/^\/[A-Za-z0-9]{4}$/, (req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
});


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
                handleCreate(ws, clientMsg);
                break;
            }

            case "enter": {
                handleEnter(ws, clientMsg);
                break;
            }

            case "refresh": {
                handleRefresh(ws, clientMsg);
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
                handleStart(ws, clientMsg);
                break;
            }

            case "leave": {
                handleLeave(ws, clientMsg);
                break;
            }

            case "acknowledge-game-over": {
                handleAcknowledgeGameOver(ws, clientMsg);
                break;
            }

            case "debug-force-game-over": {
                handleDebugForceGameOver(ws, clientMsg);
                break;
            }

            case "join": {
                handleJoin(ws, clientMsg);
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
                    
                    if (client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === player.roomCode) {
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
                    
                //     if (client.userId !== player.id && client.readyState === WebSocket.OPEN && players.get(client.userId)?.roomCode === player.roomCode) {
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
                    // endEquationForming now clears the equation timer itself (first thing),
                    // so it's reset before any transition to hi/lo selection arms its own timer.
                    endEquationForming(game);
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
                const selected = choices as string[];
                const wantsLow = selected.includes("low");
                const wantsHigh = selected.includes("high");

                if (wantsLow && wantsHigh) {
                    // Swing: fully validate the second equation BEFORE mutating any player state.
                    // A rejected swing submit must leave the player completely unselected (so the
                    // client can retry and the resolution check doesn't count them) — previously
                    // player.choices was set first, so a rejected order stranded them with choices
                    // but null results, shown as "(no selection)" with empty equations.
                    if (!clientMsg.order) {
                        console.log("swing betting requires a second card order");
                        return;
                    }

                    const swingOrder: unknown[] = clientMsg.order;
                    if (!Array.isArray(swingOrder) || swingOrder.length !== player.hand.length) return;
                    const swingSeen = new Set<number>();
                    // The client sends card indices as strings (card.dataset.id), same as the
                    // hand-order message — coerce with Number rather than rejecting on typeof.
                    for (const i of swingOrder) {
                        const idx = Number(i);
                        if (!Number.isInteger(idx) || idx < 0 || idx >= player.hand.length || swingSeen.has(idx)) return;
                        swingSeen.add(idx);
                    }
                    const otherHand = swingOrder.map(i => player.hand[Number(i)]!);

                    let otherEquationResult: number;
                    try {
                        otherEquationResult = applyOps(otherHand);
                    } catch {
                        return;
                    }
                    if (!isFinite(otherEquationResult)) return;

                    // All validation passed — commit the swing state.
                    player.choices = selected;
                    player.otherHand = otherHand;
                    player.otherEquationResult = otherEquationResult;

                    // this shouldn't be true. What if their results are 21, and 23. They might want to choose 21 as high equation, and 23 as low (even though they could have just kept 21 for both)
                    if (otherEquationResult < player.equationResult) {
                        player.lowEquationResult = otherEquationResult;
                        player.highEquationResult = player.equationResult;
                        player.lowHand = otherHand;
                        player.highHand = player.hand;
                    } else {
                        player.lowEquationResult = player.equationResult;
                        player.highEquationResult = otherEquationResult;
                        player.highHand = otherHand;
                        player.lowHand = player.hand;
                    }
                } else if (wantsLow) {
                    player.choices = selected;
                    player.lowHand = player.hand;
                    player.lowEquationResult = player.equationResult;
                } else { // wantsHigh
                    player.choices = selected;
                    player.highHand = player.hand;
                    player.highEquationResult = player.equationResult;
                }
                sendSocketMessageToEveryClientInRoom(game.roomCode, {
                    type: "player-selected-hilo",
                    id: player.id,
                });

                if (nonFoldedAndNotOutPlayers(game).every(player => player.choices.length > 0)) {
                    console.log('everyone submitted their hi or lo selections');
                    resolveHiLoSelection(game); // clears the hi/lo timer, reveals, determines winners
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
            cleanupGame(game); // deletes the game AND its player records, not just the game
        }
    });
}, 24 * 60 * 60 * 1000);

wss.on('close', function close() {
    console.log()
    clearInterval(heartbeatInterval);
    clearInterval(roomCleanupInterval);
});