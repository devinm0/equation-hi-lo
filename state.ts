import { GamePhase } from './enums.js';
import { Game, Player, Card } from './public/classes.js';
import { WebSocket, WebSocketServer } from 'ws';

export { Game, Player, Card, GamePhase };

export let games = new Map<string, Game>();
export let players = new Map<string, Player>();
export let wss: WebSocketServer;
export function setWss(server: WebSocketServer) { wss = server; }

export const RATE_LIMIT = 20;
export const INTERVAL = 10000;
// Deck has 44 number cards and each player consumes up to 4 in the worst-case
// shuffle (44 / 4 = 11 hard ceiling). Capped at 10 for a safety margin.
export const MAX_PLAYERS_PER_ROOM = 10;
export const EQUATION_DURATION =
    (process.env.GAME_MODE === 'debug' ? 20 : 90) * 1000;
// Hi/Lo selection gets its OWN timer (separate Game field) so a player who never picks a
// side — closed tab, walked away, lost the modal on a refresh — can't hang the whole table.
// 60s in production (shorter than equation forming — picking a side is quicker than building
// an equation); 20s in debug for fast E2E. Because this differs from the 90s equation timer,
// the client countdown is parameterized by total duration rather than assuming 90.
export const HI_LO_DURATION =
    (process.env.GAME_MODE === 'debug' ? 20 : 60) * 1000;
// Per-turn betting timer: each player has this long to act on their turn (first/second betting
// rounds) before they're auto-folded, so one idle/disconnected player can't stall the table.
export const BETTING_TURN_DURATION = 20 * 1000;
// Must match the .card.discarding animation-duration in public/style.css. The "deal" message
// following a discard is held back by this long so every viewer's discard fade-up animation
// (started by the preceding "player-discarded" broadcast) has time to finish before the
// hand redraw lands.
export const DISCARD_FADE_MS = 250;

export interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
    msgCount: number;
    userId: string;
}

export interface CreateMessage {
    type: "create";
    userId: string;
    color: string;
}

export interface StartMessage {
    type: "start";
    userId: string;
}

export interface RefreshMessage {
    type: "refresh";
    userId: string;
    color: string;
    username: string;
}

export interface DiscardMessage {
    type: "discard";
    userId: string;
    value: string;
    color: string;
    username: string;
}

export interface FoldMessage {
    type: "fold";
    manual: boolean;
}

export interface HandOrderMessage {
    type: "hand-order";
    userId: string;
    username: string;
    order: number[];
}

export interface LockInMessage {
    type: "lock-in";
    userId: string;
    username: string;
}

export interface HiLoSelectedMessage {
    type: "hi-lo-selected";
    userId: string;
    username: string;
    choices: string[];
    otherEquationResult?: number;
    order?: number[];
}

export interface JoinMessage {
    type: "join";
    color: string;
    userId: string;
    username: string;
}

export interface EnterMessage {
    type: "enter";
    color: string;
    userId: string;
    username: string;
    roomCode: string;
}

export interface BetMessage {
    type: "bet-placed";
    userId: string;
    betAmount: number;
    folded: boolean;
}

export interface AcknowledgeHandResultsMessage {
    type: "acknowledge-hand-results";
    userId: string;
}

export interface LeaveMessage {
    type: "leave";
    userId: string;
}

export interface AcknowledgeGameOverMessage {
    type: "acknowledge-game-over";
    userId: string;
}

// Debug-only (server honours it solely when GAME_MODE=debug): immediately ends the
// sender's game with the sender as the lone winner. Lets E2E reach game-over
// deterministically instead of grinding hands until someone busts.
export interface DebugForceGameOverMessage {
    type: "debug-force-game-over";
    userId: string;
}

// Debug-only (server honours it solely when GAME_MODE=debug): force the sender's resolved
// low/high equation results, applied just before winner determination. Lets E2E construct
// exact winner scenarios (swing ties alongside pure betters, swing sweeps, all-swing
// forfeits) that random deals can't reliably produce.
export interface DebugSetEquationResultsMessage {
    type: "debug-set-equation-results";
    userId: string;
    low?: number | null;
    high?: number | null;
}

export type ClientMessage =
    CreateMessage
    | StartMessage
    | RefreshMessage
    | DiscardMessage
    | FoldMessage
    | HandOrderMessage
    | LockInMessage
    | HiLoSelectedMessage
    | JoinMessage
    | EnterMessage
    | BetMessage
    | AcknowledgeHandResultsMessage
    | LeaveMessage
    | AcknowledgeGameOverMessage
    | DebugForceGameOverMessage
    | DebugSetEquationResultsMessage

export interface BeginHandMessage {
    type: "begin-hand";
    handNumber: number;
}

export interface CommenceEquationFormingMessage {
    type: "commence-equation-forming";
    cannotFormEquation?: boolean;
}

export interface SecondRoundBettingCommencedMessage {
    type: "second-round-betting-commenced";
}

export interface FirstRoundBettingCommencedMessage {
    type: "first-round-betting-commenced";
}

export interface EndBettingRoundMessage {
    type: "end-betting-round";
    round: GamePhase;
}

export interface PlayerDiscardedMessage {
    type: "player-discarded";
    id: string;
    username: string;
    value: string;
}

export interface PlayerSelectedHiLoMessage {
    type: "player-selected-hilo";
    id: string;
}

export interface HiLoSelectionCommencedMessage {
    type: "hi-lo-selection-commenced";
    pendingPlayerIds: string[];
}

export interface GameStartedMessage {
    type: "game-started";
}

export interface PlayerLeftMessage {
    type: "player-left";
}

export interface PlayerJoinedMessage {
    type: "player-joined";
    id: string;
    hostId: string;
    color: string;
    username: string;
}

export interface BetPlacedMessage {
    type: "bet-placed";
    id: string;
    username: string;
    betAmount: number;
    chipCount: number;
    pot: number;
    betType: string;
}

export interface SecondRoundBettingSkippedMessage {
    type: "second-round-betting-skipped";
}

export interface HiLoSelectionMessage {
    type: "hi-lo-selection";
    remainingSeconds?: number;
    totalSeconds?: number;
}

export interface KickedMessage {
    type: "kicked";
    userId: string;
    color: string;
    username: string;
    hand: Card[];
    chipCount: number;
}

export interface EndEquationFormingMessage {
    type: "end-equation-forming";
}

export interface ChipDistributionMessage {
    type: "chip-distribution";
    chipCount: number;
    id: string;
}

export interface RoundResultMessage {
    type: "round-result";
    message: string;
    loWinner: Player | null;
    hiWinner: Player | null;
    results: Result[];
}

export interface Result {}

// Sent to everyone in a room when the game ends (all but one player eliminated).
// chipCount is the winner's whole stack — i.e. their total winnings.
export interface GameWonMessage {
    type: "game-won";
    winnerId: string;
    username: string;
    color: string;
    chipCount: number;
}

export type ServerMessage =
    BeginHandMessage
    | GameWonMessage
    | CommenceEquationFormingMessage
    | EndBettingRoundMessage
    | PlayerDiscardedMessage
    | PlayerSelectedHiLoMessage
    | HiLoSelectionCommencedMessage
    | GameStartedMessage
    | PlayerLeftMessage
    | PlayerJoinedMessage
    | BetPlacedMessage
    | SecondRoundBettingSkippedMessage
    | KickedMessage
    | FirstRoundBettingCommencedMessage
    | SecondRoundBettingCommencedMessage
    | EndEquationFormingMessage
    | HiLoSelectionMessage
    | ChipDistributionMessage
    | RoundResultMessage
