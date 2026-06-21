import {
    games, players, MAX_PLAYERS_PER_ROOM, wss,
    Game, Player, GamePhase,
    ExtendedWebSocket,
    CreateMessage, EnterMessage, JoinMessage, StartMessage, LeaveMessage, RefreshMessage,
    AcknowledgeGameOverMessage, DebugForceGameOverMessage,
} from '../../state.js';
import { removeWhitespace } from '../../public/utilities.js';
import { logRoomsAndPlayers } from '../../debug/print.js';
import { sendSocketMessageToEveryClientInRoom } from '../broadcast.js';
import { notifyPlayerOfNewlyDealtCards } from '../../game/notify.js';
import { playersInRoom, nonFoldedAndNotOutPlayers, cleanupGame } from '../../game/rooms.js';
import { advanceToNextPlayersTurn } from '../../game/betting.js';
import { initializeHand, getSecondsLeft, getHiLoSecondsLeft, declareGameOver, settlePlayerDeparture } from '../../game/lifecycle.js';
import { HI_LO_DURATION } from '../../state.js';

export function handleCreate(ws: ExtendedWebSocket, clientMsg: CreateMessage) {
    let game = new Game();
    games.set(game.roomCode, game);
    console.log(games);
    // Use the client's persistent id, NOT ws.userId. On a page reload the socket is fresh and
    // ws.userId is still the throwaway connection uuid (handleRefresh deliberately does NOT bind
    // it — see that function). enterRoom binds ws.userId = clientMsg.userId and creates the
    // player record under clientMsg.userId, so the host/turn must reference that same id or the
    // new room gets a phantom host with no player record (breaks start + turn resolution).
    game.currentTurnPlayerId = game.hostId = clientMsg.userId; // TODO remove concept of hostId?? or add host promotion

    enterRoom(game, clientMsg, ws);
    console.log(game);
}

export function handleEnter(ws: ExtendedWebSocket, clientMsg: EnterMessage) { // TODO change to enter, and then just check if game is in lobby phase and if player already exists
    const game = games.get(clientMsg.roomCode);

    if (!game) {
        // send room code does not exist message
        ws.send(JSON.stringify({ type: "room-join-reject" }));

        return;
    }

    enterRoom(game, clientMsg, ws);
}

export function handleRefresh(ws: ExtendedWebSocket, clientMsg: RefreshMessage) {
    // Do NOT bind ws.userId to the client's real id here. A page reload opens a fresh socket
    // and the client `refresh`es to ask "am I still in a game?" — but it has NOT yet chosen to
    // rejoin. If we bound the id now, this socket would match the room-broadcast filter
    // (players.get(ws.userId)?.roomCode) while the player record still points at the old room,
    // so the old game's live messages (deals, folds, equation-forming) would stream into a page
    // that's only showing the home screen / rejoin prompt and render as garbage behind it.
    // Leaving ws.userId as the throwaway connection uuid (which has no player record) keeps this
    // socket inert until the user commits: `enter` (Rejoin) and `create` (New Game) both bind
    // ws.userId themselves in enterRoom and replay the correct state from scratch.
    const player = players.get(clientMsg.userId);
    if (!player) return;

    ws.send(JSON.stringify({ type: "suggest-room", roomCode: player.roomCode })); // TODO client will say must be players 2 even if the reject reason is client not being host
}

export function handleStart(ws: ExtendedWebSocket, clientMsg: StartMessage) {
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
}

export function handleLeave(ws: ExtendedWebSocket, clientMsg: LeaveMessage) {
    const player = players.get(clientMsg.userId);
    if (!player) return;
    const game = games.get(player.roomCode);
    if (!game) return;

    sendSocketMessageToEveryClientInRoom(game.roomCode, { type: "player-left" });

    // Before a hand starts (or after the game's over) there's nothing in-flight to unwind — just
    // mark them gone.
    if (game.phase === GamePhase.LOBBY || game.phase === GamePhase.GAMEOVER) {
        player.out = true;
        return;
    }

    // Mid-hand: fully resolve the room's dependence on the leaver — reassign host, fold them, and
    // push forward whatever phase was waiting on them. Critically, if they bail while it's their
    // turn to bet, this advances the turn (re-arming the per-turn timer for the next player) right
    // away, instead of stalling the table until the 20s betting-turn timeout would auto-fold them.
    // Reuses the same settlement as a player who leaves by starting a new game.
    settlePlayerDeparture(player, game);
}

// The winner clicked "Accept" on the win screen (or their tab fired beforeunload).
// Tear the whole room down — deletes the game AND every player record — so the same
// browser can immediately start a fresh game and is never suggested the dead room.
export function handleAcknowledgeGameOver(ws: ExtendedWebSocket, clientMsg: AcknowledgeGameOverMessage) {
    const player = players.get(clientMsg.userId);
    if (!player) return;
    const game = games.get(player.roomCode);
    if (!game) return;

    cleanupGame(game);
}

// Debug-only test hook (ignored unless GAME_MODE=debug): mark everyone but the sender
// out and end the game with the sender as winner, so E2E can reach game-over
// deterministically without grinding hands until a real bust.
export function handleDebugForceGameOver(ws: ExtendedWebSocket, clientMsg: DebugForceGameOverMessage) {
    if (process.env.GAME_MODE !== 'debug') return;

    const player = players.get(clientMsg.userId);
    if (!player) return;
    const game = games.get(player.roomCode);
    if (!game) return;

    // Mirror a real game-over: the champion has swept every other player's chips. Without this
    // the forced winner keeps exactly their buy-in, so net winnings (declareGameOver reports
    // chipCount - startingChipCount) come out 0 and the win modal shows an empty chipstack.
    playersInRoom(game.roomCode).forEach(p => {
        if (p.id !== player.id) {
            player.chipCount += p.chipCount;
            p.chipCount = 0;
            p.out = true;
        }
    });
    declareGameOver(game, player);
}

export function handleJoin(ws: ExtendedWebSocket, clientMsg: JoinMessage) { // TODO change to set Name
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

    player.username = removeWhitespace(clientMsg.username);
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
}

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
            ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: player.username != null }));

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

            // reject brand-new players once the room is full (deck can't supply more — see MAX_PLAYERS_PER_ROOM)
            if (playersInRoom(game.roomCode).length >= MAX_PLAYERS_PER_ROOM) {
                ws.send(JSON.stringify({ type: "room-join-reject", reason: "full" }));
                return;
            }

            // The client is committing to THIS room. If they were still seated in a DIFFERENT
            // room (they hit "New Game" / entered a new code without leaving), settle that old
            // room around their departure so its remaining players keep playing. This MUST run
            // before we overwrite their single global player record just below.
            const previous = players.get(clientMsg.userId);
            if (previous && previous.roomCode !== game.roomCode) {
                const oldGame = games.get(previous.roomCode);
                if (oldGame) {
                    settlePlayerDeparture(previous, oldGame);
                    // If the leaver was the last one in the old room, tear it down so no orphan
                    // game/timer lingers (cleanupGame also deletes their old record — fine, it's
                    // recreated for the new room immediately below).
                    if (playersInRoom(oldGame.roomCode).every(p => p.id === clientMsg.userId)) {
                        cleanupGame(oldGame);
                    }
                }
            }

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
            // assign color to player
            while (true) {
                const index = Math.floor(Math.random() * 12);
                if (index === 2 || game.usedColors.has(index)) { // index 2 is yellow (hue 60) — illegible on the white lobby cards at any lightness that still reads on dark backgrounds, so it's excluded entirely rather than dimmed
                    continue;
                } else {
                    color = `hsl(${index * 30}, 100%, 60%)`;
                    game.usedColors.add(index);
                    break;
                }
            }

            players.set(clientMsg.userId, new Player(clientMsg.userId, game.roomCode, color)); // TODO sanitize clientMsg.username to standards
            ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: false, color: color }));

            console.log([...players].filter(([id, player]) => player.roomCode === game.roomCode));

            logRoomsAndPlayers();
        }
    } else { // gamephase is not lobby
        // Bind this (brand-new) socket to the client's real id so a reconnecting `enter`
        // finds the existing player record without first needing a `refresh`. Without this,
        // ws.userId is the fresh server-generated uuid from wss.on("connection") and the
        // lookup below misses.
        ws.userId = clientMsg.userId;

        // Latest-connection-wins: kill any other open socket already bound to this id (the
        // dead pipe we're replacing, or a duplicate). Closes the ~30s window where the old
        // suspended socket and the new one both receive every broadcast, and means a would-be
        // hijacker visibly kicks the real player instead of silently co-observing their hand.
        // NOTE: userId is still an unauthenticated client string — real fix is a session token
        // issued on join and required on rejoin. Out of scope here.
        wss.clients.forEach((c) => {
            const other = c as ExtendedWebSocket;
            if (other !== ws && other.userId === clientMsg.userId) other.terminate();
        });

        const rejoiningPlayer = players.get(ws.userId); // can use ws if not gamephase bc must be true

        // Only existing members of this room can re-enter once the game is in progress.
        // A brand-new client (no player record, or one for a different room) is rejected
        // rather than left on a blank screen.
        if (!rejoiningPlayer || rejoiningPlayer.roomCode !== game.roomCode) {
            ws.send(JSON.stringify({ type: "room-join-reject", reason: "in-progress" }));
            return;
        }

        // TODO what makes this a "rejoin"? I should have that word, that's what I expected.
        ws.send(JSON.stringify({ type: "room-entered", roomCode: game.roomCode, hostId: game.hostId, joined: true, inProgress: true }));

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
                    ws.send(JSON.stringify({
                        type: "hi-lo-selection",
                        remainingSeconds: getHiLoSecondsLeft(game),
                        totalSeconds: HI_LO_DURATION / 1000,
                    }));
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
