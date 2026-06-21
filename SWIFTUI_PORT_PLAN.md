# SwiftUI Client Port Plan

> **For the implementing agent (Sonnet):** Read this whole file before writing code. It is
> self-contained but assumes you can read the existing repo. Where it says "see `file.ts`",
> open that file and copy the exact field shapes — do not guess at the wire format. Work
> through the phases in order; each ends in a runnable, testable state.

---

## 1. Goal & scope (read this first — it constrains everything)

Build a **native SwiftUI client** (iOS first, macOS as a near-free bonus) that joins the
**existing, unchanged Node/TypeScript server**. The Swift app and the existing web client
(`public/index.html`) connect to the **same WebSocket endpoint** and speak the **same JSON
protocol**, so a browser player and an iPhone player can share one room.

**In scope:**
- A SwiftUI app that can create/join a room, play a full hand, and view results.
- A Swift port of the protocol (Codable types for every message).
- A **verbatim** Swift port of the equation evaluator (`equation-core.ts`).

**Explicitly OUT of scope (do NOT do these):**
- ❌ Do not modify the server (`server.ts`, `game/`, `ws/`, `state.ts`). The whole point is
  the existing server stays the source of truth.
- ❌ Do not use Vapor / server-side Swift. No backend rewrite.
- ❌ Do not use Apple Game Center / GameKit for hosting. The server is the authority;
  Game Center is Apple-only peer-to-peer and would break web/Android interop.
- ❌ Do not change the web client except as noted in Phase 0 (one config tweak).

**Why these constraints:** the server is single-threaded Node, which makes its game-state
mutations race-free for free. Re-implementing game logic in multithreaded Swift would
reintroduce concurrency hazards for zero benefit at this scale (t3.micro, ≤10 players/room).
The client is the only thing that needs to exist in Swift.

---

## 2. The protocol (the contract you must match exactly)

All traffic is JSON text frames over one WebSocket. Messages are a tagged union keyed by
`"type"`. **Client→server sends use `userId`; server→client sends use `id`.** Do not
normalize this away — match the server.

### Endpoint
- Production: `wss://equationhi.lol`
- Local dev: `ws://localhost:8080` (or whatever `PORT` is). Make this configurable
  (build setting / `#if DEBUG`), do not hardcode only prod.

### Client → server message types (see `public/index.html` send sites)
`create`, `enter`, `join`, `start`, `discard`, `hand-order`, `lock-in`, `hi-lo-selected`,
`bet-placed`, `fold`, `acknowledge-hand-results`, `acknowledge-game-over`, `refresh`,
`debug-force-game-over`, `debug-set-equation-results`.

Exact payload shapes are at these `index.html` lines (read them, copy field-for-field):
- `create` — line ~1502: `{ type, userId, color }`
- `join` — line ~1443: `{ type, color, userId, username }`
- `start` — line ~1512: `{ type, userId }`
- `discard` — line ~1723: `{ type, userId, value, color, username }`
- `bet-placed` — line ~2361: `{ type, userId, betAmount }`
- `fold` — line ~2378: `{ type, manual: true }`  ⚠️ note: no userId, has `manual`
- `hand-order` — line ~2793: `{ type, userId, username, order: string[] }`
- `hi-lo-selected` — line ~1181 / ~1200: `{ type, userId, username, choices: string[], otherEquationResult?, order?: string[] }`
- `acknowledge-hand-results` — line ~2689: `{ type, userId }`
- `acknowledge-game-over` — line ~1664: `{ type, userId }`

### Server → client message types (payload shapes defined in the `game/` + `ws/` + `server.ts` files)
`init`, `room-entered`, `suggest-room`, `room-join-reject`, `reject-start`, `player-joined`,
`player-left`, `begin-hand`, `deal`, `first-round-betting-commenced`,
`second-round-betting-commenced`, `second-round-betting-skipped`, `next-turn`, `bet-placed`,
`player-folded`, `player-discarded`, `end-betting-round`, `commence-equation-forming`,
`player-reordered-hand`, `player-locked-in`, `end-equation-forming`,
`hi-lo-selection-commenced`, `hi-lo-selection`, `player-selected-hilo`, `round-result`,
`chip-distribution`, `game-started`, `game-won`, `kicked`, `player-discarded`,
`unknown-message`.

Where to read exact shapes:
- `game/notify.ts` — `deal` payload (`DealPayload`: `id, color, username, chipCount, multiplicationCardDealt, hand?`) and the `getHandToSendFromHand` hidden-card logic.
- `game/betting.ts` — betting-round / `bet-placed` / `next-turn` broadcasts.
- `game/lifecycle.ts` — phase-transition messages (`commence-equation-forming`,
  `hi-lo-selection-commenced`, betting-commenced, `*EndTime` timer fields).
- `game/results.ts` — `round-result`, `chip-distribution`, reveal `deal`s, `game-won`.
- `ws/handlers/session.ts` — `init`, `room-entered`, join/rejoin, `refresh` handling.
- `server.ts` — `init` (line ~110: `{ type: "init", id }`), rate limit, heartbeat.

⚠️ **Timer fields:** several phase messages carry an absolute `endTime` (epoch ms) —
`equationEndTime`, `hiLoEndTime`, `bettingTurnEndTime` (see `public/classes.ts` `Game`).
A rejoining client uses these to recover remaining time. Decode and honor them.

---

## 3. Enums to port (from `enums.ts`)

```swift
enum NumberCard: Int, Codable { case zero, one, two, three, four, five, six,
                                     seven, eight, nine, ten }   // raw 0...10

// Operators are the EXACT unicode glyphs the server uses — copy them precisely:
enum OperatorCard: String, Codable {
    case add = "+", subtract = "−", divide = "÷", multiply = "×", root = "√"
}   // ⚠️ subtract is U+2212 MINUS SIGN, not hyphen-minus. Root is √ U+221A.

enum Suit: Int, Codable { case stone, bronze, silver, gold, op }   // 0...4

enum GamePhase: String, Codable {
    case lobby
    case firstDeal = "first-deal"
    case firstBetting = "first-betting"
    case secondDeal = "second-deal"
    case equationForming = "equation-forming"
    case secondBetting = "second-betting"
    case hiLoSelection = "hi-lo-selection"
    case resultViewing = "result-viewing"
    case gameOver = "game-over"
}
```

---

## 4. Target folder structure

```
EquationHiLo/                      (new Xcode project / Swift Package, in repo root or /ios)
├── App/
│   └── EquationHiLoApp.swift      // @main; creates + injects GameStore
├── Networking/
│   ├── GameSocket.swift           // actor wrapping URLSessionWebSocketTask
│   ├── ServerMessage.swift        // inbound tagged-union Decodable + payload structs
│   └── ClientMessage.swift        // outbound Encodable
├── Model/
│   ├── Enums.swift                // section 3
│   ├── Card.swift                 // Card + CardValue custom Codable
│   └── EquationEvaluator.swift    // VERBATIM port of equation-core.ts (section 7)
├── State/
│   └── GameStore.swift            // @Observable @MainActor; applies ServerMessage → state
└── Views/
    ├── RootView.swift             // switch on store.phase
    ├── HomeView.swift             // create / join entry
    ├── LobbyView.swift
    ├── EquationFormingView.swift  // drag-to-reorder hand
    ├── BettingView.swift          // call/raise/fold + slider
    ├── HiLoView.swift             // hi / lo / swing selection
    └── ResultsView.swift          // round results + game-won
└── Tests/
    └── EquationEvaluatorTests.swift
```

Decide project type: a standalone **Xcode app project** is simplest for iOS. Put it under
`/ios` in the repo so it doesn't disturb the Node build. Add it to `.gitignore` exceptions
as needed; do not let Xcode-generated `DerivedData`/`*.xcuserstate` get committed.

---

## 5. Key types (skeletons — fill in remaining payloads from section 2)

### Card (the `value` union is the first gotcha)
A card `value` is a number (0–10) OR an operator glyph OR `null` (hidden). JSON has no
union, so decode by attempt:

```swift
enum CardValue: Codable, Equatable {
    case number(Int)
    case op(String)        // one of the OperatorCard glyphs
    case hidden            // JSON null

    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .hidden }
        else if let n = try? c.decode(Int.self) { self = .number(n) }
        else { self = .op(try c.decode(String.self)) }
    }
    func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .number(let n): try c.encode(n)
        case .op(let s): try c.encode(s)
        case .hidden: try c.encodeNil()
        }
    }
}

struct Card: Codable, Identifiable, Equatable {
    let id = UUID()        // LOCAL identity only (see gotcha #1) — not from server
    var value: CardValue
    var suit: Suit?
    var hidden: Bool = false
    private enum CodingKeys: String, CodingKey { case value, suit, hidden }
}
```

### Inbound tagged union
```swift
enum ServerMessage: Decodable {
    case initSession(InitPayload)
    case deal(DealPayload)
    case nextTurn(NextTurnPayload)
    case betPlaced(BetPlacedPayload)
    case roundResult(RoundResultPayload)
    case commenceEquationForming(EquationFormingPayload)
    // … one case per server "type" in section 2
    case unknown(type: String)

    private enum K: String, CodingKey { case type }
    init(from decoder: Decoder) throws {
        let env = try decoder.container(keyedBy: K.self)
        let type = try env.decode(String.self, forKey: .type)
        let whole = try decoder.singleValueContainer()
        switch type {
        case "init": self = .initSession(try whole.decode(InitPayload.self))
        case "deal": self = .deal(try whole.decode(DealPayload.self))
        case "next-turn": self = .nextTurn(try whole.decode(NextTurnPayload.self))
        case "bet-placed": self = .betPlaced(try whole.decode(BetPlacedPayload.self))
        case "round-result": self = .roundResult(try whole.decode(RoundResultPayload.self))
        // …
        default: self = .unknown(type: type)
        }
    }
}
```
> Decode unknown types into `.unknown` rather than throwing — the server has debug/edge
> messages and you want forward-compat. Log them.

### Outbound
```swift
enum ClientMessage: Encodable {
    case create(userId: String, color: String)
    case join(userId: String, username: String, color: String)
    case start(userId: String)
    case discard(userId: String, username: String, color: String, value: String)
    case betPlaced(userId: String, betAmount: Int)
    case fold(manual: Bool)                          // ⚠️ no userId; matches index.html
    case lockIn(userId: String)
    case handOrder(userId: String, username: String, order: [String])
    case hiLoSelected(userId: String, username: String, choices: [String], order: [String]?)
    case acknowledgeHandResults(userId: String)
    case acknowledgeGameOver(userId: String)
    case refresh(userId: String)
    // encode(to:) writes "type" + the arm's fields with the EXACT key names from section 2
}
```

### Socket (actor — keeps read loop & sends from racing)
```swift
actor GameSocket {
    private var task: URLSessionWebSocketTask?
    private let enc = JSONEncoder(); private let dec = JSONDecoder()
    var onMessage: (@Sendable (ServerMessage) -> Void)?

    func connect(url: URL) {
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        Task { await receiveLoop() }
    }
    func send(_ m: ClientMessage) async throws {
        let data = try enc.encode(m)
        try await task?.send(.string(String(decoding: data, as: UTF8.self)))
    }
    private func receiveLoop() async {
        guard let task else { return }
        do {
            if case .string(let s) = try await task.receive(),
               let d = s.data(using: .utf8),
               let msg = try? dec.decode(ServerMessage.self, from: d) {
                onMessage?(msg)
            }
            await receiveLoop()
        } catch { /* gotcha #3: backoff + reconnect + send refresh */ }
    }
}
```

### Store
```swift
@Observable @MainActor
final class GameStore {
    var myId = UUID().uuidString    // overwritten by server "init" id on first connect
    var myName = ""
    var myColor = ""
    var phase: GamePhase = .lobby
    var roomCode = ""
    var players: [String: PlayerVM] = [:]
    var myHand: [Card] = []
    var pot = 0
    var toCall = 0
    var currentTurnPlayerId: String?
    // timer end-times (epoch ms) for the active phase
    var phaseEndTime: Double?

    private let socket = GameSocket()
    func start(url: URL) {
        Task {
            await socket.setOnMessage { [weak self] msg in
                Task { @MainActor in self?.apply(msg) }
            }
            await socket.connect(url: url)
        }
    }
    func apply(_ msg: ServerMessage) { /* big switch → mutate state */ }
    func send(_ msg: ClientMessage) { Task { try? await socket.send(msg) } }
}
```

---

## 6. Phased task list (each phase ends runnable & testable)

### Phase 0 — Prep (no Swift yet)
- [ ] Confirm the web client uses a dynamic WS URL (CLAUDE.md "Known Issue #1"). If
  `wss://equationhi.lol` is still hardcoded in `index.html`, that's fine to leave for the
  web app, but note the **Swift app must point at a configurable URL** including localhost.
- [ ] Run the server locally (`npm run dev`) and confirm the web client plays a full hand,
  so you have a known-good reference to diff the Swift client against.
- [ ] Capture a real session's frames: add a temporary `console.log` of every inbound/outbound
  message in `index.html` (or use browser devtools WS inspector) and play one full hand.
  Save the transcript — it's your golden fixture for decoding tests.

### Phase 1 — Model + evaluator (pure, no UI, fully unit-testable)
- [ ] `Enums.swift`, `Card.swift` (+ `CardValue`).
- [ ] `EquationEvaluator.swift` — **verbatim** port (section 7).
- [ ] `EquationEvaluatorTests.swift` — port the relevant Jest cases from `__tests__/tests.ts`,
  and MUST include the regression case `√9/6-10` → `(√9)/6-10`, NOT `√(9/6-10)`.
- [ ] Gate: `swift test` green. This phase has zero networking risk; nail it first.

### Phase 2 — Protocol round-trip (still no UI)
- [ ] `ServerMessage.swift` + every payload struct (read shapes from section 2 source files).
- [ ] `ClientMessage.swift`.
- [ ] Decode tests: feed the Phase-0 transcript JSON into `ServerMessage` decoding; assert no
  `.unknown` for known types and that fields populate. Encode tests: assert your
  `ClientMessage` JSON byte-matches what `index.html` sends (key names, `userId` vs `id`).
- [ ] Gate: all known server messages decode; all client messages encode to the exact shapes.

### Phase 3 — Socket + store, headless
- [ ] `GameSocket.swift`, `GameStore.swift` with the `apply` switch.
- [ ] Wire `create`/`join`/`start` and verify against a locally running server via a small
  command-line/test harness (print `store.phase` transitions). Two clients (Swift + browser)
  in one room should both advance through phases.
- [ ] Gate: Swift client can sit in a room a browser created and receive deals.

### Phase 4 — UI vertical slice
- [ ] `EquationHiLoApp`, `RootView` (phase switch), `HomeView`, `LobbyView`.
- [ ] Render hand + chips from store. Goal: create/join + see lobby + see cards dealt.

### Phase 5 — Interactive phases (the hard UI)
- [ ] `EquationFormingView` — drag-to-reorder (gotcha #1). Use `.onMove` in a `List` first
  for correctness, then upgrade to a free-form `.draggable`/`.dropDestination` table layout.
  Send `hand-order` with the `order` string array. Show live result via the Phase-1 evaluator.
- [ ] `BettingView` — call/raise slider + fold; send `bet-placed` / `fold`.
- [ ] `HiLoView` — choices (hi/lo/swing); send `hi-lo-selected` (include `order` when required).
- [ ] `ResultsView` — `round-result` + `chip-distribution` + `game-won`; ack messages.

### Phase 6 — Resilience & polish
- [ ] Reconnect/backoff + `refresh` on foreground (gotcha #3); honor `*EndTime` timers.
- [ ] Sounds via `AVFoundation` (mirror `public/sounds.js`); QR via `CoreImage` if you want
  the share-room feature.
- [ ] Manual cross-client test: full hand with a browser player + Swift player in same room.

---

## 7. The three things that WILL bite you (do not skip)

### Gotcha #1 — Card identity for reordering
The server's hand JSON cards carry **no stable id**. The web client uses DOM `dataset.id`
strings and sends them as the `order` array in `hand-order` and `hi-lo-selected`. In Swift you
must assign client-side identity (`Card.id = UUID()`), keep it stable across re-renders (do
NOT recreate `Card`s on every `deal`/reorder echo), and map your local ids to whatever string
the server expects in `order`. **Read `index.html` lines ~2793 and ~1181 to see exactly what
goes in `order`** and reproduce that contract. This is the spine of EQUATIONFORMING — get it
right before building the drag UI.

### Gotcha #2 — Evaluator must match the server BIT-for-BIT
`equation-core.ts` exists specifically because the client and server evaluators once drifted
(the `√9/6-10` bug: one side parsed `√(9/6-10)` → NaN and auto-folded a valid hand). Port it
**verbatim** — same shunting-yard, same precedence, same "unary √ binds tightest, applied to
the immediate number" rule. Reference (port this logic exactly):

```swift
enum Token: Equatable { case number(Double); case op(Character); case sqrt }

enum EquationError: Error { case empty, missingOperator, sqrtAfterNumber,
    operatorMustFollowNumber, endsWithOperator, sqrtMissingOperand, missingOperands, invalid }

func evaluateTokens(_ tokens: [Token]) throws -> Double {
    if tokens.isEmpty { throw EquationError.empty }
    let precedence: [Character: Int] = ["+":1, "−":1, "-":1, "*":2, "×":2, "/":2, "÷":2]
    // NOTE: map BOTH the server glyphs (− × ÷) AND ASCII (- * /) to be safe; the wire uses
    // the unicode glyphs from enums.ts. Confirm which the tokens carry and normalize once.
    var output: [Token] = []; var ops: [Token] = []; var prev: Token? = nil
    func isOp(_ t: Token?) -> Bool { if case .op = t { return true }; return false }

    for tok in tokens {
        switch tok {
        case .number:
            if case .number = prev { throw EquationError.missingOperator }
            output.append(tok)
            while case .sqrt = ops.last { output.append(ops.removeLast()) }  // √ binds tightest
        case .sqrt:
            if case .number = prev { throw EquationError.sqrtAfterNumber }
            ops.append(tok)
        case .op(let o):
            guard case .number = prev else { throw EquationError.operatorMustFollowNumber }
            while case .op(let top) = ops.last,
                  (precedence[top] ?? 0) >= (precedence[o] ?? 0) {
                output.append(ops.removeLast())
            }
            ops.append(tok)
        }
        prev = tok
    }
    if let p = prev, case .number = p {} else { throw EquationError.endsWithOperator }
    while !ops.isEmpty { output.append(ops.removeLast()) }

    var stack: [Double] = []
    for tok in output {
        switch tok {
        case .number(let v): stack.append(v)
        case .sqrt:
            guard let v = stack.popLast() else { throw EquationError.sqrtMissingOperand }
            stack.append(v.squareRoot())
        case .op(let o):
            guard let b = stack.popLast(), let a = stack.popLast() else { throw EquationError.missingOperands }
            switch o {
            case "+": stack.append(a + b)
            case "−", "-": stack.append(a - b)
            case "×", "*": stack.append(a * b)
            case "÷", "/": stack.append(a / b)
            default: throw EquationError.invalid
            }
        }
    }
    guard stack.count == 1, let r = stack.first else { throw EquationError.invalid }
    return r
}
```
> ⚠️ Cross-check this against the CURRENT `equation-core.ts` at implementation time — if that
> file changed since this plan was written, the source file wins. Re-port from it.

### Gotcha #3 — Reconnect (iOS kills sockets on backgrounding)
The web client rarely loses its socket; an iOS app loses it every time it backgrounds. The
server already supports rejoin: it tracks `userId` and the phase timers send absolute
`endTime`s so a returning client recovers remaining time (see `public/classes.ts` and the
`refresh` handling in `ws/handlers/session.ts`). Build this in from Phase 3, not last:
- On disconnect: exponential backoff reconnect.
- On reconnect / app-foreground: re-send identity and a `refresh` to resync state.
- Persist `myId`/`myName`/`roomCode` (e.g. `@AppStorage`) so a cold app relaunch can rejoin.

---

## 8. Definition of done
- Swift client and a browser client play a complete hand together in one room against a
  locally-run unmodified server, through all phases (lobby → result), including a raise, a
  fold, an equation reorder, and a hi/lo selection.
- `swift test` green: evaluator parity (incl. `√9/6-10`) + protocol decode/encode tests.
- App survives backgrounding mid-hand and rejoins with correct state and remaining timers.
- Zero changes to `server.ts`, `game/`, `ws/`, `state.ts`.
