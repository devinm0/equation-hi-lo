import { GamePhase } from './enums.js';
import { Game, Player, Card } from './public/classes.js';
import { WebSocket, WebSocketServer } from 'ws';

export { Game, Player, Card, GamePhase };

export let games = new Map<string, Game>();
export let players = new Map<string, Player>();
export let wss: WebSocketServer;
export function setWss(server: WebSocketServer) { wss = server; }

export const emojis = ['💀','❤️','😎','💩','👽','🧠','🐸','🍄','🪐','🔥','❄️','🍩'];
export const RATE_LIMIT = 20;
export const INTERVAL = 10000;
export const EQUATION_DURATION =
    (process.env.GAME_MODE === 'debug' ? 20 : 90) * 1000;

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
}

export interface KickedMessage {
    type: "kicked";
    id: string;
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

export type ServerMessage =
    BeginHandMessage
    | CommenceEquationFormingMessage
    | EndBettingRoundMessage
    | PlayerDiscardedMessage
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
